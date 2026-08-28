/**
 * Phase 4 capture harness. Takes one real turn from the live CLI and writes it to
 * `docs/capture-phase4-tools.jsonl`, so the reducer can be replayed against it offline forever
 * after. Raw captures live in `docs/`, never in a session scratchpad: Phase 3's original capture
 * was lost with its session and had to be re-taken at the cost of another API call.
 *
 * It uses the **same flags and the same env sanitising as `src/cli/claude-process.ts`**, so what
 * lands here is what the panel would see. The only addition is `--allowedTools`, because the
 * session is non-interactive and every tool would otherwise be denied before it ran — and a
 * denial is the one tool outcome the Phase 3 capture already covers.
 *
 * Run from the repo root:  node docs/capture-phase4.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BINARY = '/Users/you/.local/bin/claude';
const OUT = 'docs/capture-phase4-tools.jsonl';

// A throwaway working directory: the turn edits a file, and it must not be a vault note.
const cwd = mkdtempSync(join(tmpdir(), 'guki-phase4-'));
writeFileSync(join(cwd, 'sample.txt'), 'alpha\nbravo\ncharlie\ndelta\n');

// RESEARCH trap 2: Headroom and friends are inherited and have to go.
const DENY = /^(CLAUDE|ANTHROPIC|AI_AGENT|HEADROOM)/;
const env = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v !== undefined && !DENY.test(k)) env[k] = v;
}

const child = spawn(
	BINARY,
	[
		'-p',
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		// Not part of the plugin's flag set. See the header: without it nothing actually runs.
		'--allowedTools', 'Edit,Read,Task,Glob',
	],
	{ cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
);

const out = createWriteStream(OUT);
let buffer = '';
const seen = new Map();

child.stdout.on('data', (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split('\n');
	buffer = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) continue;
		out.write(line + '\n');
		try {
			const ev = JSON.parse(line);
			const key = ev.type === 'stream_event' ? `stream_event/${ev.event?.type}` : `${ev.type}/${ev.subtype ?? ''}`;
			seen.set(key, (seen.get(key) ?? 0) + 1);
			if (ev.parent_tool_use_id) seen.set('** parent_tool_use_id **', (seen.get('** parent_tool_use_id **') ?? 0) + 1);
		} catch { /* a partial line is written and counted on the next chunk */ }
	}
});

child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`));

child.on('exit', (code) => {
	out.end();
	console.log(`\nexit ${code}; wrote ${OUT}`);
	for (const [k, n] of [...seen].sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
	console.log(`\nscratch dir: ${cwd}`);
});

// Two things the Phase 3 capture lacks: a subagent (parent_tool_use_id) and an Edit input.
const prompt =
	'Do exactly two things, in this order, with no preamble. ' +
	'1) Use the Task tool to launch an Explore subagent that reports how many lines sample.txt has. ' +
	'2) Then use the Edit tool on sample.txt to change the line "bravo" to "BRAVO-EDITED". ' +
	'Then stop and reply with one short sentence.';

child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
child.stdin.end();
