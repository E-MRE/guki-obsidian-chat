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
 * K.  Phase 5a: the permission bridge, driven end to end — the real `PermissionBroker` talking to
 *     the real `mcp-permission-server.mjs` in a real process over a real unix socket, with this
 *     file playing the claude CLI. The server is outside `tsconfig` and outside eslint, so this is
 *     the only thing in the toolchain that looks at it at all.
 * L.  Phase 5a acceptance-run findings: a denial our own broker issued must not render as a tool
 *     failure, and the diff must not be drawn twice for one gated call.
 * M.  A real Stop-pressed-while-a-card-is-open turn, replayed from
 *     `docs/capture-phase5a-stop.jsonl`. §L's own cancellation checks answered the broker directly
 *     and missed the ordering that made the defect; this replays the CLI's real event order.
 * N.  Phase 5b: the permission policy — PLAN §2b's table and the Bash gate, over a real temp vault
 *     with a real symlink out of it, plus the broker end to end. Longer than any other section
 *     because an auto-allow is invisible: it produces no card, so every `allow` branch needs an
 *     assertion that names it. §N12 is the exception that proves the rule — the one decision the
 *     reader *does* see, and it was being shown wrong.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	ChatState,
	hasRenderableContent,
	orderedBlocks,
	type AssistantItem,
	type PermissionItem,
} from '../src/core/chat-state';
import { StreamReducer } from '../src/core/stream-reducer';
import { SessionManager } from '../src/core/session-manager';
import { PermissionBroker } from '../src/core/permission-broker';
import {
	deniedToolUseIds,
	isSystemInitEvent,
	mcpServerStatus,
	parseStreamJsonLine,
	type ResultEvent,
	type StreamJsonEvent,
	type SystemInitEvent,
} from '../src/cli/events';
import { startsExpanded, toolCategory, toolResultText, toolSummary } from '../src/core/tool-policy';
import { diffFromToolInput, diffStats, emptyPaneText } from '../src/ui/diff-view';
import { toolResultTitle, toolStatusText } from '../src/ui/tool-card';
import { permissionDiff } from '../src/ui/permission-card';
import { containsPath, permissionVerdict } from '../src/core/permission-policy';
import { FALLBACK_VAULT_PATH } from '../src/constants';
import { tokenizeCommand } from '../src/core/bash-whitelist';
import { createVaultPaths } from '../src/core/vault-path-resolver';

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

/**
 * `eq`, for a value that has to be computed from input that might make the code under test throw.
 *
 * A guard that stops a malformed event from throwing cannot be proven by asserting on its return
 * value alone: strip the guard and the code throws *before* the assertion runs, which kills the
 * harness and silently skips every section after it. Found while proving §K goes red.
 */
function eqCall<T>(name: string, produce: () => T, expected: T): void {
	let actual: T;
	try {
		actual = produce();
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${name} — threw: ${String(error)}`);
		return;
	}
	eq(name, actual, expected);
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

	// The two results that arrive with `is_error: true` — and are **not** failures.
	//
	// These two assertions used to read `toolIsError === true`, and they were wrong in exactly the
	// way Emre's Phase 5a acceptance rounds reported. This capture's own `result` event settles it:
	//
	//   "permission_denials": [{"tool_name": "WebSearch", "tool_use_id": "toolu_01QXoT…"},
	//                          {"tool_name": "WebSearch", "tool_use_id": "toolu_01KHHp…"}]
	//   "subtype": "success", "is_error": false
	//
	// The CLI is saying these were *declined*, on a turn it considers successful, and the result
	// text says so too ("Claude requested permissions use WebSearch, but you haven't granted it
	// yet"). The old expectation encoded the defect, so it changed when the defect did.
	//
	// This capture is also the evidence that the fix is not just about our own bridge: no
	// permission server was attached when it was taken, so these are **CLI-side** denials, and they
	// now render correctly for the same reason a bridge denial does.
	eq('slot 3 is a denial, not an error', tool1?.toolIsError, false);
	eq('slot 4 is a denial, not an error', tool2?.toolIsError, false);
	eq('...and slot 3 is marked as denied', tool1?.toolDenied, true);
	eq('...and so is slot 4', tool2?.toolDenied, true);
	check(
		'slot 3 result carries the denial message, not a blank box',
		tool1?.toolResultText?.includes("haven't granted it yet") === true,
		JSON.stringify(tool1?.toolResultText),
	);

	// The is_error override still exists — it is just not what these two blocks exercise any more.
	eq('WebSearch is collapsed by category', toolCategory('WebSearch'), 'collapsed');
	eq('a genuinely errored card still starts expanded', startsExpanded('WebSearch', true), true);
	eq('...and the successful one does not', startsExpanded('ToolSearch', false), false);
	// A denied card is not forced open: `startsExpanded` is asked with the block's own flag, which
	// the fix leaves false. Forcing it open would be the expand-on-error rule firing on something
	// that did not error.
	eq(
		'...and neither does a denied one',
		startsExpanded(tool1?.toolName, tool1?.toolIsError === true),
		false,
	);

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


// --- K. Phase 5a: the permission bridge -----------------------------------

/*
 * Everything below drives the **real** `PermissionBroker` and the **real**
 * `src/cli/mcp-permission-server.mjs`, in a real process, over a real unix socket — with this
 * harness standing in for the claude CLI. That is deliberate and it is the point of the section:
 * the server is outside `tsconfig` and outside eslint (it runs in Node, not in the renderer), so
 * nothing else in the toolchain looks at it at all. It only proves itself when it is run.
 *
 * The harness plays the CLI honestly: it reads the `mcp.json` the broker wrote, spawns whatever
 * `command`/`args`/`env` it finds there, and speaks MCP JSON-RPC over that process's stdio. So a
 * broken interpreter path, a wrong env name or a malformed config fails here rather than being
 * asserted about in the abstract.
 */

/**
 * Node's `require`, published where `src/cli/node-api.ts` looks for it. The production code
 * reaches Node through `window.require` because that is the only form that survives both lint
 * rules *and* the CJS bundle (trap 14, trap 15); in this harness `window` does not exist, so it is
 * created rather than the code under test being changed to suit the test.
 */
(globalThis as unknown as { window: unknown }).window = {
	require: createRequire(import.meta.url),
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

const PERM_TIMEOUT_MS = 10_000;

/**
 * An async queue over a newline-delimited JSON stream.
 *
 * `next()` resolves with `TIMED_OUT` rather than rejecting. "The CLI was never answered" is one of
 * the regressions this section exists to catch — a stranded JSON-RPC id is exactly what a broken
 * `cancelPending` produces — and a rejection would take the harness down instead of reporting it,
 * silently skipping every section after it.
 */
const TIMED_OUT = { __timedOut: true } as const;

function ndjsonQueue(stream: NodeJS.ReadableStream): {
	next(): Promise<Record<string, unknown>>;
	seen: Record<string, unknown>[];
} {
	const seen: Record<string, unknown>[] = [];
	const queued: Record<string, unknown>[] = [];
	const waiters: ((value: Record<string, unknown>) => void)[] = [];
	let buffer = '';

	stream.setEncoding('utf8');
	stream.on('data', (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim().length === 0) {
				continue;
			}
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			seen.push(parsed);
			const waiter = waiters.shift();
			if (waiter) {
				waiter(parsed);
			} else {
				queued.push(parsed);
			}
		}
	});

	return {
		seen,
		next(): Promise<Record<string, unknown>> {
			const ready = queued.shift();
			if (ready) {
				return Promise.resolve(ready);
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					resolve(TIMED_OUT as unknown as Record<string, unknown>);
				}, PERM_TIMEOUT_MS);
				waiters.push((value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
		},
	};
}

/**
 * A real directory standing in for the vault, with real files and a real symlink out of it.
 *
 * From Phase 5b the broker judges every request against a vault root, so the bridge sections need
 * one that exists — and §N needs one it can point `realpath` at. Everything §K, §L and §M send uses
 * `/vault/...`, which is *outside* this root, so those sections keep asking exactly as they did
 * before the policy existed; that is why their assertions are untouched.
 *
 * Layout:
 *   <vault>/notes/todo.md      an ordinary note
 *   <vault>/.git/config        inside the vault, but not covered by "git makes it reversible"
 *   <vault>/escape             a symlink pointing at <outside>, which is not in the vault at all
 *   <outside>/secret.txt       the thing a symlink or a `..` is trying to reach
 */
const POLICY_VAULT = (() => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-vault-')));
	const root = join(base, 'vault');
	const outside = join(base, 'outside');
	mkdirSync(join(root, 'notes'), { recursive: true });
	mkdirSync(join(root, '.git'), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, 'notes', 'todo.md'), '- one\n');
	writeFileSync(join(root, '.git', 'config'), '[core]\n');
	writeFileSync(join(outside, 'secret.txt'), 'secret\n');
	symlinkSync(outside, join(root, 'escape'));
	return { base, root, outside };
})();

/** The `content[0].text` of an MCP tool result, parsed. This is where the verdict lives. */
function verdictOf(response: Record<string, unknown>): Record<string, unknown> | null {
	const result = response.result as { content?: { type?: string; text?: string }[] } | undefined;
	const text = result?.content?.[0]?.text;
	if (typeof text !== 'string') {
		return null;
	}
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * A `SessionManager`-shaped app for the broker: a config dir and an adapter that serves the real
 * server source. `readPaths` records what the broker asked for, so the path it builds is asserted
 * rather than assumed.
 */
function brokerApp(readPaths: string[]): never {
	return {
		vault: {
			configDir: '.obsidian',
			adapter: {
				read: (path: string) => {
					readPaths.push(path);
					return Promise.resolve(
						readFileSync(join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs'), 'utf8'),
					);
				},
			},
		},
	} as never;
}

/** Starts a broker and, playing the CLI, spawns the server exactly as its `mcp.json` describes. */
async function startBridge(): Promise<{
	broker: PermissionBroker;
	state: ChatState;
	child: ReturnType<typeof spawn>;
	rpc: ReturnType<typeof ndjsonQueue>;
	config: Record<string, unknown>;
	readPaths: string[];
	send: (message: unknown) => void;
	stop: () => void;
}> {
	const readPaths: string[] = [];
	const state = new ChatState();
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	await broker.start();

	const configPath = broker.cliArgs[1] ?? '';
	const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
	const entry = (config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)[
		'guki-perm'
	];

	const child = spawn(entry.command, entry.args, {
		env: { ...process.env, ...entry.env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const rpc = ndjsonQueue(child.stdout);
	// The server writes diagnostics to stderr and must never write them to stdout; drained so the
	// pipe cannot fill and block the process.
	child.stderr.resume();

	return {
		broker,
		state,
		child,
		rpc,
		config,
		readPaths,
		send: (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`),
		stop: () => {
			broker.dispose();
			child.kill('SIGKILL');
		},
	};
}

/**
 * Resolves when the child has exited, or rejects on timeout.
 *
 * `signal` is reported alongside `code` because they are mutually exclusive and which one arrives
 * says *how* the server died — which is the whole difference between the three teardown mechanisms
 * these checks separate (PHASE5A-STATE D3).
 */
function waitForExit(
	child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode, timedOut: false });
	}
	// Resolves rather than rejects on timeout. "The server did not exit" is exactly the regression
	// these checks exist to catch, and a rejection here takes the whole harness down with it —
	// found while proving this section goes red, where reverting the socket-close handler crashed
	// the run instead of reporting it and silently skipped every section after it.
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			resolve({ code: null, signal: null, timedOut: true });
		}, PERM_TIMEOUT_MS);
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, timedOut: false });
		});
	});
}

/**
 * Spawns the real server against a **bare** socket server rather than the broker, so the teardown
 * paths can be exercised one at a time. `dispose()` fires all three at once; a check that only ever
 * sees them together cannot tell which of them is actually load-bearing.
 */
async function spawnServerAgainstBareSocket(): Promise<{
	child: ReturnType<typeof spawn>;
	rpc: ReturnType<typeof ndjsonQueue>;
	socket: Promise<import('node:net').Socket>;
	close: () => void;
}> {
	const dir = mkdtempSync(join(tmpdir(), 'guki-checks-perm-'));
	const socketPath = join(dir, 'perm.sock');

	let resolveSocket: (value: import('node:net').Socket) => void = () => undefined;
	const socket = new Promise<import('node:net').Socket>((resolve) => (resolveSocket = resolve));
	const server = createServer((connection) => resolveSocket(connection));
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	const child = spawn(process.execPath, [join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs')], {
		env: { ...process.env, GUKI_PERM_SOCKET: socketPath, GUKI_PERM_TOKEN: 'test-token' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const rpc = ndjsonQueue(child.stdout);
	child.stderr.resume();

	return {
		child,
		rpc,
		socket,
		close: () => {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

console.log('K1. The generated mcp.json is the one PLAN Phase 5 task 3 specifies');
{
	const bridge = await startBridge();

	// No `manifest.dir` was given, so this is the reconstructed fallback.
	eq(
		'with no manifest.dir, the path is rebuilt from the config dir and the plugin id',
		bridge.readPaths[0],
		'.obsidian/plugins/guki-chat/mcp-permission-server.mjs',
	);

	const args = bridge.broker.cliArgs;
	eq('--mcp-config is passed', args[0], '--mcp-config');
	check('...with an absolute path', args[1]?.startsWith('/') === true, args[1]);
	eq('--permission-prompt-tool is passed', args[2], '--permission-prompt-tool');
	eq('...naming our server and tool', args[3], 'mcp__guki-perm__permission_prompt');

	// Both are absences, and both are the difference between a working gate and no gate at all:
	// `acceptEdits` auto-approves Bash (RESEARCH B5b), `--strict-mcp-config` drops Emre's own
	// servers. An absence cannot be spotted by reading the happy path, so it is asserted.
	check('no --permission-mode flag at all', !args.includes('--permission-mode'), args.join(' '));
	check('no --strict-mcp-config', !args.includes('--strict-mcp-config'), args.join(' '));

	const entry = (bridge.config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)[
		'guki-perm'
	];
	// A bare `node` fails silently — the stdio server never spawns and never appears in the tool
	// list, with no error of its own (RESEARCH B5, trap 7).
	check('the interpreter is an absolute path, never a bare name', entry.command.startsWith('/'), entry.command);
	check('...and it is a real executable', existsSync(entry.command), entry.command);
	check('the server script exists where mcp.json points', existsSync(entry.args[0] ?? ''), entry.args[0]);
	check('the socket path is handed over in the env', typeof entry.env.GUKI_PERM_SOCKET === 'string');
	check('...and so is the token', (entry.env.GUKI_PERM_TOKEN ?? '').length > 0);

	bridge.stop();
}

console.log("K1b. manifest.dir wins over the reconstructed path");
{
	// `manifest.dir` is what Obsidian actually knows; the fallback hardcodes both the config
	// directory and the plugin id and is only there because the field is optional. If the two ever
	// disagree — a renamed plugin folder, a non-default config dir — the real one has to be used,
	// and the failure is silent: the wrong path just fails to read and the gate never starts.
	//
	// No server is spawned here: the broker only writes files and listens, and the *CLI* is what
	// spawns the server. So this costs a socket, not a process.
	const readPaths: string[] = [];
	const broker = new PermissionBroker(
		brokerApp(readPaths),
		new ChatState(),
		POLICY_VAULT.root,
		'Config/plugins/renamed-guki',
	);
	await broker.start();
	eq(
		'the supplied plugin folder is the one read from',
		readPaths[0],
		'Config/plugins/renamed-guki/mcp-permission-server.mjs',
	);
	broker.dispose();
}

console.log('K2. The MCP handshake, against the real server process');
{
	const bridge = await startBridge();

	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
	const init = await bridge.rpc.next();
	check('initialize is answered at all', init !== TIMED_OUT, JSON.stringify(init));
	eq('initialize is answered on the right id', init.id, 1);
	const initResult = init.result as { protocolVersion?: string; serverInfo?: { name?: string } };
	eq('the requested protocol version is echoed', initResult.protocolVersion, '2025-11-25');
	eq('the server names itself', initResult.serverInfo?.name, 'guki-perm');

	// A notification carries no id and must draw no reply at all; a reply to it would be a
	// protocol error the CLI reports as a broken server.
	bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	const list = await bridge.rpc.next();
	eq('the notification drew no response — tools/list is the next reply', list.id, 2);
	const tools = (list.result as { tools?: { name?: string }[] }).tools ?? [];
	eq('exactly one tool is exposed', tools.length, 1);
	eq('...and it is the one --permission-prompt-tool names', tools[0]?.name, 'permission_prompt');

	bridge.stop();
}

console.log('K3. Allow: the request reaches the panel and the verdict reaches the CLI');
{
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	const input = { file_path: '/vault/note.md', content: 'alpha\nbravo\n' };
	bridge.send({
		jsonrpc: '2.0',
		id: 7,
		method: 'tools/call',
		params: {
			name: 'permission_prompt',
			// The three fields the CLI actually sends, verbatim (RESEARCH B5, PHASE5A-STATE F2).
			arguments: { tool_name: 'Write', input, tool_use_id: 'toolu_01Bc' },
		},
	});

	// The card is what proves the request crossed the socket. Polled rather than awaited on a
	// promise: the broker's only output is the ChatState item.
	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('a permission card was added to the transcript', card !== undefined);
	eq('it carries the tool name', card?.toolName, 'Write');
	eq('it carries the tool_use_id, so it can be tied to the tool card', card?.toolUseId, 'toolu_01Bc');
	eq('it starts pending', card?.status, 'pending');
	// Content, not shape: the card renders its body out of this, so an input that arrived empty
	// would be a blank approval dialog — the Phase 3 empty-block defect in a new place.
	eq(
		'the tool input survived the socket intact',
		JSON.stringify(card?.input),
		JSON.stringify(input),
	);
	// The whole point of a permission prompt: nothing is answered until the reader answers.
	eq('nothing was written to the CLI yet', bridge.rpc.seen.length, 1);

	bridge.broker.decide(card?.requestId ?? '', 'allow');
	const answer = await bridge.rpc.next();
	check('a verdict came back at all', answer !== TIMED_OUT, JSON.stringify(answer));
	eq('the verdict comes back on the tools/call id', answer.id, 7);
	const verdict = verdictOf(answer);
	eq('behavior is allow', verdict?.behavior, 'allow');
	eq(
		'updatedInput echoes the original input',
		JSON.stringify(verdict?.updatedInput),
		JSON.stringify(input),
	);
	check('no deny message rode along', verdict?.message === undefined);
	eq('the card closed as allowed', card?.status, 'allowed');

	bridge.stop();
}

console.log('K4. Deny carries a message, and is not an error');
{
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	bridge.send({
		jsonrpc: '2.0',
		id: 9,
		method: 'tools/call',
		params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } },
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	// A request with no `tool_use_id` still has to produce a usable card: the field is optional on
	// the wire and a card that needed it would silently not appear.
	check('a card appears even with no tool_use_id', card !== undefined);
	eq('...and the field is simply absent', card?.toolUseId, undefined);

	bridge.broker.decide(card?.requestId ?? '', 'deny', 'The user denied this tool call in Obsidian.');
	const answer = await bridge.rpc.next();
	check('a verdict came back at all', answer !== TIMED_OUT, JSON.stringify(answer));
	const verdict = verdictOf(answer);
	eq('behavior is deny', verdict?.behavior, 'deny');
	// The contract requires a message on a denial; an empty one leaves the model with nothing to
	// explain to the reader (RESEARCH B5).
	check('a non-empty message is included', ((verdict?.message ?? '') as string).length > 0, JSON.stringify(verdict));
	eq('the card closed as denied', card?.status, 'denied');

	bridge.stop();
}

console.log('K5. A turn that ends first answers the request rather than stranding it');
{
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	bridge.send({
		jsonrpc: '2.0',
		id: 11,
		method: 'tools/call',
		params: { name: 'permission_prompt', arguments: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } },
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('the request is open', card?.status === 'pending');
	check('the broker knows it is holding one', bridge.broker.hasPending);

	// Stop, in effect: the turn ended underneath an open request.
	bridge.broker.cancelPending('The turn was stopped before the request was answered.');
	const answer = await bridge.rpc.next();
	check('the CLI is answered rather than left waiting', answer !== TIMED_OUT, JSON.stringify(answer));
	eq('...on the id it is holding', answer.id, 11);
	eq('...as a denial, because nothing was approved', verdictOf(answer)?.behavior, 'deny');
	// `cancelled`, not `denied`: the reader did not deny anything, and the card must not read as a
	// decision they made (PHASE5A-STATE D5).
	eq('the card reads as unanswered, not as a denial', card?.status, 'cancelled');
	check('nothing is left pending', !bridge.broker.hasPending);

	bridge.stop();
}

console.log('K5b. A socket that does not know the token gets nothing');
{
	// The temp directory is already 0700, so this is the second line of defence rather than the
	// first — but it is also what makes a reported pid safe to SIGTERM on the way out, so it is
	// worth proving rather than assuming.
	const bridge = await startBridge();
	const socketPath = join(dirname(bridge.broker.cliArgs[1] ?? ''), 'perm.sock');

	const intruder = createConnection(socketPath);
	await new Promise<void>((resolve) => intruder.once('connect', resolve));
	intruder.write(`${JSON.stringify({ type: 'hello', token: 'wrong-token', pid: 999999 })}\n`);
	intruder.write(
		`${JSON.stringify({ type: 'request', id: 'x-1', tool_name: 'Write', input: { file_path: '/vault/x.md' } })}\n`,
	);
	// Raced against a timer rather than simply awaited: an intruder that is *not* dropped never
	// emits 'close', so a bare await would hang the harness and be reported as a pass by anything
	// that greps for failures. Being tolerated is the regression; it has to surface as one.
	const dropped = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), PERM_TIMEOUT_MS);
		intruder.once('close', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});

	check('the connection was dropped', dropped && intruder.destroyed);
	eq(
		'and its request never became a card',
		bridge.state.items.filter((item) => item.kind === 'permission').length,
		0,
	);
	intruder.destroy();
	bridge.stop();
}

console.log('K6. dispose() kills the server process — the quit acceptance criterion, offline');
{
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();
	check('the server is running', bridge.child.exitCode === null);

	// Exactly what `onunload` / `workspace.on('quit')` do. Nothing here kills the child directly —
	// this asserts the server dies of the *broker* going away, which is what makes `ps` come back
	// empty after Obsidian quits (trap 9: two processes to clean up, not one).
	//
	// The outcome is deliberately not pinned to a code or a signal. `dispose()` fires all three
	// teardown mechanisms at once and they race; the first version of this check demanded `code 0`
	// and failed because SIGTERM won that particular race — proving only that the check was
	// asserting on the wrong thing. What the acceptance criterion asks is that the process is gone.
	// Which mechanism did it is pinned separately, one fixture each, in K7 and K8.
	bridge.broker.dispose();
	const exit = await waitForExit(bridge.child);
	check('the server is gone', !exit.timedOut, JSON.stringify(exit));
}

console.log('K7. The server dies with the panel even when dispose() never runs');
{
	// The case `dispose()` cannot cover: Obsidian was force-quit or the renderer crashed, so no
	// teardown ran and nobody sent a SIGTERM. The socket closing is the only signal left, and it
	// has to be enough on its own — otherwise a crashed Obsidian leaves an orphan behind.
	const harness = await spawnServerAgainstBareSocket();
	const socket = await harness.socket;
	harness.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
	const init = await harness.rpc.next();
	eq('the server is serving', init.id, 1);

	socket.destroy();
	const exit = await waitForExit(harness.child);
	check('losing the panel socket alone ends the server', !exit.timedOut, JSON.stringify(exit));
	eq('...cleanly', exit.code, 0);
	eq('...and not by a signal, so this really was the socket path', exit.signal, null);
	harness.close();
}

console.log('K8. The server dies with the CLI');
{
	// The third mechanism, from the other side: the CLI exited, so the server has nothing left to
	// serve. Without this an orphan survives every restart of the subprocess, not just of Obsidian.
	const harness = await spawnServerAgainstBareSocket();
	const socket = await harness.socket;
	const hello = JSON.parse((await new Promise<string>((resolve) => socket.once('data', (d) => resolve(String(d))))).trim()) as {
		type?: string;
		token?: string;
		pid?: number;
	};
	eq('the server introduces itself', hello.type, 'hello');
	eq('...with the token it was given', hello.token, 'test-token');
	// The pid is what `dispose()` sends SIGTERM to; without it the backstop has no target.
	eq('...and its own pid', hello.pid, harness.child.pid);

	harness.child.stdin.end();
	const exit = await waitForExit(harness.child);
	check('stdin ending ends the server', !exit.timedOut, JSON.stringify(exit));
	eq('...cleanly', exit.code, 0);
	harness.close();
}

console.log('K9. With no panel listening, the server refuses to serve at all');
{
	// Fail closed, and fail loudly. A server that started but could not reach the plugin would
	// report `connected` to the CLI and then silently deny everything — the "no approval gate,
	// quietly" state PLAN task 9 forbids. So it exits before answering `initialize`, which makes it
	// absent from `system/init.mcp_servers`, which the startup self-check reports (K9).
	const child = spawn(process.execPath, [join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs')], {
		env: {
			...process.env,
			GUKI_PERM_SOCKET: join(tmpdir(), `guki-nonexistent-${String(Date.now())}.sock`),
			GUKI_PERM_TOKEN: 'irrelevant',
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const rpc = ndjsonQueue(child.stdout);
	child.stderr.resume();
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);

	const exit = await waitForExit(child);
	check('the server exited rather than serving', !exit.timedOut, JSON.stringify(exit));
	check('...and non-zero', exit.code !== 0 && !exit.timedOut, String(exit.code));
	eq('...without answering anything on stdout', rpc.seen.length, 0);
}

console.log('K10. mcpServerStatus, over the real init event from the capture');
{
	// The real `system/init` from `docs/capture-phase4-tools.jsonl`, so the field names are the
	// ones the CLI actually sends rather than the ones we remember.
	const capture4 = readFileSync(join(process.cwd(), 'docs', 'capture-phase4-tools.jsonl'), 'utf8');
	let init: SystemInitEvent | null = null;
	for (const line of capture4.split('\n')) {
		const event = parseStreamJsonLine(line);
		if (event && isSystemInitEvent(event)) {
			init = event;
			break;
		}
	}
	check('the capture has a system/init', init !== null);

	eq('a connected server reads as connected', mcpServerStatus(init!, 'codebase-memory-mcp'), 'connected');
	// `needs-auth` is a third status, not a synonym for connected. Both claude.ai servers sit in it
	// permanently on this machine, which is why the self-check compares against 'connected'
	// exactly rather than testing for absence of a failure.
	eq('needs-auth is reported as itself', mcpServerStatus(init!, 'claude.ai Focus MCP'), 'needs-auth');
	// The trap-7 case: a stdio server that failed to spawn is not listed at all.
	eq('a server that never registered reads as null', mcpServerStatus(init!, 'guki-perm'), null);

	// Off-the-wire shapes that must read as "not there" rather than throw.
	eqCall(
		'a missing list reads as null',
		() => mcpServerStatus({ type: 'system', subtype: 'init' }, 'guki-perm'),
		null,
	);
	eqCall(
		'a non-array list reads as null',
		() =>
			mcpServerStatus(
				{ type: 'system', subtype: 'init', mcp_servers: 'nope' } as unknown as SystemInitEvent,
				'guki-perm',
			),
		null,
	);
	eqCall(
		'a null entry is skipped, not dereferenced',
		() =>
			mcpServerStatus(
				{
					type: 'system',
					subtype: 'init',
					mcp_servers: [null, { name: 'guki-perm', status: 'connected' }],
				} as unknown as SystemInitEvent,
				'guki-perm',
			),
		'connected',
	);
	eqCall(
		'an entry with no status reads as null, not as connected',
		() => mcpServerStatus({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'guki-perm' }] }, 'guki-perm'),
		null,
	);
}

console.log('K11. The startup self-check refuses input when the gate is missing');
{
	// One fixture per outcome, not one shared one: a check that only ever sees the failing path
	// proves the alarm fires, never that it stays quiet when it should.
	const good = new SessionManager(app);
	stub(good, () => Promise.resolve(true), []);
	const goodReducer = (good as unknown as { reducer: StreamReducer }).reducer;
	goodReducer.apply({
		type: 'system',
		subtype: 'init',
		mcp_servers: [{ name: 'guki-perm', status: 'connected' }],
	} as StreamJsonEvent);
	eq('a connected gate leaves the composer alone', good.blocked, null);
	good.dispose();

	for (const [label, servers] of [
		['absent', [{ name: 'codebase-memory-mcp', status: 'connected' }]],
		['failed', [{ name: 'guki-perm', status: 'failed' }]],
		['needs-auth', [{ name: 'guki-perm', status: 'needs-auth' }]],
	] as const) {
		const manager = new SessionManager(app);
		const written: string[] = [];
		stub(manager, () => Promise.resolve(true), written);

		manager.send('hello');
		for (let i = 0; i < 8; i += 1) {
			await Promise.resolve();
		}
		eq(`[${label}] the first message went out`, written.length, 1);

		const reducer = (manager as unknown as { reducer: StreamReducer }).reducer;
		reducer.apply({ type: 'system', subtype: 'init', mcp_servers: servers } as StreamJsonEvent);

		check(`[${label}] input is refused`, manager.blocked !== null, String(manager.blocked));
		const turn = manager.state.items.find((i) => i.kind === 'assistant') as AssistantItem;
		eq(`[${label}] the turn in flight was failed, not left hanging`, turn.status, 'error');
		const notice = manager.state.items.find((i) => i.kind === 'notice');
		check(`[${label}] a notice says what happened`, notice !== undefined);
		check(
			`[${label}] ...and names the server`,
			(notice as { detail?: string } | undefined)?.detail?.includes('guki-perm') === true,
			JSON.stringify((notice as { detail?: string } | undefined)?.detail),
		);

		// The refusal has to actually refuse. A blocked panel that still queues messages would be
		// a CLI running with no approval gate — the exact state the check exists to prevent.
		manager.send('and another');
		for (let i = 0; i < 8; i += 1) {
			await Promise.resolve();
		}
		eq(`[${label}] a message sent while blocked never reaches the CLI`, written.length, 1);

		// A second init on the same fault must not stack a second notice.
		reducer.apply({ type: 'system', subtype: 'init', mcp_servers: servers } as StreamJsonEvent);
		eq(
			`[${label}] the fault is reported once, not once per turn`,
			manager.state.items.filter((i) => i.kind === 'notice').length,
			1,
		);
		manager.dispose();
	}
}

console.log('K12. A turn ending is what tells the broker to answer an open request');
{
	// K5 proves `cancelPending` answers the CLI; this proves anything ever calls it. They are
	// separate guards and they fail separately — removing the wiring left every K5 assertion green,
	// because K5 calls the broker directly. In Obsidian this is the whole of the Stop path: the CLI
	// cannot emit a `result` while it is blocked on the bridge, so a turn that ends with a card
	// still open ended because the user pressed Stop.
	const manager = new SessionManager(app);
	const reasons: string[] = [];
	(manager as unknown as { broker: { cancelPending(reason: string): void; dispose(): void } }).broker = {
		cancelPending: (reason: string) => reasons.push(reason),
		dispose: () => undefined,
	};
	stub(manager, () => Promise.resolve(true), []);

	manager.send('write me a note');
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}
	eq('nothing was cancelled while the turn was running', reasons.length, 0);

	const reducer = (manager as unknown as { reducer: StreamReducer }).reducer;
	reducer.noteInterruptSent();
	reducer.apply({ type: 'result', subtype: 'success', is_error: false } as StreamJsonEvent);

	eq('the turn ending reached the broker', reasons.length, 1);
	check('...with a reason the model can be told', (reasons[0] ?? '').length > 0, JSON.stringify(reasons[0]));
	manager.dispose();
}

// --- L. Phase 5a acceptance-run findings ----------------------------------

console.log('L1. A denial our own broker issued is not a tool failure');
{
	// Emre's acceptance run, step 3. The CLI reports a call the reader declined as a `tool_result`
	// with `is_error: true` — byte for byte what a tool that genuinely failed produces. Reading the
	// flag alone painted the red "Error" badge on the Write card while the approval card, one row
	// below, correctly said "Denied. The turn continues." Trap 6, applied at the turn level
	// (`applyResult`) but not at the card level.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);

	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: {
			content: [
				{
					type: 'tool_use',
					id: 'toolu_denied',
					name: 'Write',
					input: { file_path: '/vault/n.md', content: 'alpha\n' },
				},
			],
		},
	} as StreamJsonEvent);

	// The bridge asked, and the reader said no.
	r.notePermissionRequested('toolu_denied');
	r.notePermissionDenied('toolu_denied');

	r.apply({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_denied',
					is_error: true,
					content: 'The user doesn\'t want to take this action right now.',
				},
			],
		},
	} as StreamJsonEvent);

	const block = orderedBlocks(turn)[0];
	eq('the block is the Write call', block?.toolName, 'Write');
	// The assertion the defect broke. `is_error` on the wire is `true`; the card must not be red.
	eq('is_error: true from our own denial does NOT set the error flag', block?.toolIsError, false);
	eq('...it is recorded as a denial instead', block?.toolDenied, true);
	// The result text still has to arrive — suppressing the badge must not suppress the message
	// that explains what happened.
	check(
		'the explanation is still shown',
		(block?.toolResultText?.length ?? 0) > 0,
		JSON.stringify(block?.toolResultText),
	);
	eq('and the tool is no longer pending', block?.toolPending, false);

	// A denied tool is not a failed turn either — the half that already worked, asserted so a fix
	// on one side cannot quietly regress the other.
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1 } as StreamJsonEvent);
	eq('the turn completes normally', turn.status, 'complete');
	eq('with no error text', turn.errorText, undefined);
}

console.log('L2. A tool that really failed is still an error');
{
	// The other half, and the reason this is not a blanket "ignore is_error on tool results".
	// A genuine failure has to keep its badge; the only thing that separates the two is whether we
	// denied it, which is not on the wire at all.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', id: 'toolu_broke', name: 'Read', input: { file_path: '/nope' } }],
		},
	} as StreamJsonEvent);
	r.apply({
		type: 'user',
		message: {
			content: [
				{ type: 'tool_result', tool_use_id: 'toolu_broke', is_error: true, content: 'ENOENT' },
			],
		},
	} as StreamJsonEvent);

	const block = orderedBlocks(turn)[0];
	eq('an undenied failure keeps its error flag', block?.toolIsError, true);
	eq('...and is not marked as denied', block?.toolDenied, false);
	// The error override still forces the card open (PLAN §2), which is what `startsExpanded` is
	// asked here rather than asserted about the DOM.
	eq('the card still opens itself on a real error', startsExpanded('Read', true), true);
}

console.log('L3. A denial for one call does not touch another');
{
	// Matched by `tool_use_id`, never by ordering — the same rule the tool results already follow.
	// Two Writes in one turn, one denied and one allowed, is the shape that catches a set used as
	// a per-turn boolean.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	for (const id of ['toolu_a', 'toolu_b']) {
		r.apply({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/vault/${id}.md`, content: 'x\n' } }] },
		} as StreamJsonEvent);
	}
	r.notePermissionRequested('toolu_a');
	r.notePermissionRequested('toolu_b');
	r.notePermissionDenied('toolu_b');

	r.apply({
		type: 'user',
		message: {
			content: [
				{ type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'declined' },
				{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'File created successfully.' },
			],
		},
	} as StreamJsonEvent);

	const blocks = orderedBlocks(turn);
	const allowed = blocks.find((b) => b.toolUseId === 'toolu_a');
	const denied = blocks.find((b) => b.toolUseId === 'toolu_b');
	eq('the allowed call is not denied', allowed?.toolDenied, false);
	eq('...and not an error', allowed?.toolIsError, false);
	eq('the denied call is denied', denied?.toolDenied, true);
	eq('...and still not an error', denied?.toolIsError, false);
}

console.log('L4. The flags survive the block being replaced, in either order');
{
	// `applyAssistant` replaces the whole block, and the ordering between the bridge call and that
	// event is not something we control — Phase 0 saw the `assistant` event first, but "usually
	// first" is not a contract. Both orders are driven here because only one of them exercises the
	// carry-over and only the other exercises the stamp-on-create.
	for (const bridgeFirst of [true, false]) {
		const label = bridgeFirst ? 'bridge first' : 'assistant first';
		const s = new ChatState();
		const r = new StreamReducer(s);
		const turn = s.addAssistantMessage();
		r.beginTurn(turn);
		r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
		// The streamed opening, which is what registers the id before any authoritative event.
		r.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'toolu_x', name: 'Write' },
			},
		} as StreamJsonEvent);

		const assistant = () =>
			r.apply({
				type: 'assistant',
				message: {
					content: [
						{ type: 'tool_use', id: 'toolu_x', name: 'Write', input: { file_path: '/vault/x.md', content: 'x\n' } },
					],
				},
			} as StreamJsonEvent);

		if (bridgeFirst) {
			r.notePermissionRequested('toolu_x');
			r.notePermissionDenied('toolu_x');
			assistant();
		} else {
			assistant();
			r.notePermissionRequested('toolu_x');
			r.notePermissionDenied('toolu_x');
		}

		const block = orderedBlocks(turn)[0];
		eq(`[${label}] the request flag survived`, block?.toolPermissionRequested, true);
		eq(`[${label}] the denial survived`, block?.toolDenied, true);

		r.apply({
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: 'declined' }],
			},
		} as StreamJsonEvent);
		eq(`[${label}] and the result is not an error`, block?.toolIsError, false);
	}
}

console.log('L5. The flags do not leak into the next turn');
{
	// Both sets are per-turn. A denial in turn 1 silencing a genuine failure in turn 2 would be the
	// worst possible version of this fix: the badge exists to be believed.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const first = s.addAssistantMessage();
	r.beginTurn(first);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'toolu_same', name: 'Write', input: {} }] },
	} as StreamJsonEvent);
	r.notePermissionDenied('toolu_same');
	r.apply({ type: 'result', subtype: 'success', is_error: false } as StreamJsonEvent);

	const second = s.addAssistantMessage();
	r.beginTurn(second);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'toolu_same', name: 'Write', input: {} }] },
	} as StreamJsonEvent);
	r.apply({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', tool_use_id: 'toolu_same', is_error: true, content: 'disk full' }],
		},
	} as StreamJsonEvent);

	const block = orderedBlocks(second)[0];
	eq('a real failure in the next turn is still an error', block?.toolIsError, true);
	eq('...and is not marked as denied', block?.toolDenied, false);
}

console.log('L6. Stop with a card open reaches the tool card, not just the permission card');
{
	// The end-to-end version of step 6, through the real broker and the real server: the reader
	// never answered, the broker denies on their behalf, and the tool card must show that as an
	// outcome rather than as a failure.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	const denials: string[] = [];
	bridge.broker.onDenied = (toolUseId: string) => denials.push(toolUseId);

	bridge.send({
		jsonrpc: '2.0',
		id: 21,
		method: 'tools/call',
		params: {
			name: 'permission_prompt',
			arguments: { tool_name: 'Write', input: { file_path: '/vault/n.md', content: 'x\n' }, tool_use_id: 'toolu_stop' },
		},
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('the card is open', card?.status === 'pending');

	bridge.broker.cancelPending('The turn was stopped before the request was answered.');
	const answer = await bridge.rpc.next();
	check('the CLI was answered', answer !== TIMED_OUT, JSON.stringify(answer));
	eq('the card reads as unanswered', card?.status, 'cancelled');
	// The bit the defect was missing: the same event has to reach the tool card too.
	eq('the tool_use_id was handed on for the tool card', denials.join(','), 'toolu_stop');

	bridge.stop();
}

console.log('L6b. Deny and Allow are told apart on the way to the tool card');
{
	// The commonest path of all, and the one Emre's step 3 exercises: the reader presses Deny.
	// L6 covers the Stop path and they are separate branches in the broker — removing this one left
	// every other L check green.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	const denied: string[] = [];
	const requested: string[] = [];
	bridge.broker.onDenied = (toolUseId: string) => denied.push(toolUseId);
	bridge.broker.onRequested = (toolUseId: string) => requested.push(toolUseId);

	const ask = (id: number, toolUseId: string) =>
		bridge.send({
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: {
				name: 'permission_prompt',
				arguments: { tool_name: 'Write', input: { file_path: `/vault/${toolUseId}.md`, content: 'x\n' }, tool_use_id: toolUseId },
			},
		});

	const cardFor = async (index: number): Promise<PermissionItem | undefined> => {
		for (let i = 0; i < 200; i += 1) {
			const cards = bridge.state.items.filter((item) => item.kind === 'permission') as PermissionItem[];
			if (cards.length > index) {
				return cards[index];
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return undefined;
	};

	ask(41, 'toolu_yes');
	const first = await cardFor(0);
	bridge.broker.decide(first?.requestId ?? '', 'allow');
	await bridge.rpc.next();
	// An allowed call is going to succeed; marking it denied would put a "Denied" badge on a file
	// that really was written.
	eq('Allow hands nothing to the denial path', denied.length, 0);

	ask(42, 'toolu_no');
	const second = await cardFor(1);
	bridge.broker.decide(second?.requestId ?? '', 'deny', 'declined');
	await bridge.rpc.next();
	eq('Deny hands the id on, so the tool card can stop reading it as a failure', denied.join(','), 'toolu_no');

	// Both calls were announced when their cards appeared — that is what suppresses the duplicate
	// diff, and it happens regardless of the verdict.
	eq('both requests were announced', requested.join(','), 'toolu_yes,toolu_no');

	bridge.stop();
}

console.log('L7. A request with no tool_use_id cannot mark a tool card');
{
	// Nothing to join to. Guessing a block would put a "Denied" badge on an unrelated tool, which
	// is worse than the missing badge — so the callbacks stay silent and the card falls back to the
	// pre-fix behaviour for that one call.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	const seen: string[] = [];
	bridge.broker.onRequested = (toolUseId: string) => seen.push(toolUseId);
	bridge.broker.onDenied = (toolUseId: string) => seen.push(toolUseId);

	bridge.send({
		jsonrpc: '2.0',
		id: 31,
		method: 'tools/call',
		// `rm -rf /` rather than the `ls` this used to send: from Phase 5b `ls` clears the whitelist
		// and is auto-allowed, which would produce no card at all and make this section assert on a
		// card that was never meant to exist. What is under test here is the *absence* of an id
		// handoff, so the command only has to be one the policy asks about.
		params: { name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } } },
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('the card still appears', card !== undefined);
	bridge.broker.decide(card?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();

	eq('no id was ever handed on', seen.length, 0);
	eq('...and the card itself still resolved', card?.status, 'denied');
	bridge.stop();
}

console.log('L8. The permission card owns the diff; the tool card stops repeating it');
{
	// Finding 2. Both surfaces derive their body from the same `diffFromToolInput`, so before the
	// fix a permission-gated Write drew the identical Before/After twice — one passive above, one
	// actionable below. Asserted on the parse, not on the DOM: the duplicate *is* the second parse.
	const input = { file_path: '/vault/n.md', content: 'alpha\nbravo\n' };
	const diff = diffFromToolInput('Write', input);
	check('the approval card still has a diff to show', diff !== null);
	// The path is the half the tool card never rendered and the permission card must.
	eq('...including the target path', diff?.path, '/vault/n.md');
	eq('...and the content', diff ? diffStats(diff).added : -1, 2);

	// `renderBody` asks for the diff only when the call was *not* bridged. The condition itself is
	// one line in the card, so what is asserted here is the parse it guards: a bridged call must
	// still have a diff available (the approval card needs it) while the tool card declines to draw
	// a second one. `toolCardDiffFor` mirrors the card's own expression — see the note below.
	const bridgedDiff = (block: { toolPermissionRequested?: boolean }) =>
		block.toolPermissionRequested === true ? null : diffFromToolInput('Write', input);
	eq('a bridged call yields no second diff', bridgedDiff({ toolPermissionRequested: true }), null);
	check('an unbridged call still gets its diff', bridgedDiff({}) !== null);
}

console.log('L9. The words the reader actually sees, from the shipped card code');
{
	// `toolStatusText` and `toolResultTitle` are where "a denial is not a failure" stops being a
	// flag and becomes something on screen. They are pure functions of a block, so they are driven
	// directly — restating the condition in the harness would keep passing against a card that had
	// been changed back, which is the trap L8's first draft fell into.
	const base = { index: 0, kind: 'tool_use', text: '', final: true, toolName: 'Write' } as const;

	eq(
		'a bridged call waiting on the reader says so, instead of "Running…"',
		toolStatusText({ ...base, toolPending: true, toolPermissionRequested: true }),
		'Waiting for approval…',
	);
	eq(
		'an ordinary call in flight still says "Running…"',
		toolStatusText({ ...base, toolPending: true }),
		'Running…',
	);
	// The acceptance bar from Emre's step 3, in the one place it is rendered.
	eq(
		'a denied call reads "Denied", never "Error"',
		toolStatusText({ ...base, toolDenied: true }),
		'Denied',
	);
	eq(
		'a call that really failed still reads "Error"',
		toolStatusText({ ...base, toolIsError: true }),
		'Error',
	);
	// Belt and braces: if the reducer ever let both flags be set, the reader's own decision wins.
	eq(
		'denial wins over a stray error flag',
		toolStatusText({ ...base, toolDenied: true, toolIsError: true }),
		'Denied',
	);
	eq('a plain success says nothing', toolStatusText({ ...base }), '');

	eq('the result block is headed "Denied"', toolResultTitle({ ...base, toolDenied: true }), 'Denied');
	eq('...or "Error" for a real failure', toolResultTitle({ ...base, toolIsError: true }), 'Error');
	eq('...or "Result" otherwise', toolResultTitle({ ...base }), 'Result');
}

console.log('L10. SessionManager is what joins the broker to the reducer');
{
	// L6b proves the broker fires; L1 proves the reducer acts on it. Neither proves anything
	// connects the two — every L check that touches the broker installs its own callbacks, which
	// overwrite the ones `SessionManager` set. Deleting the wiring left all of them green.
	//
	// The same shape as K12, and for the same reason: a callback nobody assigns is a silent no-op.
	const manager = new SessionManager(app);
	const broker = (manager as unknown as { broker: PermissionBroker }).broker;
	const reducer = (manager as unknown as { reducer: StreamReducer }).reducer;

	check('the manager installed a request callback', broker.onRequested !== null);
	check('the manager installed a denial callback', broker.onDenied !== null);

	const turn = manager.state.addAssistantMessage();
	reducer.beginTurn(turn);
	reducer.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	reducer.apply({
		type: 'assistant',
		message: {
			content: [
				{ type: 'tool_use', id: 'toolu_join', name: 'Write', input: { file_path: '/vault/j.md', content: 'x\n' } },
			],
		},
	} as StreamJsonEvent);

	// Called exactly as the broker calls them.
	broker.onRequested?.('toolu_join');
	broker.onDenied?.('toolu_join');

	const block = orderedBlocks(turn)[0];
	eq('a request reaches the block', block?.toolPermissionRequested, true);
	eq('a denial reaches the block', block?.toolDenied, true);

	reducer.apply({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', tool_use_id: 'toolu_join', is_error: true, content: 'declined' }],
		},
	} as StreamJsonEvent);
	eq('so the card is not painted red', block?.toolIsError, false);
	manager.dispose();
}

// --- M. Replay of a real Stop-during-pending-permission turn --------------

/*
 * `docs/capture-phase5a-stop.jsonl`, replayed event by event in the order the CLI produced it,
 * with this harness performing the plugin's own actions at the points it really performed them.
 *
 * This section exists because §L did not catch the defect it was written for. Its `cancelPending`
 * checks answered the broker directly, with the turn still open — which is not what happens. In a
 * real Stop the CLI emits its synthetic `tool_result` and then `result` **within 1 ms**, and the
 * plugin's `cancelPending` runs from `onTurnEnd`, i.e. after `applyResult` has already nulled the
 * active turn. Answering the broker by hand skipped that entire ordering.
 *
 * So the fixture is the raw capture, and the replay drives the real `StreamReducer` over it. The
 * `_guki` records in the file are the plugin's side of the conversation, kept inline so the
 * interleaving survives: `socket-in` is the bridge asking, `stdin` is Stop going out, `socket-out`
 * is the deny going back.
 */

console.log('M. Real Stop-during-pending-permission turn, replayed from the capture');
{
	const raw = readFileSync(join(process.cwd(), 'docs', 'capture-phase5a-stop.jsonl'), 'utf8');
	const records: Record<string, unknown>[] = [];
	for (const line of raw.split('\n')) {
		if (line.trim().length === 0) {
			continue;
		}
		records.push(JSON.parse(line) as Record<string, unknown>);
	}
	check('the capture has records', records.length > 0, String(records.length));

	const s = new ChatState();
	const r = new StreamReducer(s);
	let turnEnds = 0;
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);

	// The plugin's own timeline, replayed at the points the capture recorded it.
	let requestedAt = -1;
	let deniedAt = -1;
	let toolUseId = '';
	let cliToolResultAt = -1;
	let resultAt = -1;
	let index = 0;

	r.onTurnEnd = () => {
		turnEnds += 1;
	};

	for (const record of records) {
		index += 1;
		const marker = record._guki;

		if (marker === 'socket-in') {
			// The bridge asked: `PermissionBroker.handleRequest` adds the card and announces the id.
			const msg = record.msg as { type?: string; tool_use_id?: string } | undefined;
			if (msg?.type === 'request' && typeof msg.tool_use_id === 'string') {
				toolUseId = msg.tool_use_id;
				requestedAt = index;
				r.notePermissionRequested(toolUseId);
			}
			continue;
		}

		if (marker === 'socket-out') {
			// The deny going back — `cancelPending`, at the moment it really fired.
			const payload = record.payload as { behavior?: string } | undefined;
			if (payload?.behavior === 'deny' && toolUseId.length > 0) {
				deniedAt = index;
				r.notePermissionDenied(toolUseId);
			}
			continue;
		}

		if (typeof marker === 'string') {
			// `stdin`, `stderr`, `exit` — the plugin's other side, nothing for the reducer.
			continue;
		}

		if (record.type === 'user') {
			const content = (record as { message?: { content?: { type?: string }[] } }).message?.content;
			if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
				cliToolResultAt = index;
			}
		}
		if (record.type === 'result') {
			resultAt = index;
		}
		r.apply(record as unknown as StreamJsonEvent);
	}

	// --- the ordering that makes this hard, asserted from the file itself ---
	check('the bridge asked before Stop', requestedAt > 0, String(requestedAt));
	check('the CLI sent its own tool_result', cliToolResultAt > 0, String(cliToolResultAt));
	check('...before the result event', cliToolResultAt < resultAt, `${cliToolResultAt} vs ${resultAt}`);
	// The heart of it: the plugin's deny is the *last* thing to happen. Anything that depended on
	// it arriving in time was always going to be wrong.
	check('...and the plugin denied only after the result', deniedAt > resultAt, `${deniedAt} vs ${resultAt}`);

	// --- what the reader sees ---
	const blocks = orderedBlocks(turn);
	const tool = blocks.find((b) => b.kind === 'tool_use');
	eq('the turn produced a Write card', tool?.toolName, 'Write');
	eq('...matched to the id the bridge asked about', tool?.toolUseId, toolUseId);

	// The defect, in one assertion. The CLI's synthetic result carries `is_error: true`; the card
	// must not read it as a failure.
	eq('the cancelled call is NOT an error', tool?.toolIsError, false);
	eq('...it is a denial', tool?.toolDenied, true);
	eq('...and it is not left claiming to be running', tool?.toolPending, false);

	// The words on screen, from the shipped card code rather than from a restatement.
	eq('the header badge reads "Denied"', toolStatusText(tool ?? ({} as never)), 'Denied');
	eq('the result block is headed "Denied"', toolResultTitle(tool ?? ({} as never)), 'Denied');
	// The CLI's generic cancellation text is still shown — suppressing the badge must not suppress
	// the explanation.
	check(
		"the CLI's own message survives",
		tool?.toolResultText?.includes("doesn't want to proceed") === true,
		JSON.stringify(tool?.toolResultText?.slice(0, 90)),
	);

	// --- and the turn itself ---
	// Every field on this result event says "failure" except `terminal_reason`: subtype is
	// `error_during_execution`, `is_error` is true, `stop_reason` is `tool_use`. Without the
	// interrupt flag the turn would render red; this replay never called `noteInterruptSent`, so
	// what is being asserted here is that `aborted_tools` alone is enough.
	eq('the turn reads as stopped, not failed', turn.status, 'stopped');
	eq('...with no error text', turn.errorText, undefined);
	eq('onTurnEnd fired once', turnEnds, 1);
}

console.log('M2. The interrupt flag is not the only thing holding this up');
{
	// The other half of the same event, isolated: `aborted_tools` was not a value the reducer knew
	// before this capture — it only had `aborted_streaming` from RESEARCH B4. The `interruptSent`
	// flag covers the real Stop path, so a missing value here would have stayed invisible until a
	// cancellation arrived that we had not asked for.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		terminal_reason: 'aborted_tools',
		stop_reason: 'tool_use',
	} as StreamJsonEvent);
	eq('aborted_tools alone reads as stopped', turn.status, 'stopped');

	// And the original value still does.
	const s2 = new ChatState();
	const r2 = new StreamReducer(s2);
	const turn2 = s2.addAssistantMessage();
	r2.beginTurn(turn2);
	r2.apply({ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming' } as StreamJsonEvent);
	eq('aborted_streaming still reads as stopped', turn2.status, 'stopped');

	// A real failure with no cancellation marker is still a failure — the set must not swallow one.
	const s3 = new ChatState();
	const r3 = new StreamReducer(s3);
	const turn3 = s3.addAssistantMessage();
	r3.beginTurn(turn3);
	r3.apply({ type: 'result', subtype: 'error_during_execution', is_error: true } as StreamJsonEvent);
	eq('an uncancelled failure is still an error', turn3.status, 'error');
}

console.log('M3. permission_denials alone is enough, with no help from the broker');
{
	// The reducer must not depend on `notePermissionDenied` having been called: a denial the CLI
	// made on its own never touches our bridge at all. The Phase 3 capture is real evidence of that
	// case (§D, the two WebSearch calls), and this is the same thing stated narrowly.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 'toolu_cli', name: 'WebSearch', input: { query: 'x' } }] },
	} as StreamJsonEvent);
	r.apply({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', tool_use_id: 'toolu_cli', is_error: true, content: 'not granted' }],
		},
	} as StreamJsonEvent);

	const block = orderedBlocks(turn)[0];
	// Before the result event there is nothing that says this was a denial, so the error flag is
	// the honest reading — this asserts the transition, not just the end state.
	eq('mid-turn it looks like an error, because nothing says otherwise yet', block?.toolIsError, true);

	r.apply({
		type: 'result',
		subtype: 'success',
		is_error: false,
		permission_denials: [{ tool_name: 'WebSearch', tool_use_id: 'toolu_cli' }],
	} as StreamJsonEvent);

	eq('the result event corrects it', block?.toolIsError, false);
	eq('...to a denial', block?.toolDenied, true);
	eq('and the turn is a success', turn.status, 'complete');

	// Malformed lists must yield nothing rather than throw — this is off-the-wire data driving a
	// rendering decision, so the guards matter as much as the happy path.
	eqCall(
		'a missing list denies nothing',
		() => deniedToolUseIds({ type: 'result', subtype: 'success' }).join(','),
		'',
	);
	eqCall(
		'a non-array list denies nothing',
		() =>
			deniedToolUseIds({
				type: 'result',
				subtype: 'success',
				permission_denials: 'nope',
			} as unknown as ResultEvent).join(','),
		'',
	);
	eqCall(
		'a null entry is skipped, not dereferenced',
		() =>
			deniedToolUseIds({
				type: 'result',
				subtype: 'success',
				permission_denials: [null, { tool_use_id: 'toolu_ok' }],
			} as unknown as ResultEvent).join(','),
		'toolu_ok',
	);
	eqCall(
		'an entry with no id is skipped',
		() => deniedToolUseIds({ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'X' }] }).join(','),
		'',
	);
}

console.log('M4. A broker denial that lands after the turn ended still reaches the block');
{
	// The one case `result.permission_denials[]` cannot cover: our broker answered, but the CLI did
	// not record a denial — it had already abandoned the call, or the permission server died and
	// the socket-close path settled the card on its own.
	//
	// This is what makes `stampPermissionState` look the block up against the *turn* rather than
	// against `active`. `applyResult` nulls `active` before firing `onTurnEnd`, and `cancelPending`
	// runs from inside that callback, so the lookup that used `active` found nothing and the stamp
	// was discarded in silence — no throw, no log, just a card that stayed red.
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	r.apply({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', id: 'toolu_late', name: 'Write', input: { file_path: '/vault/l.md', content: 'x\n' } }],
		},
	} as StreamJsonEvent);
	r.notePermissionRequested('toolu_late');
	r.apply({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', tool_use_id: 'toolu_late', is_error: true, content: 'rejected' }],
		},
	} as StreamJsonEvent);

	// The turn ends with **no** `permission_denials` — guard A has nothing to work with here.
	let endedWhileActive: boolean | null = null;
	r.onTurnEnd = () => {
		// Exactly where `SessionManager` calls `broker.cancelPending`, and the reason this is hard:
		// by now the reducer no longer has an active turn.
		endedWhileActive = r.hasActiveTurn();
		r.notePermissionDenied('toolu_late');
	};
	r.apply({ type: 'result', subtype: 'success', is_error: false } as StreamJsonEvent);

	eq('the callback really does run after the turn closed', endedWhileActive, false);

	const block = orderedBlocks(turn)[0];
	eq('the late denial still landed on the block', block?.toolDenied, true);
	eq('...and cleared the error flag the tool_result had set', block?.toolIsError, false);
	eq('so the badge reads "Denied"', toolStatusText(block ?? ({} as never)), 'Denied');
}

console.log('M5. Stop settles the request immediately, so the card never flashes red');
{
	// Guard A corrects the card when the `result` event arrives, which is enough to make every
	// end-state assertion pass — and that is exactly why this check looks at the states *in
	// between* instead. The CLI's synthetic `tool_result` lands ~1 ms before `result`, so with
	// correction alone the block really is `toolIsError: true` for one render, and the panel
	// re-renders on every `emitChange`. A red badge that appears and disappears is still a red
	// badge appearing.
	//
	// `SessionManager.interrupt()` answers the open request before any of that, so the id is
	// already known to be denied when `applyToolResult` runs and the flag is never set at all.
	const manager = new SessionManager(app);
	const written: string[] = [];
	stub(manager, () => Promise.resolve(true), written);

	const internals = manager as unknown as {
		broker: { cancelPending(reason: string): void; dispose(): void; onDenied: ((id: string) => void) | null };
		reducer: StreamReducer;
	};
	// Keep the callbacks the manager wired up, then stand in for the broker: `cancelPending` does
	// what the real one does for a card that is still open — answer it as denied.
	const onDenied = internals.broker.onDenied;
	let cancelCalls = 0;
	let stillOpen = true;
	internals.broker = {
		onDenied,
		cancelPending: () => {
			cancelCalls += 1;
			if (stillOpen) {
				stillOpen = false;
				onDenied?.('toolu_flash');
			}
		},
		dispose: () => undefined,
	};

	manager.send('write a note');
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}

	const reducer = internals.reducer;
	reducer.apply({ type: 'stream_event', event: { type: 'message_start' } } as StreamJsonEvent);
	reducer.apply({
		type: 'assistant',
		message: {
			content: [{ type: 'tool_use', id: 'toolu_flash', name: 'Write', input: { file_path: '/vault/f.md', content: 'x\n' } }],
		},
	} as StreamJsonEvent);
	reducer.notePermissionRequested('toolu_flash');

	// Every state the UI would have rendered, sampled where the UI samples it.
	const seenError: boolean[] = [];
	const turnItem = manager.state.items.find((i) => i.kind === 'assistant') as AssistantItem;
	manager.state.subscribe(() => {
		for (const block of turnItem.blocks.values()) {
			if (block.kind === 'tool_use') {
				seenError.push(block.toolIsError === true);
			}
		}
	});

	manager.interrupt();
	eq('Stop asked the broker to settle the open request', cancelCalls, 1);

	// Now the CLI's own sequence, in the order the capture recorded it.
	reducer.apply({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_flash',
					is_error: true,
					content: "The user doesn't want to proceed with this tool use.",
				},
			],
		},
	} as StreamJsonEvent);
	reducer.apply({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		terminal_reason: 'aborted_tools',
		permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_flash' }],
	} as StreamJsonEvent);

	check('the UI was re-rendered along the way', seenError.length > 0, String(seenError.length));
	// The assertion this section exists for: not just the final state, but every state.
	eq(
		'the card was never once flagged as an error',
		seenError.filter((wasError) => wasError).length,
		0,
	);

	const block = [...turnItem.blocks.values()].find((b) => b.kind === 'tool_use');
	eq('and it ends as a denial', block?.toolDenied, true);
	eq('the turn reads as stopped', turnItem.status, 'stopped');
	manager.dispose();
}

// --- N. Phase 5b: the permission policy -----------------------------------

/*
 * The table in `src/core/permission-policy.ts` and the Bash gate in `src/core/bash-whitelist.ts`.
 *
 * This section is longer than any other for one reason: **an auto-allow is invisible.** An `ask`
 * that is wrong shows up in Obsidian the first time it is hit — a card appears, or one does not.
 * An `allow` that is wrong produces no card, no notice and no difference the reader can see; the
 * file is simply written. So every `allow` branch below is named and asserted individually, and the
 * reversion sweep drives each one red on its own. A table entry nothing tests is a hole with a
 * comment over it.
 *
 * Everything path-shaped runs against `POLICY_VAULT` — a real directory, with a real symlink out of
 * it — because the rule under test is "the resolved, symlink-free path", and a stubbed resolver
 * would be testing the stub.
 */

console.log('N1. containsPath: the one line where "inside the vault" is defined');
{
	eq('the root itself is inside', containsPath('/vault', '/vault'), true);
	eq('a trailing slash on the root changes nothing', containsPath('/vault/', '/vault/notes'), true);
	eq('a child is inside', containsPath('/vault', '/vault/notes/todo.md'), true);
	// The classic prefix bug: a sibling that merely starts with the root's name.
	eq('a name-sharing sibling is NOT inside', containsPath('/vault', '/vault-backup/x.md'), false);
	eq('...nor is a suffix match', containsPath('/vault', '/other/vault/x.md'), false);
	eq('an unresolvable path is never inside', containsPath('/vault', null), false);
	eq('an empty root matches nothing', containsPath('', '/anything'), false);
	// A root of `/` would make every path on the machine "inside the vault" — the single most
	// permissive failure this function has, so it is refused rather than computed.
	eq('a root of / matches nothing', containsPath('/', '/etc/passwd'), false);
}

console.log('N2. createVaultPaths, against a real vault with a real symlink');
const vaultPaths = await createVaultPaths(POLICY_VAULT.root);
{
	// A sibling that shares the root's name, on disk this time rather than as a string.
	mkdirSync(`${POLICY_VAULT.root}-backup`, { recursive: true });
	writeFileSync(`${POLICY_VAULT.root}-backup/stolen.md`, 'x\n');
	// A symlink pointing *into* the vault from outside it: resolution must allow this one, which is
	// what makes the check a resolution rather than a string comparison.
	symlinkSync(join(POLICY_VAULT.root, 'notes'), join(POLICY_VAULT.outside, 'inlink'));

	eq('the root is resolved once, at construction', vaultPaths.root, POLICY_VAULT.root);
	eq('an absolute path inside the vault', vaultPaths.isInside(join(POLICY_VAULT.root, 'notes', 'todo.md')), true);
	eq('a relative path is relative to the vault (the CLI cwd)', vaultPaths.isInside('notes/todo.md'), true);
	// The Write case: the file does not exist yet, so only its ancestor can be resolved.
	eq('a file that does not exist yet, inside the vault', vaultPaths.isInside(join(POLICY_VAULT.root, 'notes', 'new.md')), true);
	eq('...even several levels of it', vaultPaths.isInside(join(POLICY_VAULT.root, 'a', 'b', 'c.md')), true);
	eq('the vault root itself', vaultPaths.isInside(POLICY_VAULT.root), true);
	eq('a symlink from outside pointing back in resolves inside', vaultPaths.isInside(join(POLICY_VAULT.outside, 'inlink', 'todo.md')), true);

	// The four escapes. Each one is a plain string that *looks* like it is inside the vault.
	eq('a symlink out of the vault is caught', vaultPaths.isInside(join(POLICY_VAULT.root, 'escape', 'secret.txt')), false);
	eq('...and so is the symlink itself', vaultPaths.isInside(join(POLICY_VAULT.root, 'escape')), false);
	// Built by concatenation, never with `path.join`: `join` collapses `..` itself, which would
	// hand the resolver an already-normalised path and quietly test nothing. Caught by this very
	// section — the first version of the symlink check below passed for exactly that reason.
	eq('.. climbing out is caught', vaultPaths.isInside(`${POLICY_VAULT.root}/../outside/secret.txt`), false);
	eq('a relative .. is caught too', vaultPaths.isInside('../outside/secret.txt'), false);
	// A relative argument must not be normalised on its way to being made absolute either — this is
	// the same ordering trap one level up, and `path.join` would collapse `escape/..` before the
	// symlink was ever followed.
	eq('a relative path through the symlink is caught', vaultPaths.isInside('escape/secret.txt'), false);
	eq('...and a relative .. after the symlink too', vaultPaths.isInside('escape/../outside/sibling.txt'), false);
	eq('a name-sharing sibling directory is caught', vaultPaths.isInside(`${POLICY_VAULT.root}-backup/stolen.md`), false);
	eq('an unrelated absolute path is caught', vaultPaths.isInside('/etc/passwd'), false);
	// `~` is expanded by a shell, and nothing here runs one. Left literal it would resolve to
	// `<vault>/~/.ssh/id_rsa` — inside the vault, and completely wrong.
	eq('~ is refused rather than treated as a directory name', vaultPaths.isInside('~/.ssh/id_rsa'), false);
	eq('...and so is a bare ~', vaultPaths.isInside('~'), false);
	eq('an empty path resolves to nothing', vaultPaths.resolve(''), null);

	// The ordering trap the resolver is built around: `..` *after* a symlink. Collapsing it
	// lexically first (what `path.resolve`/`path.join` do) turns this into `<vault>/secret.txt`.
	writeFileSync(join(POLICY_VAULT.outside, 'sibling.txt'), 'x\n');
	eq(
		'.. is applied after the symlink, not before it',
		vaultPaths.isInside(`${POLICY_VAULT.root}/escape/../outside/sibling.txt`),
		false,
	);
	// The same string, collapsed the way `path.resolve` would collapse it, lands *inside* the
	// vault — which is what the resolver would answer if it normalised before resolving.
	eq('...and the lexical answer really is the wrong one', resolve(`${POLICY_VAULT.root}/escape/../outside/sibling.txt`).startsWith(POLICY_VAULT.root), true);
	// F2, from the orchestrator's review: the ancestor walk used to fall back to `path.resolve` once
	// its depth ran out, which collapses `..` lexically — reopening at the back door the exact hole
	// `realpathSync.native` closes at the front. The fallback resolves the **whole** path, existing
	// prefix included, and the symlink lives in that prefix. It needs an absurd path to reach, and
	// the wrong answer was `allow`, which has no witness. Both "could not resolve" exits return null
	// now, and null is never inside the vault.
	const deepTail = Array.from({ length: 70 }, (_, i) => `d${String(i)}`).join('/');
	eq(
		'a path too deep to walk is not resolved into the vault',
		vaultPaths.isInside(`${POLICY_VAULT.root}/escape/../${deepTail}/x`),
		false,
	);
	eq('...and it resolves to nothing at all, rather than to a lexical guess', vaultPaths.resolve(`${POLICY_VAULT.root}/escape/../${deepTail}/x`), null);
	// The same shape one component shallower still resolves properly — the guard must not be doing
	// its job by refusing everything.
	const shallowTail = Array.from({ length: 3 }, (_, i) => `d${String(i)}`).join('/');
	eq('a shallow non-existent path through the symlink still resolves, and lands outside', vaultPaths.isInside(`${POLICY_VAULT.root}/escape/../${shallowTail}/x`), false);
	eq('...and a shallow non-existent path inside the vault is still inside', vaultPaths.isInside(`${POLICY_VAULT.root}/${shallowTail}/x`), true);

	eq(
		'...and the resolved path really is the outside one',
		vaultPaths.resolve(join(POLICY_VAULT.root, 'escape', 'secret.txt')),
		join(POLICY_VAULT.outside, 'secret.txt'),
	);
}

console.log('N3. The read-only row: allowed inside the vault, asked outside it');
{
	const inside = join(POLICY_VAULT.root, 'notes', 'todo.md');
	eq('Read inside the vault is silent', permissionVerdict('Read', { file_path: inside }, vaultPaths), 'allow');
	eq('Read outside the vault asks', permissionVerdict('Read', { file_path: '/etc/hosts' }, vaultPaths), 'ask');
	eq('Read through a symlink out of the vault asks', permissionVerdict('Read', { file_path: join(POLICY_VAULT.root, 'escape', 'secret.txt') }, vaultPaths), 'ask');
	eq('NotebookRead inside is silent', permissionVerdict('NotebookRead', { notebook_path: join(POLICY_VAULT.root, 'n.ipynb') }, vaultPaths), 'allow');
	eq('NotebookRead outside asks', permissionVerdict('NotebookRead', { notebook_path: '/tmp/n.ipynb' }, vaultPaths), 'ask');
	eq('LS inside is silent', permissionVerdict('LS', { path: POLICY_VAULT.root }, vaultPaths), 'allow');
	eq('LS outside asks', permissionVerdict('LS', { path: POLICY_VAULT.outside }, vaultPaths), 'ask');
	eq('Grep with a path inside is silent', permissionVerdict('Grep', { pattern: 'x', path: POLICY_VAULT.root }, vaultPaths), 'allow');
	eq('Grep with a path outside asks', permissionVerdict('Grep', { pattern: 'x', path: '/etc' }, vaultPaths), 'ask');

	// The optional-path case: no `path` means the CLI's cwd, which is the vault root, and asking
	// for every one of these is the per-turn card storm RESEARCH B5b warns about.
	eq('Grep with no path at all is silent', permissionVerdict('Grep', { pattern: 'spawn' }, vaultPaths), 'allow');
	eq('Glob with no path at all is silent', permissionVerdict('Glob', { pattern: '**/*.md' }, vaultPaths), 'allow');
	// ...but a *required* path that is missing is malformed, and malformed is never allowed.
	eq('Read with no file_path asks', permissionVerdict('Read', {}, vaultPaths), 'ask');
	eq('LS with no path asks', permissionVerdict('LS', {}, vaultPaths), 'ask');
	eq('Read with a non-string file_path asks', permissionVerdict('Read', { file_path: 42 }, vaultPaths), 'ask');

	// The glob-shaped arguments, which reach the filesystem without going through `path`.
	eq('a Glob pattern climbing out asks', permissionVerdict('Glob', { pattern: '../outside/*' }, vaultPaths), 'ask');
	eq('an absolute Glob pattern asks', permissionVerdict('Glob', { pattern: '/etc/**' }, vaultPaths), 'ask');
	eq('a Grep glob filter climbing out asks', permissionVerdict('Grep', { pattern: 'x', glob: '../**' }, vaultPaths), 'ask');
	// Grep's own `pattern` is a regular expression, where `..` means "any two characters". Checking
	// it would ask on ordinary searches for no gain.
	eq('a Grep regex containing .. is still silent', permissionVerdict('Grep', { pattern: 'a..b' }, vaultPaths), 'allow');
}

console.log('N4. The edit row: git makes it reversible, so the exceptions are where it does not');
{
	const note = join(POLICY_VAULT.root, 'notes', 'todo.md');
	const fresh = join(POLICY_VAULT.root, 'notes', 'brand-new.md');
	eq('Edit inside the vault is silent', permissionVerdict('Edit', { file_path: note, old_string: 'a', new_string: 'b' }, vaultPaths), 'allow');
	eq('Write to a new file inside the vault is silent', permissionVerdict('Write', { file_path: fresh, content: 'hello\n' }, vaultPaths), 'allow');
	eq('MultiEdit inside the vault is silent', permissionVerdict('MultiEdit', { file_path: note, edits: [{ old_string: 'a', new_string: 'b' }] }, vaultPaths), 'allow');
	eq('NotebookEdit inside the vault is silent', permissionVerdict('NotebookEdit', { notebook_path: join(POLICY_VAULT.root, 'n.ipynb'), new_source: 'x' }, vaultPaths), 'allow');

	eq('Write outside the vault asks', permissionVerdict('Write', { file_path: '/tmp/x.md', content: 'hi' }, vaultPaths), 'ask');
	eq('Edit outside the vault asks', permissionVerdict('Edit', { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }, vaultPaths), 'ask');
	eq('Write through a symlink out of the vault asks', permissionVerdict('Write', { file_path: join(POLICY_VAULT.root, 'escape', 'x.md'), content: 'hi' }, vaultPaths), 'ask');
	eq('Write with no file_path asks', permissionVerdict('Write', { content: 'hi' }, vaultPaths), 'ask');

	// PLAN's "deletion, or an existing file being emptied" row.
	eq('Write with empty content asks', permissionVerdict('Write', { file_path: note, content: '' }, vaultPaths), 'ask');
	eq('Write with whitespace-only content asks', permissionVerdict('Write', { file_path: note, content: '   \n' }, vaultPaths), 'ask');
	eq('Write with no content at all asks', permissionVerdict('Write', { file_path: note }, vaultPaths), 'ask');
	eq('NotebookEdit deleting a cell asks', permissionVerdict('NotebookEdit', { notebook_path: join(POLICY_VAULT.root, 'n.ipynb'), edit_mode: 'delete' }, vaultPaths), 'ask');
	eq('NotebookEdit inserting a cell is silent', permissionVerdict('NotebookEdit', { notebook_path: join(POLICY_VAULT.root, 'n.ipynb'), edit_mode: 'insert', new_source: 'x' }, vaultPaths), 'allow');
	eq('MultiEdit with a malformed edits field asks', permissionVerdict('MultiEdit', { file_path: note, edits: 'nope' }, vaultPaths), 'ask');

	// F1, from the orchestrator's review: `Edit` and `MultiEdit` had no destructive branch at all,
	// so an edit whose `new_string` is empty and whose `old_string` is the whole file emptied it
	// silently. `Edit` requires `old_string` to match, so the file provably exists — PLAN §2b's
	// "an existing file being emptied", verbatim, and it was the one row going the permissive way.
	eq('Edit emptying its target asks', permissionVerdict('Edit', { file_path: note, old_string: '- one\n', new_string: '' }, vaultPaths), 'ask');
	eq('MultiEdit with any entry emptying its target asks', permissionVerdict('MultiEdit', { file_path: note, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: '- one\n', new_string: '' }] }, vaultPaths), 'ask');
	eq('...even when the emptying entry is first', permissionVerdict('MultiEdit', { file_path: note, edits: [{ old_string: '- one\n', new_string: '' }] }, vaultPaths), 'ask');
	// The shape this trade costs a card on, stated so the cost is visible: deleting a fragment
	// anchored on context is the common shape and stays silent.
	eq('an Edit deleting a line with context is still silent', permissionVerdict('Edit', { file_path: note, old_string: 'a\nb\nc', new_string: 'a\nc' }, vaultPaths), 'allow');
	eq('a malformed Edit asks', permissionVerdict('Edit', { file_path: note, old_string: 'a' }, vaultPaths), 'ask');
	eq('an Edit with a non-string new_string asks', permissionVerdict('Edit', { file_path: note, old_string: 'a', new_string: 7 }, vaultPaths), 'ask');

	// Inside the vault, and still asked: the auto-allow rests on "git makes it reversible", and a
	// write into `.git` is the one edit that revokes that argument.
	eq('Write into .git asks', permissionVerdict('Write', { file_path: join(POLICY_VAULT.root, '.git', 'config'), content: 'x' }, vaultPaths), 'ask');
	eq('Edit inside .git asks', permissionVerdict('Edit', { file_path: join(POLICY_VAULT.root, '.git', 'hooks', 'pre-commit'), old_string: 'a', new_string: 'b' }, vaultPaths), 'ask');
	// A note that merely mentions git in its name is not `.git`.
	eq('...but a note called git-notes.md is not .git', permissionVerdict('Write', { file_path: join(POLICY_VAULT.root, 'notes', 'git-notes.md'), content: 'x' }, vaultPaths), 'allow');
}

console.log('N5. The free row: web is free, but only over http(s)');
{
	eq('WebSearch is silent', permissionVerdict('WebSearch', { query: 'obsidian plugin api' }, vaultPaths), 'allow');
	eq('TodoWrite is silent', permissionVerdict('TodoWrite', { todos: [] }, vaultPaths), 'allow');
	eq('WebFetch over https is silent', permissionVerdict('WebFetch', { url: 'https://docs.obsidian.md/' }, vaultPaths), 'allow');
	eq('WebFetch over http is silent', permissionVerdict('WebFetch', { url: 'http://localhost:8080/x' }, vaultPaths), 'allow');
	// A URL is not always a web address: `file://` is a local file read wearing one.
	eq('WebFetch of a file:// url asks', permissionVerdict('WebFetch', { url: 'file:///etc/passwd' }, vaultPaths), 'ask');
	eq('...whatever the case of the scheme', permissionVerdict('WebFetch', { url: 'FILE:///etc/passwd' }, vaultPaths), 'ask');
	eq('WebFetch with no url asks', permissionVerdict('WebFetch', {}, vaultPaths), 'ask');
}

console.log('N6. Unknown, malformed, and the subagent');
{
	eq('an unrecognised built-in asks', permissionVerdict('KillShell', { shell_id: '1' }, vaultPaths), 'ask');
	eq('an MCP tool asks', permissionVerdict('mcp__mem0__add_memory', { text: 'x' }, vaultPaths), 'ask');
	eq('our own permission tool asks', permissionVerdict('mcp__guki-perm__permission_prompt', {}, vaultPaths), 'ask');
	eq('a missing tool name asks', permissionVerdict(undefined, {}, vaultPaths), 'ask');
	eq('a non-string tool name asks', permissionVerdict(7, {}, vaultPaths), 'ask');
	eq('an empty tool name asks', permissionVerdict('', {}, vaultPaths), 'ask');
	eq('a null input asks', permissionVerdict('Read', null, vaultPaths), 'ask');
	eq('a string input asks', permissionVerdict('Read', 'file.md', vaultPaths), 'ask');
	// Case matters: the table is keyed on the CLI's own names, and a near-miss must not be allowed.
	eq('a lowercased tool name is not the tool', permissionVerdict('read', { file_path: join(POLICY_VAULT.root, 'notes', 'todo.md') }, vaultPaths), 'ask');

	// Settled by Emre's acceptance run, step 8: a subagent's inner calls are gated individually —
	// its own `Write /tmp/agent-test.md` and its follow-up `Bash` each produced their own card. So
	// allowing the parent grants nothing, and the deviation that asked about it is closed.
	eq('Agent is silent — its inner calls are carded individually', permissionVerdict('Agent', { subagent_type: 'Explore', prompt: 'x' }, vaultPaths), 'allow');
	eq('Task is silent, under either name', permissionVerdict('Task', { subagent_type: 'Explore', prompt: 'x' }, vaultPaths), 'allow');
	// ...and the inner call itself, which is the reason the parent is safe to allow: a subagent's
	// `Write` outside the vault is judged by this same table, on its own.
	eq('a subagent-shaped Write outside the vault still asks', permissionVerdict('Write', { file_path: '/tmp/agent-test.md', content: 'x' }, vaultPaths), 'ask');
}

console.log('N7. Bash step 1: the metacharacter veto, on the raw string');
{
	const bash = (command: string): string => permissionVerdict('Bash', { command }, vaultPaths);

	// PLAN §2b's three mandatory negatives, verbatim. Each one begins with a whitelisted name, which
	// is exactly why name-based whitelisting is not what this is.
	eq('"git status; rm -rf x" asks', bash('git status; rm -rf x'), 'ask');
	eq('"ls $(whoami)" asks', bash('ls $(whoami)'), 'ask');
	eq('"cat a > b" asks', bash('cat a > b'), 'ask');
	eq('"echo hi\\nrm x" asks (embedded newline)', bash('echo hi\nrm x'), 'ask');

	eq('&& asks', bash('ls && rm -rf x'), 'ask');
	eq('|| asks', bash('ls || rm -rf x'), 'ask');
	eq('a pipe asks', bash('cat notes/todo.md | sh'), 'ask');
	eq('>> asks', bash('cat notes/todo.md >> notes/other.md'), 'ask');
	eq('< asks', bash('wc -l < notes/todo.md'), 'ask');
	eq('a background & asks', bash('ls &'), 'ask');
	eq('a backtick asks', bash('ls `whoami`'), 'ask');
	eq('a carriage return asks', bash('ls\rrm -rf x'), 'ask');

	// The additions to PLAN's list, and the hole each of them closes. PLAN vetoes `$(` but not a
	// bare `$`, and its step 3 only rejects tokens that resolve to an *existing* path — so the
	// literal token `$HOME/.ssh/id_rsa`, which exists nowhere, would have cleared all three steps
	// and the shell would then have expanded it.
	eq('a bare $ asks — the shell expands it, the path check cannot see it', bash('cat $HOME/.ssh/id_rsa'), 'ask');
	eq('${...} asks', bash('cat ${HOME}/x'), 'ask');
	eq('~ asks', bash('cat ~/.ssh/id_rsa'), 'ask');
	eq('a glob asks — it is unexpanded here and expanded by the shell', bash('cat ../*'), 'ask');
	eq('a ? glob asks', bash('cat notes/todo.m?'), 'ask');
	eq('a bracket glob asks', bash('cat notes/[a-z]*.md'), 'ask');
	eq('brace expansion asks', bash('cat notes/{a,b}.md'), 'ask');
	eq('a backslash escape asks', bash('cat notes/my\\ note.md'), 'ask');
	eq('a subshell paren asks', bash('(cd /etc)'), 'ask');
	eq('a comment asks', bash('ls # rm -rf x'), 'ask');
	eq('history expansion asks', bash('ls !!'), 'ask');
}

console.log('N8. Bash step 2: argv exact match on leading tokens');
{
	const bash = (command: string): string => permissionVerdict('Bash', { command }, vaultPaths);

	eq('"ls -la" is silent', bash('ls -la'), 'allow');
	eq('"pwd" is silent', bash('pwd'), 'allow');
	eq('"git status" is silent', bash('git status'), 'allow');
	eq('"git log --oneline -5" is silent', bash('git log --oneline -5'), 'allow');
	eq('"git diff" is silent', bash('git diff'), 'allow');
	eq('"git branch" is silent', bash('git branch'), 'allow');
	eq('"node --version" is silent', bash('node --version'), 'allow');
	eq('"which node" is silent', bash('which node'), 'allow');
	eq('"wc -l notes/todo.md" is silent', bash('wc -l notes/todo.md'), 'allow');
	eq('leading and trailing whitespace does not matter', bash('   ls -la  '), 'allow');

	// Prefix matching is on *tokens*, not on characters.
	eq('"git statusx" asks — not a token match', bash('git statusx'), 'ask');
	eq('"lsof" asks', bash('lsof'), 'ask');
	eq('"rm -rf /" asks', bash('rm -rf /'), 'ask');
	eq('"git push" asks — a whitelisted first token is not enough', bash('git push'), 'ask');
	eq('"git" alone asks', bash('git'), 'ask');
	eq('"node script.js" asks — only --version is whitelisted', bash('node script.js'), 'ask');
	eq('an empty command asks', bash(''), 'ask');
	eq('whitespace only asks', bash('   '), 'ask');
	eq('a non-string command asks', permissionVerdict('Bash', { command: 42 }, vaultPaths), 'ask');
	eq('a missing command asks', permissionVerdict('Bash', {}, vaultPaths), 'ask');

	// The tokeniser itself, since step 3 reads its output as filenames.
	eq('quotes are honoured and stripped', (tokenizeCommand("cat 'my notes.md'") ?? []).join('|'), 'cat|my notes.md');
	eq('double quotes too', (tokenizeCommand('cat "my notes.md"') ?? []).join('|'), 'cat|my notes.md');
	eq('an unbalanced quote does not tokenise', tokenizeCommand('cat "notes'), null);
	eq('...and the gate asks about it', bash('cat "notes'), 'ask');
	eq('an empty quoted token survives as a token', (tokenizeCommand("cat ''") ?? []).length, 2);
}

console.log('N9. Bash step 3: every non-flag token must stay inside the vault');
{
	const bash = (command: string): string => permissionVerdict('Bash', { command }, vaultPaths);

	// PLAN §2b's own step 3 negatives.
	eq('"wc -l /etc/passwd" asks', bash('wc -l /etc/passwd'), 'ask');
	eq('"cat /etc/passwd" asks', bash('cat /etc/passwd'), 'ask');
	// PLAN's own positive.
	eq('"cat notes/todo.md" is silent', bash('cat notes/todo.md'), 'allow');
	eq('an absolute path inside the vault is silent', bash(`cat ${join(POLICY_VAULT.root, 'notes', 'todo.md')}`), 'allow');

	eq('climbing out with .. asks', bash('ls ../outside'), 'ask');
	eq('a symlink out of the vault asks', bash('cat escape/secret.txt'), 'ask');
	eq('a name-sharing sibling directory asks', bash(`ls ${POLICY_VAULT.root}-backup`), 'ask');
	eq('a quoted path outside the vault asks', bash(`cat "${POLICY_VAULT.outside}/secret.txt"`), 'ask');

	// Subcommands and flags are tokens too, and must not produce spurious cards.
	eq('a subcommand token is not mistaken for a path', bash('git status'), 'allow');
	eq('a flag is skipped', bash('ls -la'), 'allow');
	// ...but a flag that carries a path is refused rather than reasoned about.
	eq('a flag carrying a path asks', bash('git --git-dir=/etc/x status'), 'ask');
	eq('a long flag with a path asks', bash('ls --directory=/etc'), 'ask');
}

console.log('N10. The broker: an allow never reaches the transcript, and the CLI still hears it');
{
	// The wiring, not the callee. Three reversions in earlier phases deleted a real call site and
	// broke nothing, because the checks drove the callee directly — so this drives the whole bridge:
	// the real broker, the real server process, a real socket, with this harness playing the CLI.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	const allowed = { file_path: join(POLICY_VAULT.root, 'notes', 'todo.md') };
	bridge.send({
		jsonrpc: '2.0',
		id: 41,
		method: 'tools/call',
		params: { name: 'permission_prompt', arguments: { tool_name: 'Read', input: allowed, tool_use_id: 'toolu_auto' } },
	});
	const response = await bridge.rpc.next();
	check('the CLI got an answer at all', response !== TIMED_OUT, JSON.stringify(response));
	eq('...on the right JSON-RPC id', response.id, 41);
	const verdict = verdictOf(response);
	eq('...and the answer is allow', verdict?.behavior, 'allow');
	eq('...carrying the original input back as updatedInput', JSON.stringify(verdict?.updatedInput), JSON.stringify(allowed));

	// The half that has no other witness: nothing was added to the transcript. Polled, because a
	// card arriving late would be just as wrong as one arriving now.
	await new Promise((resolve) => setTimeout(resolve, 100));
	eq('no permission card was ever added', bridge.state.items.filter((i) => i.kind === 'permission').length, 0);
	eq('...and the broker has nothing pending', bridge.broker.hasPending, false);

	// The same bridge, a request the policy asks about: the Phase 5a path still works.
	bridge.send({
		jsonrpc: '2.0',
		id: 42,
		method: 'tools/call',
		params: { name: 'permission_prompt', arguments: { tool_name: 'Write', input: { file_path: '/etc/hosts', content: 'x' }, tool_use_id: 'toolu_ask' } },
	});
	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('a call outside the vault still produces a card', card !== undefined);
	eq('...and it is the right one', card?.toolUseId, 'toolu_ask');
	bridge.broker.decide(card?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();

	bridge.stop();

	// The other half of the wiring, one layer up: `SessionManager` is what knows the vault root, and
	// nothing else in this file constructs the broker the way production does. If that argument is
	// ever dropped or emptied the policy still runs — it just judges every path against the wrong
	// boundary, and the panel fills with cards instead of failing.
	const wired = new SessionManager(app);
	eq(
		'SessionManager hands its own vault path to the broker',
		(wired as unknown as { broker: { vaultRoot: string } }).broker.vaultRoot,
		FALLBACK_VAULT_PATH,
	);
	wired.dispose();
}

console.log('N11. The broker fails closed when it has no filesystem to judge against');
{
	// `policyPaths` is null until `start()` finishes, and a request that arrives without it cannot
	// be judged. The guard is invisible from the outside — the only way it goes wrong is by
	// answering `allow` — so it is reached here directly and asserted.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	(bridge.broker as unknown as { policyPaths: unknown }).policyPaths = null;
	bridge.send({
		jsonrpc: '2.0',
		id: 51,
		method: 'tools/call',
		// A call that would otherwise be auto-allowed twice over: read-only, inside the vault.
		params: { name: 'permission_prompt', arguments: { tool_name: 'Read', input: { file_path: join(POLICY_VAULT.root, 'notes', 'todo.md') }, tool_use_id: 'toolu_noroot' } },
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('with no resolver, even a Read inside the vault produces a card', card !== undefined);
	bridge.broker.decide(card?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();
	bridge.stop();
}

console.log('N12. The approval card tells the truth about what a Write destroys');
{
	// F4, and the most serious finding of Emre's acceptance run. Step 9 asked GuKi to empty a note
	// holding `merhaba\ndünya`. The policy correctly asked — and the card rendered
	// `Before: (empty)`, telling the reader nothing was being lost while the whole file was about
	// to go. `oldText` was never populated for a `Write`, because the tool input does not carry it
	// and nothing read the file.
	//
	// Three states, and the third is the point: `(empty)` must mean "verifiably empty", never "we
	// did not look". Driven through the real broker rather than through `diffFromToolInput` alone,
	// because the half that was missing was *the read*, not the formatting.
	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	async function cardFor(id: number, input: unknown): Promise<PermissionItem | undefined> {
		const before = bridge.state.items.filter((i) => i.kind === 'permission').length;
		bridge.send({
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: { name: 'permission_prompt', arguments: { tool_name: 'Write', input, tool_use_id: `toolu_${String(id)}` } },
		});
		for (let i = 0; i < 200; i += 1) {
			const cards = bridge.state.items.filter((item) => item.kind === 'permission') as PermissionItem[];
			if (cards.length > before) {
				return cards[cards.length - 1];
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return undefined;
	}

	// (1) content — the acceptance-run case, byte for byte.
	const note = join(POLICY_VAULT.root, 'notes', 'perm-b-test.md');
	writeFileSync(note, 'merhaba\ndünya\n');
	const emptying = await cardFor(61, { file_path: note, content: '' });
	check('emptying a note produces a card', emptying !== undefined);
	eq('the broker read the file before the card existed', emptying?.priorContent?.kind, 'content');
	eq(
		'...and it read the real content',
		emptying?.priorContent?.kind === 'content' ? emptying.priorContent.text : '',
		'merhaba\ndünya\n',
	);
	const emptyingDiff = diffFromToolInput('Write', emptying?.input, emptying?.priorContent);
	eq('the Before pane holds what is about to be destroyed', emptyingDiff?.oldText, 'merhaba\ndünya\n');
	eq('...and it is not flagged unknown', emptyingDiff?.oldUnknown, undefined);
	eq('...so the card counts both lines as removed', emptyingDiff ? diffStats(emptyingDiff).removed : -1, 2);
	// The exact defect, phrased as the reader saw it: the pane has lines to show, so the `(empty)`
	// placeholder is not what renders.
	check('the Before pane is no longer the empty placeholder', (emptyingDiff?.oldText ?? '') !== '');
	// ...and the same thing through the card's own accessor, which is the line that carries
	// `priorContent` from the item into the parser. Asserted separately because a reversion of that
	// wiring is invisible from `diffFromToolInput` alone.
	eq(
		'the permission card reads the prior content off the item',
		emptying === undefined ? '' : (permissionDiff(emptying)?.oldText ?? ''),
		'merhaba\ndünya\n',
	);
	bridge.broker.decide(emptying?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();

	// (2) absent — a create. `(empty)` is the truth here, and steps 2 and 4 must keep rendering it.
	const fresh = join(POLICY_VAULT.outside, 'brand-new.md');
	const creating = await cardFor(62, { file_path: fresh, content: 'hello\n' });
	check('writing a new file outside the vault produces a card', creating !== undefined);
	eq('the reader is told the file does not exist yet', creating?.priorContent?.kind, 'absent');
	const creatingDiff = diffFromToolInput('Write', creating?.input, creating?.priorContent);
	eq('...which renders as a verified empty Before', creatingDiff === null ? '' : emptyPaneText(creatingDiff, 'before'), '(empty)');
	eq('...and nothing is reported as removed', creatingDiff ? diffStats(creatingDiff).removed : -1, 0);
	bridge.broker.decide(creating?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();

	// (3) unknown — a target that cannot be read. A directory is the deterministic case.
	const unreadable = await cardFor(63, { file_path: POLICY_VAULT.outside, content: 'x\n' });
	check('writing over an unreadable target produces a card', unreadable !== undefined);
	eq('a target that could not be read is not called empty', unreadable?.priorContent?.kind, 'unknown');
	const unknownDiff = diffFromToolInput('Write', unreadable?.input, unreadable?.priorContent);
	eq('...it renders as not read', unknownDiff === null ? '' : emptyPaneText(unknownDiff, 'before'), '(not read)');
	eq(
		'...through the card accessor too',
		unreadable === undefined ? '' : emptyPaneText(permissionDiff(unreadable) ?? { newText: '' }, 'before'),
		'(not read)',
	);
	eq('...and it must not claim an empty oldText', unknownDiff?.oldText, undefined);
	bridge.broker.decide(unreadable?.requestId ?? '', 'deny', 'no');
	await bridge.rpc.next();

	// The two states must not render alike — the whole finding in one line.
	check(
		'(empty) and (not read) are different strings',
		emptyPaneText({ newText: 'x', oldText: '' }, 'before') !== emptyPaneText({ newText: 'x', oldUnknown: true }, 'before'),
	);
	// The After pane never claims to have been read; only Before can be unknown.
	eq('the After pane is unaffected', emptyPaneText({ newText: '', oldUnknown: true }, 'after'), '(empty)');

	// The tool card is deliberately untouched: it renders a call that already happened, it never
	// reads a file, and `src/ui/tool-card.ts` is the NUL-byte file (trap 27) that nothing here goes
	// near. Its default stays exactly what it was before this fix.
	eq('with no prior content supplied, the parse is unchanged', diffFromToolInput('Write', { file_path: '/x.md', content: 'a\n' })?.oldText, undefined);

	bridge.stop();
}

console.log('N13. A policy that throws produces a card, not a hung CLI');
{
	// F3. There is no reachable throw today — the input is `JSON.parse` output and every read of it
	// is guarded — so this is insurance, and insurance still has to be shown to work. The failure it
	// prevents is the one this project has been bitten by three times: an exception inside the
	// socket's `data` handler means no answer is ever sent, and the CLI waits on a JSON-RPC id
	// forever. A check that dies by crashing is indistinguishable from one that never ran.
	// The throw this section induces happens inside the socket's `data` handler, not inside any
	// assertion's call stack — so without the guard under test it is an **uncaught exception**, and
	// an uncaught exception takes the whole harness down. That is the failure mode this project has
	// been bitten by three times: `grep FAIL` finds nothing and the reversion reads as a pass.
	// Installing a listener converts the crash into a reported failure, which is what a reversion
	// sweep needs to see. Removed again at the end of the section so it masks nothing else.
	const onUncaught = (error: Error): void => {
		failures += 1;
		console.log(`  FAIL the policy threw all the way out of the socket handler — ${String(error.message)}`);
	};
	process.on('uncaughtException', onUncaught);

	const bridge = await startBridge();
	bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
	await bridge.rpc.next();

	(bridge.broker as unknown as { policyPaths: unknown }).policyPaths = {
		root: POLICY_VAULT.root,
		resolve: () => {
			throw new Error('boom');
		},
		isInside: () => {
			throw new Error('boom');
		},
	};

	bridge.send({
		jsonrpc: '2.0',
		id: 71,
		method: 'tools/call',
		// Would otherwise be auto-allowed: read-only, inside the vault.
		params: { name: 'permission_prompt', arguments: { tool_name: 'Read', input: { file_path: join(POLICY_VAULT.root, 'notes', 'todo.md') }, tool_use_id: 'toolu_throw' } },
	});

	let card: PermissionItem | undefined;
	for (let i = 0; i < 200 && !card; i += 1) {
		card = bridge.state.items.find((item) => item.kind === 'permission') as PermissionItem | undefined;
		if (!card) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	check('a throwing policy still produces a card', card !== undefined);
	bridge.broker.decide(card?.requestId ?? '', 'deny', 'no');
	const answered = await bridge.rpc.next();
	// The half that matters: the CLI was answered at all.
	check('...and the CLI is answered rather than left waiting', answered !== TIMED_OUT, JSON.stringify(answered));
	eq('...on the right id', answered.id, 71);
	bridge.stop();
	process.removeListener('uncaughtException', onUncaught);
}

rmSync(POLICY_VAULT.base, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
