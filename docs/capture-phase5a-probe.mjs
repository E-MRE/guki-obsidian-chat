// Zero-API-cost probe: does the real claude CLI actually register our permission server?
// Pointing --permission-prompt-tool at a name that does not exist makes the CLI print the tools it
// DID register and exit, before any model call (RESEARCH B5). If mcp__guki-perm__permission_prompt
// is in that list, the interpreter path, the mcp.json and the socket all work end to end.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.argv[2];
const VAULT = '/Users/you/Documents/YourVault';
const dir = mkdtempSync(join(tmpdir(), 'guki-probe-'));
const sock = join(dir, 'perm.sock');
const server = join(dir, 'mcp-permission-server.mjs');
copyFileSync(join(REPO, 'src/cli/mcp-permission-server.mjs'), server);
writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
  mcpServers: { 'guki-perm': { command: '/opt/homebrew/bin/node', args: [server],
    env: { GUKI_PERM_SOCKET: sock, GUKI_PERM_TOKEN: 'probe-token' } } },
}, null, 2));

const sockServer = createServer((c) => {
  c.setEncoding('utf8');
  c.on('data', (d) => console.log('[socket from server]', d.trim()));
});
await new Promise((r) => sockServer.listen(sock, r));

// The same env scrubbing claude-process.ts does.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !/^(CLAUDE|ANTHROPIC|AI_AGENT|HEADROOM)/i.test(k)) env[k] = v;
}
env.PATH = '/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const child = spawn('/Users/you/.local/bin/claude', [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages',
  '--mcp-config', join(dir, 'mcp.json'),
  '--permission-prompt-tool', 'mcp__guki-perm__DOES_NOT_EXIST',
], { cwd: VAULT, env, stdio: ['pipe', 'pipe', 'pipe'] });

let out = '', err = '';
let initSeen = null;
let buf = '';
child.stdout.on('data', (d) => {
  out += d;
  buf += d;
  const lines = buf.split(String.fromCharCode(10)); buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'system' && e.subtype === 'init' && !initSeen) {
      initSeen = e;
      console.log('=== system/init.mcp_servers ===');
      console.log(JSON.stringify(e.mcp_servers, null, 2));
      console.log('permissionMode:', JSON.stringify(e.permissionMode));
      console.log('guki-perm in tools list:', (e.tools || []).filter(t => t.includes('guki-perm')));
      child.kill('SIGKILL');
    }
  }
});
child.stderr.on('data', (d) => (err += d));
child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');

const code = await new Promise((r) => { setTimeout(() => { child.kill('SIGKILL'); r('TIMEOUT'); }, 120000); child.on('exit', r); });
console.log('EXIT:', code);
console.log('--- stderr ---'); console.log(err.slice(0, 2000));
console.log('init seen:', initSeen !== null);
sockServer.close();
process.exit(0);
