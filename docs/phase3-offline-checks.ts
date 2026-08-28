/**
 * Phase 3 offline checks. Run:
 *
 *   npx esbuild docs/phase3-offline-checks.ts --bundle --platform=node --format=esm \
 *     --alias:obsidian=./docs/obsidian-stub.mjs --outfile=/tmp/guki-checks.mjs && node /tmp/guki-checks.mjs
 *
 * Two sections, both driving the **real** production classes — no re-implementation of the logic
 * under test:
 *
 * A. `StreamReducer` replayed against `docs/capture-phase3-thinking-redacted.jsonl`, a real turn
 *    from the same CLI, same vault and same model the panel runs. The Phase 3 replay checked slot
 *    *placement* only, which is why it passed while a thinking block was arriving empty. Every
 *    assertion here is on the **content** each slot ended up holding.
 *
 * B. `SessionManager`'s queue lifecycle, with `ensureProcess` and the process object stubbed. These
 *    cover the two paths a manual test cannot reach: Stop pressed before the turn begins, and a
 *    turn failed from outside the stream while a message is queued behind it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatState, orderedBlocks, type AssistantItem } from '../src/core/chat-state';
import { StreamReducer } from '../src/core/stream-reducer';
import { SessionManager } from '../src/core/session-manager';
import { parseStreamJsonLine } from '../src/cli/events';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
	check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- A. replay the real capture -------------------------------------------

console.log('A. StreamReducer over docs/capture-phase3-thinking-redacted.jsonl');

// Relative to the working directory, not to the bundle: run this from the repo root.
const capture = readFileSync(join(process.cwd(), 'docs', 'capture-phase3-thinking-redacted.jsonl'), 'utf8');

const state = new ChatState();
const reducer = new StreamReducer(state);
let turnEnds = 0;
reducer.onTurnEnd = () => {
	turnEnds += 1;
};

const item = state.addAssistantMessage();
reducer.beginTurn(item);

let lines = 0;
for (const line of capture.split('\n')) {
	const event = parseStreamJsonLine(line);
	if (event) {
		lines += 1;
		reducer.apply(event);
	}
}

const blocks = orderedBlocks(item);
console.log(
	`  replayed ${String(lines)} events → ${String(blocks.length)} blocks: ` +
		blocks
			.map((b) => `${String(b.index)}:${b.kind}(${String(b.text.length)}${b.toolName ? `/${b.toolName}` : ''})`)
			.join(' '),
);

// Slot alignment: six blocks over three API messages, indices restarting at 0 twice.
eq('block count', blocks.length, 6);
eq('slots are 0..5 with no gap', blocks.map((b) => b.index).join(','), '0,1,2,3,4,5');
eq(
	'block kinds in stream order',
	blocks.map((b) => b.kind).join(','),
	'thinking,text,tool_use,tool_use,tool_use,text',
);

// Content, which is what the old replay never looked at.
const [thinking, firstText, tool0, tool1, tool2, lastText] = blocks;
eq('slot 0 is the thinking block', thinking?.kind, 'thinking');
eq('slot 0 thinking text is EMPTY — the model redacts it', thinking?.text, '');
check('slot 0 is final', thinking?.final === true);
check('slot 0 has a duration', typeof thinking?.startedAt === 'number' && typeof thinking.endedAt === 'number');
eq('slot 0 carries the live token count', thinking?.thinkingTokens, 158);

check(
	'slot 1 text survived intact',
	firstText?.text === 'Mem0 Active | user=you | project=YourVault | branch=main | memories=?',
	JSON.stringify(firstText?.text),
);
check('slot 1 is final', firstText?.final === true);

eq('slot 2 tool name', tool0?.toolName, 'ToolSearch');
eq('slot 3 tool name', tool1?.toolName, 'WebSearch');
eq('slot 4 tool name', tool2?.toolName, 'WebSearch');
check(
	'the three tool_use blocks kept distinct ids',
	new Set([tool0?.toolUseId, tool1?.toolUseId, tool2?.toolUseId]).size === 3,
);

check('slot 5 holds the closing answer', (lastText?.text.length ?? 0) > 100, String(lastText?.text.length));
check('slot 5 starts with the streamed opening', lastText?.text.startsWith('Web aramasına izin verilmedi') === true);
check('slot 5 is final', lastText?.final === true);
check(
	'no block still carries a streaming flag',
	blocks.every((b) => b.final),
);
eq('turn ended as complete', item.status, 'complete');
eq('onTurnEnd fired once', turnEnds, 1);
check('meta line has both halves', item.meta?.durationMs === 15238 && item.meta.costUsd === 0.1832235);

// What the renderer keys off. `text.length > 0` is the exact expander condition in
// `MessageList.updateThinkingBlock`; on this capture it is false for the whole turn.
eq('renderer would offer NO expander on this thinking block', (thinking?.text.length ?? 0) > 0, false);
eq('...but the header still has a duration to show', typeof thinking?.endedAt, 'number');

// --- B. the reducer's own end-of-turn contract ----------------------------

console.log('B1. StreamReducer.failActiveTurn fires onTurnEnd');
{
	const s = new ChatState();
	const r = new StreamReducer(s);
	let ends = 0;
	r.onTurnEnd = () => {
		ends += 1;
	};
	const turn: AssistantItem = s.addAssistantMessage();
	r.beginTurn(turn);
	const failed = r.failActiveTurn('boom');
	check('returns true when a turn was failed', failed);
	eq('the item is an error', turn.status, 'error');
	eq('onTurnEnd fired', ends, 1);
	r.failActiveTurn('again');
	eq('onTurnEnd fires even with no active turn', ends, 2);
}

// --- C. SessionManager queue lifecycle ------------------------------------

interface Stubbed {
	ensureProcess: () => Promise<boolean>;
	process: { alive: boolean; write: (line: string) => boolean; stop: () => void } | null;
}

/**
 * Replaces the two things that need a real machine: binary resolution and the subprocess. The
 * stubbed `ensureProcess` installs a working process the way the real one does, so a pump that
 * runs after the process died revives it exactly as it would in Obsidian.
 */
function stub(manager: SessionManager, gate: () => Promise<boolean>, written: string[]): void {
	const internals = manager as unknown as Stubbed;
	const live = {
		alive: true,
		write: (line: string) => {
			written.push(line);
			return true;
		},
		stop: () => undefined,
	};
	internals.ensureProcess = async () => {
		const ready = await gate();
		if (ready) {
			internals.process = live;
		}
		return ready;
	};
	internals.process = live;
}

const app = { vault: { adapter: {} } } as never;

console.log('C1. Stop pressed before the first turn begins cancels the queued message');
{
	const manager = new SessionManager(app);
	const written: string[] = [];
	let release: (value: boolean) => void = () => undefined;
	stub(manager, () => new Promise<boolean>((resolve) => (release = resolve)), written);

	manager.send('hello');
	check('busy while queued', manager.busy);
	manager.interrupt();
	const queued = manager.state.items.find((i) => i.kind === 'assistant') as AssistantItem;
	eq('the cancelled turn shows as stopped', queued.status, 'stopped');
	eq('not busy any more, so the button goes back to Send', manager.busy, false);

	release(true);
	await Promise.resolve();
	await Promise.resolve();
	eq('the cancelled message was never written to the CLI', written.length, 0);
	manager.dispose();
}

console.log('C2. A turn failed from outside the stream releases the message queued behind it');
{
	const manager = new SessionManager(app);
	const written: string[] = [];
	stub(manager, () => Promise.resolve(true), written);

	manager.send('first');
	await Promise.resolve();
	await Promise.resolve();
	eq('first message went out', written.length, 1);

	manager.send('second');
	await Promise.resolve();
	eq('second message is queued, not sent', written.length, 1);

	// The process is gone, so the interrupt cannot be written: `interrupt` falls into
	// `failActiveTurn`. Before the fix this stranded "second" forever.
	const internals = manager as unknown as Stubbed;
	internals.process = { alive: false, write: () => false, stop: () => undefined };
	manager.interrupt();
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}
	const assistants = manager.state.items.filter((i) => i.kind === 'assistant') as AssistantItem[];
	eq('the dead turn is an error', assistants[0]?.status, 'error');
	eq('the queued turn was sent, not stranded', written.length, 2);
	check('the second message is the one that went out', written[1]?.includes('second') === true);
	manager.dispose();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
