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
import { interruptRequestLine, userMessageLine, type StreamJsonEvent } from '../cli/events';
import { CLAUDE_BINARY_OVERRIDE, FALLBACK_VAULT_PATH } from '../constants';
import { ChatState, type AssistantItem } from './chat-state';
import { StreamReducer } from './stream-reducer';

interface QueuedTurn {
	text: string;
	item: AssistantItem;
	/** Set by `interrupt` when Stop is pressed before this turn ever reached the CLI. */
	cancelled?: boolean;
}

export class SessionManager {
	readonly state = new ChatState();
	private readonly reducer = new StreamReducer(this.state);
	private process: ClaudeProcess | null = null;
	private startPromise: Promise<boolean> | null = null;
	private readonly queue: QueuedTurn[] = [];
	private disposed = false;
	private interruptCount = 0;

	constructor(private readonly app: App) {
		// Nothing drained the queue when a turn *ended* — `pump` was only ever reached from
		// `send`, so a message typed while the previous one was still streaming stayed queued
		// forever. Latent since Phase 2; Phase 3 makes overlapping turns easy to hit.
		this.reducer.onTurnEnd = () => {
			void this.pump();
		};
	}

	/** True while a turn is in flight or waiting. Drives the composer's Send/Stop swap. */
	get busy(): boolean {
		return this.reducer.hasActiveTurn() || this.queue.length > 0;
	}

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

	/**
	 * Stops the turn in flight. The subprocess survives and the next turn is normal (RESEARCH B4);
	 * the CLI answers in about 2 ms and closes the turn with `terminal_reason:"aborted_streaming"`,
	 * which the reducer renders as "stopped" rather than an error.
	 *
	 * A message the user queued behind this one is still a message they asked for, so the queue is
	 * left alone — `onTurnEnd` sends it as soon as the aborted result lands.
	 *
	 * Before the turn begins there is nothing to interrupt but there is something to cancel: the
	 * composer shows Stop from the moment anything is queued, and on the first message the six-step
	 * binary resolution runs before the turn starts. Returning early there left the button reading
	 * "Stop" and doing nothing for that whole window.
	 */
	interrupt(): void {
		if (this.disposed) {
			return;
		}
		if (!this.reducer.hasActiveTurn()) {
			this.cancelQueuedTurns();
			return;
		}
		this.interruptCount += 1;
		const sent = this.process?.write(interruptRequestLine(`guki-int-${String(this.interruptCount)}`)) ?? false;
		if (sent) {
			// The reducer cannot tell a cancellation from a failure by the result event alone: a
			// Stop pressed while a tool call is pending comes back as `error_during_execution` with
			// no `terminal_reason`. Telling it that we asked for this is what keeps it "stopped".
			this.reducer.noteInterruptSent();
		} else {
			// No live process to interrupt: the turn is already dead, so say so instead of
			// leaving the panel on a Stop button that does nothing.
			this.reducer.failActiveTurn('The turn could not be stopped: the process is gone.');
		}
	}

	/**
	 * Drops every turn that has not been handed to the CLI yet and shows each as stopped.
	 *
	 * The flag matters as much as the removal: a `pump` already suspended on `ensureProcess` holds
	 * its own reference to the head of the queue and would otherwise send the message after the
	 * user cancelled it.
	 */
	private cancelQueuedTurns(): void {
		if (this.queue.length === 0) {
			return;
		}
		for (const turn of this.queue.splice(0, this.queue.length)) {
			turn.cancelled = true;
			turn.item.status = 'stopped';
		}
		this.state.emitChange();
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
		// Binary resolution takes seconds on the first message. Stop, dispose and a second pump can
		// all land inside that window, so the head of the queue is re-checked rather than trusted.
		if (this.disposed || next.cancelled === true || this.queue[0] !== next) {
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
		// Cleared first: `failActiveTurn` pumps the queue, and pumping it here would just try to
		// spawn the same unusable binary again.
		this.queue.length = 0;
		this.reducer.failActiveTurn(`The Claude Code CLI could not be started: ${error.message}`);
		this.state.addNotice('error', 'The Claude Code CLI could not be started.', error.message);
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
		// Same ordering rule as `handleSpawnError`: the queue goes before the turn is failed, so
		// the pump that `failActiveTurn` triggers finds nothing to restart the process for.
		this.queue.length = 0;
		const failed = this.reducer.failActiveTurn(`The Claude Code process stopped (${how}).`);
		this.state.addNotice(
			'error',
			failed
				? 'The Claude Code process stopped mid-turn. The next message starts a new conversation.'
				: 'The Claude Code process stopped. The next message starts a new conversation.',
			info.stderr.trim().length > 0 ? info.stderr.trim() : how,
		);
	}

	/** `onunload` and `workspace.on('quit')` both land here. Safe to call twice. */
	dispose(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.process?.stop();
		this.process = null;
	}
}
