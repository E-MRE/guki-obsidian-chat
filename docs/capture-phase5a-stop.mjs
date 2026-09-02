/*
 * Captures a REAL "Stop pressed while a permission card is open" turn, end to end.
 *
 * Written for Emre's Phase 5a acceptance round 2, finding 3: the tool card kept showing a red
 * "Error" for a call the user had cancelled. §L's tests did not reproduce it because they answered
 * the broker directly instead of replaying a real CLI interrupt sequence — so this script exists to
 * produce that sequence once, as raw output, and `docs/capture-phase5a-stop.jsonl` is the fixture
 * the offline checks replay from then on.
 *
 * It plays the plugin exactly as the plugin behaves, including the timing that matters:
 *   1. spawns the real CLI with the real flags and the real permission server;
 *   2. sends a message that makes the model call `Write`;
 *   3. when the bridge asks, **does not answer** — this is the card sitting open;
 *   4. sends the same `control_request` interrupt `SessionManager.interrupt()` sends;
 *   5. answers the still-open request with a deny only **after** the `result` event, which is when
 *      `reducer.onTurnEnd` → `broker.cancelPending()` fires today.
 *
 * Every stdout line is written to the jsonl with a `_t` millisecond offset prepended, and the
 * socket traffic is written as `_guki` records in the same file, so the interleaving of the CLI's
 * events and our own decisions is preserved. That interleaving is the whole point: reading it is
 * what shows where the synthetic `tool_result` lands relative to `result`.
 *
 *   node docs/capture-phase5a-stop.mjs
 *
 * Costs one real API call. Raw captures live in `docs/`, never in a scratchpad — a scratchpad went
 * with its session once already and the phase had to pay for the same turn twice.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, copyFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(DOCS);
const VAULT = '/Users/you/Documents/YourVault';
const CLAUDE = '/Users/you/.local/bin/claude';
const OUT = join(DOCS, 'capture-phase5a-stop.jsonl');

/** Wait this long after the bridge asks before pressing Stop — long enough to be a real pause. */
const STOP_AFTER_MS = 1200;

const dir = mkdtempSync(join(tmpdir(), 'guki-stopcap-'));
const sockPath = join(dir, 'perm.sock');
const serverPath = join(dir, 'mcp-permission-server.mjs');
copyFileSync(join(REPO, 'src/cli/mcp-permission-server.mjs'), serverPath);
writeFileSync(
  join(dir, 'mcp.json'),
  JSON.stringify(
    {
      mcpServers: {
        'guki-perm': {
          command: '/opt/homebrew/bin/node',
          args: [serverPath],
          env: { GUKI_PERM_SOCKET: sockPath, GUKI_PERM_TOKEN: 'capture-token' },
        },
      },
    },
    null,
    2,
  ),
);

const out = createWriteStream(OUT);
const t0 = Date.now();
const record = (obj) => out.write(JSON.stringify({ _t: Date.now() - t0, ...obj }) + '\n');

/** The socket the permission server calls back on — this script standing in for PermissionBroker. */
let permSocket = null;
let pendingRequestId = null;
let interruptSent = false;
let resultSeen = false;

const sockServer = createServer((connection) => {
  permSocket = connection;
  connection.setEncoding('utf8');
  let buf = '';
  connection.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(String.fromCharCode(10));
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      record({ _guki: 'socket-in', msg });
      if (msg.type === 'request') {
        // The card is now on screen and nobody is answering it. This is the state under test.
        pendingRequestId = msg.id;
        console.log(`[${Date.now() - t0}ms] bridge asked for ${msg.tool_name} (${msg.tool_use_id})`);
        setTimeout(pressStop, STOP_AFTER_MS);
      }
    }
  });
});
await new Promise((r) => sockServer.listen(sockPath, r));

// The same env scrubbing `claude-process.ts` does (RESEARCH C, trap 2).
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !/^(CLAUDE|ANTHROPIC|AI_AGENT|HEADROOM)/i.test(k)) env[k] = v;
}
env.PATH = '/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const child = spawn(
  CLAUDE,
  [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    join(dir, 'mcp.json'),
    '--permission-prompt-tool',
    'mcp__guki-perm__permission_prompt',
  ],
  { cwd: VAULT, env, stdio: ['pipe', 'pipe', 'pipe'] },
);

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

function pressStop() {
  if (interruptSent) return;
  interruptSent = true;
  console.log(`[${Date.now() - t0}ms] STOP`);
  const payload = { type: 'control_request', request_id: 'guki-int-1', request: { subtype: 'interrupt' } };
  record({ _guki: 'stdin', payload });
  send(payload);
}

/** What `broker.cancelPending()` does — and, today, only after `result` has already been handled. */
function cancelPending(reason) {
  if (!pendingRequestId || !permSocket) return;
  const payload = { type: 'decision', id: pendingRequestId, behavior: 'deny', message: reason };
  pendingRequestId = null;
  record({ _guki: 'socket-out', payload });
  console.log(`[${Date.now() - t0}ms] cancelPending -> deny`);
  permSocket.write(JSON.stringify(payload) + '\n');
}

let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  const lines = buf.split(String.fromCharCode(10));
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      record({ _guki: 'unparsed', line });
      continue;
    }
    record(e);

    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'tool_use') console.log(`[${Date.now() - t0}ms] tool_use ${b.name} ${b.id}`);
      }
    }
    if (e.type === 'user') {
      for (const b of e.message?.content ?? []) {
        if (b?.type === 'tool_result') {
          console.log(
            `[${Date.now() - t0}ms] tool_result ${b.tool_use_id} is_error=${String(b.is_error)} ` +
              JSON.stringify(String(b.content ?? '')).slice(0, 160),
          );
        }
      }
    }
    if (e.type === 'result') {
      resultSeen = true;
      console.log(
        `[${Date.now() - t0}ms] RESULT subtype=${e.subtype} is_error=${String(e.is_error)} ` +
          `terminal_reason=${String(e.terminal_reason)} denials=${JSON.stringify(e.permission_denials ?? []).slice(0, 300)}`,
      );
      // Exactly where the plugin does it: reducer.onTurnEnd fires at the end of applyResult.
      cancelPending('The turn was stopped before the request was answered.');
      setTimeout(() => child.stdin.end(), 800);
    }
  }
});

child.stderr.on('data', (d) => record({ _guki: 'stderr', text: String(d) }));

send({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Use the Write tool to create the file 📥 000-Inbox/Dump/guki-stop-capture.md with exactly one line of content: merhaba',
      },
    ],
  },
});

const hardStop = setTimeout(() => {
  console.log('TIMEOUT — killing');
  child.kill('SIGKILL');
}, 180000);

child.on('exit', (code, signal) => {
  clearTimeout(hardStop);
  record({ _guki: 'exit', code, signal, resultSeen });
  out.end();
  sockServer.close();
  console.log(`EXIT code=${String(code)} signal=${String(signal)} -> ${OUT}`);
  process.exit(0);
});
