/**
 * Offline checks, Phases 3 and 4. Run from the repo root:
 *
 *   npx esbuild docs/offline-checks.ts --bundle --platform=node --format=esm \
 *     --alias:obsidian=./docs/obsidian-stub.mjs --outfile=/tmp/guki-checks.mjs && node /tmp/guki-checks.mjs
 *
 * Every section drives the **real** production classes — no re-implementation of the logic under
 * test — and asserts on the **content** each slot ended up holding, never merely on where blocks
 * landed. That distinction is the whole point: Phase 3's first replay passed while a thinking
 * block was silently arriving empty, because it only checked ordering.
 *
 * A.  `StreamReducer` replayed against `docs/capture-phase3-thinking-redacted.jsonl`, a real turn
 *     from the same CLI, vault and model the panel runs.
 * B.  The reducer's end-of-turn contract.
 * C.  `SessionManager`'s queue lifecycle, with `ensureProcess` and the process object stubbed.
 * D.  Phase 4: the tool state that same real capture produces — inputs, results, error flags.
 * E.  Phase 4: id-matching under reordered results, which the capture cannot prove on its own.
 * F.  Phase 4: `tool-policy` — the category table, the unknown-tool rule, the error override.
 * G.  Phase 4: `diff-view` input parsing and line counting.
 * H.  Phase 4: subagent activity, and tools left running when a turn is cut short.
 * I.  Phase 4: replay of `docs/capture-phase4-tools.jsonl` — a second real turn, taken for the two
 *     things the Phase 3 capture lacks: a live subagent and a real `Edit` input.
 * J.  The three defects from Emre's Phase 4 acceptance run that carry state: a Stop during a
 *     pending tool call, and a trailing newline counted as a line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatState, hasRenderableContent, orderedBlocks, type AssistantItem } from '../src/core/chat-state';
import { StreamReducer } from '../src/core/stream-reducer';
import { SessionManager } from '../src/core/session-manager';
import { parseStreamJsonLine, type StreamJsonEvent } from '../src/cli/events';
import { startsExpanded, toolCategory, toolResultText, toolSummary } from '../src/core/tool-policy';
import { diffFromToolInput, diffStats } from '../src/ui/diff-view';

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

// --- D. Phase 4: tool state from the same real capture --------------------

console.log('D. Tool blocks from the real capture');
{
	// `tool0/1/2` are slots 2, 3, 4 of the replay in section A: ToolSearch, then two WebSearches.
	// Section A already proved the names and the distinct ids; this is about their content.

	// The parsed arguments arrive only on the authoritative `assistant` event (PHASE4-STATE F3).
	// `mapBlock` dropped this field before Phase 4, so the card had nothing to summarise.
	const input0 = tool0?.toolInput as { query?: string; max_results?: number } | undefined;
	eq('slot 2 carries the parsed tool input', input0?.query, 'select:WebSearch,WebFetch');
	eq('slot 2 input is fully parsed, not a JSON fragment', input0?.max_results, 2);
	const input1 = tool1?.toolInput as { query?: string } | undefined;
	eq(
		'slot 3 carries its own query',
		input1?.query,
		'Trabzonspor Avrupa Ligi play-off maç sonucu Ağustos 2026',
	);

	// The summary line the card header shows.
	eq('slot 2 summary is the primary argument', toolSummary(tool0?.toolName, tool0?.toolInput), 'select:WebSearch,WebFetch');

	// The success result. Its `content` is an **array of blocks with no `text` field** — handling
	// only the string shape would have rendered this blank.
	check(
		'slot 2 result text is non-empty despite the array-of-blocks shape',
		(tool0?.toolResultText?.length ?? 0) > 0,
		JSON.stringify(tool0?.toolResultText),
	);
	// Exact, not `includes`: a fallback that stringified the whole array would also contain both
	// names, so a loose check here would pass against the string-only flattener it is meant to
	// catch. This is the per-block flattening, one block per line.
	eq(
		'slot 2 result text is the array flattened block by block',
		tool0?.toolResultText,
		'{"type":"tool_reference","tool_name":"WebSearch"}\n{"type":"tool_reference","tool_name":"WebFetch"}',
	);
	// `is_error` is absent, not false, on a successful result (PHASE4-STATE F4).
	eq('slot 2 is NOT an error', tool0?.toolIsError, false);
	eq('slot 2 is no longer pending once its result landed', tool0?.toolPending, false);

	// The two error results.
	eq('slot 3 is flagged as an error', tool1?.toolIsError, true);
	eq('slot 4 is flagged as an error', tool2?.toolIsError, true);
	check(
		'slot 3 result carries the denial message, not a blank box',
		tool1?.toolResultText?.includes("haven't granted it yet") === true,
		JSON.stringify(tool1?.toolResultText),
	);

	// The is_error override: a WebSearch is `collapsed` by the table, but an errored one opens.
	eq('WebSearch is collapsed by category', toolCategory('WebSearch'), 'collapsed');
	eq('...but the errored card starts expanded', startsExpanded('WebSearch', true), true);
	eq('...and the successful one does not', startsExpanded('ToolSearch', false), false);

	// RESEARCH trap 6, on live data: two tools were denied and the turn is still a success.
	eq('two denied tools did NOT fail the turn', item.status, 'complete');

	// Why the phase exists: before Phase 4 a tool_use block counted as nothing on screen, so a
	// turn that opened with a tool call held "Working…" for its whole length. The capture's turn
	// also has text blocks, which would carry this on their own — so the check is made against a
	// turn holding **nothing but** a tool_use block.
	const onlyTool = new ChatState().addAssistantMessage();
	onlyTool.blocks.set(0, { index: 0, kind: 'tool_use', text: '', final: false, toolName: 'Read' });
	eq('a turn holding only a tool_use block has something to show', hasRenderableContent(onlyTool), true);
}

// --- E. Phase 4: results are matched by id, not by arrival order -----------

console.log('E. tool_result matched by tool_use_id under reordered arrival');
{
	// The capture's results happen to arrive in block order, so it cannot prove this on its own.
	// Here B's result arrives before A's. Order-matching would put B's output under A.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);

	const toolUse = (index: number, id: string, name: string): StreamJsonEvent[] => [
		{
			type: 'stream_event',
			event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
		} as StreamJsonEvent,
		{
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id, name, input: { file_path: `/vault/${name}.md` } }] },
		} as StreamJsonEvent,
	];
	const toolResult = (id: string, text: string, isError?: boolean): StreamJsonEvent =>
		({
			type: 'user',
			message: {
				role: 'user',
				content: [
					isError === true
						? { type: 'tool_result', tool_use_id: id, content: text, is_error: true }
						: { type: 'tool_result', tool_use_id: id, content: text },
				],
			},
		}) as StreamJsonEvent;

	for (const ev of [
		{ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent,
		...toolUse(0, 'toolu_AAA', 'Read'),
		...toolUse(1, 'toolu_BBB', 'Grep'),
		// Reversed on purpose: B first, then A.
		toolResult('toolu_BBB', 'output-for-B'),
		toolResult('toolu_AAA', 'output-for-A', true),
		// An id from a different turn entirely. It must be dropped, not applied to some slot.
		toolResult('toolu_STRANGER', 'output-for-nobody'),
	]) {
		r.apply(ev);
	}

	const [a, b] = orderedBlocks(turn);
	eq('slot 0 is the Read', a?.toolName, 'Read');
	eq('slot 1 is the Grep', b?.toolName, 'Grep');
	eq("slot 0 got A's output even though B's arrived first", a?.toolResultText, 'output-for-A');
	eq("slot 1 got B's output", b?.toolResultText, 'output-for-B');
	eq("slot 0 kept A's error flag", a?.toolIsError, true);
	eq('slot 1 is not an error — is_error was absent, not false', b?.toolIsError, false);
	check(
		'an unmatched tool_use_id was dropped, not applied to a slot',
		orderedBlocks(turn).every((blk) => blk.toolResultText !== 'output-for-nobody'),
	);

	// The authoritative `assistant` event **replaces** the block wholesale. Nothing orders it
	// against the `tool_result`, so the result can land first — and then the replacement would
	// wipe it and leave the card on "Running…" forever. The block has to open, take its result,
	// and only then get its authoritative event.
	const s2 = new ChatState();
	const r2 = new StreamReducer(s2);
	const turn2 = s2.addAssistantMessage();
	r2.beginTurn(turn2);
	r2.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r2.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_EARLY', name: 'Read', input: {} },
		},
	} as StreamJsonEvent);
	r2.apply({
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_EARLY', content: 'early-output', is_error: true }],
		},
	} as StreamJsonEvent);
	eq('the early result landed', orderedBlocks(turn2)[0]?.toolResultText, 'early-output');
	r2.apply({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'toolu_EARLY', name: 'Read', input: { file_path: '/x' } }] },
	} as StreamJsonEvent);
	eq(
		'a result that arrived BEFORE the assistant event survives the replacement',
		orderedBlocks(turn2)[0]?.toolResultText,
		'early-output',
	);
	eq('...and so does its error flag', orderedBlocks(turn2)[0]?.toolIsError, true);
	eq('...and the card is not left running', orderedBlocks(turn2)[0]?.toolPending, false);
	eq('...while the authoritative input still landed', (orderedBlocks(turn2)[0]?.toolInput as { file_path?: string } | undefined)?.file_path, '/x');
}

// --- F. Phase 4: the policy table -----------------------------------------

console.log('F. tool-policy');
{
	eq('Edit is expanded', toolCategory('Edit'), 'expanded');
	eq('Write is expanded', toolCategory('Write'), 'expanded');
	eq('Read is collapsed', toolCategory('Read'), 'collapsed');
	eq('TodoWrite is collapsed', toolCategory('TodoWrite'), 'collapsed');
	eq('Bash is compact', toolCategory('Bash'), 'compact');

	// The unknown-tool rule. An MCP tool name is the realistic case.
	eq('an unknown MCP tool falls back to collapsed', toolCategory('mcp__plugin_mem0_mem0__add_memory'), 'collapsed');
	eq('a tool with no name at all falls back to collapsed', toolCategory(undefined), 'collapsed');
	eq('an unknown tool does not start expanded', startsExpanded('mcp__whatever', false), false);
	eq('...unless it errored', startsExpanded('mcp__whatever', true), true);

	// The summary must never throw on input of an unexpected shape.
	eq('summary of undefined input is empty, not a crash', toolSummary('Read', undefined), '');
	eq('summary of a null input is empty', toolSummary('Read', null), '');
	// The array must hold a string: an array of numbers reads as empty either way, so it would
	// pass even against an `asRecord` that accepts arrays.
	eq('summary of an array input is empty', toolSummary('Read', ['a string', 'another']), '');
	eq('summary of a string input is empty', toolSummary('Read', 'not-an-object'), '');
	eq('Bash summarises its command', toolSummary('Bash', { command: 'ls -la' }), 'ls -la');
	eq('TodoWrite summarises by count', toolSummary('TodoWrite', { todos: [1, 2, 3] }), '3 items');
	eq(
		'an unknown MCP tool falls back to its first string field',
		toolSummary('mcp__x__y', { limit: 5, pattern: 'spawn' }),
		'spawn',
	);
	check(
		'a long path is abbreviated from the tail, keeping the file name',
		toolSummary('Read', { file_path: `/Users/e/${'deep/'.repeat(40)}main.ts` }).endsWith('main.ts'),
		toolSummary('Read', { file_path: `/Users/e/${'deep/'.repeat(40)}main.ts` }),
	);

	// The result flattener's three runtime shapes.
	eq('a string result passes through', toolResultText('plain'), 'plain');
	eq('an absent result is empty', toolResultText(undefined), '');
	eq('a null result is empty', toolResultText(null), '');
	eq(
		'an array of text blocks is joined',
		toolResultText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
		'one\ntwo',
	);
	check(
		'an array of non-text blocks still says something',
		toolResultText([{ type: 'tool_reference', tool_name: 'WebSearch' }]).includes('WebSearch'),
	);
	check('an object result is stringified, not dropped', toolResultText({ ok: true }).includes('ok'));
}

// --- G. Phase 4: the diff surface -----------------------------------------

console.log('G. diff-view');
{
	const edit = diffFromToolInput('Edit', {
		file_path: '/vault/note.md',
		old_string: 'keep\nremove one\nremove two\ntail',
		new_string: 'keep\nadd one\ntail',
	});
	check('an Edit input parses into a diff', edit !== null);
	eq('the diff keeps the file path', edit?.path, '/vault/note.md');
	eq('two lines removed', edit ? diffStats(edit).removed : -1, 2);
	eq('one line added', edit ? diffStats(edit).added : -1, 1);

	const write = diffFromToolInput('Write', { file_path: '/vault/new.md', content: 'a\nb\nc' });
	check('a Write input parses into a diff', write !== null);
	eq('a Write has no before text', write?.oldText, undefined);
	eq('a Write counts every line as added', write ? diffStats(write).added : -1, 3);
	eq('a Write removes nothing', write ? diffStats(write).removed : -1, 0);

	const multi = diffFromToolInput('MultiEdit', {
		file_path: '/vault/note.md',
		edits: [
			{ old_string: 'a', new_string: 'A' },
			{ old_string: 'b', new_string: 'B' },
		],
	});
	check('a MultiEdit input parses into one combined diff', multi !== null);

	// Everything that must degrade rather than throw.
	eq('a Read is not a diff tool', diffFromToolInput('Read', { file_path: '/x' }), null);
	eq('an Edit with missing strings is not a diff', diffFromToolInput('Edit', { file_path: '/x' }), null);
	eq('an Edit with a non-string old_string is not a diff', diffFromToolInput('Edit', { old_string: 5, new_string: 'x' }), null);
	eq('undefined input is not a diff', diffFromToolInput('Edit', undefined), null);
	eq('a null input is not a diff', diffFromToolInput('Edit', null), null);
	eq('an array input is not a diff', diffFromToolInput('Write', ['a']), null);
	eq('a MultiEdit with no usable edits is not a diff', diffFromToolInput('MultiEdit', { edits: [] }), null);

	// Identical texts must not produce a negative or overlapping hunk.
	const same = diffFromToolInput('Edit', { old_string: 'x\ny', new_string: 'x\ny' });
	eq('an unchanged Edit adds nothing', same ? diffStats(same).added : -1, 0);
	eq('an unchanged Edit removes nothing', same ? diffStats(same).removed : -1, 0);

	// A repeated line must not be counted as both leading context and trailing context. If the
	// suffix scan is allowed to overlap the prefix, the two slices collapse to empty and the diff
	// silently shows *no change at all* for a line that really was deleted — `Array.slice` clamps
	// rather than throwing, so counting only "not negative" would never catch it.
	const repeated = diffFromToolInput('Edit', { old_string: 'a\na\na', new_string: 'a\na' });
	eq('a deleted repeated line is still counted as removed', repeated ? diffStats(repeated).removed : -1, 1);
	eq('...and nothing is counted as added', repeated ? diffStats(repeated).added : -1, 0);
}

// --- H. Phase 4: subagents, and tools left running ------------------------

console.log('H1. A subagent event lights up its parent Task card');
{
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);

	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_TASK', name: 'Task', input: {} },
		},
	} as StreamJsonEvent);

	const task = () => orderedBlocks(turn)[0];
	eq('the Task card is running before any subagent event', task()?.toolPending, true);
	eq('...but not yet flagged as a subagent', task()?.subagentActive, undefined);

	// Subagent output is hidden in v1: the marker is on the envelope, not on the inner event.
	r.apply({
		type: 'assistant',
		parent_tool_use_id: 'toolu_TASK',
		message: { content: [{ type: 'text', text: 'subagent chatter' }] },
	} as StreamJsonEvent);

	eq('the parent card now reports a running subagent', task()?.subagentActive, true);
	eq('the subagent content did NOT leak into the main flow', orderedBlocks(turn).length, 1);
	check(
		'no block holds the subagent text',
		orderedBlocks(turn).every((blk) => !blk.text.includes('subagent chatter')),
	);

	// A stream_event under the same parent is the other path into the same flag.
	r.apply({
		type: 'stream_event',
		parent_tool_use_id: 'toolu_TASK',
		event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'more' } },
	} as StreamJsonEvent);
	eq('a subagent stream_event does not add a block either', orderedBlocks(turn).length, 1);

	// An unknown parent id must not throw or attach itself to some other card.
	r.apply({
		type: 'assistant',
		parent_tool_use_id: 'toolu_NOT_HERE',
		message: { content: [{ type: 'text', text: 'orphan' }] },
	} as StreamJsonEvent);
	eq('an unknown parent id is ignored', orderedBlocks(turn).length, 1);

	// The line resolves when the parent Task call returns.
	r.apply({
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_TASK', content: 'done' }] },
	} as StreamJsonEvent);
	eq('the subagent line clears when the parent Task returns', task()?.subagentActive, false);
	eq('the Task card stops running', task()?.toolPending, false);
	eq('the Task card holds its result', task()?.toolResultText, 'done');
}

console.log('H1b. Each subagent event path lights the parent card on its own');
{
	// Three separate event paths carry `parent_tool_use_id` — `stream_event`, `assistant` and
	// `user` — and each has its own guard in the reducer. H1 feeds all three into one card, so the
	// first to arrive satisfies the flag and the other two guards are proved by nothing: reverting
	// either of them left every check in H1 and I green. One card per path is what makes each guard
	// answerable, and each path is also checked for content leaking onto the card, which is the
	// v1 decision the guards exist for.
	const lit = (feed: (r: StreamReducer) => void): AssistantItem => {
		const s = new ChatState();
		const r = new StreamReducer(s);
		const turn = s.addAssistantMessage();
		r.beginTurn(turn);
		r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
		r.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'toolu_P', name: 'Agent', input: {} },
			},
		} as StreamJsonEvent);
		feed(r);
		return turn;
	};

	const viaStream = orderedBlocks(
		lit((r) =>
			r.apply({
				type: 'stream_event',
				parent_tool_use_id: 'toolu_P',
				event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hidden chatter' } },
			} as StreamJsonEvent),
		),
	)[0];
	eq('a subagent stream_event alone lights the card', viaStream?.subagentActive, true);
	check(
		'...and its delta did not land on the card',
		viaStream?.text.includes('hidden chatter') !== true,
		JSON.stringify(viaStream?.text),
	);

	const viaAssistant = orderedBlocks(
		lit((r) =>
			r.apply({
				type: 'assistant',
				parent_tool_use_id: 'toolu_P',
				message: { content: [{ type: 'text', text: 'hidden chatter' }] },
			} as StreamJsonEvent),
		),
	)[0];
	eq('a subagent assistant event alone lights the card', viaAssistant?.subagentActive, true);
	check(
		'...and its text did not land on the card',
		viaAssistant?.text.includes('hidden chatter') !== true,
		JSON.stringify(viaAssistant?.text),
	);

	const viaUser = orderedBlocks(
		lit((r) =>
			r.apply({
				type: 'user',
				parent_tool_use_id: 'toolu_P',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'toolu_INNER', content: 'hidden output' }],
				},
			} as StreamJsonEvent),
		),
	)[0];
	eq("a subagent's own tool_result alone lights the card", viaUser?.subagentActive, true);
	eq("...and the subagent's output did not fill the parent card", viaUser?.toolResultText, undefined);
}

console.log('H1c. A card still fills when there is no partial-message stream at all');
{
	// `--include-partial-messages` is what produces `content_block_start`, and that is where the
	// id → slot mapping is normally registered. Without the flag a `tool_use` block is announced
	// only by the authoritative `assistant` event, so it has to register there too or the result
	// would have no card to land on. Every other section feeds a `content_block_start` first,
	// which is why removing that second registration left them all green.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', id: 'toolu_NOSTREAM', name: 'Read', input: { file_path: '/vault/a.md' } }],
		},
	} as StreamJsonEvent);
	r.apply({
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_NOSTREAM', content: 'contents' }] },
	} as StreamJsonEvent);

	const blk = orderedBlocks(turn)[0];
	eq('the card exists with no stream_event at all', blk?.toolName, 'Read');
	eq('...and its result found it by id', blk?.toolResultText, 'contents');
	eq('...and it is not left running', blk?.toolPending, false);
}

console.log('H2. A turn cut short does not leave a tool card spinning');
{
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);

	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_NEVER', name: 'Bash', input: {} },
		},
	} as StreamJsonEvent);
	eq('the card is running', orderedBlocks(turn)[0]?.toolPending, true);

	// A cancelled turn: its result event has no `result` field at all (RESEARCH B4).
	r.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' } as StreamJsonEvent);
	eq('the turn shows as stopped, not as an error', turn.status, 'stopped');
	eq('the tool card stopped claiming it is running', orderedBlocks(turn)[0]?.toolPending, false);

	// The same must hold when the turn is failed from outside the stream.
	const s2 = new ChatState();
	const r2 = new StreamReducer(s2);
	const turn2 = s2.addAssistantMessage();
	r2.beginTurn(turn2);
	r2.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r2.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_DEAD', name: 'Bash', input: {} },
		},
	} as StreamJsonEvent);
	r2.failActiveTurn('the subprocess died');
	eq('a subprocess death also stops the spinner', orderedBlocks(turn2)[0]?.toolPending, false);
}

console.log('H3. Tool slots do not leak across turns');
{
	const s = new ChatState();
	const r = new StreamReducer(s);
	const first = s.addAssistantMessage();
	r.beginTurn(first);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_REUSED', name: 'Read', input: {} },
		},
	} as StreamJsonEvent);
	r.apply({ type: 'result', subtype: 'success', is_error: false } as StreamJsonEvent);

	const second = s.addAssistantMessage();
	r.beginTurn(second);
	// The new turn opens its own tool at the same slot under a *different* id. If the id→slot map
	// were not cleared, the previous turn's id would still point at slot 0 and a late result for
	// it would land on this turn's unrelated Bash card. An empty new turn would not catch that:
	// the lookup would resolve to a slot that holds no block, and nothing would happen.
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_FRESH', name: 'Bash', input: {} },
		},
	} as StreamJsonEvent);
	r.apply({
		type: 'user',
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_REUSED', content: 'late' }] },
	} as StreamJsonEvent);

	eq("the new turn's card was not filled by the old turn's id", orderedBlocks(second)[0]?.toolResultText, undefined);
	eq('...and is still waiting for its own result', orderedBlocks(second)[0]?.toolPending, true);
	check(
		'the closed turn was not rewritten either',
		orderedBlocks(first)[0]?.toolResultText === undefined,
		JSON.stringify(orderedBlocks(first)[0]?.toolResultText),
	);
}

// --- I. Phase 4: replay of the second real capture (subagent + Edit) ------

console.log('I. StreamReducer over docs/capture-phase4-tools.jsonl');
{
	// Taken from the live CLI by `docs/capture-phase4.mjs`, same flags as the panel. It holds the
	// two things the Phase 3 capture lacks: a real subagent (`parent_tool_use_id` populated on 11
	// events, plus the `system/task_*` lifecycle) and a real `Edit` input.
	const raw = readFileSync(join(process.cwd(), 'docs', 'capture-phase4-tools.jsonl'), 'utf8');
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	for (const line of raw.split('\n')) {
		const ev = parseStreamJsonLine(line);
		if (ev) {
			r.apply(ev);
		}
	}

	const blks = orderedBlocks(turn);
	console.log(
		`  ${String(blks.length)} blocks: ` +
			blks.map((b) => `${String(b.index)}:${b.kind}${b.toolName ? `(${b.toolName})` : ''}`).join(' '),
	);

	// Only the main agent's blocks are here. The subagent made five tool calls of its own — Bash,
	// Glob, Read, Bash, Bash — and none of them may appear as a card.
	eq(
		'only the main agent produced blocks',
		blks.map((b) => b.toolName ?? b.kind).join(','),
		'text,Agent,Read,Edit,text',
	);
	check(
		"none of the subagent's own tool calls leaked in as cards",
		!blks.some((b) => b.toolName === 'Glob' || b.toolName === 'Bash'),
		blks.map((b) => b.toolName).join(','),
	);

	const agent = blks.find((b) => b.toolName === 'Agent');
	const edit = blks.find((b) => b.toolName === 'Edit');

	// PLAN Phase 4.5 calls this tool `Task`; on the wire at CLI 2.1.250 it is `Agent`.
	check('the subagent tool is present under the name the CLI actually sends', agent !== undefined);
	eq('the subagent card resolved when its Task finished', agent?.subagentActive, false);
	eq('...and is not left running', agent?.toolPending, false);
	check(
		'the subagent card holds the summary its result carried',
		agent?.toolResultText?.includes('Line count: 4') === true,
		JSON.stringify(agent?.toolResultText?.slice(0, 120)),
	);
	eq('the subagent card is not an error', agent?.toolIsError, false);
	check(
		'the subagent progress was tracked while it ran',
		(agent?.subagentToolUses ?? 0) >= 5,
		String(agent?.subagentToolUses),
	);

	// The Edit input, which is what the diff surface consumes.
	const editInput = edit?.toolInput as { old_string?: string; new_string?: string } | undefined;
	eq('the Edit block carries old_string', editInput?.old_string, 'bravo');
	eq('the Edit block carries new_string', editInput?.new_string, 'BRAVO-EDITED');
	const editDiff = diffFromToolInput('Edit', edit?.toolInput);
	check('the real Edit input parses into a diff', editDiff !== null);
	eq('one line removed', editDiff ? diffStats(editDiff).removed : -1, 1);
	eq('one line added', editDiff ? diffStats(editDiff).added : -1, 1);
	eq('Edit is expanded by category, so its diff is open by default', startsExpanded('Edit', false), true);

	// A `Read` result arrives as a plain string here; the `Agent` result as an array of text
	// blocks. Both must come out as readable text.
	const read = blks.find((b) => b.toolName === 'Read');
	check(
		'the Read card holds its string result',
		read?.toolResultText?.includes('alpha') === true,
		JSON.stringify(read?.toolResultText?.slice(0, 60)),
	);

	// One Bash call inside the subagent was denied, and the turn still succeeded (RESEARCH trap 6).
	eq('the turn completed despite a denial inside the subagent', turn.status, 'complete');
	check(
		'no main-flow card was marked as an error by the subagent-internal denial',
		blks.every((b) => b.toolIsError !== true),
		blks.filter((b) => b.toolIsError === true).map((b) => b.toolName).join(','),
	);

	check('every tool card stopped running', blks.every((b) => b.toolPending !== true));
}

// --- J. Phase 4 acceptance-run defects ------------------------------------

console.log('J1. Stop during a pending tool call reads as stopped, not as an error');
{
	// Emre's acceptance run, step 10. The card correctly stopped saying "Running…" but the
	// transcript showed a red "The turn ended with error_during_execution.". When Stop lands while
	// a tool call is waiting for permission the CLI ends the turn with
	// `subtype: "error_during_execution"` and **no `terminal_reason`**, so the reducer's
	// `aborted_streaming` test never fired.
	//
	// Driven through the real SessionManager, because the fix spans both classes: only the manager
	// knows the interrupt went out, and only the reducer sees the result event.
	const manager = new SessionManager(app);
	const written: string[] = [];
	stub(manager, () => Promise.resolve(true), written);
	const reducer = (manager as unknown as { reducer: StreamReducer }).reducer;

	manager.send('read a file');
	for (let i = 0; i < 4; i += 1) {
		await Promise.resolve();
	}
	reducer.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	reducer.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_PENDING', name: 'Read', input: {} },
		},
	} as StreamJsonEvent);

	manager.interrupt();
	check('the interrupt request went out', written.some((line) => line.includes('interrupt')), written.join(' | '));

	// No `terminal_reason` anywhere on this event — that is the whole point of the case.
	reducer.apply({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
	} as StreamJsonEvent);

	const turn = manager.state.items.find((i) => i.kind === 'assistant') as AssistantItem;
	eq('a stopped turn is stopped, whatever subtype the CLI reports', turn.status, 'stopped');
	eq('...and carries no error text to render', turn.errorText, undefined);
	eq('...and its tool card is not left running', orderedBlocks(turn)[0]?.toolPending, false);
	manager.dispose();
}

console.log('J2. The same subtype without a Stop is still an error');
{
	// The other half of the fix, and the reason it is not a subtype check:
	// `error_during_execution` also arrives with no Stop involved, and that one is a real failure
	// the reader has to see. A blanket mapping of the subtype would swallow it silently.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({ type: 'result', subtype: 'error_during_execution', is_error: true } as StreamJsonEvent);
	eq('an unrequested failure is still an error', turn.status, 'error');
	check(
		'...and says what happened',
		turn.errorText?.includes('error_during_execution') === true,
		JSON.stringify(turn.errorText),
	);

	// And the flag must not survive the turn it was set on: one Stop may not silence every failure
	// that follows it. Stop a second turn for real, then let a third fail on its own.
	const second = s.addAssistantMessage();
	r.beginTurn(second);
	r.noteInterruptSent();
	r.apply({ type: 'result', subtype: 'success', is_error: false } as StreamJsonEvent);
	eq('the stopped turn is stopped', second.status, 'stopped');

	const third = s.addAssistantMessage();
	r.beginTurn(third);
	r.apply({ type: 'result', subtype: 'error_during_execution', is_error: true } as StreamJsonEvent);
	eq('the interrupt flag does not leak into the next turn', third.status, 'error');
}

console.log('J3. A trailing newline is not an extra line');
{
	// Emre's acceptance run, step 2: a three-line Write reported `+4 −0` and drew a fourth, empty,
	// green row. `split('\n')` on text that ends in a newline yields a trailing empty element that
	// is not a line. The counts are asserted rather than the DOM because both come from the same
	// array — the phantom row *is* the phantom line.
	const write = diffFromToolInput('Write', { file_path: '/vault/n.md', content: 'alpha\nbravo\ncharlie\n' });
	eq('a three-line file with a trailing newline counts three added', write ? diffStats(write).added : -1, 3);
	eq('...and removes nothing', write ? diffStats(write).removed : -1, 0);

	// Only one trailing empty element goes: a file really ending in a blank line still has it.
	const blankLast = diffFromToolInput('Write', { content: 'alpha\n\n' });
	eq('a genuine trailing blank line survives', blankLast ? diffStats(blankLast).added : -1, 2);

	const empty = diffFromToolInput('Write', { content: '' });
	eq('an empty file is zero lines, not one', empty ? diffStats(empty).added : -1, 0);

	// The same trap on both sides of an Edit: without the fix each side gains a phantom line and
	// they cancel out in the counts while both panes still draw an empty row.
	const edit = diffFromToolInput('Edit', { old_string: 'alpha\nbravo\n', new_string: 'alpha\nBRAVO\n' });
	eq('an Edit with trailing newlines removes one line', edit ? diffStats(edit).removed : -1, 1);
	eq('...and adds one', edit ? diffStats(edit).added : -1, 1);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
