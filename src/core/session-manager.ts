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
import {
	interruptRequestLine,
	mcpServerStatus,
	userMessageLine,
	type StreamJsonEvent,
	type SystemInitEvent,
} from '../cli/events';
import { CLAUDE_BINARY_OVERRIDE, FALLBACK_VAULT_PATH, MCP_SERVER_NAME } from '../constants';
import {
	composeMessage,
	imageAttachments,
	type Attachment,
	type ImageAttachment,
} from './attachments';
import { ChatState, type AssistantItem } from './chat-state';
import { PermissionBroker, type PermissionBehavior } from './permission-broker';
import type { VaultPaths } from './permission-policy';
import { StreamReducer } from './stream-reducer';
import { createVaultPaths } from './vault-path-resolver';

/** The one status that means the approval gate is really there (PHASE5A-STATE F1). */
const MCP_CONNECTED = 'connected';

interface QueuedTurn {
	text: string;
	/** The `image` content blocks this turn carries. Empty for every turn that is not an image. */
	images: readonly ImageAttachment[];
	item: AssistantItem;
	/** Set by `interrupt` when Stop is pressed before this turn ever reached the CLI. */
	cancelled?: boolean;
}

export class SessionManager {
	readonly state = new ChatState();
	private readonly reducer = new StreamReducer(this.state);
	private readonly broker: PermissionBroker;
	private process: ClaudeProcess | null = null;
	private startPromise: Promise<boolean> | null = null;
	private readonly queue: QueuedTurn[] = [];
	private disposed = false;
	private interruptCount = 0;
	private vaultPathsPromise: Promise<VaultPaths> | null = null;

	/**
	 * Set when the panel must stop accepting input, with the reason shown in the composer.
	 *
	 * There is exactly one thing that sets it: the startup self-check finding that the permission
	 * server is not connected. A CLI running with no approval gate must never be usable, and the
	 * refusal has to be visible rather than a silently degraded mode (PLAN Phase 5 task 9).
	 */
	private blockedReason: string | null = null;

	constructor(
		private readonly app: App,
		/** `PluginManifest.dir`, passed straight through to the broker. Optional in the API. */
		pluginDir?: string,
	) {
		// The vault root is handed over explicitly: it is the boundary PLAN §2b's whole table is
		// written against, and it must be the *same* string the CLI is given as its cwd.
		this.broker = new PermissionBroker(app, this.state, this.vaultPath, pluginDir);
		// The broker knows requests and verdicts; the reducer knows blocks. Joining them here is
		// what keeps a denial from painting the tool card red — the wire reports our own denial as
		// `is_error: true`, indistinguishable from a tool that really failed.
		this.broker.onRequested = (toolUseId: string) => {
			this.reducer.notePermissionRequested(toolUseId);
		};
		this.broker.onDenied = (toolUseId: string) => {
			this.reducer.notePermissionDenied(toolUseId);
		};
		// Nothing drained the queue when a turn *ended* — `pump` was only ever reached from
		// `send`, so a message typed while the previous one was still streaming stayed queued
		// forever. Latent since Phase 2; Phase 3 makes overlapping turns easy to hit.
		this.reducer.onTurnEnd = () => {
			// Still here as the backstop, though `interrupt` now settles the common case earlier: a
			// turn can also end under an open request without a Stop — the process dying, or the
			// CLI abandoning the call itself. Whatever the route, the server must not be left
			// holding a JSON-RPC id it can never reply to (PHASE5A-STATE D5). Idempotent.
			this.broker.cancelPending('The turn ended before the request was answered.');
			void this.pump();
		};

		this.reducer.onInit = (event: SystemInitEvent) => {
			this.checkPermissionServer(event);
		};

		this.reducer.onQuotaWarning = (warning) => {
			this.state.setQuotaWarning(warning);
		};
	}

	/** Non-null when input is refused. The composer shows it and disables itself. */
	get blocked(): string | null {
		return this.blockedReason;
	}

	/** Called by the permission card. `requestId` comes off the `PermissionItem`. */
	decidePermission(requestId: string, behavior: PermissionBehavior): void {
		this.broker.decide(
			requestId,
			behavior,
			behavior === 'deny' ? 'The user denied this tool call in Obsidian.' : undefined,
		);
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

	/**
	 * The vault boundary, for the attachment checks the view makes before a chip exists.
	 *
	 * Memoised, and built from `this.vaultPath` — the *same* string the broker is handed and the
	 * CLI is spawned with. That single source is what the broker's own comment is about; two
	 * `VaultPaths` objects over one root string cannot drift, whereas two derivations of the root
	 * could. It is not taken from the broker because the broker only builds its copy inside
	 * `start()`, which also spawns the permission server — attaching a chip must not do that.
	 */
	vaultPaths(): Promise<VaultPaths> {
		this.vaultPathsPromise ??= createVaultPaths(this.vaultPath);
		return this.vaultPathsPromise;
	}

	/**
	 * Enqueues a message. Returns immediately; the UI follows `ChatState`.
	 *
	 * File attachments become path references in the text (`composeMessage`) rather than a separate
	 * field on the wire: they hold a path, not bytes, so there is nothing to send but the prompt.
	 * The composed message is what goes into `ChatState` too — the panel shows what was actually
	 * sent, including the `@` references, rather than hiding the mechanism that skips the
	 * permission gate.
	 *
	 * A pasted **image** is the exception and travels as its own `image` block, so it contributes
	 * nothing to `message`. **That is why the emptiness test below is not `message.length === 0`.**
	 * An image with no typed text composes to the empty string, and the old test returned here on
	 * it: the composer cleared, no bubble appeared, no error was reported, and the message was
	 * simply gone. `hasSendableContent` already said such a message was sendable, so the composer
	 * happily let Send be pressed — the two disagreed, and this one was the liar.
	 */
	send(text: string, attachments: readonly Attachment[] = []): void {
		const message = composeMessage(text, attachments);
		const images = imageAttachments(attachments);
		if ((message.length === 0 && images.length === 0) || this.disposed || this.blockedReason !== null) {
			return;
		}

		this.state.addUserMessage(message, images);
		const item = this.state.addAssistantMessage();
		this.queue.push({ text: message, images, item });
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
		// Answered here, not only from `onTurnEnd`. Stop means "do not do that", so the request the
		// reader is looking at is settled the moment they press it — and settling it *now* is also
		// what puts the id in the reducer before the CLI's synthetic `tool_result` arrives. Left to
		// `onTurnEnd`, that result lands first (1 ms earlier, in `docs/capture-phase5a-stop.jsonl`)
		// and the card is already painted red by the time anyone knows the call was cancelled.
		this.broker.cancelPending('The turn was stopped before the request was answered.');
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
			// The blocked reason, when there is one, is the truthful message: `ensureProcess` also
			// fails when the *permission server* could not be started, and saying the CLI was the
			// problem would send the reader looking in the wrong place.
			next.item.errorText ??= this.blockedReason ?? 'The Claude Code CLI could not be started.';
			this.state.emitChange();
			return;
		}

		this.queue.shift();
		this.reducer.beginTurn(next.item);
		const written = this.process?.write(userMessageLine(next.text, next.images)) ?? false;
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

		// Strictly before the spawn: the permission server connects to the broker's socket before
		// it answers `initialize`, and a socket that is not listening yet means the server exits and
		// never registers. Starting the CLI without the gate ready is the failure this ordering
		// exists to prevent.
		try {
			await this.broker.start();
		} catch (error) {
			const detail =
				error instanceof BinaryNotFoundError
					? `Looked at: ${error.attempts.join(', ')}`
					: error instanceof Error
						? error.message
						: String(error);
			this.blockInput('The approval gate could not be started, so the chat is disabled.');
			this.state.addNotice('error', 'The permission server could not be started.', detail);
			return false;
		}

		const claude = new ClaudeProcess({
			binaryPath,
			cwd: this.vaultPath,
			extraArgs: this.broker.cliArgs,
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

	/**
	 * The startup self-check (PLAN Phase 5 task 9).
	 *
	 * A stdio MCP server that fails to spawn produces no error of its own — it simply never appears
	 * in the list (RESEARCH B5, trap 7). So the only evidence that the approval gate exists is its
	 * entry in `system/init.mcp_servers`, and its absence has to be treated as loudly as a crash:
	 * a missing permission server means the CLI is running with no gate at all.
	 *
	 * Run on every init, not only the first, because init arrives at the start of every turn
	 * (RESEARCH B1) and a server that dies mid-session is the same danger as one that never started.
	 */
	private checkPermissionServer(event: SystemInitEvent): void {
		const status = mcpServerStatus(event, MCP_SERVER_NAME);
		if (status === MCP_CONNECTED) {
			return;
		}
		if (this.blockedReason !== null) {
			// Already reported. Later turns must not stack another notice on the same fault.
			return;
		}

		const detail =
			status === null
				? `'${MCP_SERVER_NAME}' is not in system/init.mcp_servers. A stdio MCP server that fails to start is never reported by the CLI.`
				: `'${MCP_SERVER_NAME}' reported status '${status}', not '${MCP_CONNECTED}'.`;

		this.blockInput('The approval gate is not running, so the chat is disabled.');
		this.queue.length = 0;
		this.reducer.failActiveTurn(
			'The permission server is not connected, so this turn was stopped before any tool could run.',
		);
		this.state.addNotice(
			'error',
			'The permission server did not register. Reload the plugin, or restart Obsidian, before using the chat.',
			detail,
		);
	}

	private blockInput(reason: string): void {
		this.blockedReason = reason;
		this.state.emitChange();
	}

	/**
	 * `onunload` and `workspace.on('quit')` both land here. Safe to call twice.
	 *
	 * **Two processes, not one** (trap 9): the CLI, and the MCP permission server the CLI spawned.
	 * The broker owns the second one's teardown because we have no handle on it — see its `dispose`.
	 */
	dispose(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.process?.stop();
		this.process = null;
		this.broker.dispose();
	}
}
