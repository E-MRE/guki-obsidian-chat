/**
 * Owns the conversation: one persistent subprocess, one turn at a time.
 *
 * Lives on the plugin, not on the view, so the process survives the panel being closed and
 * reopened. Nothing here renders; it drives `ChatState` through `StreamReducer`.
 *
 * Cleanup is manual — `Component.register*` does not cover a subprocess (RESEARCH C).
 */
import { App, FileSystemAdapter } from 'obsidian';
import { BinaryNotFoundError, resolveClaudeBinary } from '../cli/binary-resolver';
import { ClaudeProcess, type ProcessExitInfo } from '../cli/claude-process';
import { userMessageLine, type StreamJsonEvent } from '../cli/events';
import { CLAUDE_BINARY_OVERRIDE, FALLBACK_VAULT_PATH } from '../constants';
import { ChatState, type AssistantItem } from './chat-state';
import { StreamReducer } from './stream-reducer';

interface QueuedTurn {
	text: string;
	item: AssistantItem;
}

export class SessionManager {
	readonly state = new ChatState();
	private readonly reducer = new StreamReducer(this.state);
	private process: ClaudeProcess | null = null;
	private startPromise: Promise<boolean> | null = null;
	private readonly queue: QueuedTurn[] = [];
	private disposed = false;

	constructor(private readonly app: App) {}

	/**
	 * The vault root, for `spawn`'s `cwd`. Checked with `instanceof` rather than cast: a cast that
	 * silently succeeds on a non-file adapter is exactly the class of bug Phase 1 kept producing.
	 */
	private get vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		return FALLBACK_VAULT_PATH;
	}

	/** Enqueues a message. Returns immediately; the UI follows `ChatState`. */
	send(text: string): void {
		const trimmed = text.trim();
		if (trimmed.length === 0 || this.disposed) {
			return;
		}

		this.state.addUserMessage(trimmed);
		const item = this.state.addAssistantMessage();
		this.queue.push({ text: trimmed, item });
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.disposed || this.reducer.hasActiveTurn()) {
			return;
		}
		const next = this.queue[0];
		if (!next) {
			return;
		}

		const ready = await this.ensureProcess();
		if (this.disposed) {
			return;
		}
		if (!ready) {
			// ensureProcess already reported why; drop the queued turns instead of hanging.
			this.queue.length = 0;
			next.item.status = 'error';
			next.item.errorText ??= 'The Claude Code CLI could not be started.';
			this.state.emitChange();
			return;
		}

		this.queue.shift();
		this.reducer.beginTurn(next.item);
		const written = this.process?.write(userMessageLine(next.text)) ?? false;
		if (!written) {
			this.reducer.failActiveTurn('The message could not be written to the CLI: the process is gone.');
			this.state.addNotice('error', 'The Claude Code process is not running.');
		}
	}

	/** Resolves the binary and starts the process once; concurrent callers share the attempt. */
	private ensureProcess(): Promise<boolean> {
		if (this.process?.alive) {
			return Promise.resolve(true);
		}
		this.startPromise ??= this.startProcess().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async startProcess(): Promise<boolean> {
		let binaryPath: string;
		try {
			const resolution = await resolveClaudeBinary(CLAUDE_BINARY_OVERRIDE);
			binaryPath = resolution.path;
			console.debug(`GuKi Chat: using claude at ${resolution.path} (${resolution.source})`);
		} catch (error) {
			if (error instanceof BinaryNotFoundError) {
				this.state.addNotice(
					'error',
					'Could not find the Claude Code CLI.',
					`Looked at: ${error.attempts.join(', ')}`,
				);
			} else {
				this.state.addNotice(
					'error',
					'Could not find the Claude Code CLI.',
					error instanceof Error ? error.message : String(error),
				);
			}
			return false;
		}

		const claude = new ClaudeProcess({
			binaryPath,
			cwd: this.vaultPath,
			callbacks: {
				onEvent: (event: StreamJsonEvent) => this.reducer.apply(event),
				onUnparsedLine: (line: string) => {
					console.warn('GuKi Chat: unparsable stdout line', line);
				},
				onStderr: (chunk: string) => {
					console.warn('GuKi Chat: claude stderr', chunk);
				},
				onSpawnError: (error: Error) => this.handleSpawnError(error),
				onExit: (info: ProcessExitInfo) => this.handleExit(info),
			},
		});
		this.process = claude;
		await claude.start();
		return claude.alive;
	}

	/**
	 * A wrong path or a non-executable file surfaces here, not through 'exit'. Reporting it is what
	 * keeps the panel from waiting on a process that never existed.
	 */
	private handleSpawnError(error: Error): void {
		if (this.disposed) {
			return;
		}
		this.reducer.failActiveTurn(`The Claude Code CLI could not be started: ${error.message}`);
		this.state.addNotice('error', 'The Claude Code CLI could not be started.', error.message);
		this.queue.length = 0;
	}

	/**
	 * An unexpected exit is the local twin of the silent MCP server trap: without this the CLI can
	 * die in its first second and the panel would show nothing at all. stderr is what usually says
	 * why, so it is shown.
	 */
	private handleExit(info: ProcessExitInfo): void {
		this.process = null;
		if (this.disposed || !info.unexpected) {
			return;
		}

		const how = info.signal !== null ? `signal ${info.signal}` : `exit code ${String(info.code)}`;
		const failed = this.reducer.failActiveTurn(`The Claude Code process stopped (${how}).`);
		this.state.addNotice(
			'error',
			failed
				? 'The Claude Code process stopped mid-turn. The next message starts a new conversation.'
				: 'The Claude Code process stopped. The next message starts a new conversation.',
			info.stderr.trim().length > 0 ? info.stderr.trim() : how,
		);
		this.queue.length = 0;
	}

	/** `onunload` and `workspace.on('quit')` both land here. Safe to call twice. */
	dispose(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.process?.stop();
		this.process = null;
	}
}
