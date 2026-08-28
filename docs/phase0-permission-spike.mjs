// Phase 0 spike: verify the --permission-prompt-tool bridge end-to-end.
// Spawns the real claude binary with a local MCP server acting as the
// permission prompt, and checks whether tools/call actually fires.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CB = '/Users/you/.local/share/claude/versions/2.1.248';
const DIR = process.cwd();
const DECISION = process.env.DECISION || 'allow';

fs.writeFileSync(DIR + '/mcp.json', JSON.stringify({
  mcpServers: { perm: { command: process.execPath, args: [DIR + '/permserver.mjs'], env: { PERM_DECISION: DECISION } } }
}));
try { fs.unlinkSync(DIR + '/permserver.log'); } catch {}
try { fs.unlinkSync(DIR + '/x.txt'); } catch {}

// The plugin will spawn claude from Obsidian, which has none of the outer
// session's variables. Reproduce that clean environment here so the spike
// measures the CLI, not the harness it happens to run inside.
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT|HEADROOM)/.test(k)) delete env[k];
}
env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
env.HOME = '/Users/you';

const PMODE = process.env.PMODE || '';
const PROMPT = process.env.PROMPT ||
  'Use the Write tool to create a file named x.txt in the current directory with the exact content: hello-phase0';
const args = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--model', 'claude-haiku-4-5-20251001',
  '--mcp-config', DIR + '/mcp.json',
  '--permission-prompt-tool', 'mcp__perm__permission_prompt',
  ...(PMODE ? ['--permission-mode', PMODE] : []),
  PROMPT
];

const p = spawn(CB, args, { cwd: DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
p.stdin.end();

const out = fs.createWriteStream(DIR + `/run-${DECISION}.jsonl`);
let buf = '';
p.stdout.on('data', d => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    out.write(l + '\n');
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'system' && e.subtype !== 'init') console.log('SYS', e.subtype);
    if (e.type === 'result') {
      console.log('RESULT', e.subtype, 'is_error=' + e.is_error,
        'denials=' + JSON.stringify(e.permission_denials || []).slice(0, 400));
      console.log('TEXT', (e.result || '').slice(0, 300));
    }
  }
});
p.stderr.on('data', d => process.stderr.write('[err] ' + d));

p.on('exit', code => {
  console.log('EXIT', code);
  const exists = fs.existsSync(DIR + '/x.txt');
  console.log('x.txt exists:', exists, exists ? JSON.stringify(fs.readFileSync(DIR + '/x.txt', 'utf8')) : '');
  const log = fs.existsSync(DIR + '/permserver.log') ? fs.readFileSync(DIR + '/permserver.log', 'utf8') : '';
  console.log('tools/call seen:', log.includes('tools/call'));
  const argLines = log.split('\n').filter(l => l.includes('PERMISSION_REQUEST_ARGS'));
  console.log('bridge fired for:', argLines.map(l => JSON.parse(l).PERMISSION_REQUEST_ARGS.tool_name).join(', ') || 'NOTHING');
  argLines.forEach(l => console.log('ARGS:', l.slice(0, 600)));
});
