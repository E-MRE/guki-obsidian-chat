/**
 * The single persistent `claude` subprocess.
 *
 * One process for the whole conversation, fed over stdin with `--input-format stream-json`
 * (RESEARCH B1: ~4x faster per turn than respawning, and it avoids re-running every SessionStart
 * hook on every message).
 *
 * The environment is stripped, not inherited: `ANTHROPIC_BASE_URL` redirects the CLI at Headroom,
 * and when Obsidian itself was launched from inside a Claude Code session the whole
 * `CLAUDE*` / `ANTHROPIC*` / `AI_AGENT*` / `HEADROOM*` family leaks in. Phase 0 failed twice
 * before this was done (RESEARCH C).
 *
 * The process is not covered by `Component.register*` — the owner must call `stop()`.
 */
import { nodeChildProcess, nodeEnv, nodePath, type SpawnedProcess } from './node-api';
import { parseStreamJsonLine, type StreamJsonEvent } from './events';

/** Env names matching this are dropped before spawning (RESEARCH C, trap 2). */
const ENV_DENY_PATTERN = /^(CLAUDE|ANTHROPIC|AI_AGENT|HEADROOM)/i;

/** PATH floor for a GUI-launched Obsidian, which inherits almost nothing. */
const BASE_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];

const STDERR_BUFFER_LIMIT = 8000;
const SIGTERM_AFTER_MS = 2000;
const SIGKILL_AFTER_MS = 2000;

export interface ProcessExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** True when the exit was not requested by `stop()`. */
	unexpected: boolean;
	/** Tail of stderr, so a CLI that dies on startup is not silent. */
	stderr: string;
}

export interface ClaudeProcessCallbacks {
	onEvent(event: StreamJsonEvent): void;
	/** A stdout line that could not be parsed. Logged, never fatal. */
	onUnparsedLine?(line: string): void;
	onStderr?(chunk: string): void;
	/** `spawn` itself failed — wrong path, not executable, ENOENT. */
	onSpawnError(error: Error): void;
	onExit(info: ProcessExitInfo): void;
}

export interface ClaudeProcessOptions {
	binaryPath: string;
	cwd: string;
	/**
	 * Flags appended to the mandatory set. Phase 5 puts the permission bridge here —
	 * `--mcp-config`, `--permission-prompt-tool` — so this class keeps owning only the flags that
	 * are true of every run.
	 */
	extraArgs?: string[];
	callbacks: ClaudeProcessCallbacks;
}

export class ClaudeProcess {
	private child: SpawnedProcess | null = null;
	private stdoutRemainder = '';
	private stderrBuffer = '';
	private stopping = false;
	private exited = false;
	/** Set once stdin has failed. A broken pipe never heals, so no later write is attempted. */
	private stdinBroken = false;
	private timers: number[] = [];

	constructor(private readonly options: ClaudeProcessOptions) {}

	get alive(): boolean {
		return this.child !== null && !this.exited;
	}

	/**
	 * `--verbose` is mandatory: without it, `--print` plus `--output-format stream-json` exits 1
	 * with a one-line stderr (RESEARCH B0).
	 *
	 * `--include-partial-messages` is what adds the `stream_event` type — without it the reply
	 * arrives in one burst when each block completes (RESEARCH B3).
	 *
	 * There is deliberately **no `--permission-mode`**: default mode is what routes every tool call
	 * to the permission bridge, and `acceptEdits` auto-approves `Bash` while still prompting for
	 * `Read` (RESEARCH B5b). And no `--strict-mcp-config`, which would drop the user's own MCP
	 * servers. Both are absences, so both are recorded here rather than nowhere.
	 */
	private buildArgs(): string[] {
		return [
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			...(this.options.extraArgs ?? []),
		];
	}

	private async buildEnv(): Promise<Record<string, string>> {
		const path = await nodePath();
		const source = nodeEnv();
		const env: Record<string, string> = {};

		for (const [key, value] of Object.entries(source)) {
			if (value === undefined || ENV_DENY_PATTERN.test(key)) {
				continue;
			}
			env[key] = value;
		}

		// The binary is called by absolute path, but the CLI shells out to its own tools, so it
		// still needs a usable PATH — including the directory it was resolved from.
		const dirs = [path.dirname(this.options.binaryPath), ...BASE_PATH_DIRS];
		for (const dir of (source.PATH ?? '').split(':')) {
			if (dir.length > 0 && !dirs.includes(dir)) {
				dirs.push(dir);
			}
		}
		env.PATH = dirs.join(':');

		return env;
	}

	/** Async only because the Node modules are loaded through a guarded dynamic import. */
	async start(): Promise<void> {
		if (this.child) {
			return;
		}

		const { callbacks } = this.options;
		let child: SpawnedProcess;
		try {
			const childProcess = await nodeChildProcess();
			const env = await this.buildEnv();
			// No shell, ever: `claude` is a zsh function on this machine (RESEARCH C).
			child = childProcess.spawn(this.options.binaryPath, this.buildArgs(), {
				cwd: this.options.cwd,
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
			});
		} catch (error) {
			callbacks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		this.child = child;

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			this.stderrBuffer = (this.stderrBuffer + chunk).slice(-STDERR_BUFFER_LIMIT);
			callbacks.onStderr?.(chunk);
		});

		// 'error' fires for ENOENT/EACCES and never pairs with a useful exit code, so it is
		// reported on its own. Without this, a wrong binary path leaves the UI waiting forever.
		child.on('error', (error: Error) => {
			callbacks.onSpawnError(error);
		});

		/*
		 * stdin needs its own listener, and Phase 6 task 3 is what makes that reachable.
		 *
		 * An `'error'` event on a stream with no listener is re-thrown by Node, and this stream
		 * lives in Obsidian's renderer — an unhandled EPIPE here does not fail a turn, it takes the
		 * window's script context down with it. Until task 3 the largest line written was a typed
		 * message plus a few paths, kilobytes; a pasted image puts megabytes of base64 on one line,
		 * and a large enough one kills the CLI mid-write. Measured while probing the size ceiling
		 * (PHASE6-TASK3-STATE M1): a 309 MiB line ended the process and the writer died on EPIPE.
		 *
		 * Marking the process gone is what turns that into a legible failure: `write` then returns
		 * false and `SessionManager` fails the turn with a message, instead of the panel freezing.
		 */
		child.stdin.on('error', (error: Error) => {
			this.stdinBroken = true;
			callbacks.onStderr?.(`stdin write failed: ${error.message}\n`);
		});

		child.on('exit', (code, signal) => {
			this.exited = true;
			this.clearTimers();
			// Flush whatever was left without a trailing newline.
			const tail = this.stdoutRemainder;
			this.stdoutRemainder = '';
			if (tail.trim().length > 0) {
				this.handleLine(tail);
			}
			callbacks.onExit({
				code,
				signal,
				unexpected: !this.stopping,
				stderr: this.stderrBuffer,
			});
		});
	}

	/**
	 * Chunk boundaries are not line boundaries — the last fragment is kept until its newline
	 * arrives (PLAN Phase 2, task 3).
	 */
	private consumeStdout(chunk: string): void {
		const parts = (this.stdoutRemainder + chunk).split('\n');
		this.stdoutRemainder = parts.pop() ?? '';
		for (const line of parts) {
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		const event = parseStreamJsonLine(line);
		if (!event) {
			if (line.trim().length > 0) {
				this.options.callbacks.onUnparsedLine?.(line);
			}
			return;
		}
		this.options.callbacks.onEvent(event);
	}

	/**
	 * Writes one NDJSON line to stdin. Returns false when there is no live process to write to.
	 *
	 * The `try` is not decoration: `write` throws synchronously on an already-destroyed stream, and
	 * a throw out of here reaches the composer's click handler. Both this and the `'error'`
	 * listener installed at spawn exist for the same reason — see that comment.
	 */
	write(line: string): boolean {
		const child = this.child;
		if (!child || this.exited || this.stdinBroken || !child.stdin.writable) {
			return false;
		}
		try {
			child.stdin.write(line);
		} catch {
			this.stdinBroken = true;
			return false;
		}
		return true;
	}

	/**
	 * Gentle first: `stdin.end()` exits 0 cleanly (RESEARCH B1). SIGTERM after 2 s, SIGKILL 2 s
	 * after that. Callers must not await this on the Obsidian quit path longer than necessary.
	 */
	stop(): void {
		const child = this.child;
		if (!child || this.exited) {
			return;
		}
		this.stopping = true;

		try {
			child.stdin.end();
		} catch {
			// A broken pipe here just means the process is already going away.
		}

		this.timers.push(
			window.setTimeout(() => {
				if (!this.exited) {
					child.kill('SIGTERM');
				}
			}, SIGTERM_AFTER_MS),
		);
		this.timers.push(
			window.setTimeout(() => {
				if (!this.exited) {
					child.kill('SIGKILL');
				}
			}, SIGTERM_AFTER_MS + SIGKILL_AFTER_MS),
		);
	}

	private clearTimers(): void {
		for (const timer of this.timers) {
			window.clearTimeout(timer);
		}
		this.timers = [];
	}
}
