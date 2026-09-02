/*
 * The permission bridge's other half: a minimal MCP stdio server exposing one tool,
 * `permission_prompt`, which the CLI calls through `--permission-prompt-tool`.
 *
 * This file is **not bundled**. esbuild copies it next to `main.js`, the plugin copies it into a
 * private temp directory, and the CLI — not the plugin — spawns it, because `--mcp-config` with a
 * stdio server means the CLI owns the process and both its pipes. Its stdout is therefore the MCP
 * channel and nothing else may be written there; a stray `console.log` corrupts the JSON-RPC
 * stream. Diagnostics go to stderr, which the CLI ignores.
 *
 * Two channels, then:
 *
 *   stdin/stdout  ← JSON-RPC 2.0, line delimited → the claude CLI
 *   unix socket   ← NDJSON                       → the Obsidian plugin (permission-broker.ts)
 *
 * The socket is connected **before** `initialize` is answered. If the plugin is not listening we
 * exit immediately, so the server never registers and the plugin's startup self-check reports it.
 * The alternative — starting anyway — would report `connected` to the CLI and then silently deny
 * every tool call, which is exactly the "no approval gate, quietly" state PLAN task 9 forbids.
 *
 * Written against `docs/permserver-spike.mjs`, which proved the transport and the contract end to
 * end in Phase 0 (RESEARCH B5). The wire shapes here are that spike's, not new inventions.
 */
import net from 'node:net';

const SOCKET_PATH = process.env.GUKI_PERM_SOCKET;
const TOKEN = process.env.GUKI_PERM_TOKEN;

/** stderr only — stdout belongs to the CLI. */
function warn(message) {
	process.stderr.write(`guki-perm: ${message}\n`);
}

function fatal(message) {
	warn(message);
	process.exit(1);
}

if (!SOCKET_PATH || !TOKEN) {
	fatal('GUKI_PERM_SOCKET and GUKI_PERM_TOKEN must both be set.');
}

// --- the plugin channel ----------------------------------------------------

/** JSON-RPC id of every `tools/call` still waiting for the user, keyed by our own request id. */
const pending = new Map();
let nextRequestId = 0;

const socket = net.createConnection(SOCKET_PATH);
socket.setEncoding('utf8');

let socketReady = false;
let socketBuffer = '';

socket.on('error', (error) => {
	// Before the handshake this is "the plugin is not there" and it is fatal (see the file header).
	// After it, the plugin has gone away — there is nobody left to ask, so exiting is the only
	// honest answer. Either way the CLI notices its MCP server is gone.
	fatal(`socket error: ${error.message}`);
});

socket.on('close', () => {
	// Obsidian quit, or the plugin was unloaded. This is the mechanism that makes the server die
	// with the app; the plugin's SIGTERM is only a backstop.
	process.exit(0);
});

socket.on('connect', () => {
	socketReady = true;
	sendToPlugin({ type: 'hello', token: TOKEN, pid: process.pid });
});

socket.on('data', (chunk) => {
	socketBuffer += chunk;
	const lines = socketBuffer.split('\n');
	socketBuffer = lines.pop() ?? '';
	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			warn(`unparsable line from the plugin: ${line.slice(0, 200)}`);
			continue;
		}
		handlePluginMessage(message);
	}
});

function sendToPlugin(message) {
	socket.write(`${JSON.stringify(message)}\n`);
}

function handlePluginMessage(message) {
	if (message?.type === 'shutdown') {
		process.exit(0);
	}
	if (message?.type !== 'decision') {
		return;
	}
	const rpcId = pending.get(message.id);
	if (rpcId === undefined) {
		// A decision for a request we already answered, or one from a previous process. Dropping it
		// is correct: answering the same JSON-RPC id twice is worse than ignoring a late reply.
		return;
	}
	pending.delete(message.id);

	// The contract, verbatim from the binary's own strings (RESEARCH B5):
	//   {behavior: 'allow', updatedInput?: object} | {behavior: 'deny', message: string}
	const payload =
		message.behavior === 'allow'
			? { behavior: 'allow', updatedInput: message.updatedInput }
			: { behavior: 'deny', message: message.message ?? 'Denied in Obsidian.' };

	sendRpc({
		jsonrpc: '2.0',
		id: rpcId,
		result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
	});
}

// --- the CLI channel -------------------------------------------------------

const TOOL_DEFINITION = {
	name: 'permission_prompt',
	description: 'Ask the user in Obsidian to approve or deny a tool call.',
	// Declared exactly as the Phase 0 spike declared it, because that is the schema the CLI was
	// proven against. `permission_suggestions` is part of it and is **never sent** (RESEARCH B5) —
	// it is kept only so the schema is not a new, unverified one.
	inputSchema: {
		type: 'object',
		properties: {
			tool_name: { type: 'string' },
			input: { type: 'object' },
			tool_use_id: { type: 'string' },
			permission_suggestions: { type: 'array' },
		},
	},
};

function sendRpc(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	stdinBuffer += chunk;
	const lines = stdinBuffer.split('\n');
	stdinBuffer = lines.pop() ?? '';
	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		handleRpc(message);
	}
});

process.stdin.on('end', () => {
	// The CLI exited. Nothing left to serve.
	process.exit(0);
});

function handleRpc(message) {
	const { method, id } = message;

	if (method === 'initialize') {
		sendRpc({
			jsonrpc: '2.0',
			id,
			result: {
				// Echo the version the client asked for, as the spike did — negotiating a version
				// down is the client's job, not ours.
				protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'guki-perm', version: '1.0.0' },
			},
		});
		return;
	}

	if (method === 'tools/list') {
		sendRpc({ jsonrpc: '2.0', id, result: { tools: [TOOL_DEFINITION] } });
		return;
	}

	if (method === 'tools/call') {
		handlePermissionRequest(message);
		return;
	}

	// Notifications (`notifications/initialized`) carry no id and want no reply. Anything else with
	// an id gets an empty result rather than an error: an unimplemented method must not look like a
	// broken server.
	if (method !== undefined && id !== undefined) {
		sendRpc({ jsonrpc: '2.0', id, result: {} });
	}
}

/**
 * Holds the JSON-RPC id and asks the plugin. **No timeout**: the reply comes back whenever the user
 * answers, and Stop is what ends a turn nobody wants to answer (PLAN task 7). If the plugin goes
 * away first, the socket closes and this process exits, which the CLI sees.
 */
function handlePermissionRequest(message) {
	const id = message.id;
	const args = message.params?.arguments ?? {};

	if (!socketReady) {
		// Cannot ask, so cannot allow. Fail closed, and say why in the message the model sees.
		sendRpc({
			jsonrpc: '2.0',
			id,
			result: {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							behavior: 'deny',
							message: 'The Obsidian panel is not reachable, so the request could not be shown.',
						}),
					},
				],
			},
		});
		return;
	}

	nextRequestId += 1;
	const requestId = `${String(process.pid)}-${String(nextRequestId)}`;
	pending.set(requestId, id);

	sendToPlugin({
		type: 'request',
		id: requestId,
		// Passed through untouched. The plugin decides what is renderable; this process only
		// carries the message (RESEARCH B5 F2: three fields arrive, and only three).
		tool_name: args.tool_name,
		input: args.input,
		tool_use_id: args.tool_use_id,
	});
}
