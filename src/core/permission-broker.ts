/**
 * The plugin half of the permission bridge (PLAN Phase 5, tasks 1–3, 5, 7, 8).
 *
 * The CLI is run with `--permission-prompt-tool mcp__guki-perm__permission_prompt`, so every tool
 * call it does not consider low-risk is routed to an MCP server of ours instead of being decided
 * inside the CLI. That server is `src/cli/mcp-permission-server.mjs`, and **the CLI spawns it**,
 * not us: `--mcp-config` with a stdio server means the CLI owns the process and both its pipes. So
 * the server's stdout is the MCP channel, and this class opens the only other channel there is —
 * a unix domain socket the server connects back to (PHASE5A-STATE D1).
 *
 *   Obsidian (this class) ── unix socket ── mcp-permission-server.mjs ── stdio ── claude CLI
 *
 * What it owns:
 * - a private temp directory holding the socket, the copied server script and `mcp.json`;
 * - the socket server, listening **before** the CLI is spawned;
 * - the pending requests, and the verdict that answers each one;
 * - killing the server on the way out, which needs a pid rather than a handle, because we never
 *   spawned it (PHASE5A-STATE D3).
 *
 * **Phase 5a's policy is deliberately trivial: ask for everything.** PLAN §2b's table and the Bash
 * whitelist are Phase 5b. The seam is intentional — the bridge and the policy engine are verified
 * separately, and the policy is the half that must not be written in a hurry.
 */
import type { App } from 'obsidian';
import { normalizePath } from 'obsidian';
import { resolveNodeBinary } from '../cli/binary-resolver';
import {
	nodeFs,
	nodeKill,
	nodeNet,
	nodeOs,
	nodePath,
	type NodeSocket,
	type NodeSocketServer,
} from '../cli/node-api';
import { MCP_SERVER_NAME, PERMISSION_PROMPT_TOOL, PERMISSION_SERVER_FILE, PLUGIN_ID } from '../constants';
import type { ChatState, PermissionItem } from './chat-state';

/** What the server sends us, and what we send back. NDJSON, one message per line. */
interface HelloMessage {
	type: 'hello';
	token?: string;
	pid?: number;
}

interface RequestMessage {
	type: 'request';
	id?: string;
	tool_name?: string;
	/** The tool's arguments, straight off the wire. `unknown`, and every read of it is guarded. */
	input?: unknown;
	tool_use_id?: string;
}

type ServerMessage = HelloMessage | RequestMessage | { type: string };

export type PermissionBehavior = 'allow' | 'deny';

interface PendingRequest {
	socket: NodeSocket;
	item: PermissionItem;
}

/**
 * The shared secret the server proves itself with over the socket.
 *
 * `crypto.randomUUID()` is only defined in a secure context. Obsidian's `app://` origin is one, but
 * that is a property of how Obsidian registers its scheme rather than something this plugin
 * controls — and if it were ever not, the broker would throw on startup and the panel would refuse
 * input over a missing convenience function. `getRandomValues` has no such requirement, so it is
 * the fallback: same entropy, no context condition.
 */
function randomToken(): string {
	if (typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PermissionBroker {
	private server: NodeSocketServer | null = null;
	private readonly sockets = new Set<NodeSocket>();
	/** Pids reported by an authenticated `hello`. The only pids `dispose` will ever signal. */
	private readonly serverPids = new Set<number>();
	private readonly pending = new Map<string, PendingRequest>();

	private tempDir: string | null = null;
	private socketPath: string | null = null;
	private configPath: string | null = null;
	private token: string | null = null;
	private startPromise: Promise<void> | null = null;
	private disposed = false;

	/**
	 * Fired with the `tool_use_id` of a call the bridge has put a card on screen for, and again
	 * when that call ends up denied or unanswered.
	 *
	 * The broker deliberately does not reach into the reducer itself — it knows about requests and
	 * verdicts, not about blocks and slots. `SessionManager` owns both and does the joining.
	 * Neither fires when the request carried no `tool_use_id`: without one there is nothing to
	 * join to, and guessing a block would put a badge on the wrong tool.
	 */
	onRequested: ((toolUseId: string) => void) | null = null;
	onDenied: ((toolUseId: string) => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly state: ChatState,
		/**
		 * `PluginManifest.dir` — the vault-relative path to this plugin's folder. Optional in the
		 * API, so it is optional here; `readServerSource` falls back to rebuilding it.
		 */
		private readonly pluginDir?: string,
	) {}

	/**
	 * Prepares everything the CLI needs and starts listening. Must complete **before** the CLI is
	 * spawned: the server connects to the socket before it answers `initialize`, and if the socket
	 * is not there yet it exits, which the startup self-check then reports as a missing server.
	 *
	 * Idempotent — concurrent callers share the one attempt, the same shape `SessionManager`
	 * already uses for the subprocess.
	 */
	start(): Promise<void> {
		if (this.startPromise) {
			return this.startPromise;
		}
		this.startPromise = this.startOnce();
		return this.startPromise;
	}

	private async startOnce(): Promise<void> {
		const fs = await nodeFs();
		const os = await nodeOs();
		const path = await nodePath();
		const net = await nodeNet();

		// Resolved first, because a missing node is the one failure worth reporting before any
		// files are written. It throws BinaryNotFoundError, which the caller renders.
		const node = await resolveNodeBinary();

		// A private directory under the OS temp dir, not under the vault: the vault is synced and
		// watched, and a socket file appearing in it would show up in Obsidian's own file explorer.
		// `mkdtemp` gives it a unique name and 0700 permissions, which is also what protects the
		// socket — the token is a second line, not the first.
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'guki-chat-perm-'));
		this.tempDir = dir;
		this.socketPath = path.join(dir, 'perm.sock');
		this.configPath = path.join(dir, 'mcp.json');
		this.token = randomToken();

		// The server script is read through Obsidian's own adapter rather than by rebuilding a
		// filesystem path: `manifest.dir` is vault-relative (obsidian.d.ts:4946) and the config
		// directory is not always `.obsidian`. Copied into the temp dir so everything the CLI
		// touches is in one place we own and can delete.
		const source = await this.readServerSource();
		const serverPath = path.join(dir, PERMISSION_SERVER_FILE);
		await fs.promises.writeFile(serverPath, source, 'utf8');

		// An **absolute** interpreter path. A bare `node` fails silently — the stdio server never
		// spawns and never appears in the tool list, with no error of its own (RESEARCH B5, trap 7).
		const config = {
			mcpServers: {
				[MCP_SERVER_NAME]: {
					command: node.path,
					args: [serverPath],
					env: {
						GUKI_PERM_SOCKET: this.socketPath,
						GUKI_PERM_TOKEN: this.token,
					},
				},
			},
		};
		await fs.promises.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');

		const server = net.createServer((socket) => {
			this.acceptSocket(socket);
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.socketPath, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		// After listen succeeds, an error is a runtime problem rather than a startup one. Logged
		// and swallowed: an unhandled 'error' on a net.Server is a hard crash in Node.
		server.on('error', (error: Error) => {
			console.warn('GuKi Chat: permission socket error', error);
		});
	}

	/**
	 * Reads the server script through Obsidian's own adapter rather than by rebuilding a filesystem
	 * path: `manifest.dir` is already vault-relative, which is what `DataAdapter.read` wants, and
	 * the config directory is not always `.obsidian`.
	 *
	 * The fallback exists because `manifest.dir` is optional in the API (obsidian.d.ts:4946). It
	 * hardcodes both the config dir and the plugin id, so it is strictly a guess — good enough to
	 * keep the panel working, not good enough to prefer.
	 */
	private async readServerSource(): Promise<string> {
		const pluginDir = this.pluginDir ?? `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
		return this.app.vault.adapter.read(normalizePath(`${pluginDir}/${PERMISSION_SERVER_FILE}`));
	}

	/** The flags the CLI is spawned with. Empty until `start()` has run. */
	get cliArgs(): string[] {
		if (this.configPath === null) {
			return [];
		}
		return [
			'--mcp-config',
			this.configPath,
			// No `--strict-mcp-config`: Emre's own MCP servers must survive (PLAN Phase 5 task 3).
			// No `--permission-mode` either — default mode is what routes every call to the bridge
			// (RESEARCH B5b: `acceptEdits` auto-approves Bash and bypasses the card entirely).
			'--permission-prompt-tool',
			PERMISSION_PROMPT_TOOL,
		];
	}

	// --- the socket ---------------------------------------------------------

	private acceptSocket(socket: NodeSocket): void {
		socket.setEncoding('utf8');
		this.sockets.add(socket);

		let authenticated = false;
		let buffer = '';

		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim().length === 0) {
					continue;
				}
				let message: ServerMessage;
				try {
					message = JSON.parse(line) as ServerMessage;
				} catch {
					console.warn('GuKi Chat: unparsable line from the permission server', line);
					continue;
				}

				if (!authenticated) {
					// Nothing is accepted before a `hello` carrying this session's token. The
					// directory is already 0700, so this is a second line rather than the first —
					// but it is also what makes a reported pid safe to signal on the way out.
					if (message.type !== 'hello' || (message as HelloMessage).token !== this.token) {
						console.warn('GuKi Chat: rejecting an unauthenticated permission socket');
						socket.destroy();
						return;
					}
					authenticated = true;
					const pid = (message as HelloMessage).pid;
					if (typeof pid === 'number') {
						this.serverPids.add(pid);
					}
					continue;
				}

				if (message.type === 'request') {
					this.handleRequest(socket, message as RequestMessage);
				}
			}
		});

		socket.on('error', (error: Error) => {
			console.warn('GuKi Chat: permission socket error', error);
		});

		socket.on('close', () => {
			this.sockets.delete(socket);
			// Requests this socket was holding can never be answered now. They are dropped rather
			// than left in `pending`, where a later decision would write to a dead socket.
			for (const [id, entry] of this.pending) {
				if (entry.socket === socket) {
					this.pending.delete(id);
					if (entry.item.status === 'pending') {
						entry.item.status = 'cancelled';
						if (entry.item.toolUseId !== undefined) {
							this.onDenied?.(entry.item.toolUseId);
						}
					}
				}
			}
			this.state.emitChange();
		});
	}

	/**
	 * Phase 5a's whole policy: **ask for everything**. Every request becomes a card.
	 *
	 * Phase 5b replaces this one line with PLAN §2b's table — an `allow` verdict answers here
	 * without a card and is logged, and only an `ask` verdict reaches `addPermissionRequest`.
	 */
	private handleRequest(socket: NodeSocket, message: RequestMessage): void {
		const id = message.id;
		if (typeof id !== 'string' || id.length === 0) {
			return;
		}
		const item = this.state.addPermissionRequest({
			requestId: id,
			toolName: typeof message.tool_name === 'string' ? message.tool_name : 'Unknown tool',
			input: message.input,
			toolUseId: typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined,
		});
		this.pending.set(id, { socket, item });
		if (item.toolUseId !== undefined) {
			this.onRequested?.(item.toolUseId);
		}
	}

	// --- verdicts -----------------------------------------------------------

	/** True while any card is waiting for the reader. */
	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	/**
	 * The reader answered. Sends the verdict back and closes the card.
	 *
	 * `allow` echoes the original input as `updatedInput`. The binary treats it as optional and
	 * falls back to the original when it is missing, but echoing it is the path Phase 0 proved, so
	 * that is the one taken (RESEARCH B5).
	 */
	decide(requestId: string, behavior: PermissionBehavior, message?: string): void {
		const entry = this.pending.get(requestId);
		if (!entry) {
			return;
		}
		this.pending.delete(requestId);
		entry.item.status = behavior === 'allow' ? 'allowed' : 'denied';
		if (behavior === 'deny' && entry.item.toolUseId !== undefined) {
			// So the tool card renders this as a decision rather than as a failure: the CLI is about
			// to report it as a `tool_result` with `is_error: true` and nothing on the wire says who
			// caused it.
			this.onDenied?.(entry.item.toolUseId);
		}

		this.send(entry.socket, {
			type: 'decision',
			id: requestId,
			behavior,
			updatedInput: behavior === 'allow' ? entry.item.input : undefined,
			message: behavior === 'deny' ? (message ?? 'Denied in Obsidian.') : undefined,
		});
		this.state.emitChange();
	}

	/**
	 * Answers every outstanding request as denied, because the turn they belong to has ended.
	 *
	 * The only real route here is Stop: the CLI cannot produce a `result` while it is waiting on
	 * the bridge. Leaving the request unanswered would strand the server holding a JSON-RPC id it
	 * can never reply to. The card is marked `cancelled`, not `denied` — the reader did not deny
	 * anything, and it must not read as a decision they made (PHASE5A-STATE D5).
	 */
	cancelPending(reason: string): void {
		if (this.pending.size === 0) {
			return;
		}
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			entry.item.status = 'cancelled';
			this.send(entry.socket, { type: 'decision', id, behavior: 'deny', message: reason });
			if (entry.item.toolUseId !== undefined) {
				// Same reasoning as `decide`: the CLI will report this as a failed tool, and it was
				// not one. The reader did not even get to answer.
				this.onDenied?.(entry.item.toolUseId);
			}
		}
		this.state.emitChange();
	}

	private send(socket: NodeSocket, message: Record<string, unknown>): void {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch (error) {
			// A dead socket means the server is gone; the card is already closed either way.
			console.warn('GuKi Chat: could not answer the permission server', error);
		}
	}

	// --- lifecycle ----------------------------------------------------------

	/**
	 * `onunload` and `workspace.on('quit')` both land here — architectural rule #6, and the second
	 * of the two processes that trap 9 is about. Safe to call twice.
	 *
	 * Three mechanisms, because the server is not ours to `.kill()`: telling it to shut down,
	 * closing the socket it exits on, and a `SIGTERM` to the pid it reported. Synchronous
	 * throughout — Obsidian's quit path does not wait for promises.
	 */
	dispose(): void {
		this.disposed = true;
		this.pending.clear();

		for (const socket of this.sockets) {
			this.send(socket, { type: 'shutdown' });
			socket.destroy();
		}
		this.sockets.clear();

		for (const pid of this.serverPids) {
			// Only pids that arrived on a socket authenticated with this session's token.
			nodeKill(pid, 'SIGTERM');
		}
		this.serverPids.clear();

		try {
			this.server?.close();
		} catch (error) {
			console.warn('GuKi Chat: could not close the permission socket', error);
		}
		this.server = null;

		// Best effort, and deliberately not awaited: the temp directory holds a socket file, the
		// copied server and mcp.json, all of which the OS reclaims anyway.
		const dir = this.tempDir;
		this.tempDir = null;
		if (dir !== null) {
			void nodeFs()
				.then((fs) => fs.promises.rm(dir, { recursive: true, force: true }))
				.catch(() => undefined);
		}
	}

	/** Exposed for the offline checks and for diagnosis; never used to make a decision. */
	get isDisposed(): boolean {
		return this.disposed;
	}
}
