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
 * O.  Phase 6: attachments — that an in-vault chip always reaches the CLI as an `@"…"` reference,
 *     and that nothing which failed the vault-boundary check can become one. The `@` form skips
 *     the permission system entirely, so this is the same class of invisible decision as §N's
 *     auto-allows: a wrong reference produces no error, just a model that never saw the file.
 *     Task 2 adds the other direction: a file that arrived from *outside* Obsidian is placed by
 *     where it resolves, so the same door produces an `@` for a vault file and a plain path for
 *     anything else (§O5), and a `File` is turned into a path by feature detection (§O6).
 *     Task 3 adds the one attachment that is **not** a path: a pasted clipboard image, sent as
 *     bytes. §O7 pins that it contributes no text to the prompt at all — an invented path would
 *     reach `attachmentReference`'s `location` check and could come back as an `@` for something
 *     that is not a file. §O8 drives the real `SessionManager` to pin that an image with no typed
 *     text is not silently dropped. §O9 pins the base64 across a chunk boundary. §O10 is the
 *     media-type gate and `onPasted`'s decision table, including that plain text is **not** taken.
 *     Task 4 adds §O11: **which** paste is the composer's at all, the decision that runs before
 *     §O10's. It is asserted because the inline version of it shipped a defect — a paste aimed at
 *     a reply bubble was claimed by neither branch and did nothing — and because the guard on its
 *     other side is load-bearing: too wide and the panel steals a note's paste.
 * N.  Phase 5b: the permission policy — PLAN §2b's table and the Bash gate, over a real temp vault
 *     with a real symlink out of it, plus the broker end to end. Longer than any other section
 *     because an auto-allow is invisible: it produces no card, so every `allow` branch needs an
 *     assertion that names it. §N12 is the exception that proves the rule — the one decision the
 *     reader *does* see, and it was being shown wrong.
 * U.  Phase 7 task 3 round A: permission model security floor (.obsidian protection and
 *     Unicode path normalisation).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	assistantCopyText,
	assistantCopyVisible,
	ChatState,
	hasRenderableContent,
	orderedBlocks,
	type AssistantItem,
	type MessageBlock,
	type PermissionItem,
} from '../src/core/chat-state';
import { StreamReducer } from '../src/core/stream-reducer';
import { SessionManager } from '../src/core/session-manager';
import { PermissionBroker } from '../src/core/permission-broker';
import {
	contextUsageFromResult,
	deniedToolUseIds,
	formatModelName,
	isSystemInitEvent,
	mcpServerStatus,
	parseQuotaSnapshot,
	parseStreamJsonLine,
	userMessageLine,
	type RateLimitEvent,
	type ResultEvent,
	type StreamJsonEvent,
	type SystemInitEvent,
} from '../src/cli/events';
import { startsExpanded, toolCategory, toolResultText, toolSummary } from '../src/core/tool-policy';
import { diffFromToolInput, diffStats, emptyPaneText } from '../src/ui/diff-view';
import { toolPermissionBodyText, toolResultTitle, toolStatusText } from '../src/ui/tool-card';
import { canRememberPermission, createPermissionCard, permissionDiff, rememberLabelText, shortenPathForLabel, type PermissionActions } from '../src/ui/permission-card';
import { clearRememberedDecisions, DEFAULT_SETTINGS, formatRememberedDecision, GukiSettingTab, removeRememberedDecision } from '../src/ui/settings-tab';
import GukiChatPlugin from '../src/main';
import { getLocale, setLocale, t } from '../src/i18n';
import { settingsStrings } from '../src/i18n/keys/settings';
import { chatStrings } from '../src/i18n/keys/chat';
import { transcriptStrings } from '../src/i18n/keys/transcript';
import { coreStrings } from '../src/i18n/keys/core';
import { ChatView, currentStatus, HISTORY_PAGE_SIZE } from '../src/ui/chat-view';
import { renderQuotaBar } from '../src/ui/composer';
import { appendPromptHistory, PROMPT_HISTORY_CAP } from '../src/core/prompt-history';
import { formatTurnMeta, MessageList, withTurnMeta } from '../src/ui/message-list';
import {
	buildRememberedDecision,
	containsPath,
	DEFAULT_PERMISSION_SETTINGS,
	editVerdict,
	enforceFloor,
	evaluateCandidateVerdict,
	evaluateEditCandidate,
	normalizePermissionSettings,
	permissionVerdict,
	validateEditFloor,
	type CategorySetting,
	type PermissionCategory,
	type PermissionSettings,
	type RememberedDecision,
} from '../src/core/permission-policy';
import { bashVerdict, evaluateBashCandidate, tokenizeCommand, validateBashFloor } from '../src/core/bash-whitelist';
import { createVaultPaths } from '../src/core/vault-path-resolver';
import {
	addAttachment,
	attachmentKey,
	attachmentReference,
	composeMessage,
	encodeBase64,
	hasSendableContent,
	imageAttachments,
	imageDataUrl,
	imageSummary,
	isImageMediaType,
	promptReference,
	type Attachment,
	type AttachmentLocation,
	type ImageAttachment,
	type PathAttachment,
} from '../src/core/attachments';
import {
	externalFilePaths,
	readImageAttachment,
	resolveExternalFile,
	resolveVaultFile,
	triageImageFiles,
} from '../src/core/attachment-resolver';
import { absolutePathForFile } from '../src/cli/node-api';
import { Composer, pasteBelongsToComposer, type ComposerOptions } from '../src/ui/composer';
import { DEFAULT_SEND_KEY, shouldSend } from '../src/core/send-key';
import { filterVaultFiles, insertItem, type DropdownItem, type TriggerMatch } from '../src/ui/composer-dropdown';
import {
	buildSessionSummary,
	extractUserPromptText,
	isExplicitHumanUser,
	isSyntheticUser,
	MAX_DERIVED_TITLE_LENGTH,
	projectSlug,
	sanitizeDerivedTitle,
	scanSessionsDir,
	sessionDisplayTitle,
	resolveSessionTitle,
	panelTitleFor,
	type SessionSummary,
	type TitleSource,
} from '../src/data/session-index';
import { ConversationTitleStore, type ConversationTitleMap } from '../src/data/conversation-titles';
import { PromptHistoryStore } from '../src/data/prompt-history';
import {
	formatSessionDate,
	HistoryDropdown,
	shapeSessionRow,
	type HistoryRowItem,
} from '../src/ui/history-dropdown';
import { NodeTranscriptStore } from '../src/data/transcript-store';
import { App, FileSystemAdapter, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { parseAskUserQuestionInput, decideAskUserQuestion, formatAskUserQuestionSummary, parseAskUserQuestionAnswers } from '../src/core/ask-user-question';
import { AskUserQuestionInline } from '../src/ui/ask-user-question';
import { DiskTranscriptLoader, resolveTranscriptBranch } from '../src/data/disk-transcript-loader';
import { translateTranscriptRecords, parsePersistedOutput, resolveSidecarContent } from '../src/data/transcript-translator';
import type { ChatItem, UserItem, AssistantItem, DividerItem, PermissionItem } from '../src/core/chat-state';


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

/**
 * A harness precondition, not an assertion: the thing the section is about must exist before any
 * of its checks mean anything.
 *
 * Throwing is deliberate, and it is the opposite of `check`. If `mcpServers['guki-perm']` is
 * missing, or `spawn` handed back no `stdin`, then every assertion below it is testing nothing —
 * a `check` there would report a tidy FAIL and let the run continue past a harness that is no
 * longer wired up. This stops the run at the first real cause instead.
 *
 * It also exists because `noUncheckedIndexedAccess` is on: indexing a `Record` yields
 * `T | undefined`, and the alternative to a named helper is `!` scattered at each site, which
 * silences the compiler without saying why the value is there.
 */
function required<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) {
		throw new Error(`harness precondition failed: ${what} is missing`);
	}
	return value;
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
// This is the reducer's first turn, so there is no baseline yet: the running total is the
// reported cumulative verbatim, same number as the turn's own cost (PHASE6-TASK5-STATE §P).
eq('sessionCostUsd on a process\'s first turn equals the turn\'s own cost', item.meta?.sessionCostUsd, 0.1832235);

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

// A real `FileSystemAdapter` instance, because the production guard is `instanceof
// FileSystemAdapter` (§C3 exercises the other side, a plain object that fails it). The path itself
// is never read from disk by anything in sections C–M: they stub `ensureProcess`/`startProcess`
// outright, so this only has to be a string `broker.vaultRoot` can be compared against.
const sharedVaultAdapter = new FileSystemAdapter();
sharedVaultAdapter.getBasePath = () => join(tmpdir(), 'guki-checks-shared-vault');
const app = { vault: { adapter: sharedVaultAdapter } } as never;

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

console.log('C3. A non-FileSystemAdapter vault blocks input instead of guessing a path');
{
	// There used to be a hardcoded fallback path here — Emre's own vault. Anyone else's install
	// would have started the CLI, silently, against the wrong directory. The fix has to close off
	// every door `vaultPath` had: construction, `send`, and `vaultPaths()`.
	const mobileApp = { vault: { adapter: {} } } as never;
	const manager = new SessionManager(mobileApp);

	check(
		'input is refused at construction, before any message is ever sent',
		manager.blocked !== null,
		String(manager.blocked),
	);
	const notice = manager.state.items.find((i) => i.kind === 'notice');
	check('...and a notice explains why, not just a silently disabled composer', notice !== undefined);

	manager.send('hello');
	eq('the message was refused, not queued toward a startProcess that would throw', manager.busy, false);
	check(
		'no assistant turn was created for the refused message',
		!manager.state.items.some((i) => i.kind === 'assistant'),
	);

	// The other caller of the same getter: it must reject, not throw synchronously and not hang.
	let rejected = false;
	try {
		await manager.vaultPaths();
	} catch {
		rejected = true;
	}
	check('vaultPaths() rejects cleanly instead of throwing out of the getter', rejected);

	manager.dispose();
}

console.log('C4. A real FileSystemAdapter is unaffected by the unsupported-adapter guard');
{
	// The most likely way to break this: guarding `vaultPath` so eagerly that a normal desktop
	// vault — every other test in this file, `app` included — trips it too.
	const manager = new SessionManager(app);
	eq('a real FileSystemAdapter is never blocked', manager.blocked, null);
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
	const entry = required(
		(config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)[
			'guki-perm'
		],
		"mcpServers['guki-perm']",
	);

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

	const entry = required(
		(bridge.config.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)[
			'guki-perm'
		],
		"mcpServers['guki-perm']",
	);
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
	required(harness.child.stdin, 'the spawned server\'s stdin').write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
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

	required(harness.child.stdin, 'the spawned server\'s stdin').end();
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
		sharedVaultAdapter.getBasePath(),
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

// --- O. Phase 6: attachments -----------------------------------------------

/*
 * Two things, and only the second one is about a string.
 *
 * `attachmentReference` decides the *syntax*, and the syntax is a security decision (PLAN's Phase
 * 6 table): `@path` is expanded by the CLI client-side, before the model sees the message — no
 * `Read`, no tool call, no policy consultation. So `@` is correct for a path already inside the
 * vault, where §2b would allow the read anyway, and catastrophic for one outside it.
 *
 * `resolveVaultFile` decides *whether a chip may exist at all*, and it is the only thing that
 * authorises an `@`. It runs against `POLICY_VAULT` — a real directory with a real symlink out of
 * it — for the same reason §N does: the rule is "the resolved path", and a note that is a symlink
 * pointing out of the vault looks like an ordinary note everywhere else in Obsidian.
 *
 * The quoting asserted below is not style. Measured 2026-09-02 against the real CLI (2.1.258),
 * every read tool in `--disallowedTools` so no `Read` fallback could mask the result: a bare
 * `@/path/with a space/note.md` **did not expand at all** — the model answered `NO_CONTENT` with
 * `permission_denials: []`. Backslash-escaping the spaces did not expand either. `@"…"` expanded,
 * with and without spaces, and with an emoji folder. In this vault (`🏰 300-Projects`,
 * `📥 000-Inbox/Dump`) the unquoted form would have failed on nearly every real note while
 * producing no error anywhere, which is why it is pinned here rather than left to the eye.
 *
 * To drive this section red: drop the quotes in `attachmentReference`, or make `resolveVaultFile`
 * trust `getFullPath` without the `containsPath` check. Each breaks O1/O2 and O3 respectively.
 */

console.log('O1. attachmentReference: the @-form, and when there must not be one');
{
	/*
	 * Table-driven so task 2 extends it by adding rows, not by writing a second test. The
	 * `outside-vault` rows are already here: the *UI* for out-of-vault attachments is task 2, but
	 * the rule is two-way and a two-way rule with one branch asserted is how the wrong half gets
	 * filled in later.
	 */
	const cases: { name: string; path: string; location: AttachmentLocation; want: string | null }[] = [
		{
			name: 'an in-vault path is quoted',
			path: '/vault/notes/todo.md',
			location: 'in-vault',
			want: '@"/vault/notes/todo.md"',
		},
		{
			// The measured reason this function exists.
			name: 'a space does not truncate it',
			path: '/vault/300 Projects/My Note.md',
			location: 'in-vault',
			want: '@"/vault/300 Projects/My Note.md"',
		},
		{
			name: 'an emoji folder is quoted like any other',
			path: '/vault/\u{1F3F0} 300-Projects/Sellina.md',
			location: 'in-vault',
			want: '@"/vault/\u{1F3F0} 300-Projects/Sellina.md"',
		},
		{
			// Quoting a spaceless path expands too (measured), so there is deliberately no branch
			// on "does it contain a space" — one code path, and no rarely-taken half to rot.
			name: 'a spaceless path is quoted anyway, so there is one code path',
			path: '/vault/todo.md',
			location: 'in-vault',
			want: '@"/vault/todo.md"',
		},
		{
			// `@"a "quoted" name"` closes early and expands to nothing — measured. Answering null
			// sends the plain path instead, which the model reads through §2b's gate.
			name: 'a double quote in the name gets no @-form at all',
			path: '/vault/notes/Emre\'s "quoted" note.md',
			location: 'in-vault',
			want: null,
		},
		{
			// Not separately measured — it follows from the measured rule that `@` parsing stops
			// at whitespace, which a quoted string cannot carry past a line break.
			name: 'a newline in the name gets no @-form either',
			path: '/vault/notes/weird\nsecond line.md',
			location: 'in-vault',
			want: null,
		},
		{
			name: 'an empty path is never a reference',
			path: '',
			location: 'in-vault',
			want: null,
		},
		{
			// The direction that matters: `@` here would silently disable all of Phase 5b for this
			// file. A plain path makes the model call `Read`, which raises the card.
			name: 'an out-of-vault path is a PLAIN path, never @',
			path: '/etc/hosts',
			location: 'outside-vault',
			want: '/etc/hosts',
		},
		{
			// A space does not make an out-of-vault path quotable. The quoting exists to carry `@`
			// parsing past whitespace; a plain path is prose the model reads and hands to `Read`,
			// so quote characters here would end up inside the argument it copies. What keeps it
			// unambiguous is `composeMessage` putting every reference on its own line.
			name: 'a space does not make an out-of-vault path quoted',
			path: '/Users/e/Library/Application Support/report.pdf',
			location: 'outside-vault',
			want: '/Users/e/Library/Application Support/report.pdf',
		},
		{
			// The `["\n\r]` guard belongs to the `@` branch only, and this row is what says so: a
			// quote in the name cannot break a plain path, so refusing one would drop the file out
			// of the prompt for no reason. The location test comes first, deliberately.
			name: 'a quote in the name still gets an out-of-vault plain path',
			path: '/tmp/Emre\'s "quoted" file.txt',
			location: 'outside-vault',
			want: '/tmp/Emre\'s "quoted" file.txt',
		},
		{
			name: 'an empty out-of-vault path is never a reference either',
			path: '',
			location: 'outside-vault',
			want: null,
		},
	];

	for (const c of cases) {
		const attachment: PathAttachment = {
			kind: 'path',
			absolutePath: c.path,
			displayName: 'x',
			location: c.location,
		};
		eqCall(c.name, () => attachmentReference(attachment), c.want);
	}

	// Stated once as its own assertion rather than left implicit in the table: no reference for an
	// out-of-vault path may begin with `@`.
	const outside = attachmentReference({
		kind: 'path',
		absolutePath: '/etc/hosts',
		displayName: 'hosts',
		location: 'outside-vault',
	});
	check('...and it does not start with @', outside !== null && !outside.startsWith('@'), String(outside));
}

console.log('O2. composeMessage: an in-vault path reaches the CLI only as an @-form');
{
	/**
	 * The acceptance criterion, as an assertion: **every** occurrence of the path in the outgoing
	 * message is wrapped in `@"…"`, and there is at least one.
	 *
	 * Checking `message.includes('@"' + path + '"')` would not do it — that passes while a second,
	 * bare copy of the same path also sits in the message, which is precisely the bug that has no
	 * visible symptom. So this walks every occurrence.
	 */
	function everyMentionIsAtForm(message: string, absolutePath: string): boolean {
		let from = 0;
		let seen = 0;
		for (;;) {
			const at = message.indexOf(absolutePath, from);
			if (at === -1) {
				break;
			}
			seen += 1;
			const before = message.slice(Math.max(0, at - 2), at);
			const after = message.slice(at + absolutePath.length, at + absolutePath.length + 1);
			if (before !== '@"' || after !== '"') {
				return false;
			}
			from = at + absolutePath.length;
		}
		return seen > 0;
	}

	const spaced = '/vault/\u{1F3F0} 300-Projects/Sellina.md';
	const inVault = (path: string): PathAttachment => ({
		kind: 'path',
		absolutePath: path,
		displayName: 'n.md',
		location: 'in-vault',
	});

	const one = composeMessage('what does this say?', [inVault(spaced)]);
	check('the path appears only as @"…"', everyMentionIsAtForm(one, spaced), one);
	check('...and the typed text survives', one.includes('what does this say?'), one);

	// Two chips, and the text after them.
	const other = '/vault/notes/todo.md';
	const two = composeMessage('compare these', [inVault(spaced), inVault(other)]);
	check('both paths are @-forms (first)', everyMentionIsAtForm(two, spaced), two);
	check('both paths are @-forms (second)', everyMentionIsAtForm(two, other), two);

	// An attachment on its own is a real message — "here, look at this".
	const bare = composeMessage('', [inVault(spaced)]);
	check('an attachment with no text still sends the reference', everyMentionIsAtForm(bare, spaced), bare);
	eq('...and nothing else', bare, `@"${spaced}"`);

	// No attachments: unchanged behaviour, and no stray decoration.
	eq('no attachments leaves the text alone', composeMessage('  hello  ', []), 'hello');

	// The quote-in-name case degrades to a plain path rather than to nothing. Asserted as its own
	// row because "the file silently went missing from the prompt" is the failure to avoid.
	const quoted = '/vault/notes/Emre\'s "quoted" note.md';
	const degraded = composeMessage('read it', [inVault(quoted)]);
	check('a quote-in-name path is still in the prompt, as a plain path', degraded.includes(quoted), degraded);
	check('...and is not wrapped in a broken @-form', !degraded.includes(`@"${quoted}"`), degraded);
}

console.log('O3. resolveVaultFile: only a path that resolves inside the vault becomes a chip');
{
	// A real adapter instance, because the production guard is `instanceof FileSystemAdapter`. Its
	// `getFullPath` does what Obsidian's does: vault-relative in, absolute out.
	const adapter = new FileSystemAdapter();
	adapter.getFullPath = (relative: string) => `${POLICY_VAULT.root}/${relative}`;

	function vaultFile(relativePath: string): TFile {
		const file = new TFile();
		return Object.assign(file, {
			path: relativePath,
			name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
		}) as TFile;
	}

	const app = { vault: { adapter, getName: () => 'vault', getFileByPath: () => null } } as never;

	const ordinary = resolveVaultFile(app, vaultPaths, vaultFile('notes/todo.md'));
	check('an ordinary note resolves', ordinary !== null);
	eq('...to an absolute path', ordinary?.absolutePath, `${POLICY_VAULT.root}/notes/todo.md`);
	eq('...marked in-vault, which is what authorises the @', ordinary?.location, 'in-vault');
	eq('...with the file name on the chip', ordinary?.displayName, 'todo.md');
	// The whole point, joined up: this is the string the CLI will be handed.
	eq(
		'...and composes to an @-form',
		composeMessage('', ordinary ? [ordinary] : []),
		`@"${POLICY_VAULT.root}/notes/todo.md"`,
	);

	/*
	 * The security case. `<vault>/escape` is a real symlink to `<outside>`, so
	 * `escape/secret.txt` is a path Obsidian would happily show inside the vault and that resolves
	 * outside it. An `@` on this would hand the CLI a file from outside the vault with no card and
	 * no denial — the exact bypass PLAN §5 decision 11 refuses to add a fifth of.
	 */
	const escaped = resolveVaultFile(app, vaultPaths, vaultFile('escape/secret.txt'));
	eq('a note that resolves through a symlink OUT of the vault is refused', escaped, null);

	// And nothing that was refused can reach the message.
	eq('...so it contributes nothing to the prompt', composeMessage('read it', []), 'read it');

	// A vault-relative path climbing out with `..`. `realpath` applies `..` after the symlink, so
	// this is the ordering trap §N2 exists for, arriving through the attachment door instead.
	eq(
		'`..` back out of the vault is refused',
		resolveVaultFile(app, vaultPaths, vaultFile('escape/../outside/secret.txt')),
		null,
	);

	/*
	 * **Existence is deliberately not the gate.** A missing file inside the vault still resolves
	 * inside it, because `createVaultPaths` resolves the closest existing *ancestor* and appends
	 * the remainder — the behaviour §N needs so the policy can judge a `Write` to a file that does
	 * not exist yet. Attachments inherit it, and that is right: the boundary is the security
	 * question, and existence is not. A chip's source is always a `TFile` Obsidian just handed us,
	 * so the only way to get here is a file deleted between the drag and the drop — a race whose
	 * cost is an `@` that expands to nothing, not a file read from outside the vault.
	 *
	 * Asserted rather than left unsaid, because the tempting "fix" is to add an existence check,
	 * and that would put a filesystem read into a function that deliberately does not do one.
	 */
	const missing = resolveVaultFile(app, vaultPaths, vaultFile('notes/gone.md'));
	eq('a missing in-vault file is still in-vault', missing?.location, 'in-vault');
	eq(
		'...at the path it would have',
		missing?.absolutePath,
		`${POLICY_VAULT.root}/notes/gone.md`,
	);

	// The adapter guard. On a non-file adapter there is no filesystem path to hand over at all,
	// and a cast that silently succeeded would produce a meaningless string.
	const mobile = { vault: { adapter: {}, getName: () => 'vault', getFileByPath: () => null } } as never;
	eq(
		'a non-FileSystemAdapter vault attaches nothing',
		resolveVaultFile(mobile, vaultPaths, vaultFile('notes/todo.md')),
		null,
	);
}

console.log('O4. the chip list');
{
	const chip = (path: string): PathAttachment => ({
		kind: 'path',
		absolutePath: path,
		displayName: 'n.md',
		location: 'in-vault',
	});

	// Dragging the same note twice is one chip — and the same guard is what stops the drag-manager
	// source and the `dataTransfer` fallback from both adding it.
	const once = addAttachment([], chip('/vault/a.md'));
	eq('the first attachment is added', once.length, 1);
	eq('the same path again is not', addAttachment(once, chip('/vault/a.md')).length, 1);
	eq('a different path is', addAttachment(once, chip('/vault/b.md')).length, 2);

	// The composer's emptiness check cannot be the textarea alone.
	eq('empty text with no chips is not sendable', hasSendableContent('   ', []), false);
	eq('empty text with a chip is', hasSendableContent('   ', [chip('/vault/a.md')]), true);
	eq('text with no chips is', hasSendableContent('hi', []), true);
}

console.log('O5. resolveExternalFile: the location comes from the path, never from the door');
{
	/*
	 * Task 2's rule, and the one way to get it wrong.
	 *
	 * A file that arrives from outside Obsidian — Finder drag, paste, picker — is placed by where
	 * it *resolves*, not by where it came from. Both answers are legal and both are asserted here,
	 * because "it arrived from outside Obsidian, so treat it as outside the vault" is the
	 * plausible-sounding half of the rule and it fails in the direction with no symptom: a vault
	 * file would be sent as a plain path (harmless, just a card the reader did not need), while the
	 * mirror mistake — trusting the raw path instead of the resolved one — hands the CLI an
	 * out-of-vault file as an `@`, with no card and no denial.
	 *
	 * Fixtures are built by **string concatenation, never `path.join`** (trap 28): `join` collapses
	 * `..` lexically, before any symlink is followed, which is exactly the normalisation the
	 * resolver must not do.
	 */
	const outsideFile = `${POLICY_VAULT.outside}/task2-outside.txt`;
	const outsideDir = `${POLICY_VAULT.outside}/task2-dir`;
	const intoVault = `${POLICY_VAULT.outside}/task2-into-vault`;
	writeFileSync(outsideFile, 'out\n');
	mkdirSync(outsideDir, { recursive: true });
	// A symlink living *outside* the vault that points *into* it. The mirror of `escape`.
	symlinkSync(`${POLICY_VAULT.root}/notes`, intoVault);

	const external = (absolutePath: string, displayName = 'x'): { absolutePath: string; displayName: string } => ({
		absolutePath,
		displayName,
	});

	// 1. The ordinary out-of-vault case: a chip, and a PLAIN path in the prompt.
	const out = await resolveExternalFile(vaultPaths, external(outsideFile, 'task2-outside.txt'));
	eq('a file outside the vault is attached', out.kind, 'attached');
	if (out.kind === 'attached') {
		eq('...marked outside-vault', out.attachment.location, 'outside-vault');
		eq('...with the name off the File', out.attachment.displayName, 'task2-outside.txt');
		eq('...and no @ in the prompt', composeMessage('read it', [out.attachment]), `${outsideFile}\n\nread it`);
		check(
			'...so the model has to call Read, which §2b turns into a card',
			!composeMessage('', [out.attachment]).includes('@'),
			composeMessage('', [out.attachment]),
		);
	}

	/*
	 * 2. **Emre's case from task 1's acceptance run.** A file dragged in from Finder that happens
	 * to live inside the vault must become an `@`, exactly like one dragged from the file explorer.
	 * Task 1 refused it, because it never touched the `File` API and so had no path to resolve.
	 */
	const insideViaFinder = await resolveExternalFile(
		vaultPaths,
		external(`${POLICY_VAULT.root}/notes/todo.md`, 'todo.md'),
	);
	eq('a vault file dragged in from Finder is attached', insideViaFinder.kind, 'attached');
	if (insideViaFinder.kind === 'attached') {
		eq('...marked IN-vault, from where it is and not where it came from', insideViaFinder.attachment.location, 'in-vault');
		eq(
			'...so it composes to an @-form',
			composeMessage('', [insideViaFinder.attachment]),
			`@"${POLICY_VAULT.root}/notes/todo.md"`,
		);
	}

	// 3. And the same answer through a symlink that points into the vault from outside it. The
	// path the user handed us is outside; the file is inside; the file is what counts.
	const throughInLink = await resolveExternalFile(vaultPaths, external(`${intoVault}/todo.md`));
	eq('a symlink from outside INTO the vault is in-vault', throughInLink.kind === 'attached' && throughInLink.attachment.location, 'in-vault');
	eq(
		'...at the resolved path, not the one dropped',
		throughInLink.kind === 'attached' && throughInLink.attachment.absolutePath,
		`${POLICY_VAULT.root}/notes/todo.md`,
	);

	/*
	 * 4. The reverse, and the reversion target. `<vault>/escape` is a real symlink out of the
	 * vault, so this path *looks* inside it and resolves outside. A string prefix match on the raw
	 * path answers in-vault and `@`-references a file from outside the vault with no card at all.
	 *
	 * Note the deliberate asymmetry with §O3: through the in-vault door (a `TFile` from Obsidian's
	 * own explorer) this same file is still **refused**, which is task 1's behaviour and is left
	 * alone here. Through the external door it becomes a plain path, which is strictly better than
	 * a refusal — it is attachable and it raises a card. Unifying the two doors is a change to
	 * verified behaviour and is flagged for the orchestrator rather than made here.
	 */
	const escaped = await resolveExternalFile(vaultPaths, external(`${POLICY_VAULT.root}/escape/secret.txt`));
	eq('a vault path that resolves OUT through a symlink is outside-vault', escaped.kind === 'attached' && escaped.attachment.location, 'outside-vault');
	eq(
		'...at the real path outside the vault',
		escaped.kind === 'attached' && escaped.attachment.absolutePath,
		`${POLICY_VAULT.outside}/secret.txt`,
	);
	check(
		'...and never as an @',
		escaped.kind === 'attached' && !(attachmentReference(escaped.attachment) ?? '@').startsWith('@'),
	);

	// 5. `..` applied after the symlink, arriving through the attachment door (trap 28 / §N2).
	const dotdot = await resolveExternalFile(
		vaultPaths,
		external(`${POLICY_VAULT.root}/escape/../outside/secret.txt`),
	);
	eq('`..` after a symlink resolves outside the vault', dotdot.kind === 'attached' && dotdot.attachment.location, 'outside-vault');

	// 6. Directories, refused on both sides of the boundary. `Read` on a directory errors, and the
	// check is a real `stat` of the resolved path rather than an inspection of the `File`, whose
	// `type` and `size` for a directory are platform trivia.
	const droppedDir = await resolveExternalFile(vaultPaths, external(outsideDir, 'task2-dir'));
	eq('a dropped folder is refused', droppedDir.kind, 'refused');
	eq('...as a folder, so the notice can say so', droppedDir.kind === 'refused' && droppedDir.reason, 'directory');
	eq('...naming it', droppedDir.kind === 'refused' && droppedDir.displayName, 'task2-dir');
	const inVaultDir = await resolveExternalFile(vaultPaths, external(`${POLICY_VAULT.root}/notes`, 'notes'));
	eq('a folder inside the vault is refused too', inVaultDir.kind === 'refused' && inVaultDir.reason, 'directory');
	// A symlink to a directory is caught because the stat is of the resolved path.
	const linkedDir = await resolveExternalFile(vaultPaths, external(intoVault, 'task2-into-vault'));
	eq('a symlink to a folder is refused as a folder', linkedDir.kind === 'refused' && linkedDir.reason, 'directory');

	/*
	 * 7. A path that no longer exists. Unlike the in-vault door (§O3), existence *is* checked here
	 * — and for a reason that is not about security: an external `File` names something that was
	 * on disk a moment ago, so a missing one means it went away underneath us and there is nothing
	 * to attach. The in-vault door keeps a `TFile` Obsidian is still holding.
	 */
	const gone = await resolveExternalFile(vaultPaths, external(`${POLICY_VAULT.outside}/task2-gone.txt`, 'task2-gone.txt'));
	eq('a path that no longer exists is refused', gone.kind === 'refused' && gone.reason, 'unresolvable');
	// `~` is expanded by a shell, and nothing here runs one — `VaultPaths.resolve` answers null
	// rather than treating it as a directory name (which would place it inside the vault).
	const tilde = await resolveExternalFile(vaultPaths, external('~/.ssh/id_rsa', 'id_rsa'));
	eq('a ~ path is refused rather than resolved', tilde.kind === 'refused' && tilde.reason, 'unresolvable');

	// 8. The whole external door, joined up: `File`s in, one message out. Two files, one on each
	// side of the boundary, in one paste — which is what makes the per-file rule visible.
	const files = externalFilePaths([
		{ name: 'todo.md', path: `${POLICY_VAULT.root}/notes/todo.md` },
		{ name: 'task2-outside.txt', path: outsideFile },
	] as unknown as ArrayLike<File>);
	eq('both files came through with paths', files.length, 2);
	const attachments: PathAttachment[] = [];
	for (const file of files) {
		const resolution = await resolveExternalFile(vaultPaths, file);
		if (resolution.kind === 'attached') {
			attachments.push(resolution.attachment);
		}
	}
	eq('both became chips', attachments.length, 2);
	eq(
		'the vault one is an @-form and the outside one is a plain path, in one message',
		composeMessage('compare these', attachments),
		`@"${POLICY_VAULT.root}/notes/todo.md"\n${outsideFile}\n\ncompare these`,
	);
}

console.log('O6. absolutePathForFile: feature detection, and the no-path branch task 3 needs');
{
	/*
	 * R11's rule, as an assertion. Electron removed `File.path` in 32 in favour of
	 * `webUtils.getPathForFile`; this machine's Obsidian 1.13.7 bundles Electron 43.3.0, so
	 * `File.path` is already gone here — but it is written as **feature detection, not a version
	 * check**, because Obsidian's bundled Electron moves on its own schedule and a hardcoded
	 * threshold would need re-verifying at every Obsidian update.
	 *
	 * Both outer branches are drivable offline. The middle one is not: there is no `electron`
	 * module in this harness, so `window.require('electron')` throws and the function answers
	 * null — which is the same answer a real path-less `File` produces, and it is the branch PLAN
	 * Phase 6 task 3 (the clipboard image) is built on. That the *live* renderer reaches
	 * `webUtils` is a manual step, not this.
	 */
	const asFile = (shape: Record<string, unknown>): File => shape as unknown as File;

	eq(
		'a File carrying a path (older Electron) is used as-is',
		absolutePathForFile(asFile({ name: 'a.pdf', path: '/tmp/a.pdf' })),
		'/tmp/a.pdf',
	);
	eq(
		'a File with no path at all falls through to webUtils, and here to null',
		absolutePathForFile(asFile({ name: 'shot.png' })),
		null,
	);
	// Obsidian's own handler reads `d.path || ""` and then tests `!s`, so an empty string means
	// "no path" and must not be returned as one (app.js 1.13.7, byte 1,444,293).
	eq(
		'an empty path is not a path',
		absolutePathForFile(asFile({ name: 'shot.png', path: '' })),
		null,
	);
	eq(
		'a non-string path is not trusted either',
		absolutePathForFile(asFile({ name: 'odd.bin', path: 42 })),
		null,
	);

	// The list form the three affordances hand over. A path-less `File` is dropped in silence:
	// that is the clipboard image, and a notice here would be one task 3 deletes.
	const mixed = externalFilePaths([
		{ name: 'a.pdf', path: '/tmp/a.pdf' },
		{ name: 'shot.png' },
		{ name: 'b.txt', path: '/tmp/b.txt' },
	] as unknown as ArrayLike<File>);
	eq('the path-less File is dropped', mixed.length, 2);
	eq('...order is kept', mixed.map((f) => f.absolutePath).join(','), '/tmp/a.pdf,/tmp/b.txt');
	eq('...and the display name comes off the File', mixed[0]?.displayName, 'a.pdf');
	eq('no FileList at all is no files', externalFilePaths(null).length, 0);
	eq('an empty FileList is no files', externalFilePaths([] as unknown as ArrayLike<File>).length, 0);
}

/*
 * §O7–O10 are task 3: the pasted clipboard image, the one attachment that sends **bytes**.
 *
 * Everything above holds a path, and the assertions above are about which *syntax* that path
 * reaches the CLI as. An image has no path at all, and the failure modes are different in kind:
 *
 * - it must never contribute text to the prompt. A fake path — `''`, a `blob:` URL, a temp file —
 *   would flow through `composeMessage` into the message body and through `attachmentReference`'s
 *   `location` check, where a bitmap would be classified as in-vault or out-of-vault. One of those
 *   is an `@`. Nothing errors (§O7);
 * - an image with no typed text composes to the empty string, and `SessionManager.send`'s emptiness
 *   test used to drop exactly that message with no bubble, no error and no notice (§O8);
 * - the base64 has to be right, and eyeballing a screenshot proves nothing (§O9);
 * - the media type is a gate, because bytes the pipeline cannot decode come back
 *   `subtype: "success"` — a billed turn with the model apologising, and no error state anywhere
 *   (measured, PHASE6-TASK3-STATE M3). §O10.
 */

console.log('O7. an image attachment contributes NO text to the prompt');
{
	const image = (id: string, data = 'aGk='): ImageAttachment => ({
		kind: 'image',
		id,
		displayName: 'Pasted image',
		mediaType: 'image/png',
		data,
		byteLength: 2,
	});
	const inVault: PathAttachment = {
		kind: 'path',
		absolutePath: `${POLICY_VAULT.root}/notes/todo.md`,
		displayName: 'todo.md',
		location: 'in-vault',
	};

	// The exhaustive dispatcher: this is where the compiler asks every kind what it puts in the
	// prompt, and for an image the answer is nothing, because it travels in its own content block.
	eq('promptReference of an image is null', promptReference(image('image-1')), null);
	eq('promptReference of a path is the reference', promptReference(inVault), `@"${inVault.absolutePath}"`);

	// The acceptance-shaped statement of the same thing.
	eq('an image alone composes to the empty string', composeMessage('', [image('image-1')]), '');
	eq('...and with text, to exactly the text', composeMessage('what is this?', [image('image-1')]), 'what is this?');

	/*
	 * The catastrophic direction, stated so it cannot be reintroduced quietly. A bytes attachment
	 * that carried an invented path would put that path in the prompt as free-standing text, and a
	 * bytes attachment that carried a `location` would take the `@` branch.
	 */
	const mixed = composeMessage('compare these', [image('image-1'), inVault, image('image-2')]);
	eq(
		'two images beside a path chip leave only the path in the message',
		mixed,
		`@"${inVault.absolutePath}"\n\ncompare these`,
	);
	check('no image id leaks into the prompt', !mixed.includes('image-1') && !mixed.includes('image-2'), mixed);
	check('no base64 leaks into the prompt', !mixed.includes('aGk='), mixed);
	check('no data: URL leaks into the prompt', !mixed.includes('data:'), mixed);
	// The one that has no visible symptom: an `@` for something that is not a file at all.
	check('an image never produces an @', !composeMessage('', [image('image-1')]).includes('@'), mixed);

	// Identity. A path chip is keyed by its path, an image by its generated id — the clipboard calls
	// every screenshot `image.png`, so two pastes must be two chips and not one.
	eq('an image is keyed by its id', attachmentKey(image('image-7')), 'image-7');
	eq('a path is keyed by its path', attachmentKey(inVault), inVault.absolutePath);
	eq('the same image id twice is one chip', addAttachment([image('image-1')], image('image-1')).length, 1);
	eq(
		'two pasted images with identical bytes are two chips',
		addAttachment([image('image-1')], image('image-2')).length,
		2,
	);
	// A path chip and an image chip cannot collide even if the ids were to look like paths.
	eq('a path and an image coexist', addAttachment([inVault], image('image-1')).length, 2);

	// The split the wire is built from.
	eq('imageAttachments picks only the images', imageAttachments([image('image-1'), inVault, image('image-2')]).length, 2);
	eq('...in order', imageAttachments([image('image-3'), inVault, image('image-4')]).map((i) => i.id).join(','), 'image-3,image-4');
	eq('a chip list with no images yields none', imageAttachments([inVault]).length, 0);
}

console.log('O8. an image with no typed text is a sendable message, and is not dropped');
{
	/*
	 * **The bug this section exists for.** `SessionManager.send` tested `message.length === 0` and
	 * returned. An image contributes nothing to `message`, so an image with no typed text hit that
	 * branch: the composer cleared, no user bubble appeared, no assistant turn started, and nothing
	 * anywhere said why. `hasSendableContent` already answered `true` for the same input, so the
	 * composer let Send be pressed — the two disagreed and this was the one that lied.
	 *
	 * Driven through the real `SessionManager` with `ensureProcess` and the process stubbed, the
	 * way §C drives the queue, so it is the production emptiness test under assertion and not a
	 * re-implementation of it.
	 */
	const image: ImageAttachment = {
		kind: 'image',
		id: 'image-send-1',
		displayName: 'Pasted image',
		mediaType: 'image/png',
		data: 'aVZCT1J3MEs=',
		byteLength: 8,
	};

	const written: string[] = [];
	const session = new SessionManager(app);
	const internals = session as unknown as {
		ensureProcess: () => Promise<boolean>;
		process: { alive: boolean; write: (line: string) => boolean; stop: () => void } | null;
	};
	internals.ensureProcess = () => Promise.resolve(true);
	internals.process = {
		alive: true,
		write: (line: string) => {
			written.push(line);
			return true;
		},
		stop: () => undefined,
	};

	// The composer's own gate already says this is sendable; that half was never wrong.
	eq('an image with no text is sendable content', hasSendableContent('', [image]), true);

	session.send('', [image]);
	await Promise.resolve();
	await Promise.resolve();

	const userItems = session.state.items.filter((item) => item.kind === 'user');
	eq('an image with no typed text produces a user message', userItems.length, 1);
	eq('...an assistant turn was started for it', session.state.items.filter((i) => i.kind === 'assistant').length, 1);
	eq('...and it reached the CLI', written.length, 1);

	// The transcript keeps the picture, because the panel shows what was actually sent and an
	// image-only bubble would otherwise be empty.
	const userItem = userItems[0];
	eq('the bubble carries the image', userItem?.kind === 'user' && (userItem.images?.length ?? 0), 1);
	eq('...with no text', userItem?.kind === 'user' && userItem.text, '');

	/*
	 * And the wire payload really is an image block with no text block beside it (M4).
	 *
	 * Deliberately **not** `required(written[0], …)`: reverting the emptiness test is the whole
	 * point of this section, and that revert leaves `written` empty. `required` throws, which would
	 * kill the run before its summary line — a reversion that crashes the harness is
	 * indistinguishable from one that never ran, and it reads as a pass. The sentinel turns it into
	 * two reported failures instead.
	 */
	const line = written[0] ?? '';
	const content: { type: string }[] =
		line.length > 0 ? (JSON.parse(line) as { message: { content: { type: string }[] } }).message.content : [];
	eq('one content block', content.length, 1);
	eq('...and it is the image', content[0]?.type, 'image');

	session.dispose();
}

console.log('O9. base64: pinned against a known sequence, and across a chunk boundary');
{
	/*
	 * The encoder is chunked because `btoa(String.fromCharCode(...bytes))` overflows the call stack
	 * on anything screenshot-sized. Chunking is only correct while the chunk is a multiple of 3 —
	 * base64 maps 3 input bytes onto 4 output characters, so a boundary anywhere else would emit
	 * padding in the middle of the string. That is silent: the prefix decodes, the rest is garbage,
	 * and the model reports that it could not see the picture.
	 *
	 * So the interesting fixture is one **longer than the chunk**, compared against Node's own
	 * encoder rather than against a hand-written expectation.
	 */
	eq('empty input encodes to nothing', encodeBase64(new Uint8Array(0)), '');
	eq('a known sequence', encodeBase64(new Uint8Array([104, 105])), 'aGk=');
	// The PNG magic number, which is what every pasted screenshot actually starts with.
	eq(
		'the PNG signature',
		encodeBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		'iVBORw0KGgo=',
	);
	// Each of the three residue classes mod 3, so both padding cases are covered.
	for (const length of [1, 2, 3, 4, 5]) {
		const bytes = new Uint8Array(length);
		for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
		eq(`${String(length)} byte(s) match Buffer`, encodeBase64(bytes), Buffer.from(bytes).toString('base64'));
	}

	/*
	 * Longer than one chunk (32,766 bytes) and deliberately not a multiple of it, so the last chunk
	 * is short and the boundary is really crossed. This is the assertion that fails if the chunk
	 * size stops being divisible by 3.
	 *
	 * **Sized like a real screenshot, not like a threshold.** The first version of this fixture was
	 * 66 KB, and the sweep caught it: reverting the encoder to
	 * `btoa(String.fromCharCode(...bytes))` — the exact trap chunking exists to avoid — left the
	 * suite GREEN, because 66,766 arguments do not overflow V8's stack. A fixture tuned to sit just
	 * past the real limit would rot the moment a stack size changes, so this uses the input size
	 * the code actually sees instead: a full-display retina PNG. Task 2's measured clipboard paste
	 * was 27,878 bytes and the screenshots on this machine run 240–526 KB (M2), so 3 MiB is a
	 * generous but honest stand-in, and it overflows the spread form comfortably.
	 */
	const big = new Uint8Array(3 * 1024 * 1024 + 1234);
	for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff;
	/*
	 * `eqCall`, not `eq`, and for the reason `eqCall` exists. The failure this guards against is
	 * `btoa(String.fromCharCode(...bytes))`, which does not return a wrong answer — it **throws**
	 * a stack overflow. Evaluated as an argument to `eq` that throw would escape, kill the run
	 * before its summary line, and read as a check that never ran.
	 */
	eqCall('a multi-chunk buffer matches Buffer exactly', () => encodeBase64(big), Buffer.from(big).toString('base64'));
	// Stated separately, because it is the specific way a wrong chunk size fails: padding may only
	// ever appear as one or two characters at the very end. Interior `=` means a chunk boundary
	// landed off a multiple of 3, and everything after it decodes to garbage — silently.
	let encoded = '';
	try {
		encoded = encodeBase64(big);
	} catch {
		// Reported by the assertion below rather than taking the run down with it.
	}
	check('...with padding only at the very end', /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), encoded.slice(0, 40));

	// The data URL the chip and the bubble render from, and the tooltip that tells two apart.
	const shot: ImageAttachment = {
		kind: 'image',
		id: 'image-1',
		displayName: 'Pasted image',
		mediaType: 'image/png',
		data: 'iVBORw0KGgo=',
		byteLength: 27_878,
	};
	eq('the data URL carries the media type', imageDataUrl(shot), 'data:image/png;base64,iVBORw0KGgo=');
	eq('the tooltip names the format and size', imageSummary(shot), 'Pasted image — PNG, 27 KB');
}

console.log('O10. the media-type gate, and onPasted\'s decision table');
{
	/*
	 * Which formats, and why there is a gate at all when PLAN says "no supported-format list of our
	 * own". That sentence is about the path case, where `Read` decides what it can open. Here we
	 * build the block, so we make the claim.
	 *
	 * Measured 2026-09-02 (M3), and it is the reason this is not merely tidiness: bytes the
	 * pipeline cannot decode return `subtype: "success"`, `is_error: false`, as an ordinary
	 * assistant bubble in which the model says it could not see the image. No error state, no red,
	 * a real API charge. In all three refusals the model named exactly PNG / JPEG / GIF / WebP.
	 */
	eq('png is accepted', isImageMediaType('image/png'), true);
	eq('jpeg is accepted', isImageMediaType('image/jpeg'), true);
	eq('gif is accepted', isImageMediaType('image/gif'), true);
	eq('webp is accepted', isImageMediaType('image/webp'), true);
	// The one a web-page drag really produces, and the one that would come back as a polite
	// non-answer rather than an error.
	eq('svg is refused', isImageMediaType('image/svg+xml'), false);
	eq('heic is refused', isImageMediaType('image/heic'), false);
	eq('tiff is refused', isImageMediaType('image/tiff'), false);
	eq('bmp is refused', isImageMediaType('image/bmp'), false);
	eq('an empty type is refused', isImageMediaType(''), false);
	eq('a non-image type is refused', isImageMediaType('application/pdf'), false);
	// Case matters: the list is compared exactly, so a would-be `IMAGE/PNG` is not silently taken.
	eq('the comparison is exact', isImageMediaType('IMAGE/PNG'), false);

	/*
	 * `triageImageFiles` — the synchronous half, which is what `onPasted` answers from.
	 *
	 * `absolutePathForFile` answers `null` for every `File` in this harness that has no `path`
	 * property (there is no `electron` module here, §O6), so a fixture with a `path` is the
	 * "file copied in Finder" case and one without is the "clipboard bitmap" case.
	 */
	const asFiles = (shapes: Record<string, unknown>[]): ArrayLike<File> => shapes as unknown as ArrayLike<File>;

	// 1. Plain text: no files at all, so nothing is taken and the textarea keeps the paste.
	const nothing = triageImageFiles(asFiles([]));
	eq('an empty list yields no images', nothing.images.length, 0);
	eq('...and no refusals', nothing.unsupported.length, 0);
	eq('no list at all is the same', triageImageFiles(null).images.length, 0);
	eq('undefined is the same', triageImageFiles(undefined).unsupported.length, 0);

	// 2. A file copied in Finder — it has a path, so it belongs to task 2 and this door ignores it
	// entirely. Including when it is an image: a `.png` on disk is read by `Read`, not sent as bytes.
	const withPaths = triageImageFiles(asFiles([
		{ name: 'a.pdf', type: 'application/pdf', path: '/tmp/a.pdf' },
		{ name: 'shot.png', type: 'image/png', path: '/tmp/shot.png' },
	]));
	eq('a file with a path is not taken as bytes', withPaths.images.length, 0);
	eq('...not even an image file with a path', withPaths.unsupported.length, 0);
	// Stated from the other side too: task 2's door still claims both of them.
	eq('...because task 2 has them', externalFilePaths(asFiles([
		{ name: 'a.pdf', type: 'application/pdf', path: '/tmp/a.pdf' },
		{ name: 'shot.png', type: 'image/png', path: '/tmp/shot.png' },
	])).length, 2);

	// 3. The clipboard bitmap: path-less and in an accepted format.
	const pasted = triageImageFiles(asFiles([{ name: 'image.png', type: 'image/png', size: 27878 }]));
	eq('a path-less png is taken as bytes', pasted.images.length, 1);
	eq('...and is not refused', pasted.unsupported.length, 0);

	// 4. A path-less image in a format the model cannot read — refused, and the notice can name it.
	const svg = triageImageFiles(asFiles([{ name: 'logo.svg', type: 'image/svg+xml' }]));
	eq('a path-less svg is not sent', svg.images.length, 0);
	eq('...it is refused', svg.unsupported.length, 1);
	eq('...naming the file', svg.unsupported[0]?.displayName, 'logo.svg');
	eq('...and the type, so the notice is actionable', svg.unsupported[0]?.mediaType, 'image/svg+xml');

	// 5. A path-less `File` that is not an image at all is passed over **in silence**, which is
	// what task 2 did with every path-less File. We have never seen one; inventing a notice for it
	// would train the reader to ignore notices.
	const odd = triageImageFiles(asFiles([{ name: 'mystery', type: 'application/x-thing' }]));
	eq('a path-less non-image is not taken', odd.images.length, 0);
	eq('...and is not reported either', odd.unsupported.length, 0);

	// 6. One paste carrying both doors' payloads. Neither door may swallow the other's file.
	const both = asFiles([
		{ name: 'notes.txt', type: 'text/plain', path: '/tmp/notes.txt' },
		{ name: 'image.png', type: 'image/png' },
	]);
	eq('the path file goes to task 2', externalFilePaths(both).length, 1);
	eq('...at its path', externalFilePaths(both)[0]?.absolutePath, '/tmp/notes.txt');
	eq('the path-less image goes to task 3', triageImageFiles(both).images.length, 1);

	/*
	 * 7. `onPasted`'s decision table, as the view computes it.
	 *
	 * This is the value that decides `preventDefault()`. Getting it wrong in the false direction
	 * means an ordinary text paste stops landing in the textarea — the regression Emre checked by
	 * hand in task 2 step 7. The view's expression is reproduced here rather than called, because
	 * there is no DOM harness in this project; manual steps 3 and 4 are the witnesses to the
	 * wiring itself, and this pins the decision the wiring carries.
	 */
	const paste = (files: ArrayLike<File> | null): boolean => {
		const external = externalFilePaths(files);
		const triage = triageImageFiles(files);
		return external.length > 0 || triage.images.length > 0 || triage.unsupported.length > 0;
	};
	eq('plain text is NOT taken, so the textarea still gets it', paste(asFiles([])), false);
	eq('...and neither is a paste with no clipboard data', paste(null), false);
	eq('a file copied in Finder is taken, as a path chip', paste(asFiles([{ name: 'a.pdf', path: '/tmp/a.pdf', type: 'application/pdf' }])), true);
	eq('a path-less image is taken, as bytes', paste(asFiles([{ name: 'image.png', type: 'image/png' }])), true);
	eq('a refused image is still taken, so the notice is the answer', paste(asFiles([{ name: 'l.svg', type: 'image/svg+xml' }])), true);
	eq('a path-less non-image is NOT taken', paste(asFiles([{ name: 'mystery', type: 'application/x-thing' }])), false);

	/*
	 * 8. `readImageAttachment` end to end, with a `File` stub whose `arrayBuffer` is real. This is
	 * the function that stamps the media type onto the outgoing block, so it re-checks rather than
	 * trusting the triage.
	 */
	const stubFile = (name: string, type: string, bytes: Uint8Array): File => ({
		name,
		type,
		arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
	}) as unknown as File;

	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const read = await readImageAttachment(stubFile('image.png', 'image/png', png));
	eq('a png File becomes an image attachment', read?.kind, 'image');
	eq('...with the bytes base64-encoded', read?.data, 'iVBORw0KGgo=');
	eq('...carrying its media type', read?.mediaType, 'image/png');
	eq('...and its decoded length', read?.byteLength, 8);
	// The clipboard's generic name is replaced; anything else is kept.
	eq('the clipboard\'s generic name becomes a label', read?.displayName, 'Pasted image');
	eq(
		'...but a real name is kept',
		(await readImageAttachment(stubFile('diagram.png', 'image/png', png)))?.displayName,
		'diagram.png',
	);
	// Ids are per-attachment, so two reads of identical bytes are two chips.
	const first = await readImageAttachment(stubFile('image.png', 'image/png', png));
	const second = await readImageAttachment(stubFile('image.png', 'image/png', png));
	check('two reads get different ids', (first?.id ?? '') !== (second?.id ?? ''), `${String(first?.id)} vs ${String(second?.id)}`);

	// The gate again, at the point the claim is made.
	eq('an svg File is refused here too', await readImageAttachment(stubFile('l.svg', 'image/svg+xml', png)), null);
	// Zero bytes would decode to nothing and come back as a successful turn saying so (M3).
	eq('an empty File is refused', await readImageAttachment(stubFile('image.png', 'image/png', new Uint8Array(0))), null);
	// A read that throws is a refusal, not a crash inside the paste handler.
	const exploding = { name: 'image.png', type: 'image/png', arrayBuffer: () => Promise.reject(new Error('gone')) } as unknown as File;
	eq('a File whose bytes cannot be read is refused', await readImageAttachment(exploding), null);

	/*
	 * 9. The wire format, from RESEARCH B6 — images first, text last, and no empty text block.
	 */
	const block = (data: string, mediaType = 'image/png') => ({ mediaType, data });
	const withText: unknown = JSON.parse(userMessageLine('what is this?', [block('aGk=')]));
	const contentOf = (payload: unknown): { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] =>
		(payload as { message: { content: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] } }).message.content;

	eq('an image and text are two blocks', contentOf(withText).length, 2);
	eq('...the image comes first', contentOf(withText)[0]?.type, 'image');
	eq('...as a base64 source', contentOf(withText)[0]?.source?.type, 'base64');
	eq('...with the media type the API field name wants', contentOf(withText)[0]?.source?.media_type, 'image/png');
	eq('...and the raw base64, with no data: prefix', contentOf(withText)[0]?.source?.data, 'aGk=');
	eq('...the text comes last', contentOf(withText)[1]?.type, 'text');
	eq('...unchanged', contentOf(withText)[1]?.text, 'what is this?');

	// Measured (M4): a content array of image blocks alone is accepted, so no filler text is
	// invented for the API's benefit. An empty text block would be a request the API rejects.
	const noText: unknown = JSON.parse(userMessageLine('', [block('aGk='), block('/9j/', 'image/jpeg')]));
	eq('an image with no text is image blocks only', contentOf(noText).length, 2);
	eq('...both images', contentOf(noText).filter((b) => b.type === 'image').length, 2);
	eq('...and no empty text block', contentOf(noText).filter((b) => b.type === 'text').length, 0);
	eq('...in the order they were attached', contentOf(noText)[1]?.source?.media_type, 'image/jpeg');

	// The unchanged case: a message with no images is exactly what Phases 2–5 sent.
	const plain: unknown = JSON.parse(userMessageLine('merhaba'));
	eq('a text-only message is one text block', contentOf(plain).length, 1);
	eq('...unchanged from RESEARCH B1', contentOf(plain)[0]?.text, 'merhaba');
}

console.log('O11. which paste is the composer\'s — the ownership predicate');
{
	/*
	 * `pasteBelongsToComposer` decides, for a `paste` dispatched anywhere in the document, whether
	 * this panel takes it. It runs *before* §O10's decision table: §O10 says what a claimed paste
	 * turns into, this says whether it is claimed.
	 *
	 * **Why it is asserted, when §S of PHASE6-TASK4-STATE.md argued no assertion was owed.** That
	 * argument was right about the CSS and wrong here. The inline version of this test had two
	 * branches — target inside the composer, or target an ancestor of it — and a paste aimed at a
	 * reply bubble's `<li>` satisfies neither, because a selection in the transcript makes the
	 * `<li>` itself the event target (§M7, measured in Emre's console). Clicking a bubble and
	 * pressing Cmd+V therefore did nothing at all: the exact gesture the change existed to fix.
	 * Row 3 below is that defect. The rows either side of it are the opposite risk — a predicate
	 * that claims a target outside the panel takes a note's paste away from the note, silently.
	 *
	 * **There is no DOM in this harness.** Node has no `document` (checked: `typeof document ===
	 * 'undefined'`), the project has no jsdom, and `docs/obsidian-stub.mjs` is classes and two
	 * functions — it has never had a DOM. So the tree below is built out of plain objects with a
	 * real `contains`, walking real parent links, and cast to `Node` at the boundary. That is the
	 * same idiom §O10 uses for its `File` stubs, and it is not a weakened test: `contains` is the
	 * *only* DOM method the predicate calls, and this implementation obeys its actual contract,
	 * including that a node contains itself. What it cannot prove is the wiring — that the listener
	 * is on the document and that `event.target` is what is passed in — and that is what the manual
	 * step 11 is for.
	 */
	interface FakeNode {
		readonly tag: string;
		parent: FakeNode | null;
		contains(other: unknown): boolean;
	}

	const node = (tag: string, children: FakeNode[] = []): FakeNode => {
		const self: FakeNode = {
			tag,
			parent: null,
			contains(other: unknown): boolean {
				for (let walk = other as FakeNode | null; walk; walk = walk.parent) {
					if (walk === self) {
						return true;
					}
				}
				return false;
			},
		};
		for (const child of children) {
			child.parent = self;
		}
		return self;
	};
	const asNode = (fake: FakeNode): Node => fake as unknown as Node;

	/*
	 * The real shape, from `chat-view.ts:56-74`: `.guki-root` is `panelEl`, `.guki-composer` is the
	 * form, and the transcript and the footer are siblings inside the panel. The note leaf is a
	 * *sibling subtree* of the panel — that is the whole point of it being here.
	 */
	const textarea = node('textarea');
	const attachButton = node('button.guki-composer-attach');
	const tools = node('div.guki-composer-tools', [attachButton]);
	const form = node('div.guki-composer', [tools, textarea]);
	const footer = node('div.guki-footer', [form]);
	const bubbleLi = node('li[dir=auto]');
	const bubbleBody = node('div.guki-message-body', [bubbleLi]);
	const bubble = node('div.guki-message', [bubbleBody]);
	const transcript = node('div.guki-messages-wrap', [bubble]);
	const panel = node('div.guki-root', [transcript, footer]);
	const viewContent = node('div.view-content', [panel]);
	const gukiLeaf = node('div.workspace-leaf-content[guki]', [viewContent]);
	const noteLi = node('li[dir=auto][note]');
	const noteEditor = node('div.cm-content', [noteLi]);
	const noteTab = node('div.workspace-tab-header');
	const noteLeaf = node('div.workspace-leaf-content[markdown]', [noteEditor, noteTab]);
	const workspace = node('div.workspace', [gukiLeaf, noteLeaf]);
	const body = node('body', [workspace]);

	const ours = (target: FakeNode, pointerInPanel: boolean, shown: boolean): boolean =>
		pasteBelongsToComposer(asNode(target), asNode(form), asNode(panel), pointerInPanel, shown);

	// The tree itself, first — a `contains` that answered "yes" to everything would make every row
	// below pass. This is the §K lesson: prove the fixture before trusting the assertion.
	check('the fixture: the panel contains the bubble\'s li', asNode(panel).contains(asNode(bubbleLi)));
	check('the fixture: the panel does NOT contain the note\'s li', !asNode(panel).contains(asNode(noteLi)));
	check('the fixture: body contains the composer', asNode(body).contains(asNode(form)));
	check('the fixture: the note leaf does not contain the composer', !asNode(noteLeaf).contains(asNode(form)));

	// 1. The caret is in the textarea — the ordinary paste, and the `fenerbahçe` path's target.
	// Guards off, because this branch must not depend on them.
	eq('1. the textarea is ours', ours(textarea, false, true), true);
	eq('...and does not need the last click', ours(textarea, false, false), true);

	// 2. Inside the composer but not the textarea: clicking the tools row's empty area, which
	// Emre's console showed as `PASTE <div class="guki-composer-tools">`.
	eq('2. an attach button inside the composer is ours', ours(attachButton, false, true), true);
	eq('...and so is the tools row itself', ours(tools, false, true), true);

	/*
	 * 3. **The escaped defect.** Clicking the text of a reply bubble puts a selection in it
	 * (`.guki-message` re-enables `user-select`, styles.css:76) and Chromium dispatches `paste` to
	 * the selection anchor's node — the `<li>` — not to `document.activeElement`, which was `body`.
	 * Neither of the old branches matched: the composer does not contain the `<li>`, and the `<li>`
	 * does not contain the composer. Without this row the fix is unverified.
	 */
	eq('3. an li inside a reply bubble is ours', ours(bubbleLi, true, true), true);
	// Asserted with the guards *off* as well, because the in-panel branch is deliberately
	// unguarded: a target in the panel says where the reader is, so nothing else has to.
	eq('...even with no recorded click in the panel', ours(bubbleLi, false, true), true);
	eq('...and the bubble and the transcript with it', ours(bubble, false, true), true);
	eq('...including the scroller between bubbles', ours(transcript, false, true), true);
	// The panel's own root, and the footer: in-panel ancestors of the composer, which the old
	// version reached only through the guarded branch and this one claims outright.
	eq('...and blank panel space (the root itself)', ours(panel, false, false), true);
	eq('...and the footer around the composer', ours(footer, false, false), true);

	// 4. Outside the transcript there is no selection, so the paste goes to `body` — the case the
	// ancestor branch was written for, and the one Emre's second console line shows.
	eq('4. body with the last click in the panel is ours', ours(body, true, true), true);
	eq('...and so is any other ancestor of the composer', ours(viewContent, true, true), true);
	eq('...and the leaf holding our view', ours(gukiLeaf, true, true), true);

	/*
	 * 5. **The guard Emre confirmed by hand, and the most important row here.** Obsidian routes an
	 * unfocused paste to the active leaf (§M5), so clicking another note's tab header and pressing
	 * Cmd+V puts the text in that note. `body` is an ancestor of our composer too, so without the
	 * last-click requirement we would claim it. A failure on this row means we are stealing pastes.
	 */
	eq('5. body with the last click OUTSIDE the panel is not ours', ours(body, false, true), false);
	eq('...nor is any other ancestor', ours(viewContent, false, true), false);

	// 6. The stale path: the panel was clicked, then hidden by a keyboard tab switch rather than by
	// a click somewhere else, so `pointerInPanel` is still true and only `isShown()` knows.
	eq('6. body with the panel hidden is not ours', ours(body, true, false), false);
	eq('...and both guards failing is still not ours', ours(body, false, false), false);

	/*
	 * 7. A different subtree entirely — a note's own `<li>`, its editor, its tab header. Asserted
	 * with **both guards true**, which is the strongest form: the subtree test alone has to refuse
	 * it, or the widened branch 1 would have widened the panel's claim to the whole app.
	 */
	eq('7. an li in a note is not ours', ours(noteLi, true, true), false);
	eq('...nor the note\'s editor', ours(noteEditor, true, true), false);
	eq('...nor another note\'s tab header', ours(noteTab, true, true), false);
	eq('...nor the leaf that holds them', ours(noteLeaf, true, true), false);
	// The workspace is an ancestor of the panel *and* of the note leaf, so it is the one node above
	// the panel that is genuinely ambiguous — and it is exactly what the guards are for.
	eq('the workspace above both is ours only with the last click here', ours(workspace, true, true), true);
	eq('...and not without it', ours(workspace, false, true), false);
}

// --- P. cost/duration badge: delta accounting and the process-restart guard --

console.log("P1. Three turns in one process: each result carries this turn's own delta, and the running total is the reducer's own sum");
{
	const s = new ChatState();
	const r = new StreamReducer(s);

	const turn1 = s.addAssistantMessage();
	r.beginTurn(turn1);
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.25, duration_ms: 1000 } as StreamJsonEvent);
	eq('turn 1: no baseline yet, so the cost is the reported cumulative verbatim', turn1.meta?.costUsd, 0.25);
	eq('turn 1: the running total equals the turn cost (first turn of the process)', turn1.meta?.sessionCostUsd, 0.25);

	const turn2 = s.addAssistantMessage();
	r.beginTurn(turn2);
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.75, duration_ms: 1500 } as StreamJsonEvent);
	eq("turn 2: cost is the delta off the CLI's cumulative (0.75 − 0.25)", turn2.meta?.costUsd, 0.5);
	eq('turn 2: the running total is the sum of the two turn costs, not the echoed cumulative', turn2.meta?.sessionCostUsd, 0.75);

	const turn3 = s.addAssistantMessage();
	r.beginTurn(turn3);
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 1.5, duration_ms: 800 } as StreamJsonEvent);
	eq('turn 3: the next delta (1.5 − 0.75)', turn3.meta?.costUsd, 0.75);
	eq('turn 3: running total keeps climbing', turn3.meta?.sessionCostUsd, 1.5);
}

console.log('P2. The restart guard: a cumulative that drops reads as a fresh process, never as a negative delta');
{
	// `SessionManager.handleExit` (session-manager.ts:360) only fails the active turn — it does not
	// replace `this.reducer` — so a subprocess restart mid-session is proven on the *same* reducer
	// instance, exactly as it happens in the real panel.
	const s = new ChatState();
	const r = new StreamReducer(s);

	const before = s.addAssistantMessage();
	r.beginTurn(before);
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.6, duration_ms: 500 } as StreamJsonEvent);
	eq('pre-restart: baseline is fresh, cost is reported verbatim', before.meta?.costUsd, 0.6);
	eq('pre-restart: running total', before.meta?.sessionCostUsd, 0.6);

	// The process died and a fresh one started: `total_cost_usd` accumulates per CLI process, not
	// per session id (measured, PHASE6-TASK5-STATE §M1), so the next result arrives with a
	// cumulative that reset to near-zero.
	const after = s.addAssistantMessage();
	r.beginTurn(after);
	r.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.05, duration_ms: 700 } as StreamJsonEvent);
	eq('post-restart: a lower cumulative is read as the fresh process\'s own total, not a delta', after.meta?.costUsd, 0.05);
	check('the turn cost is never negative across a restart', (after.meta?.costUsd ?? -1) >= 0);
	eq(
		"post-restart: the running total keeps climbing across the restart rather than dropping with the CLI's own number",
		after.meta?.sessionCostUsd,
		0.65,
	);
}

console.log('P3. Trap 3: an errored turn was still billed for, and the meta line must say so');
{
	const s = new ChatState();
	const r = new StreamReducer(s);
	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	r.apply({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		total_cost_usd: 0.02,
		duration_ms: 4200,
	} as StreamJsonEvent);
	eq('the turn reads as an error', turn.status, 'error');
	eq('...but its cost is not dropped', turn.meta?.costUsd, 0.02);
	eq('...nor its duration', turn.meta?.durationMs, 4200);
}

// --- Q. quota snapshot: rate_limit_event parsing (both windows) and the reducer's callback ---
//
// Task 5's `parseRateLimitWarning` gated on `rate_limit_info.status === 'allowed_warning'` and
// kept only the single window `rateLimitType` named. Task 7 replaces it with `parseQuotaSnapshot`
// — no status gate, both windows together — per the measurement in `cli/events.ts`'s own comment:
// the status fires on an ordinary turn with no prior warning state too, so it reads as "here is
// your current quota", not a threshold crossing a live gauge would need to gate on.

console.log('Q1. parseQuotaSnapshot: both windows together, and what a malformed payload refuses');
{
	// Verbatim from docs/capture-phase4-tools.jsonl line 36.
	const measuredInfo = {
		status: 'allowed_warning',
		resetsAt: 1787927400,
		rateLimitType: 'five_hour',
		utilization: 0.91,
		isUsingOverage: false,
		surpassedThreshold: 0.9,
		unifiedWindows: {
			five_hour: { utilization: 0.91, resetsAt: 1787927400 },
			seven_day: { utilization: 0.88, resetsAt: 1788051600 },
		},
	};
	const measured: RateLimitEvent = { type: 'rate_limit_event', rate_limit_info: measuredInfo };
	const snapshot = parseQuotaSnapshot(measured);
	check('the measured shape parses', snapshot !== null);
	eq('fiveHourUtilization', snapshot?.fiveHourUtilization, 0.91);
	eq('fiveHourResetsAt', snapshot?.fiveHourResetsAt, 1787927400);
	eq('sevenDayUtilization', snapshot?.sevenDayUtilization, 0.88);
	eq('sevenDayResetsAt', snapshot?.sevenDayResetsAt, 1788051600);

	// No status gate (the deliberate difference from task 5): a status this project has never
	// measured still parses, as long as `unifiedWindows` itself is there.
	eqCall(
		"a status never measured on the wire still parses — there is no gate on it",
		() => parseQuotaSnapshot({ type: 'rate_limit_event', rate_limit_info: { ...measuredInfo, status: 'rejected' } })?.fiveHourUtilization,
		0.91,
	);
	eqCall('missing rate_limit_info refuses', () => parseQuotaSnapshot({ type: 'rate_limit_event' }), null);
	eqCall(
		'a non-object rate_limit_info refuses',
		() => parseQuotaSnapshot({ type: 'rate_limit_event', rate_limit_info: 'nope' }),
		null,
	);
	eqCall(
		'missing unifiedWindows refuses',
		() => parseQuotaSnapshot({ type: 'rate_limit_event', rate_limit_info: { ...measuredInfo, unifiedWindows: undefined } }),
		null,
	);
	eqCall(
		'a window field with the wrong type is dropped from that window rather than coercing',
		() =>
			parseQuotaSnapshot({
				type: 'rate_limit_event',
				rate_limit_info: {
					...measuredInfo,
					unifiedWindows: { ...measuredInfo.unifiedWindows, five_hour: { utilization: '0.91', resetsAt: 1787927400 } },
				},
			})?.fiveHourUtilization,
		undefined,
	);
}

console.log('Q2. StreamReducer.onQuota over docs/capture-phase4-tools.jsonl: three snapshots inside one turn, both windows every time');
{
	const captureQ2 = readFileSync(join(process.cwd(), 'docs', 'capture-phase4-tools.jsonl'), 'utf8');
	const s = new ChatState();
	const r = new StreamReducer(s);
	const seen: Array<{ fiveHour?: number; sevenDay?: number }> = [];
	r.onQuota = (snapshot) => {
		seen.push({ fiveHour: snapshot.fiveHourUtilization, sevenDay: snapshot.sevenDayUtilization });
	};

	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	for (const line of captureQ2.split('\n')) {
		const event = parseStreamJsonLine(line);
		if (event) {
			r.apply(event);
		}
	}

	// One callback per event, not deduplicated and not collapsed to the last: the callback is the
	// reducer's whole contract, and it is the view's job to turn a same-value repeat into "update
	// in place" rather than a fresh line each time.
	eq('the callback fired once per real event in the capture', seen.length, 3);
	eq('the five_hour window climbs across the three, in order', seen.map((w) => w.fiveHour).join(','), '0.91,0.92,0.93');
	check('the seven_day window is present on every one of them, unchanged', seen.every((w) => w.sevenDay === 0.88));
}

console.log('Q3. A capture where seven_day is the triggering window: docs/capture-phase3-thinking-redacted.jsonl');
{
	const captureQ3 = readFileSync(join(process.cwd(), 'docs', 'capture-phase3-thinking-redacted.jsonl'), 'utf8');
	const s = new ChatState();
	const r = new StreamReducer(s);
	const seen: Array<{ fiveHour?: number; sevenDay?: number }> = [];
	r.onQuota = (snapshot) => {
		seen.push({ fiveHour: snapshot.fiveHourUtilization, sevenDay: snapshot.sevenDayUtilization });
	};

	const turn = s.addAssistantMessage();
	r.beginTurn(turn);
	for (const line of captureQ3.split('\n')) {
		const event = parseStreamJsonLine(line);
		if (event) {
			r.apply(event);
		}
	}

	eq('both events in this capture reach the callback', seen.length, 2);
	// Task 5's Q3 only ever saw `seven_day` in this capture because it kept just the triggering
	// window; task 7 carries `five_hour` too, present the whole time at a different value.
	eq('...and both windows are present on both, five_hour unchanged', seen.map((w) => w.fiveHour).join(','), '0.46,0.47');
	check('...seven_day unchanged too — the "no change" case a live gauge still has to render the same', seen.every((w) => w.sevenDay === 0.83));
}

// --- T. Phase 6 task 7: the composer status line's pure arithmetic ---
//
// `contextUsageFromResult`, `formatModelName` and `renderQuotaBar` are the three pieces of new
// pure logic this task adds — all in `cli/events.ts` (the first two) or `ui/composer.ts` (the
// third), none of them touching a DOM, so all three are driven directly here rather than only
// through a manual round.

console.log('T1. contextUsageFromResult: the real capture from this task\'s brief, and what a malformed result refuses');
{
	// Verbatim from this task's brief: a real `result` event, one model, contextWindow 1,000,000.
	const measured: ResultEvent = {
		type: 'result',
		subtype: 'success',
		usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 34519, output_tokens: 35 },
		modelUsage: {
			'claude-sonnet-5[1m]': {
				inputTokens: 2,
				cacheReadInputTokens: 34519,
				cacheCreationInputTokens: 0,
				contextWindow: 1000000,
				maxOutputTokens: 64000,
				canonicalModel: 'claude-sonnet-5',
			},
		},
		total_cost_usd: 0.0072578,
	};
	const usage = contextUsageFromResult(measured);
	check('the measured shape parses', usage !== null);
	// (2 + 0 + 34519) / 1000000 = 3.4521% → rounds to 3.
	eq('percent', usage?.percent, 3);
	eq('model prefers canonicalModel over the modelUsage key', usage?.model, 'claude-sonnet-5');

	eqCall('missing usage refuses', () => contextUsageFromResult({ ...measured, usage: undefined }), null);
	eqCall('missing modelUsage refuses', () => contextUsageFromResult({ ...measured, modelUsage: undefined }), null);
	eqCall(
		'a zero contextWindow refuses rather than dividing by zero',
		() =>
			contextUsageFromResult({
				...measured,
				modelUsage: { 'claude-sonnet-5[1m]': { ...measured.modelUsage!['claude-sonnet-5[1m]'], contextWindow: 0 } },
			}),
		null,
	);
	eqCall(
		'no canonicalModel falls back to the modelUsage key',
		() =>
			contextUsageFromResult({
				...measured,
				modelUsage: { 'claude-sonnet-5[1m]': { ...measured.modelUsage!['claude-sonnet-5[1m]'], canonicalModel: undefined } },
			})?.model,
		'claude-sonnet-5[1m]',
	);
}

console.log('T2. contextUsageFromResult over the real captures already in the repo — three different models, three different windows');
{
	// docs/capture-phase4-tools.jsonl: 16 + 26397 + 123137 = 149550 / 1000000 → rounds to 15%.
	eq(
		'capture-phase4-tools.jsonl (claude-opus-5, 1m window)',
		contextUsageFromResult({
			type: 'result',
			subtype: 'success',
			usage: { input_tokens: 16, cache_creation_input_tokens: 26397, cache_read_input_tokens: 123137 },
			modelUsage: { 'claude-opus-5': { contextWindow: 1000000, canonicalModel: 'claude-opus-5' } },
		})?.percent,
		15,
	);
	// docs/capture-phase5a-stop.jsonl: 10 + 12135 + 14994 = 27139 / 200000 → rounds to 14%.
	eq(
		'capture-phase5a-stop.jsonl (claude-haiku-4-5, 200k window)',
		contextUsageFromResult({
			type: 'result',
			subtype: 'error_during_execution',
			usage: { input_tokens: 10, cache_creation_input_tokens: 12135, cache_read_input_tokens: 14994 },
			modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200000, canonicalModel: 'claude-haiku-4-5' } },
		})?.percent,
		14,
	);
}

console.log('T3. formatModelName: strips the claude- prefix and any [window] suffix, title-cases the rest');
{
	eq('a bracketed context-window suffix', formatModelName('claude-sonnet-5[1m]'), 'Sonnet 5');
	eq('no suffix at all', formatModelName('claude-sonnet-5'), 'Sonnet 5');
	eq('a multi-word canonical name', formatModelName('claude-haiku-4-5'), 'Haiku 4 5');
	eq('a model id this project has never named still formats sensibly', formatModelName('claude-opus-9000[200k]'), 'Opus 9000');
}

console.log('T4. renderQuotaBar: 10 cells, clamped to the 0–100 range');
{
	eq('0%', renderQuotaBar(0), '░░░░░░░░░░');
	eq('100%', renderQuotaBar(100), '▓▓▓▓▓▓▓▓▓▓');
	eq('51% rounds to 5 filled cells', renderQuotaBar(51), '▓▓▓▓▓░░░░░');
	eq('81% rounds to 8 filled cells', renderQuotaBar(81), '▓▓▓▓▓▓▓▓░░');
	eq('a value below 0 clamps rather than producing a negative repeat count', renderQuotaBar(-5), '░░░░░░░░░░');
	eq('a value above 100 clamps to fully filled', renderQuotaBar(140), '▓▓▓▓▓▓▓▓▓▓');
}

console.log('R2. formatTurnMeta: the total is suppressed when it equals the turn cost, shown when it differs');
{
	const s = new ChatState();

	const sameValue = s.addAssistantMessage();
	sameValue.meta = { durationMs: 1200, costUsd: 0.25, sessionCostUsd: 0.25 };
	eq('equal cost and total: printed once, no "total" suffix', formatTurnMeta(sameValue), '1.2 s · $0.2500');

	// The orchestrator's own measured pair (audit round), pinned verbatim.
	const differs = s.addAssistantMessage();
	differs.meta = { durationMs: 1200, costUsd: 0.0028, sessionCostUsd: 0.022 };
	eq(
		'a total that differs is printed, labelled',
		formatTurnMeta(differs),
		'1.2 s · $0.0028 · $0.0220 total',
	);
}

console.log('R3. formatTurnMeta: two distinct floats that round to the same 4-decimal string are treated as equal, not just two equal floats');
{
	// Verified in Node before use: 0.100001 !== 0.100004 as raw numbers, but both .toFixed(4) to
	// "0.1000" — the exact case `formatTurnMeta`'s own comment claims ("compared as the same
	// 4-decimal string ... not as raw floats"). Held in `number`-typed locals rather than compared
	// as literals — two distinct numeric literals compared with `!==` is a `tsc` error under this
	// project's strict config ("this comparison appears to be unintentional"), correctly: the
	// point being proven is a runtime fact about floats, not a literal-type tautology.
	const turnCost: number = 0.100001;
	const sessionTotal: number = 0.100004;
	check('the two floats really are distinct', turnCost !== sessionTotal);
	check('...and really do round to the same displayed string', turnCost.toFixed(4) === sessionTotal.toFixed(4));

	const s = new ChatState();
	const item = s.addAssistantMessage();
	item.meta = { costUsd: turnCost, sessionCostUsd: sessionTotal };
	eq(
		'display-equal floats suppress the total exactly like true-equal ones do',
		formatTurnMeta(item),
		'$0.1000',
	);
}

console.log('R4. formatTurnMeta: either half absent on its own, and both absent');
{
	const s = new ChatState();

	const durationOnly = s.addAssistantMessage();
	durationOnly.meta = { durationMs: 4200 };
	eq('duration with no cost at all: just the duration', formatTurnMeta(durationOnly), '4.2 s');

	const costOnly = s.addAssistantMessage();
	costOnly.meta = { costUsd: 0.02 };
	eq('cost with no duration and no session total: just the cost', formatTurnMeta(costOnly), '$0.0200');

	const neither = s.addAssistantMessage();
	neither.meta = {};
	eq('both absent: an empty string, not a stray separator', formatTurnMeta(neither), '');

	const noMetaAtAll = s.addAssistantMessage();
	eq('no meta object at all (never reached a result event): still an empty string', formatTurnMeta(noMetaAtAll), '');
}

console.log('R5. withTurnMeta: the stopped and error prefixes, and the no-meta case falls back to the bare prefix');
{
	const s = new ChatState();

	const stopped = s.addAssistantMessage();
	stopped.status = 'stopped';
	stopped.meta = { durationMs: 1200, costUsd: 0.0028, sessionCostUsd: 0.022 };
	eq(
		'stopped: the badge is appended after a space, same shape as formatTurnMeta alone',
		withTurnMeta('Stopped.', stopped),
		'Stopped. 1.2 s · $0.0028 · $0.0220 total',
	);

	// Trap 3: an errored turn was still billed, so the same function runs on its error text too
	// (message-list.ts's `case 'error':`).
	const errored = s.addAssistantMessage();
	errored.status = 'error';
	errored.errorText = 'The turn ended with error_during_execution.';
	errored.meta = { durationMs: 4200, costUsd: 0.02 };
	eq(
		'error: the billed badge is appended to the error text, not dropped',
		withTurnMeta(errored.errorText, errored),
		'The turn ended with error_during_execution. 4.2 s · $0.0200',
	);

	const nothingToShow = s.addAssistantMessage();
	nothingToShow.status = 'error';
	nothingToShow.meta = {};
	eq(
		'no meta at all (failActiveTurn — no result event ever arrived): the bare prefix, no trailing space',
		withTurnMeta('Something went wrong.', nothingToShow),
		'Something went wrong.',
	);
}

rmSync(POLICY_VAULT.base, { recursive: true, force: true });

// --- S. Phase 6 task 6: data/transcript-store.ts's listSessions ------------

/*
 * `docs/RESEARCH.md` §D generalised "a scan from start/end is enough" from one 202-line sample
 * file. Measured against the real directory this plugin reads (PHASE6-TASK6-STATE §M), that
 * generalisation is wrong: `readdir` returns `tool-results` offload directories alongside real
 * `.jsonl` files, 40% of real sessions have no `ai-title` and 52% have no `cost-state`, and neither
 * record sits at a fixed offset. `session-index.ts`'s `scanSessionsDir` does a full per-line scan
 * instead, tolerant of a torn trailing line. §S4 drives that logic against a synthetic fixture,
 * deterministically; §S5 runs the full `NodeTranscriptStore` against Emre's real
 * `~/.claude/projects` directory and can only assert properties, not exact values — the directory
 * keeps growing, including from this very session (trap 4).
 */

console.log("S1. projectSlug: every '/' in the vault path becomes '-'");
eq(
	'a real vault path, the real directory name it maps to (verified 2026-09-03)',
	projectSlug('/Users/you/Documents/YourVault'),
	'-Users-you-Documents-YourVault',
);

console.log('S2. resumeArgs: trivial, but the interface shape is worth pinning');
eq(
	'--resume + the id, nothing else',
	new NodeTranscriptStore().resumeArgs('abc-123').join('|'),
	'--resume|abc-123',
);

console.log('S3. readSession: a clear not-implemented throw, not a silent []');
{
	let threw = false;
	try {
		await new NodeTranscriptStore().readSession('abc-123');
	} catch (error) {
		threw = true;
		check('the message names it as v2, not a bare generic error', String(error).includes('v2'));
	}
	check('readSession rejects rather than resolving with []', threw);
}

const SESSION_FIXTURE = (() => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-sessions-')));

	// A session with both `ai-title` and `cost-state`, neither at a fixed offset — `ai-title`
	// appears twice (matching the real file's repeated-emission shape), separated by other record
	// types, and `cost-state` sits after it rather than at the start or the end.
	writeFileSync(
		join(dir, 'session-full.jsonl'),
		[
			JSON.stringify({ type: 'system', subtype: 'init' }),
			JSON.stringify({ type: 'user', timestamp: '2026-01-01T10:00:00.000Z', sessionId: 'session-full' }),
			JSON.stringify({ type: 'assistant', message: { content: [] } }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Full Session', sessionId: 'session-full' }),
			JSON.stringify({ type: 'cost-state', sessionId: 'session-full', totalCostUSD: 0.4567, totalDuration: 1000 }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Full Session', sessionId: 'session-full' }),
			'',
		].join('\n'),
	);

	// Trap 1: a directory sharing `session-full`'s name, holding offloaded tool output — the same
	// shape the real directory has for 76 of its 155 entries. Must never be read as a session.
	mkdirSync(join(dir, 'session-full', 'tool-results'), { recursive: true });
	writeFileSync(join(dir, 'session-full', 'tool-results', 'out.json'), '{}');

	// Neither optional record — the ~40%/~52% real-world case, not a defensive-programming exercise.
	writeFileSync(
		join(dir, 'session-no-optional.jsonl'),
		[
			JSON.stringify({ type: 'queue-operation', op: 'enqueue' }),
			JSON.stringify({ type: 'user', timestamp: '2026-01-03T10:00:00.000Z', sessionId: 'session-no-optional' }),
			JSON.stringify({ type: 'queue-operation', op: 'dequeue' }),
			'',
		].join('\n'),
	);

	// A torn trailing line, as a session still being appended to would produce. The `ai-title`
	// before it must still be found.
	writeFileSync(
		join(dir, 'session-torn.jsonl'),
		[
			JSON.stringify({ type: 'user', timestamp: '2026-01-02T10:00:00.000Z', sessionId: 'session-torn' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Torn Session', sessionId: 'session-torn' }),
			'{"type":"assistant","message":{"content":[{"type":"text","text":"incomple',
		].join('\n'),
	);

	// No `user` record at all — excluded from the result rather than given a fabricated start time.
	writeFileSync(
		join(dir, 'session-nouser.jsonl'),
		[
			JSON.stringify({ type: 'system', subtype: 'init' }),
			JSON.stringify({ type: 'assistant', message: {} }),
			'',
		].join('\n'),
	);

	// A stray non-`.jsonl` *file* (not a directory) that would parse into a perfectly valid session
	// if the extension filter were gone. The `tool-results` directory above proves the filter keeps
	// something out; on its own that proof is weak — a directory fails `readFile` regardless of the
	// filter, so removing the filter and relying on that read to throw would still read green. This
	// file reads cleanly, so only the filter itself keeps it out.
	writeFileSync(
		join(dir, 'stray-file'),
		[
			JSON.stringify({ type: 'user', timestamp: '2026-01-04T10:00:00.000Z' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Should never appear' }),
			'',
		].join('\n'),
	);

	return { dir };
})();

console.log('S4. scanSessionsDir: the synthetic fixture');
{
	const sessions = await scanSessionsDir(SESSION_FIXTURE.dir);

	eq('trap 1 + the no-user case: exactly the three real sessions, not four or five', sessions.length, 3);
	eq(
		'exactly one session-full entry despite the same-named tool-results directory',
		sessions.filter((s) => s.sessionId === 'session-full').length,
		1,
	);
	check(
		'newest-first: no-optional (Jan 3) before torn (Jan 2) before full (Jan 1)',
		sessions.map((s) => s.sessionId).join('|') === 'session-no-optional|session-torn|session-full',
		sessions.map((s) => s.sessionId).join('|'),
	);

	const full = sessions.find((s) => s.sessionId === 'session-full');
	eq('session-full: sessionId taken from the filename', full?.sessionId, 'session-full');
	eq("session-full: title found despite not being on the first or last line, and repeated", full?.title, 'Full Session');
	eq('session-full: startedAt from the (only) user record', full?.startedAt, '2026-01-01T10:00:00.000Z');
	eq('session-full: cost read from totalCostUSD verbatim, not recomputed', full?.costUsd, 0.4567);

	const noOptional = sessions.find((s) => s.sessionId === 'session-no-optional');
	check('session-no-optional: title is optional, not defaulted to an empty string', noOptional?.title === undefined);
	check('session-no-optional: cost is optional, not defaulted to 0', noOptional?.costUsd === undefined);
	eq('session-no-optional: still dated correctly', noOptional?.startedAt, '2026-01-03T10:00:00.000Z');

	const torn = sessions.find((s) => s.sessionId === 'session-torn');
	eq('session-torn: the ai-title before the torn line still parsed', torn?.title, 'Torn Session');
	eq('session-torn: startedAt unaffected by the trailing garbage', torn?.startedAt, '2026-01-02T10:00:00.000Z');

	check(
		'session-nouser never appears: no user record means no fabricated startedAt, not a throw',
		!sessions.some((s) => s.sessionId === 'session-nouser'),
	);
	check(
		'stray-file never appears: the extension filter, not a lucky read failure, keeps it out',
		!sessions.some((s) => s.title === 'Should never appear'),
	);
}

rmSync(SESSION_FIXTURE.dir, { recursive: true, force: true });

console.log('S5. listSessions against the real ~/.claude/projects directory (environment-dependent — see report)');
{
	// Deliberately not a hardcoded personal path (Emre's own vault, as this used to be): that would
	// assert against a directory that only exists on one machine, guaranteed to fail everywhere
	// else. `process.cwd()` is this repo's own checkout — whoever runs offline-checks has, by
	// definition, been running `claude` from here, so real transcripts exist under its own
	// `~/.claude/projects/<slug>` the same way they did on the machine this test was written on.
	const realVaultPath = process.cwd();
	const projectsDir = join(homedir(), '.claude', 'projects', projectSlug(realVaultPath));
	if (!existsSync(projectsDir)) {
		console.log('  skip  no ~/.claude/projects directory for this checkout yet — nothing to assert');
	} else {
		const store = new NodeTranscriptStore();
		const sessions = await store.listSessions(realVaultPath);
		const rawEntries = readdirSync(projectsDir);
		// Most tool-results directories share their owning session's UUID (75 of 77, measured
		// 2026-09-03) — that pairing is expected, not trap 1. What trap 1 actually forbids is a
		// directory-only entry, with no `.jsonl` counterpart at all, ever surfacing as a session; the
		// "matching .jsonl file" check just below already proves that, since no directory-only name
		// could pass it.
		const jsonlBaseNames = new Set(rawEntries.filter((e) => e.endsWith('.jsonl')).map((e) => e.slice(0, -'.jsonl'.length)));
		const orphanDirNames = rawEntries.filter((e) => !e.endsWith('.jsonl') && !jsonlBaseNames.has(e));

		check('at least some sessions returned', sessions.length > 0, `got ${String(sessions.length)}`);
		check(
			'every returned sessionId has a matching .jsonl file in the real directory',
			sessions.every((s) => rawEntries.includes(`${s.sessionId}.jsonl`)),
		);
		check(
			'no orphan directory (no matching .jsonl at all — trap 1) is ever returned as a session',
			sessions.every((s) => !orphanDirNames.includes(s.sessionId)),
		);
		check(
			'every present title is a non-empty string pulled from a real ai-title record',
			sessions.every((s) => s.title === undefined || (typeof s.title === 'string' && s.title.length > 0)),
		);
		check(
			'every present cost is a non-negative number',
			sessions.every((s) => s.costUsd === undefined || (typeof s.costUsd === 'number' && s.costUsd >= 0)),
		);
		check(
			'sorted newest-first',
			sessions.every((s, i) => i === 0 || (sessions[i - 1]?.startedAt ?? '') >= s.startedAt),
		);
	}
}

// --- T. Phase 6 task 8: the per-message copy button's text assembly --------

/*
 * `assistantCopyText` is the one piece of the copy button that is pure and worth driving against
 * fixtures rather than eyeballing in Obsidian (task 8 brief) — which blocks are concatenated, in
 * what order, and with what joiner. The clipboard write and the "copied" icon swap are real-DOM
 * behaviour and are covered by the manual round instead (task 8 report).
 */

function assistantFixture(blocks: MessageBlock[]): AssistantItem {
	const item: AssistantItem = { kind: 'assistant', id: 'fixture', blocks: new Map(), status: 'complete' };
	// Inserted out of slot order on purpose: `assistantCopyText` goes through `orderedBlocks`,
	// which sorts by `index`, so a test that inserted in order would not catch a regression to
	// plain `Map` iteration order.
	for (const block of [...blocks].reverse()) {
		item.blocks.set(block.index, block);
	}
	return item;
}

console.log('T1. a single text block: copied verbatim, no joiner to get wrong');
eq(
	'exact markdown, not innerText',
	assistantCopyText(assistantFixture([{ index: 0, kind: 'text', text: '**bold** and a [link](x)', final: true }])),
	'**bold** and a [link](x)',
);

console.log('T2. text blocks either side of a tool call and a thinking block: only the text blocks, in slot order');
{
	const item = assistantFixture([
		{ index: 0, kind: 'text', text: 'Before the call.', final: true },
		{ index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read' },
		{ index: 2, kind: 'thinking', text: 'reasoning the reader never sees copied', final: true },
		{ index: 3, kind: 'text', text: 'After the call.', final: true },
	]);
	eq(
		'joined as separate paragraphs, tool_use/thinking text excluded entirely',
		assistantCopyText(item),
		'Before the call.\n\nAfter the call.',
	);
}

console.log('T3. a turn with no text block at all (opens with a tool call, nothing else yet): empty string, not a throw');
eq(
	'empty, not "undefined" or a stray joiner',
	assistantCopyText(assistantFixture([{ index: 0, kind: 'tool_use', text: '', final: false, toolName: 'Read' }])),
	'',
);

console.log('T4. a still-streaming text block: block.text copied as-is — there is no markdown to strip either way');
eq(
	'the in-flight plain-text delta, unchanged',
	assistantCopyText(assistantFixture([{ index: 0, kind: 'text', text: 'partial sente', final: false }])),
	'partial sente',
);

/*
 * Task 8 follow-up, fix 1: the copy button was reachable while a turn was still `pending`/
 * `streaming` (Emre caught it live). `assistantCopyVisible` is the pure decision the DOM-touching
 * `hide()`/`show()` call in `MessageList.updateAssistant` is keyed off, so it is driven against
 * fixtures the same way `assistantCopyText` is above, rather than only eyeballed in Obsidian.
 */

console.log('T5. assistantCopyVisible: hidden while the turn is still mutating, shown once it is not');
{
	const pending = assistantFixture([]);
	pending.status = 'pending';
	eq('pending: hidden — nothing has arrived yet', assistantCopyVisible(pending), false);
}
{
	const streaming = assistantFixture([{ index: 0, kind: 'text', text: 'partial', final: false }]);
	streaming.status = 'streaming';
	eq('streaming: hidden — the reply is still being written', assistantCopyVisible(streaming), false);
}
{
	const complete = assistantFixture([{ index: 0, kind: 'text', text: 'done', final: true }]);
	complete.status = 'complete';
	eq('complete: shown', assistantCopyVisible(complete), true);
}
{
	const stopped = assistantFixture([{ index: 0, kind: 'text', text: 'cut off', final: true }]);
	stopped.status = 'stopped';
	eq('stopped: shown — the turn is frozen, whatever text exists is final', assistantCopyVisible(stopped), true);
}
{
	const errored = assistantFixture([{ index: 0, kind: 'text', text: 'got this far', final: true }]);
	errored.status = 'error';
	eq('error: shown — same reasoning as stopped, the turn is frozen either way', assistantCopyVisible(errored), true);
}


// --- P. Phase 7: AskUserQuestion inline prompt parsing --------------------

console.log('P. AskUserQuestion parsing and merging');
{
	// 1. Well-formed — real measured Claude CLI payload shape (label + description, no value field)
	const wellFormed = parseAskUserQuestionInput({
		questions: [{
			question: 'Bu dokümanla ne yapmak istiyorsun?',
			header: 'Doküman',
			options: [
				{ label: 'Oku', description: 'Dokümanı oku ve içeriğini göster' },
				{ label: 'Düzenle', description: 'Dokümanda değişiklik yap' },
				{ label: 'Sil', description: 'Dokümanı sil' }
			],
			multiSelect: false
		}]
	});
	check('parses well-formed AskUserQuestion input', wellFormed !== null);
	eq('extracts the question correctly', wellFormed?.[0]?.question, 'Bu dokümanla ne yapmak istiyorsun?');
	eq('extracts header correctly', wellFormed?.[0]?.header, 'Doküman');
	eq('extracts options correctly', wellFormed?.[0]?.options?.length, 3);
	eq('extracts option label correctly', wellFormed?.[0]?.options?.[0]?.label, 'Oku');
	eq('extracts option value defaulting to label', wellFormed?.[0]?.options?.[0]?.value, 'Oku');
	eq('extracts description correctly', wellFormed?.[0]?.options?.[0]?.description, 'Dokümanı oku ve içeriğini göster');

	// 2. Malformed / Missing fields
	eq('rejects undefined input', parseAskUserQuestionInput(undefined), null);
	eq('rejects non-object input', parseAskUserQuestionInput('not an object'), null);
	eq('rejects missing questions array', parseAskUserQuestionInput({}), null);
	eq('rejects questions array with non-object items', parseAskUserQuestionInput({ questions: ['bad'] }), null);
	eq('rejects question missing "question" text', parseAskUserQuestionInput({ questions: [{ id: 'q1' }] }), null);

	// 3. Multi-select and "Other"
	const multiOther = parseAskUserQuestionInput({
		questions: [{
			question: 'Hobbies?',
			multiSelect: true,
			isOther: true
		}]
	});
	eq('extracts multiSelect flag', multiOther?.[0]?.multiSelect, true);
	eq('extracts isOther flag', multiOther?.[0]?.isOther, true);

	// 4. SessionManager merging
	let sentPayload: any;
	const dummyBroker = {
		decide: (id: string, behavior: string, reason: string | undefined, payload: any) => {
			sentPayload = payload;
		}
	};
	const dummyManager = new SessionManager({ vault: { adapter: sharedVaultAdapter } } as never);
	(dummyManager as any).broker = dummyBroker;
	dummyManager.decidePermission('req-123', 'allow', {
		updatedInput: { questions: [], answers: { color: 'blue' } }
	});
	
	check('SessionManager passes payload through to broker', sentPayload !== undefined);
	eq('Broker receives updatedInput', sentPayload?.updatedInput?.answers?.color, 'blue');
}

console.log('P2. Permission bypass on cancel');
{
	const askItem = { requestId: 'req-1', input: { questions: [] } };
	const decision = decideAskUserQuestion(askItem.input, null);
	check('cancellation (answers = null) sends deny, not allow', decision.behavior === 'deny');
}

class FakeElement {
	children: any[] = [];
	classList = new Set<string>();
	listeners: Record<string, any> = {};
	private _text: string = '';
	get text(): string {
		const parts: string[] = [];
		if (this._text) parts.push(this._text);
		for (const c of this.children) {
			const t = c.text;
			if (t) parts.push(t);
		}
		return parts.join(' ');
	}
	set text(t: string) {
		this._text = t;
	}
	value: string = '';
	selectionStart: number = 0;
	selectionEnd: number = 0;
	disabled: boolean = false;
	tag: string = 'div';
	tagName: string = 'DIV';
	scrollTop: number = 0;
	scrollHeight: number = 0;
	clientHeight: number = 0;
	childElementCount: number = 0;

	parentElement: FakeElement | null = null;
	parent: FakeElement | null = null;
	ownerDocument: any = this;

	setSelectionRange(start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
	}

	isShown(): boolean {
		return !this.hasClass('guki-hidden');
	}

	contains(other: any): boolean {
		if (!other) return false;
		if (other === this) return true;
		for (const child of this.children) {
			if (child === other || (child.contains && child.contains(other))) {
				return true;
			}
		}
		return false;
	}

	attributes: Record<string, string> = {};
	setAttribute(name: string, value: string) {
		this.attributes[name] = String(value);
	}
	setAttr(name: string, value: string) {
		this.setAttribute(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}
	getAttr(name: string): string | null {
		return this.getAttribute(name);
	}
	get nextSibling(): any {
		const p = this.parentElement ?? this.parent;
		if (!p || !p.children) return null;
		const idx = p.children.indexOf(this);
		if (idx === -1 || idx + 1 >= p.children.length) return null;
		return p.children[idx + 1];
	}

	createDiv(opts?: any) { return this.createEl('div', opts); }
	createSpan(opts?: any) { return this.createEl('span', opts); }
	createEl(tag: string, opts?: any) {
		const el = new FakeElement();
		el.tag = tag;
		el.tagName = tag.toUpperCase();
		el.parentElement = this;
		el.parent = this;
		if (opts?.cls) opts.cls.split(' ').forEach((c: string) => el.addClass(c));
		if (opts?.text) el.text = opts.text;
		if (opts?.attr) {
			for (const [k, v] of Object.entries(opts.attr)) {
				el.setAttribute(k, String(v));
			}
		}
		this.children.push(el);
		this.childElementCount = this.children.length;
		return el;
	}
	addClass(c: string) { this.classList.add(c); }
	removeClass(c: string) { this.classList.delete(c); }
	toggleClass(c: string, val: boolean) { if (val) this.addClass(c); else this.removeClass(c); }
	hasClass(c: string): boolean { return this.classList.has(c); }
	style: Record<string, any> = {};
	setCssStyles(styles?: any) {
		if (styles) Object.assign(this.style, styles);
	}
	empty() {
		this.children = [];
		this.childElementCount = 0;
	}
	setText(t: string) { this.text = t; }
	private _eventListenersList: Record<string, any[]> = {};
	addEventListener(evt: string, cb: any) {
		if (!this._eventListenersList[evt]) {
			this._eventListenersList[evt] = [];
		}
		this._eventListenersList[evt].push(cb);
		const self = this;
		this.listeners[evt] = function(e: any) {
			for (const fn of self._eventListenersList[evt]) {
				fn(e);
			}
		};
	}
	removeEventListener(evt: string, cb: any) {
		if (this._eventListenersList[evt]) {
			this._eventListenersList[evt] = this._eventListenersList[evt].filter((fn: any) => fn !== cb);
		}
	}
	hide() { this.addClass('guki-hidden'); }
	show() { this.removeClass('guki-hidden'); }
	remove() {
		const prevParent = this.parentElement ?? this.parent;
		if (prevParent && prevParent.children) {
			const idx = prevParent.children.indexOf(this);
			if (idx !== -1) {
				prevParent.children.splice(idx, 1);
				prevParent.childElementCount = prevParent.children.length;
			}
			this.parentElement = null;
			this.parent = null;
		}
	}
	appendChild(newChild: any) {
		return this.insertBefore(newChild, null);
	}
	focus() {
		if (this.listeners['focus']) this.listeners['focus']();
	}
	blur() {
		if (this.listeners['blur']) this.listeners['blur']();
	}
	scrollIntoView() {}
	click() {
		if (this.listeners['click']) {
			this.listeners['click']({ preventDefault: () => {}, target: this });
		}
	}
	insertBefore(newChild: any, refChild: any) {
		const prevParent = newChild.parentElement ?? newChild.parent;
		if (prevParent && prevParent.children) {
			const oldIdx = prevParent.children.indexOf(newChild);
			if (oldIdx !== -1) {
				prevParent.children.splice(oldIdx, 1);
				prevParent.childElementCount = prevParent.children.length;
			}
		}
		newChild.parentElement = this;
		newChild.parent = this;
		const idx = refChild ? this.children.indexOf(refChild) : -1;
		if (idx !== -1) {
			this.children.splice(idx, 0, newChild);
		} else {
			this.children.push(newChild);
		}
		this.childElementCount = this.children.length;
		return newChild;
	}
	querySelector(sel: string): any {
		const findNode = (node: any): any => {
			if (sel === 'input' && node.tag === 'input') return node;
			if (sel === 'button' && node.tag === 'button') return node;
			if (sel === 'textarea' && node.tag === 'textarea') return node;
			if (sel.startsWith('.') && node.classList.has(sel.slice(1))) return node;
			for (const child of node.children) {
				const found = findNode(child);
				if (found) return found;
			}
			return null;
		};
		return findNode(this);
	}
	querySelectorAll(sel: string): any[] {
		const results: any[] = [];
		const walk = (node: any) => {
			if (sel === 'textarea' && node.tag === 'textarea') {
				results.push(node);
			} else if (sel.startsWith('.') && node.classList.has(sel.slice(1).split('.')[0])) {
				results.push(node);
			}
			for (const child of node.children) walk(child);
		};
		walk(this);
		return results;
	}
}

console.log('P3. Fail-closed violation on malformed question');
{
	(global as any).window = { ...(global as any).window, requestAnimationFrame: (cb: any) => cb() };
	const container = new FakeElement() as any;
	let decision: any = 'no-decision-yet';
	
	const ask = new AskUserQuestionInline(
		container,
		{ registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any,
		{ input: { not_a_question: true } } as any, // malformed input
		(answers: any) => decision = answers
	);
	
	// If it auto-submits, decision would be changed.
	check('malformed question does not auto-submit', decision === 'no-decision-yet');
	
	// Simulate user pressing Escape
	ask.el.listeners['keydown']({ key: 'Escape', preventDefault: () => {} });
	check('user can escape malformed question, resulting in deny (null)', decision === null);
}

console.log('P4. Free-text ("Other") option row exists for payload with no isOther field');
{
	const container = new FakeElement() as any;
	let decision: any = 'no-decision-yet';
	new AskUserQuestionInline(
		container,
		{ registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any,
		{
			input: {
				questions: [{
					question: 'What do you want to do?',
					options: [{ label: 'Read' }, { label: 'Write' }]
				}]
			}
		} as any,
		(answers: any) => decision = answers
	);
	const inputEl = container.querySelector('input');
	check('free-text input exists even when isOther was not sent by CLI', inputEl !== null);
	eq('not submitted on mount', decision, 'no-decision-yet');
}

console.log('P5. Empty custom answer is not submittable (fail-closed)');
{
	const container = new FakeElement() as any;
	let decision: any = 'no-decision-yet';
	const ask = new AskUserQuestionInline(
		container,
		{ registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any,
		{
			input: {
				questions: [{
					question: 'What do you want to do?',
					options: [{ label: 'Read' }, { label: 'Write' }]
				}]
			}
		} as any,
		(answers: any) => decision = answers
	);
	// ArrowDown to option 1, then option 2, then Other row (index 2)
	ask.el.listeners['keydown']({ key: 'ArrowDown', preventDefault: () => {} });
	ask.el.listeners['keydown']({ key: 'ArrowDown', preventDefault: () => {} });
	// Press Enter on Other row -> moves focus into input
	ask.el.listeners['keydown']({ key: 'Enter', preventDefault: () => {} });
	eq('not submitted upon selecting Other row', decision, 'no-decision-yet');
	
	// User presses Enter inside empty input
	const inputEl = container.querySelector('input');
	ask.el.listeners['keydown']({ key: 'Enter', target: inputEl, preventDefault: () => {} });
	eq('pressing Enter in empty custom input does not submit (fail-closed)', decision, 'no-decision-yet');
}

console.log('P6. Typed custom answer reaches updatedInput correctly');
{
	// Single-select: custom text replaces choice
	const container = new FakeElement() as any;
	let decision: any = 'no-decision-yet';
	const inputPayload = {
		questions: [{
			id: 'action_q',
			question: 'What do you want to do?',
			options: [{ label: 'Read' }, { label: 'Write' }],
			multiSelect: false
		}]
	};
	const ask = new AskUserQuestionInline(
		container,
		{ registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any,
		{ input: inputPayload } as any,
		(answers: any) => {
			decision = decideAskUserQuestion(inputPayload, answers);
		}
	);
	const inputEl = container.querySelector('input');
	inputEl.listeners['focus']?.();
	inputEl.listeners['input']?.({ target: { value: 'Custom format note' } });
	ask.el.listeners['keydown']({ key: 'Enter', target: inputEl, preventDefault: () => {} });
	check('submits allow on non-empty custom answer', decision.behavior === 'allow');
	eq('single-select payload keys custom string into answers map', decision.updatedInput?.answers?.['action_q'], 'Custom format note');
}

{
	// Multi-select: custom text combines with choices
	const container = new FakeElement() as any;
	let decision: any = 'no-decision-yet';
	const inputPayload = {
		questions: [{
			id: 'pref_q',
			question: 'Select preferences',
			options: [{ label: 'Option A', value: 'optA' }, { label: 'Option B', value: 'optB' }],
			multiSelect: true
		}]
	};
	const ask = new AskUserQuestionInline(
		container,
		{ registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any,
		{ input: inputPayload } as any,
		(answers: any) => {
			decision = decideAskUserQuestion(inputPayload, answers);
		}
	);
	// Toggle option A
	ask.el.listeners['keydown']({ key: 'Enter', preventDefault: () => {} });
	// Type custom answer
	const inputEl = container.querySelector('input');
	inputEl.listeners['focus']?.();
	inputEl.listeners['input']?.({ target: { value: 'Custom C' } });
	// Submit via Enter inside input
	ask.el.listeners['keydown']({ key: 'Enter', target: inputEl, preventDefault: () => {} });
	check('submits allow on multi-select with custom text', decision.behavior === 'allow');
	const answers = decision.updatedInput?.answers?.['pref_q'];
	check('answers is an array in multi-select', Array.isArray(answers));
	eq('combines selected option and custom text', JSON.stringify(answers), JSON.stringify(['optA', 'Custom C']));
}

console.log('P7. toolPermissionBodyText for bridged calls mounted in composer slot');
{
	const askPending = { index: 0, kind: 'tool_use', text: '', final: false, toolName: 'AskUserQuestion', toolPending: true, toolPermissionRequested: true } as const;
	eq('pending AskUserQuestion says waiting for response in composer', toolPermissionBodyText(askPending), 'Waiting for your response in the composer.');

	const askDenied = { index: 0, kind: 'tool_use', text: '', final: true, toolName: 'AskUserQuestion', toolPending: false, toolPermissionRequested: true, toolDenied: true } as const;
	eq('denied AskUserQuestion says denied in composer', toolPermissionBodyText(askDenied), 'Denied in the composer.');

	const askAnswered = { index: 0, kind: 'tool_use', text: '', final: true, toolName: 'AskUserQuestion', toolPending: false, toolPermissionRequested: true } as const;
	eq('answered AskUserQuestion says answered in composer', toolPermissionBodyText(askAnswered), 'Answered in the composer.');

	const writePending = { index: 0, kind: 'tool_use', text: '', final: false, toolName: 'Write', toolPending: true, toolPermissionRequested: true } as const;
	eq('pending Write says waiting for approval in composer', toolPermissionBodyText(writePending), 'Waiting for your approval in the composer.');

	const writeDenied = { index: 0, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolPending: false, toolPermissionRequested: true, toolDenied: true } as const;
	eq('denied Write says denied in composer', toolPermissionBodyText(writeDenied), 'Denied in the composer.');

	const writeHandled = { index: 0, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolPending: false, toolPermissionRequested: true } as const;
	eq('handled Write says handled in composer', toolPermissionBodyText(writeHandled), 'Handled in the composer.');
}

console.log('P8. MessageList.sync skips PermissionItem to avoid duplicate empty card');
{
	const dummyWrapper = new FakeElement() as any;
	const dummyApp = {} as any;
	const dummyComponent = { registerDomEvent: () => {} } as any;
	const dummyActions = { decide: () => {} } as any;
	const list = new MessageList(dummyApp, dummyWrapper, dummyComponent, dummyActions);
	const permItem: PermissionItem = {
		id: 'perm-1',
		kind: 'permission',
		requestId: 'req-1',
		toolName: 'AskUserQuestion',
		input: {},
		status: 'pending',
		createdAt: 1000,
	};
	list.sync([permItem]);
	eq('no element rendered for PermissionItem in message list', (list as any).rendered.size, 0);
}

// --- U. Phase 7 task 3 round A: permission model security floor ----------

/*
 * Round A of the permission model redesign:
 * - `.obsidian/` protected segment floor: writes into .obsidian prompt, never auto-allow.
 * - Unicode path normalisation: composed (NFC) and decomposed (NFD) paths match consistently
 *   at the boundary comparison (`containsPath`).
 */

console.log('U1. .obsidian protection: writes into .obsidian prompt, never silently allowed');
{
	const pluginJs = join(POLICY_VAULT.root, '.obsidian', 'plugins', 'x', 'main.js');
	const upperPluginJs = join(POLICY_VAULT.root, '.Obsidian', 'plugins', 'x', 'main.js');
	const regularNote = join(POLICY_VAULT.root, 'notes', 'regular-task3.md');
	const obsidianInNameNote = join(POLICY_VAULT.root, 'notes', 'my.obsidian-notes.md');
	const gitConfig = join(POLICY_VAULT.root, '.git', 'config');
	const gitHooks = join(POLICY_VAULT.root, '.git', 'hooks', 'pre-commit');
	const gitInNameNote = join(POLICY_VAULT.root, 'notes', 'git-notes-task3.md');

	// 1. A write to <vault>/.obsidian/plugins/x/main.js is not auto-allowed — it prompts
	eq('Write into .obsidian/plugins prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'console.log(1)' }, vaultPaths), 'ask');
	eq('Edit inside .obsidian/plugins prompts', permissionVerdict('Edit', { file_path: pluginJs, old_string: 'a', new_string: 'b' }, vaultPaths), 'ask');
	eq('Write into .Obsidian (differently-cased) prompts', permissionVerdict('Write', { file_path: upperPluginJs, content: 'console.log(1)' }, vaultPaths), 'ask');

	// 2. A write to an ordinary in-vault note is still auto-allowed (no regression, proof match not over-broad)
	eq('Write to ordinary in-vault note is silent', permissionVerdict('Write', { file_path: regularNote, content: 'clean note' }, vaultPaths), 'allow');

	// 3. A file whose name merely contains text .obsidian is not caught by segment match
	eq('note whose name contains .obsidian is silent', permissionVerdict('Write', { file_path: obsidianInNameNote, content: 'notes about obsidian' }, vaultPaths), 'allow');

	// 4. .git protection still behaves exactly as before
	eq('Write into .git prompts', permissionVerdict('Write', { file_path: gitConfig, content: 'x' }, vaultPaths), 'ask');
	eq('Edit inside .git prompts', permissionVerdict('Edit', { file_path: gitHooks, old_string: 'a', new_string: 'b' }, vaultPaths), 'ask');
	eq('note whose name contains git is silent', permissionVerdict('Write', { file_path: gitInNameNote, content: 'x' }, vaultPaths), 'allow');
}

console.log('U2. Unicode path normalisation: composed and decomposed paths match in containsPath');
{
	// 5. Two spellings of the same path (composed and decomposed) are judged equal by the comparison normalised
	const nfcRoot = '/vault/caf\u00e9';
	const nfdRoot = '/vault/cafe\u0301';
	const nfcChild = '/vault/caf\u00e9/notes/meeting.md';
	const nfdChild = '/vault/cafe\u0301/notes/meeting.md';

	eq('NFC child inside NFD root', containsPath(nfdRoot, nfcChild), true);
	eq('NFD child inside NFC root', containsPath(nfcRoot, nfdChild), true);
	eq('NFC root equals NFD root', containsPath(nfdRoot, nfcRoot), true);
	eq('NFD root equals NFC root', containsPath(nfcRoot, nfdRoot), true);
}

// --- V. Phase 7 task 3 round B: permission model decision logic ----------

/*
 * Round B of the permission model redesign:
 * - Three permission categories in settings: read outside vault, write outside vault, run commands.
 * - Remembered decisions ("don't ask again") stored and matched per category contracts:
 *   * Read-type tools: exact canonical absolute path.
 *   * Write-type tools: exact canonical absolute path plus whether target existed on grant.
 *   * Bash: exact normalised argv token sequence. Metacharacter veto always applies.
 * - "Allow everything" mode: allows programmatically through active bridge while preserving
 *   the .obsidian/ floor and fail-closed behaviour on malformed input.
 */

console.log('V1. .obsidian floor under allow everything and all categories auto-allow');
{
	const pluginJs = join(POLICY_VAULT.root, '.obsidian', 'plugins', 'x', 'main.js');
	const upperPluginJs = join(POLICY_VAULT.root, '.Obsidian', 'plugins', 'x', 'main.js');

	const allAutoAllow: PermissionSettings = {
		readOutsideVault: 'auto-allow',
		writeOutsideVault: 'auto-allow',
		runCommands: 'auto-allow',
		allowEverything: false,
		rememberedDecisions: [],
	};

	const allowEverything: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: true,
		rememberedDecisions: [],
	};

	const allAndEverything: PermissionSettings = {
		readOutsideVault: 'auto-allow',
		writeOutsideVault: 'auto-allow',
		runCommands: 'auto-allow',
		allowEverything: true,
		rememberedDecisions: [],
	};

	const forgedRemembered: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'forged-1',
				category: 'write',
				path: pluginJs.normalize('NFC'),
				existedOnGrant: false,
			},
		],
	};

	// Writes to .obsidian/ NEVER auto-allowed, in every mode:
	eq('Write into .obsidian under all categories auto-allow prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'code' }, vaultPaths, allAutoAllow), 'ask');
	eq('Write into .obsidian under allow everything prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'code' }, vaultPaths, allowEverything), 'ask');
	eq('Write into .obsidian under all auto-allow and allow everything prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'code' }, vaultPaths, allAndEverything), 'ask');
	eq('Edit inside .obsidian under allow everything prompts', permissionVerdict('Edit', { file_path: pluginJs, old_string: 'a', new_string: 'b' }, vaultPaths, allowEverything), 'ask');
	eq('Write into .Obsidian (differently-cased) under allow everything prompts', permissionVerdict('Write', { file_path: upperPluginJs, content: 'code' }, vaultPaths, allowEverything), 'ask');
	eq('Write into .obsidian with matching remembered decision still prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'code' }, vaultPaths, forgedRemembered), 'ask');
}

console.log('V2. Category toggle isolation: each toggle affects only its own category');
{
	const outsideFile = join(tmpdir(), 'guki-v2-outside-test.txt');
	writeFileSync(outsideFile, 'outside content');

	const readOnlyAuto: PermissionSettings = {
		readOutsideVault: 'auto-allow',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [],
	};

	const writeOnlyAuto: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'auto-allow',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [],
	};

	const bashOnlyAuto: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'auto-allow',
		allowEverything: false,
		rememberedDecisions: [],
	};

	// 1. When readOutsideVault is auto-allow: read is allowed, write and bash prompt
	eq('read auto-allow allows Read outside vault', permissionVerdict('Read', { file_path: outsideFile }, vaultPaths, readOnlyAuto), 'allow');
	eq('read auto-allow does not allow Write outside vault', permissionVerdict('Write', { file_path: outsideFile, content: 'new' }, vaultPaths, readOnlyAuto), 'ask');
	eq('read auto-allow does not allow Bash command', permissionVerdict('Bash', { command: 'npm test' }, vaultPaths, readOnlyAuto), 'ask');

	// 2. When writeOutsideVault is auto-allow: write is allowed, read and bash prompt
	eq('write auto-allow allows Write outside vault', permissionVerdict('Write', { file_path: outsideFile, content: 'new' }, vaultPaths, writeOnlyAuto), 'allow');
	eq('write auto-allow does not allow Read outside vault', permissionVerdict('Read', { file_path: outsideFile }, vaultPaths, writeOnlyAuto), 'ask');
	eq('write auto-allow does not allow Bash command', permissionVerdict('Bash', { command: 'npm test' }, vaultPaths, writeOnlyAuto), 'ask');

	// 3. When runCommands is auto-allow: bash is allowed, read and write prompt
	eq('bash auto-allow allows Bash command', permissionVerdict('Bash', { command: 'npm test' }, vaultPaths, bashOnlyAuto), 'allow');
	eq('bash auto-allow does not allow Read outside vault', permissionVerdict('Read', { file_path: outsideFile }, vaultPaths, bashOnlyAuto), 'ask');
	eq('bash auto-allow does not allow Write outside vault', permissionVerdict('Write', { file_path: outsideFile, content: 'new' }, vaultPaths, bashOnlyAuto), 'ask');

	// Clean up temp file
	rmSync(outsideFile, { force: true });
}

console.log('V3. Settings normalisation: defaults on fresh install, pre-existing, and malformed inputs');
{
	const fresh = normalizePermissionSettings(null);
	eq('fresh install readOutsideVault is always ask', fresh.readOutsideVault, 'always ask');
	eq('fresh install writeOutsideVault is always ask', fresh.writeOutsideVault, 'always ask');
	eq('fresh install runCommands is always ask', fresh.runCommands, 'always ask');
	eq('fresh install allowEverything is false', fresh.allowEverything, false);
	eq('fresh install rememberedDecisions is empty', fresh.rememberedDecisions.length, 0);

	const emptyObj = normalizePermissionSettings({});
	eq('empty settings readOutsideVault is always ask', emptyObj.readOutsideVault, 'always ask');
	eq('empty settings writeOutsideVault is always ask', emptyObj.writeOutsideVault, 'always ask');
	eq('empty settings runCommands is always ask', emptyObj.runCommands, 'always ask');

	const preExisting = normalizePermissionSettings({ claudeBinaryPath: '/usr/local/bin/claude' });
	eq('pre-existing install readOutsideVault is always ask', preExisting.readOutsideVault, 'always ask');
	eq('pre-existing install writeOutsideVault is always ask', preExisting.writeOutsideVault, 'always ask');
	eq('pre-existing install runCommands is always ask', preExisting.runCommands, 'always ask');

	const malformed = normalizePermissionSettings({
		readOutsideVault: 'auto_allow',
		writeOutsideVault: true,
		runCommands: 42,
		allowEverything: 'yes',
		rememberedDecisions: 'not an array',
	});
	eq('malformed readOutsideVault falls back to always ask', malformed.readOutsideVault, 'always ask');
	eq('malformed writeOutsideVault falls back to always ask', malformed.writeOutsideVault, 'always ask');
	eq('malformed runCommands falls back to always ask', malformed.runCommands, 'always ask');
	eq('malformed allowEverything falls back to false', malformed.allowEverything, false);
	eq('malformed rememberedDecisions falls back to empty array', malformed.rememberedDecisions.length, 0);

	const validRead = normalizePermissionSettings({ readOutsideVault: 'auto-allow' });
	eq('valid auto-allow preserved for read', validRead.readOutsideVault, 'auto-allow');
	eq('missing other categories stay always ask', validRead.writeOutsideVault, 'always ask');
}

console.log('V4. Remembered read decisions: exact canonical path matching, no directory or sibling widening');
{
	const dir = mkdtempSync(join(tmpdir(), 'guki-read-test-'));
	const targetFile = join(dir, 'target.md');
	const siblingFile = join(dir, 'sibling.md');
	const backupFile = join(dir, 'target.md.bak');
	writeFileSync(targetFile, 'target');
	writeFileSync(siblingFile, 'sibling');
	writeFileSync(backupFile, 'backup');

	const settings: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-read-1',
				category: 'read',
				path: realpathSync(targetFile).normalize('NFC'),
			},
		],
	};

	eq('exact remembered read path is allowed', permissionVerdict('Read', { file_path: targetFile }, vaultPaths, settings), 'allow');
	eq('sibling path in same directory prompts', permissionVerdict('Read', { file_path: siblingFile }, vaultPaths, settings), 'ask');
	eq('directory itself prompts', permissionVerdict('LS', { path: dir }, vaultPaths, settings), 'ask');
	eq('name prefix match prompts', permissionVerdict('Read', { file_path: backupFile }, vaultPaths, settings), 'ask');

	rmSync(dir, { recursive: true, force: true });
}

console.log('V5. Remembered write decisions: target state invariant (creation vs overwrite)');
{
	const dir = mkdtempSync(join(tmpdir(), 'guki-write-test-'));
	const newPath = join(dir, 'new-file.md');
	const existingPath = join(dir, 'existing-file.md');
	writeFileSync(existingPath, 'existing');

	const canonicalNewPath = vaultPaths.resolve(newPath)!;
	const canonicalExistingPath = vaultPaths.resolve(existingPath)!;

	// Decision 1 granted for non-existent target (creation)
	const grantForCreation: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-write-new',
				category: 'write',
				path: canonicalNewPath,
				existedOnGrant: false,
			},
		],
	};

	// While target does NOT exist: allowed
	eq('write for creation target when not existing is allowed', permissionVerdict('Write', { file_path: newPath, content: 'created' }, vaultPaths, grantForCreation), 'allow');

	// Now file is created on disk
	writeFileSync(newPath, 'now exists');
	// Once target exists: must NOT match creation approval -> prompts!
	eq('write for creation target after file exists prompts', permissionVerdict('Write', { file_path: newPath, content: 'overwrite' }, vaultPaths, grantForCreation), 'ask');

	// Decision 2 granted for existing target (overwrite/edit)
	const grantForExisting: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-write-exist',
				category: 'write',
				path: canonicalExistingPath,
				existedOnGrant: true,
			},
		],
	};

	// While target exists: allowed
	eq('write for existing target when existing is allowed', permissionVerdict('Write', { file_path: existingPath, content: 'updated' }, vaultPaths, grantForExisting), 'allow');

	// Delete the file
	rmSync(existingPath, { force: true });
	// Once target deleted: must NOT match existing approval -> prompts!
	eq('write for existing target after file deleted prompts', permissionVerdict('Write', { file_path: existingPath, content: 'recreated' }, vaultPaths, grantForExisting), 'ask');

	rmSync(dir, { recursive: true, force: true });
}

console.log('V6. Remembered Bash decisions: exact argv sequence matching and metacharacter veto');
{
	const settings: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-bash-1',
				category: 'command',
				argv: ['npm', 'test'],
				cwd: vaultPaths.root,
			},
		],
	};

	// Exact match
	eq('remembered exact command is allowed', permissionVerdict('Bash', { command: 'npm test' }, vaultPaths, settings), 'allow');
	// Quote and whitespace normalization yields same argv
	eq('whitespace-normalised remembered command is allowed', permissionVerdict('Bash', { command: 'npm   "test"' }, vaultPaths, settings), 'allow');

	// Extra argument: does NOT match remembered decision and not on whitelist -> prompts
	eq('extra argument prompts', permissionVerdict('Bash', { command: 'npm test -s' }, vaultPaths, settings), 'ask');
	eq('extra subcommand prompts', permissionVerdict('Bash', { command: 'npm test --filter=foo' }, vaultPaths, settings), 'ask');

	// Metacharacter veto STILL fires on remembered command:
	eq('metacharacter semicolon prompts despite remembered match', permissionVerdict('Bash', { command: 'npm test; rm -rf /' }, vaultPaths, settings), 'ask');
	eq('metacharacter ampersand prompts despite remembered match', permissionVerdict('Bash', { command: 'npm test && echo evil' }, vaultPaths, settings), 'ask');
	eq('metacharacter pipe prompts despite remembered match', permissionVerdict('Bash', { command: 'npm test | grep m' }, vaultPaths, settings), 'ask');
	eq('metacharacter redirect prompts despite remembered match', permissionVerdict('Bash', { command: 'npm test > /tmp/out' }, vaultPaths, settings), 'ask');
	eq('metacharacter expansion prompts despite remembered match', permissionVerdict('Bash', { command: 'npm test $FOO' }, vaultPaths, settings), 'ask');
}

console.log('V7. Category boundary isolation: remembered decisions do not leak across tool categories');
{
	const sharedPath = join(tmpdir(), 'guki-shared-category-test.txt');
	writeFileSync(sharedPath, 'data');

	const canonicalShared = vaultPaths.resolve(sharedPath)!;

	const readOnlyDecision: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-read-cat',
				category: 'read',
				path: canonicalShared,
			},
		],
	};

	eq('read decision allows Read', permissionVerdict('Read', { file_path: sharedPath }, vaultPaths, readOnlyDecision), 'allow');
	eq('read decision does not allow Write on same path', permissionVerdict('Write', { file_path: sharedPath, content: 'x' }, vaultPaths, readOnlyDecision), 'ask');
	eq('read decision does not allow Edit on same path', permissionVerdict('Edit', { file_path: sharedPath, old_string: 'data', new_string: 'x' }, vaultPaths, readOnlyDecision), 'ask');
	eq('read decision does not allow Bash using same path', permissionVerdict('Bash', { command: `cat ${sharedPath}` }, vaultPaths, readOnlyDecision), 'ask');

	const writeOnlyDecision: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-write-cat',
				category: 'write',
				path: canonicalShared,
				existedOnGrant: true,
			},
		],
	};

	eq('write decision allows Write', permissionVerdict('Write', { file_path: sharedPath, content: 'x' }, vaultPaths, writeOnlyDecision), 'allow');
	eq('write decision does not allow Read on same path', permissionVerdict('Read', { file_path: sharedPath }, vaultPaths, writeOnlyDecision), 'ask');
	eq('write decision does not allow LS on same path', permissionVerdict('LS', { path: sharedPath }, vaultPaths, writeOnlyDecision), 'ask');

	rmSync(sharedPath, { force: true });
}

console.log('V8. Allow everything mode: programmatic allows, .obsidian floor, and fail-closed integrity');
{
	const outsideNote = join(tmpdir(), 'guki-v8-outside-note.md');
	writeFileSync(outsideNote, 'initial');
	const pluginJs = join(POLICY_VAULT.root, '.obsidian', 'plugins', 'x', 'main.js');
	const inVaultNote = join(POLICY_VAULT.root, 'notes', 'todo.md');

	const allowEverything: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: true,
		rememberedDecisions: [],
	};

	// 1. Absolute floor: .obsidian writes still prompt under allow everything
	eq('allow everything still refuses .obsidian Write', permissionVerdict('Write', { file_path: pluginJs, content: 'payload' }, vaultPaths, allowEverything), 'ask');
	eq('allow everything still refuses .obsidian Edit', permissionVerdict('Edit', { file_path: pluginJs, old_string: 'a', new_string: 'b' }, vaultPaths, allowEverything), 'ask');

	// 2. In-vault destructive edit guard yields to allow everything, but still prompts under default
	eq('in-vault empty Write passes under allow everything', permissionVerdict('Write', { file_path: inVaultNote, content: '' }, vaultPaths, allowEverything), 'allow');
	eq('in-vault empty Write prompts under default settings', permissionVerdict('Write', { file_path: inVaultNote, content: '' }, vaultPaths, DEFAULT_PERMISSION_SETTINGS), 'ask');

	// 3. Fail-closed behaviour on malformed input survives allow everything
	eq('malformed toolName prompts', permissionVerdict('', { file_path: outsideNote }, vaultPaths, allowEverything), 'ask');
	eq('non-string toolName prompts', permissionVerdict(123, { file_path: outsideNote }, vaultPaths, allowEverything), 'ask');
	eq('Write with missing path prompts', permissionVerdict('Write', { content: 'hello' }, vaultPaths, allowEverything), 'ask');
	eq('Write with non-string path prompts', permissionVerdict('Write', { file_path: 123, content: 'hello' }, vaultPaths, allowEverything), 'ask');
	eq('Bash with empty command prompts', permissionVerdict('Bash', { command: '   ' }, vaultPaths, allowEverything), 'ask');
	eq('Bash with non-string command prompts', permissionVerdict('Bash', { command: null }, vaultPaths, allowEverything), 'ask');
	eq('Glob with path traversal prompts', permissionVerdict('Glob', { path: POLICY_VAULT.root, pattern: '../**' }, vaultPaths, allowEverything), 'ask');
	eq('Grep with glob traversal prompts', permissionVerdict('Grep', { path: POLICY_VAULT.root, glob: '../**' }, vaultPaths, allowEverything), 'ask');
	eq('WebFetch with file scheme prompts', permissionVerdict('WebFetch', { url: 'file:///etc/passwd' }, vaultPaths, allowEverything), 'ask');
	eq('Unrecognised tool prompts', permissionVerdict('mcp__custom_tool', { foo: 'bar' }, vaultPaths, allowEverything), 'ask');
	eq('Unresolvable path prompts', permissionVerdict('Read', { file_path: '~/.ssh/id_rsa' }, vaultPaths, allowEverything), 'ask');

	// 4. Valid operations are allowed programmatically through the active bridge
	eq('valid outside Read is allowed under allow everything', permissionVerdict('Read', { file_path: outsideNote }, vaultPaths, allowEverything), 'allow');
	eq('valid outside Write is allowed under allow everything', permissionVerdict('Write', { file_path: outsideNote, content: 'updated' }, vaultPaths, allowEverything), 'allow');
	eq('valid Bash command is allowed under allow everything', permissionVerdict('Bash', { command: 'npm test' }, vaultPaths, allowEverything), 'allow');

	rmSync(outsideNote, { force: true });
}

console.log('V9. buildRememberedDecision constructor and PermissionBroker integration');
{
	const outsideNote = join(tmpdir(), 'guki-v9-outside-note.md');
	writeFileSync(outsideNote, 'initial');
	const pluginJs = join(POLICY_VAULT.root, '.obsidian', 'plugins', 'x', 'main.js');

	// buildRememberedDecision unit checks
	const readDec = buildRememberedDecision('Read', { file_path: outsideNote }, vaultPaths);
	eq('buildRememberedDecision for Read produces read category', readDec?.category, 'read');
	eq('buildRememberedDecision for Read produces canonical path', readDec?.path, realpathSync(outsideNote).normalize('NFC'));

	const writeDec = buildRememberedDecision('Write', { file_path: outsideNote, content: 'new' }, vaultPaths);
	eq('buildRememberedDecision for Write produces write category', writeDec?.category, 'write');
	eq('buildRememberedDecision for Write captures existedOnGrant true', writeDec?.existedOnGrant, true);

	const obsDec = buildRememberedDecision('Write', { file_path: pluginJs, content: 'code' }, vaultPaths);
	eq('buildRememberedDecision refuses .obsidian write target', obsDec, null);

	const bashDec = buildRememberedDecision('Bash', { command: 'npm test --filter=foo' }, vaultPaths);
	eq('buildRememberedDecision for Bash captures token sequence', bashDec?.argv?.join(' '), 'npm test --filter=foo');
	eq('buildRememberedDecision for Bash captures canonical cwd', bashDec?.cwd, vaultPaths.root);

	const bashUnresolvableDec = buildRememberedDecision('Bash', { command: 'npm test', cwd: '~' }, vaultPaths);
	eq('buildRememberedDecision refuses unresolvable cwd', bashUnresolvableDec, null);

	const bashMetaDec = buildRememberedDecision('Bash', { command: 'npm test; rm -rf /' }, vaultPaths);
	eq('buildRememberedDecision refuses Bash with metacharacters', bashMetaDec, null);

	const unrecDec = buildRememberedDecision('mcp__some_tool', {}, vaultPaths);
	eq('buildRememberedDecision refuses unrecognised tool', unrecDec, null);

	rmSync(outsideNote, { force: true });
}

// --- W. Phase 7 task 3 round B corrections: Bash directory scoping and allow-everything destructive edits ----------

console.log('W1. Bash cwd scoping: directory isolation, spelling variants, and unresolvable cwd');
{
	const dirA = mkdtempSync(join(tmpdir(), 'guki-cwd-a-'));
	const dirB = mkdtempSync(join(tmpdir(), 'guki-cwd-b-'));
	const canonicalA = realpathSync(dirA).normalize('NFC');
	const canonicalB = realpathSync(dirB).normalize('NFC');

	const grantInA: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-bash-dir-a',
				category: 'command',
				argv: ['npm', 'test'],
				cwd: canonicalA,
			},
		],
	};

	// 1. Remembered Bash decision granted in directory A does NOT match in directory B
	eq('remembered Bash in dir A does not match same command in dir B', permissionVerdict('Bash', { command: 'npm test', cwd: dirB }, vaultPaths, grantInA), 'ask');

	// 2. DOES still match in directory A
	eq('remembered Bash in dir A matches same command in dir A', permissionVerdict('Bash', { command: 'npm test', cwd: dirA }, vaultPaths, grantInA), 'allow');

	// 3. Matches when A is spelled with trailing slash
	eq('remembered Bash in dir A matches with trailing slash', permissionVerdict('Bash', { command: 'npm test', cwd: `${dirA}/` }, vaultPaths, grantInA), 'allow');

	// 4. Matches when A is spelled in NFD decomposed form
	const nfdDirA = dirA.normalize('NFD');
	eq('remembered Bash in dir A matches with NFD spelling', permissionVerdict('Bash', { command: 'npm test', cwd: nfdDirA }, vaultPaths, grantInA), 'allow');

	// 5. Unresolvable working directory prompts rather than matching
	eq('unresolvable working directory (tilde) prompts', permissionVerdict('Bash', { command: 'npm test', cwd: '~' }, vaultPaths, grantInA), 'ask');
	eq('unresolvable working directory (empty string) prompts', permissionVerdict('Bash', { command: 'npm test', cwd: '' }, vaultPaths, grantInA), 'ask');
	eq('unresolvable working directory (non-string) prompts', permissionVerdict('Bash', { command: 'npm test', cwd: 123 }, vaultPaths, grantInA), 'ask');

	// 6. Stale decision stored without cwd does not match even in directory A
	const staleSettings: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{
				id: 'rem-bash-stale',
				category: 'command',
				argv: ['npm', 'test'],
			},
		],
	};
	eq('stale Bash decision without cwd prompts', permissionVerdict('Bash', { command: 'npm test', cwd: dirA }, vaultPaths, staleSettings), 'ask');

	// Clean up temp directories
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
}

console.log('W2. Allow everything mode vs destructive edits and absolute floors');
{
	const inVaultNote = join(POLICY_VAULT.root, 'notes', 'todo.md');
	const pluginJs = join(POLICY_VAULT.root, '.obsidian', 'plugins', 'x', 'main.js');

	const allowEverything: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: true,
		rememberedDecisions: [],
	};

	// 1. With allow everything on, a destructive in-vault edit passes
	eq('with allow everything on, destructive in-vault Write passes', permissionVerdict('Write', { file_path: inVaultNote, content: '' }, vaultPaths, allowEverything), 'allow');
	eq('with allow everything on, destructive in-vault Edit passes', permissionVerdict('Edit', { file_path: inVaultNote, old_string: 'a', new_string: '' }, vaultPaths, allowEverything), 'allow');
	eq('with allow everything on, destructive in-vault MultiEdit passes', permissionVerdict('MultiEdit', { file_path: inVaultNote, edits: [{ old_string: 'a', new_string: '' }] }, vaultPaths, allowEverything), 'allow');

	// 2. With allow everything OFF (default), that same destructive in-vault edit still prompts
	eq('with allow everything off, destructive in-vault Write prompts', permissionVerdict('Write', { file_path: inVaultNote, content: '' }, vaultPaths, DEFAULT_PERMISSION_SETTINGS), 'ask');
	eq('with allow everything off, destructive in-vault Edit prompts', permissionVerdict('Edit', { file_path: inVaultNote, old_string: 'a', new_string: '' }, vaultPaths, DEFAULT_PERMISSION_SETTINGS), 'ask');
	eq('with allow everything off, destructive in-vault MultiEdit prompts', permissionVerdict('MultiEdit', { file_path: inVaultNote, edits: [{ old_string: 'a', new_string: '' }] }, vaultPaths, DEFAULT_PERMISSION_SETTINGS), 'ask');

	// 3. With allow everything on, write into .obsidian/ STILL prompts
	eq('with allow everything on, write into .obsidian still prompts', permissionVerdict('Write', { file_path: pluginJs, content: 'malicious' }, vaultPaths, allowEverything), 'ask');

	// 4. With allow everything on, malformed input still fails closed
	eq('with allow everything on, malformed missing path prompts', permissionVerdict('Write', { content: 'hello' }, vaultPaths, allowEverything), 'ask');
	eq('with allow everything on, unresolvable path prompts', permissionVerdict('Read', { file_path: '~/.ssh/id_rsa' }, vaultPaths, allowEverything), 'ask');
	eq('with allow everything on, unrecognised tool prompts', permissionVerdict('mcp__unknown', {}, vaultPaths, allowEverything), 'ask');
}

// --- X. Phase 7 task 3 round C: UI seams for permissions and settings -------------------------

console.log('X1. Gating predicate for AskUserQuestion vs ordinary tools');
{
	eq('AskUserQuestion does not offer remember affordance', canRememberPermission({ toolName: 'AskUserQuestion', id: '1', kind: 'permission', turnId: 't1', requestId: 'r1', status: 'pending', input: {} }), false);
	eq('Read offers remember affordance', canRememberPermission({ toolName: 'Read', id: '2', kind: 'permission', turnId: 't1', requestId: 'r2', status: 'pending', input: {} }), true);
	eq('Write offers remember affordance', canRememberPermission({ toolName: 'Write', id: '3', kind: 'permission', turnId: 't1', requestId: 'r3', status: 'pending', input: {} }), true);
	eq('Bash offers remember affordance', canRememberPermission({ toolName: 'Bash', id: '4', kind: 'permission', turnId: 't1', requestId: 'r4', status: 'pending', input: {} }), true);
}

console.log('X2. Exact match key stored on remember (not broader)');
{
	// Read: exact canonical path
	const testFile = join(tmpdir(), 'guki-x2-test.txt');
	writeFileSync(testFile, 'hello');
	const canonicalTestFile = realpathSync(testFile).normalize('NFC');

	const mockSettings: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [],
	};

	let saved = false;
	const state = new ChatState();
	const broker = new PermissionBroker(
		brokerApp([]),
		state,
		POLICY_VAULT.root,
		undefined,
		mockSettings,
	);
	broker.setSettings(mockSettings);
	broker.setOnSaveSettings(async () => { saved = true; });
	(broker as unknown as { policyPaths: unknown }).policyPaths = vaultPaths;

	// Simulate pending Read
	const readItem: PermissionItem = {
		id: 'perm-read-1',
		kind: 'permission',
		turnId: 'turn-1',
		toolName: 'Read',
		input: { file_path: testFile },
		requestId: 'req-read-1',
		status: 'pending',
	};
	(broker as unknown as { pending: Map<string, unknown> }).pending.set('req-read-1', {
		item: readItem,
		socket: { write: () => {} },
	});

	await broker.remember('req-read-1');
	eq('remember saved settings', saved, true);
	eq('one decision stored for Read', broker.getSettings().rememberedDecisions.length, 1);
	const readStored = broker.getSettings().rememberedDecisions[0];
	eq('stored Read category is read', readStored?.category, 'read');
	eq('stored Read path is exact canonical path', readStored?.path, canonicalTestFile);
	// Prove it does NOT match a sibling or subdirectory path
	const siblingPath = join(tmpdir(), 'guki-x2-test-other.txt');
	eq('remembered Read does NOT match sibling path', permissionVerdict('Read', { file_path: siblingPath }, vaultPaths, broker.getSettings()), 'ask');
	eq('remembered Read DOES match exact canonical path', permissionVerdict('Read', { file_path: testFile }, vaultPaths, broker.getSettings()), 'allow');

	// Bash: exact argv tokens and exact cwd
	const dirBash = mkdtempSync(join(tmpdir(), 'guki-x2-bash-'));
	const canonicalDir = realpathSync(dirBash).normalize('NFC');
	const bashItem: PermissionItem = {
		id: 'perm-bash-1',
		kind: 'permission',
		turnId: 'turn-1',
		toolName: 'Bash',
		input: { command: 'npm test --filter=foo', cwd: dirBash },
		requestId: 'req-bash-1',
		status: 'pending',
	};
	(broker as unknown as { pending: Map<string, unknown> }).pending.set('req-bash-1', {
		item: bashItem,
		socket: { write: () => {} },
	});

	await broker.remember('req-bash-1');
	eq('two decisions stored now', broker.getSettings().rememberedDecisions.length, 2);
	const bashStored = broker.getSettings().rememberedDecisions[1];
	eq('stored Bash category is command', bashStored?.category, 'command');
	eq('stored Bash argv is exact tokens', bashStored?.argv?.join(' '), 'npm test --filter=foo');
	eq('stored Bash cwd is exact directory', bashStored?.cwd, canonicalDir);

	// Prove it does NOT match broader command or different directory
	eq('remembered Bash does NOT match different arguments', permissionVerdict('Bash', { command: 'npm test', cwd: dirBash }, vaultPaths, broker.getSettings()), 'ask');
	eq('remembered Bash does NOT match different directory', permissionVerdict('Bash', { command: 'npm test --filter=foo', cwd: tmpdir() }, vaultPaths, broker.getSettings()), 'ask');
	eq('remembered Bash DOES match exact command in exact directory', permissionVerdict('Bash', { command: 'npm test --filter=foo', cwd: dirBash }, vaultPaths, broker.getSettings()), 'allow');

	rmSync(testFile, { force: true });
	rmSync(dirBash, { recursive: true, force: true });
}

console.log('X3. Remembered decisions list: individual removal and clear all');
{
	const settings: PermissionSettings = {
		readOutsideVault: 'always ask',
		writeOutsideVault: 'always ask',
		runCommands: 'always ask',
		allowEverything: false,
		rememberedDecisions: [
			{ id: 'rem-1', category: 'read', path: '/a/b/c' },
			{ id: 'rem-2', category: 'command', argv: ['ls'], cwd: '/tmp' },
			{ id: 'rem-3', category: 'write', path: '/d/e/f', existedOnGrant: true },
		],
	};

	// Remove middle entry
	const removed = removeRememberedDecision(settings, 'rem-2');
	eq('removeRememberedDecision returned true for existing id', removed, true);
	eq('two entries remain after removing rem-2', settings.rememberedDecisions.length, 2);
	eq('first entry is still rem-1', settings.rememberedDecisions[0]?.id, 'rem-1');
	eq('second entry is still rem-3', settings.rememberedDecisions[1]?.id, 'rem-3');

	// Removing non-existent id returns false
	const removedNonExistent = removeRememberedDecision(settings, 'rem-missing');
	eq('removeRememberedDecision returned false for unknown id', removedNonExistent, false);
	eq('still two entries remain', settings.rememberedDecisions.length, 2);

	// Clear all empties the store
	clearRememberedDecisions(settings);
	eq('clearRememberedDecisions emptied the list', settings.rememberedDecisions.length, 0);
	eq('rememberedDecisions is empty array', Array.isArray(settings.rememberedDecisions), true);
}

console.log('X4. Category toggling and settings persistence round-trip');
{
	const freshSettings: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS };
	eq('fresh readOutsideVault is always ask', freshSettings.readOutsideVault, 'always ask');
	eq('fresh writeOutsideVault is always ask', freshSettings.writeOutsideVault, 'always ask');
	eq('fresh runCommands is always ask', freshSettings.runCommands, 'always ask');
	eq('fresh allowEverything is false', freshSettings.allowEverything, false);

	// Toggle categories
	freshSettings.readOutsideVault = 'auto-allow';
	freshSettings.writeOutsideVault = 'auto-allow';
	freshSettings.runCommands = 'auto-allow';
	freshSettings.allowEverything = true;

	// Simulate persistence round-trip (JSON serialize -> deserialize -> normalize)
	const serialized = JSON.stringify(freshSettings);
	const deserialized = JSON.parse(serialized);
	const roundTripped = normalizePermissionSettings(deserialized);

	eq('round-tripped readOutsideVault is auto-allow', roundTripped.readOutsideVault, 'auto-allow');
	eq('round-tripped writeOutsideVault is auto-allow', roundTripped.writeOutsideVault, 'auto-allow');
	eq('round-tripped runCommands is auto-allow', roundTripped.runCommands, 'auto-allow');
	eq('round-tripped allowEverything is true', roundTripped.allowEverything, true);
}

console.log('X5. Human-readable formatting of remembered decisions');
{
	const readFmt = formatRememberedDecision({ id: '1', category: 'read', path: '/var/log/syslog' });
	eq('read format title shows tool and path', readFmt.title, 'Read: /var/log/syslog');

	const writeExistingFmt = formatRememberedDecision({ id: '2', category: 'write', path: '/home/note.md', existedOnGrant: true });
	eq('write format title shows tool and path', writeExistingFmt.title, 'Write: /home/note.md');
	eq('write format detail indicates existing file', writeExistingFmt.detail.includes('existing file'), true);

	const writeNewFmt = formatRememberedDecision({ id: '3', category: 'write', path: '/home/new.md', existedOnGrant: false });
	eq('write format detail indicates new file', writeNewFmt.detail.includes('new file'), true);

	const bashFmt = formatRememberedDecision({ id: '4', category: 'command', argv: ['npm', 'run', 'build'], cwd: '/home/project' });
	eq('bash format title shows command', bashFmt.title, 'Bash: npm run build');
	eq('bash format detail shows directory', bashFmt.detail, 'Directory: /home/project');
}


// --- Y. Phase 7 task 3 round D: End-to-end chain checks for remembered permissions -----------

function createMockDomParent(): { parent: HTMLElement; component: any } {
	const listeners = new Map<HTMLElement, Map<string, Function[]>>();
	function makeEl(tag = 'div'): any {
		const el: any = {
			tagName: tag.toUpperCase(),
			disabled: false,
			checked: false,
			textContent: '',
			children: [] as any[],
			classes: new Set<string>(),
			createDiv: (opts?: any) => {
				const child = makeEl('div');
				if (opts?.cls) child.addClass(opts.cls);
				el.children.push(child);
				return child;
			},
			createSpan: (opts?: any) => {
				const child = makeEl('span');
				if (opts?.cls) child.addClass(opts.cls);
				el.children.push(child);
				return child;
			},
			createEl: (t: string, opts?: any) => {
				const child = makeEl(t);
				if (opts?.cls) child.addClass(opts.cls);
				if (opts?.text) child.setText(opts.text);
				if (opts?.attr) Object.assign(child, opts.attr);
				el.children.push(child);
				return child;
			},
			addClass: (cls: string) => { el.classes.add(cls); },
			removeClass: (cls: string) => { el.classes.delete(cls); },
			toggleClass: (cls: string, val: boolean) => { if (val) el.classes.add(cls); else el.classes.delete(cls); },
			setText: (txt: string) => { el.textContent = txt; },
			empty: () => { el.children = []; },
			show: () => {},
			hide: () => {},
			click: () => {
				const elListeners = listeners.get(el);
				if (elListeners) {
					const clickHandlers = elListeners.get('click');
					if (clickHandlers) {
						for (const h of clickHandlers) {
							h({ type: 'click' });
						}
					}
				}
			},
		};
		return el;
	}

	const parent = makeEl('div');
	const component = {
		registerDomEvent: (target: HTMLElement, event: string, handler: Function) => {
			if (!listeners.has(target)) {
				listeners.set(target, new Map());
			}
			const targetListeners = listeners.get(target)!;
			if (!targetListeners.has(event)) {
				targetListeners.set(event, []);
			}
			targetListeners.get(event)!.push(handler);
		},
	};
	return { parent, component };
}

const e2eBase = realpathSync(mkdtempSync(join(tmpdir(), 'guki-e2e-')));
const e2eVault = join(e2eBase, 'vault');
const e2eOutside = join(e2eBase, 'outside');
mkdirSync(e2eVault, { recursive: true });
mkdirSync(e2eOutside, { recursive: true });
const e2eVaultPaths = await createVaultPaths(e2eVault);

function createMockPluginApp() {
	const adapter = new FileSystemAdapter();
	(adapter as unknown as { getBasePath: () => string; read: (p: string) => Promise<string>; exists: (p: string) => boolean; stat: (p: string) => any }).getBasePath = () => e2eVault;
	(adapter as unknown as { read: (p: string) => Promise<string> }).read = (_p: string) => Promise.resolve(
		readFileSync(join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs'), 'utf8'),
	);
	(adapter as unknown as { exists: (p: string) => boolean }).exists = (p: string) => existsSync(p);
	(adapter as unknown as { stat: (p: string) => any }).stat = (_p: string) => ({ ctime: Date.now(), mtime: Date.now(), size: 0 });

	return {
		vault: {
			configDir: '.obsidian',
			adapter,
		},
		workspace: {
			on: () => {},
			onLayoutReady: (cb: () => void) => { cb(); },
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {}, setPinned: () => {} }),
			revealLeaf: () => {},
		},
	};
}

console.log('Y1. End-to-end chain check: Read category (UI card click -> saveData -> auto-allow -> near-miss prompts)');
{
	const outsideFile = join(e2eOutside, 'e2e-read-test.txt');
	writeFileSync(outsideFile, 'read test content');
	const canonicalOutsideFile = realpathSync(outsideFile).normalize('NFC');
	const siblingFile = join(e2eOutside, 'e2e-read-sibling.txt');
	writeFileSync(siblingFile, 'sibling content');

	let savedData: any = null;
	const plugin = new GukiChatPlugin(createMockPluginApp() as any, { dir: 'plugins/guki-chat' } as any);
	plugin.loadData = async () => ({ ...DEFAULT_SETTINGS });
	plugin.saveData = async (data: any) => {
		savedData = JSON.parse(JSON.stringify(data));
	};
	await plugin.onload();

	const session = (plugin as any).session as SessionManager;
	const broker = (session as any).broker as PermissionBroker;
	(broker as unknown as { policyPaths: unknown }).policyPaths = e2eVaultPaths;

	// 1. Initial request arrives and prompts
	const reqId = 'req-e2e-read-1';
	let firstSocketWritten = '';
	const socket1 = { write: (d: any) => { firstSocketWritten = String(d); } };
	(broker as any).handleRequest(socket1, { id: reqId, tool_name: 'Read', input: { file_path: outsideFile } });

	const pendingEntry = (broker as any).pending.get(reqId);
	check('first read request prompts with pending card', pendingEntry !== undefined);
	const item = pendingEntry?.item;

	// 2. Render real UI card and click Allow with remember checked
	const { parent, component } = createMockDomParent();
	const actions: PermissionActions = {
		decide: (requestId, behavior, remember) => {
			if (remember && behavior === 'allow') {
				void session.rememberPermission(requestId);
			} else {
				session.decidePermission(requestId, behavior);
			}
		},
	};
	const card = createPermissionCard(parent, component, item, actions);
	check('card has remember checkbox', card.rememberCheckbox !== undefined);

	// User ticks checkbox and clicks Allow
	card.rememberCheckbox!.checked = true;
	card.allowEl.click();
	await new Promise((r) => setTimeout(r, 15));

	// 3. Assert decision was persisted through saveData
	eq('read decision persisted via saveData', Array.isArray(savedData?.rememberedDecisions) && savedData.rememberedDecisions.length > 0, true);
	const persisted = savedData?.rememberedDecisions?.find((d: any) => d.category === 'read' && d.path === canonicalOutsideFile);
	check('persisted read decision has exact canonical path', persisted !== undefined);
	eq('plugin settings holds read decision', plugin.settings.rememberedDecisions.some((d) => d.category === 'read' && d.path === canonicalOutsideFile), true);

	// 4. Issue second identical request -> auto-allowed without prompt
	const reqId2 = 'req-e2e-read-2';
	let secondSocketWritten = '';
	const socket2 = { write: (d: any) => { secondSocketWritten = String(d); } };
	(broker as any).handleRequest(socket2, { id: reqId2, tool_name: 'Read', input: { file_path: outsideFile } });

	check('second identical read request is auto-allowed without prompt', (broker as any).pending.has(reqId2) === false);
	check('second read received allow decision', secondSocketWritten.includes('"behavior":"allow"'));

	// 5. Issue near-miss request (sibling path) -> still prompts
	const reqIdNear = 'req-e2e-read-near';
	const socketNear = { write: () => {} };
	(broker as any).handleRequest(socketNear, { id: reqIdNear, tool_name: 'Read', input: { file_path: siblingFile } });
	check('near-miss sibling read request still prompts', (broker as any).pending.has(reqIdNear) === true);
}

console.log('Y2. End-to-end chain check: Write category (UI card click -> saveData -> auto-allow -> near-miss prompts)');
{
	const outsideWriteFile = join(e2eOutside, 'e2e-write-test.txt');
	rmSync(outsideWriteFile, { force: true });
	const siblingWriteFile = join(e2eOutside, 'e2e-write-sibling.txt');
	rmSync(siblingWriteFile, { force: true });

	let savedData: any = null;
	const pluginW = new GukiChatPlugin(createMockPluginApp() as any, { dir: 'plugins/guki-chat' } as any);
	pluginW.loadData = async () => ({ ...DEFAULT_SETTINGS });
	pluginW.saveData = async (data: any) => {
		savedData = JSON.parse(JSON.stringify(data));
	};
	await pluginW.onload();

	const sessionW = (pluginW as any).session as SessionManager;
	const brokerW = (sessionW as any).broker as PermissionBroker;
	(brokerW as unknown as { policyPaths: unknown }).policyPaths = e2eVaultPaths;

	// 1. Initial write request arrives and prompts
	const reqIdW = 'req-e2e-write-1';
	let firstWriteWritten = '';
	const socketW1 = { write: (d: any) => { firstWriteWritten = String(d); } };
	(brokerW as any).handleRequest(socketW1, { id: reqIdW, tool_name: 'Write', input: { file_path: outsideWriteFile, content: 'created' } });

	check('first write request prompts with pending card', (brokerW as any).pending.has(reqIdW) === true);
	const itemW = (brokerW as any).pending.get(reqIdW)?.item;

	// 2. Render UI card, tick checkbox, click Allow
	const { parent: parentW, component: compW } = createMockDomParent();
	const actionsW: PermissionActions = {
		decide: (requestId, behavior, remember) => {
			if (remember && behavior === 'allow') {
				void sessionW.rememberPermission(requestId);
			} else {
				sessionW.decidePermission(requestId, behavior);
			}
		},
	};
	const cardW = createPermissionCard(parentW, compW, itemW, actionsW);
	cardW.rememberCheckbox!.checked = true;
	cardW.allowEl.click();
	await new Promise((r) => setTimeout(r, 15));

	// 3. Assert decision persisted with existedOnGrant: false
	eq('write decision persisted via saveData', Array.isArray(savedData?.rememberedDecisions) && savedData.rememberedDecisions.length > 0, true);
	const canonicalOutsideWrite = e2eVaultPaths.resolve(outsideWriteFile)!.normalize('NFC');
	const persistedW = savedData?.rememberedDecisions?.find((d: any) => d.category === 'write' && d.path === canonicalOutsideWrite);
	check('persisted write decision exists with existedOnGrant false', persistedW !== undefined && persistedW.existedOnGrant === false);
	eq('plugin settings holds write decision', pluginW.settings.rememberedDecisions.some((d) => d.category === 'write' && d.path === canonicalOutsideWrite), true);

	// 4. Second identical write request (file still absent) -> auto-allowed without prompt
	const reqIdW2 = 'req-e2e-write-2';
	let secondWriteWritten = '';
	const socketW2 = { write: (d: any) => { secondWriteWritten = String(d); } };
	(brokerW as any).handleRequest(socketW2, { id: reqIdW2, tool_name: 'Write', input: { file_path: outsideWriteFile, content: 'created' } });
	check('second identical write is auto-allowed without prompt', (brokerW as any).pending.has(reqIdW2) === false);
	check('second write received allow decision', secondWriteWritten.includes('"behavior":"allow"'));

	// 5. Near-miss 1: sibling path -> prompts
	const reqIdWSibling = 'req-e2e-write-sibling';
	const socketWSibling = { write: () => {} };
	(brokerW as any).handleRequest(socketWSibling, { id: reqIdWSibling, tool_name: 'Write', input: { file_path: siblingWriteFile, content: 'sibling' } });
	check('near-miss sibling write still prompts', (brokerW as any).pending.has(reqIdWSibling) === true);

	// 6. Near-miss 2: file created after grant -> existedOnGrant invariant requires prompt
	writeFileSync(outsideWriteFile, 'now exists');
	const reqIdWExisted = 'req-e2e-write-existed';
	const socketWExisted = { write: () => {} };
	(brokerW as any).handleRequest(socketWExisted, { id: reqIdWExisted, tool_name: 'Write', input: { file_path: outsideWriteFile, content: 'overwrite' } });
	check('near-miss write after file exists still prompts', (brokerW as any).pending.has(reqIdWExisted) === true);
	rmSync(outsideWriteFile, { force: true });
}

console.log('Y3. End-to-end chain check: Bash category (UI card click -> saveData -> auto-allow -> near-miss prompts)');
{
	const bashDir = mkdtempSync(join(tmpdir(), 'guki-e2e-bash-'));
	const canonicalBashDir = realpathSync(bashDir).normalize('NFC');
	const otherDir = mkdtempSync(join(tmpdir(), 'guki-e2e-bash-other-'));
	const canonicalOtherDir = realpathSync(otherDir).normalize('NFC');
	const bashCmd = 'npm test --run';

	let savedData: any = null;
	const pluginB = new GukiChatPlugin(createMockPluginApp() as any, { dir: 'plugins/guki-chat' } as any);
	pluginB.loadData = async () => ({ ...DEFAULT_SETTINGS });
	pluginB.saveData = async (data: any) => {
		savedData = JSON.parse(JSON.stringify(data));
	};
	await pluginB.onload();

	const sessionB = (pluginB as any).session as SessionManager;
	const brokerB = (sessionB as any).broker as PermissionBroker;
	(brokerB as unknown as { policyPaths: unknown }).policyPaths = e2eVaultPaths;

	// 1. Initial bash request arrives and prompts
	const reqIdB = 'req-e2e-bash-1';
	let firstBashWritten = '';
	const socketB1 = { write: (d: any) => { firstBashWritten = String(d); } };
	(brokerB as any).handleRequest(socketB1, { id: reqIdB, tool_name: 'Bash', input: { command: bashCmd, cwd: bashDir } });

	check('first bash request prompts with pending card', (brokerB as any).pending.has(reqIdB) === true);
	const itemB = (brokerB as any).pending.get(reqIdB)?.item;

	// 2. Render UI card, tick checkbox, click Allow
	const { parent: parentB, component: compB } = createMockDomParent();
	const actionsB: PermissionActions = {
		decide: (requestId, behavior, remember) => {
			if (remember && behavior === 'allow') {
				void sessionB.rememberPermission(requestId);
			} else {
				sessionB.decidePermission(requestId, behavior);
			}
		},
	};
	const cardB = createPermissionCard(parentB, compB, itemB, actionsB);
	cardB.rememberCheckbox!.checked = true;
	cardB.allowEl.click();
	await new Promise((r) => setTimeout(r, 15));

	// 3. Assert decision persisted with argv tokens and canonical cwd
	eq('bash decision persisted via saveData', Array.isArray(savedData?.rememberedDecisions) && savedData.rememberedDecisions.length > 0, true);
	const persistedB = savedData?.rememberedDecisions?.find((d: any) => d.category === 'command' && d.cwd === canonicalBashDir);
	check('persisted bash decision has exact argv tokens', persistedB !== undefined && persistedB.argv?.join(' ') === bashCmd);
	eq('persisted bash decision has exact canonical cwd', persistedB?.cwd, canonicalBashDir);
	eq('plugin settings holds bash decision', pluginB.settings.rememberedDecisions.some((d) => d.category === 'command' && d.cwd === canonicalBashDir), true);

	// 4. Second identical bash request -> auto-allowed without prompt
	const reqIdB2 = 'req-e2e-bash-2';
	let secondBashWritten = '';
	const socketB2 = { write: (d: any) => { secondBashWritten = String(d); } };
	(brokerB as any).handleRequest(socketB2, { id: reqIdB2, tool_name: 'Bash', input: { command: bashCmd, cwd: bashDir } });
	check('second identical bash request is auto-allowed without prompt', (brokerB as any).pending.has(reqIdB2) === false);
	check('second bash received allow decision', secondBashWritten.includes('"behavior":"allow"'));

	// 5. Near-miss 1: extra argument -> prompts
	const reqIdBExtra = 'req-e2e-bash-extra';
	const socketBExtra = { write: () => {} };
	(brokerB as any).handleRequest(socketBExtra, { id: reqIdBExtra, tool_name: 'Bash', input: { command: 'npm test --run --extra', cwd: bashDir } });
	check('near-miss extra argument bash request still prompts', (brokerB as any).pending.has(reqIdBExtra) === true);

	// 6. Near-miss 2: different directory -> prompts
	const reqIdBDir = 'req-e2e-bash-diffdir';
	const socketBDir = { write: () => {} };
	(brokerB as any).handleRequest(socketBDir, { id: reqIdBDir, tool_name: 'Bash', input: { command: bashCmd, cwd: otherDir } });
	check('near-miss different directory bash request still prompts', (brokerB as any).pending.has(reqIdBDir) === true);

	rmSync(e2eBase, { recursive: true, force: true });
	rmSync(bashDir, { recursive: true, force: true });
	rmSync(otherDir, { recursive: true, force: true });
}

// --- Z. Phase 7 task 3 round E: .obsidian floor on command path and Bash permission scoping ---

console.log('Z1. Absolute floor: Write and Bash into .obsidian prompt under all configurations');
{
	const zFloorBase = realpathSync(mkdtempSync(join(tmpdir(), 'guki-z-floor-')));
	const zFloorVault = join(zFloorBase, 'vault');
	mkdirSync(join(zFloorVault, '.obsidian', 'plugins', 'x'), { recursive: true });
	const zFloorVaultPaths = await createVaultPaths(zFloorVault);
	const pluginJs = join(zFloorVault, '.obsidian', 'plugins', 'x', 'main.js');
	const bashEcho = `echo payload > ${pluginJs}`;
	const bashCp = `cp /tmp/source.js ${pluginJs}`;
	const bashTee = `tee ${pluginJs}`;

	const defaultConfig: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS };
	const readAuto: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, readOutsideVault: 'auto-allow' };
	const writeAuto: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, writeOutsideVault: 'auto-allow' };
	const cmdAuto: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, runCommands: 'auto-allow' };
	const allCategoriesAuto: PermissionSettings = {
		readOutsideVault: 'auto-allow',
		writeOutsideVault: 'auto-allow',
		runCommands: 'auto-allow',
		allowEverything: false,
		rememberedDecisions: [],
	};
	const allowEverythingOn: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, allowEverything: true };

	// Settings with remembered decisions for each exact operation
	const writeRemembered: PermissionSettings = {
		...DEFAULT_PERMISSION_SETTINGS,
		rememberedDecisions: [
			{ id: 'rem-w-obs', category: 'write', path: pluginJs.normalize('NFC'), existedOnGrant: false },
		],
	};
	const echoRemembered: PermissionSettings = {
		...DEFAULT_PERMISSION_SETTINGS,
		rememberedDecisions: [
			{ id: 'rem-b-echo', category: 'command', argv: ['echo', 'payload', '>', pluginJs], cwd: zFloorVaultPaths.root },
		],
	};
	const cpRemembered: PermissionSettings = {
		...DEFAULT_PERMISSION_SETTINGS,
		rememberedDecisions: [
			{ id: 'rem-b-cp', category: 'command', argv: ['cp', '/tmp/source.js', pluginJs], cwd: zFloorVaultPaths.root },
		],
	};
	const teeRemembered: PermissionSettings = {
		...DEFAULT_PERMISSION_SETTINGS,
		rememberedDecisions: [
			{ id: 'rem-b-tee', category: 'command', argv: ['tee', pluginJs], cwd: zFloorVaultPaths.root },
		],
	};

	// 1. Write targeting .obsidian/
	eq('Write into .obsidian prompts under default', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, defaultConfig), 'ask');
	eq('Write into .obsidian prompts under read auto-allow', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, readAuto), 'ask');
	eq('Write into .obsidian prompts under write auto-allow', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, writeAuto), 'ask');
	eq('Write into .obsidian prompts under command auto-allow', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, cmdAuto), 'ask');
	eq('Write into .obsidian prompts under all categories auto-allow', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, allCategoriesAuto), 'ask');
	eq('Write into .obsidian prompts under allow everything on', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Write into .obsidian prompts under remembered decision', permissionVerdict('Write', { file_path: pluginJs, content: 'x' }, zFloorVaultPaths, writeRemembered), 'ask');

	// 2. Bash echo/redirection targeting .obsidian/
	eq('Bash echo into .obsidian prompts under default', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, defaultConfig), 'ask');
	eq('Bash echo into .obsidian prompts under read auto-allow', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, readAuto), 'ask');
	eq('Bash echo into .obsidian prompts under write auto-allow', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, writeAuto), 'ask');
	eq('Bash echo into .obsidian prompts under command auto-allow', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, cmdAuto), 'ask');
	eq('Bash echo into .obsidian prompts under all categories auto-allow', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, allCategoriesAuto), 'ask');
	eq('Bash echo into .obsidian prompts under allow everything on', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Bash echo into .obsidian prompts under remembered decision', permissionVerdict('Bash', { command: bashEcho }, zFloorVaultPaths, echoRemembered), 'ask');

	// 3. Bash cp targeting .obsidian/
	eq('Bash cp into .obsidian prompts under default', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, defaultConfig), 'ask');
	eq('Bash cp into .obsidian prompts under read auto-allow', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, readAuto), 'ask');
	eq('Bash cp into .obsidian prompts under write auto-allow', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, writeAuto), 'ask');
	eq('Bash cp into .obsidian prompts under command auto-allow', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, cmdAuto), 'ask');
	eq('Bash cp into .obsidian prompts under all categories auto-allow', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, allCategoriesAuto), 'ask');
	eq('Bash cp into .obsidian prompts under allow everything on', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Bash cp into .obsidian prompts under remembered decision', permissionVerdict('Bash', { command: bashCp }, zFloorVaultPaths, cpRemembered), 'ask');

	// 4. Bash tee targeting .obsidian/
	eq('Bash tee into .obsidian prompts under default', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, defaultConfig), 'ask');
	eq('Bash tee into .obsidian prompts under read auto-allow', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, readAuto), 'ask');
	eq('Bash tee into .obsidian prompts under write auto-allow', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, writeAuto), 'ask');
	eq('Bash tee into .obsidian prompts under command auto-allow', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, cmdAuto), 'ask');
	eq('Bash tee into .obsidian prompts under all categories auto-allow', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, allCategoriesAuto), 'ask');
	eq('Bash tee into .obsidian prompts under allow everything on', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Bash tee into .obsidian prompts under remembered decision', permissionVerdict('Bash', { command: bashTee }, zFloorVaultPaths, teeRemembered), 'ask');

	// 5. Metacharacter veto fires under allow everything
	eq('Bash metacharacter semicolon prompts under allow everything', permissionVerdict('Bash', { command: 'echo hello; rm -rf /' }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Bash metacharacter pipe prompts under allow everything', permissionVerdict('Bash', { command: 'echo hello | cat' }, zFloorVaultPaths, allowEverythingOn), 'ask');
	eq('Bash metacharacter ampersand prompts under allow everything', permissionVerdict('Bash', { command: 'echo hello && echo world' }, zFloorVaultPaths, allowEverythingOn), 'ask');

	rmSync(zFloorBase, { recursive: true, force: true });
}

console.log('Z2. Defect 0 end-to-end chain check: Bash without cwd in request scopes to session cwd');
{
	const e2eBaseZ = realpathSync(mkdtempSync(join(tmpdir(), 'guki-e2e-z-')));
	const e2eVaultZ = join(e2eBaseZ, 'vault');
	mkdirSync(e2eVaultZ, { recursive: true });
	const e2eVaultPathsZ = await createVaultPaths(e2eVaultZ);
	const otherDirZ = mkdtempSync(join(tmpdir(), 'guki-e2e-other-z-'));
	const bashCmdZ = 'npm test --run';

	function createMockPluginAppZ() {
		const adapter = new FileSystemAdapter();
		(adapter as any).getBasePath = () => e2eVaultZ;
		(adapter as any).read = (_p: string) => Promise.resolve(
			readFileSync(join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs'), 'utf8'),
		);
		(adapter as any).exists = (p: string) => existsSync(p);
		(adapter as any).stat = (_p: string) => ({ ctime: Date.now(), mtime: Date.now(), size: 0 });

		return {
			vault: { configDir: '.obsidian', adapter },
			workspace: {
				on: () => {},
				onLayoutReady: (cb: () => void) => { cb(); },
				getLeavesOfType: () => [],
				getRightLeaf: () => null,
				getLeaf: () => ({ setViewState: async () => {}, setPinned: () => {} }),
				revealLeaf: () => {},
			},
		};
	}

	let savedDataZ: any = null;
	const pluginZ = new GukiChatPlugin(createMockPluginAppZ() as any, { dir: 'plugins/guki-chat' } as any);
	pluginZ.loadData = async () => ({ ...DEFAULT_SETTINGS });
	pluginZ.saveData = async (data: any) => {
		savedDataZ = JSON.parse(JSON.stringify(data));
	};
	await pluginZ.onload();

	const sessionZ = (pluginZ as any).session as SessionManager;
	const brokerZ = (sessionZ as any).broker as PermissionBroker;
	(brokerZ as unknown as { policyPaths: unknown }).policyPaths = e2eVaultPathsZ;

	// 1. Initial bash request arrives WITHOUT cwd (the measured real CLI wire shape)
	const reqIdZ1 = 'req-e2e-bash-z1';
	let firstBashWrittenZ = '';
	const socketZ1 = { write: (d: any) => { firstBashWrittenZ = String(d); } };
	(brokerZ as any).handleRequest(socketZ1, { id: reqIdZ1, tool_name: 'Bash', input: { command: bashCmdZ } });

	check('first bash request without cwd prompts with pending card', (brokerZ as any).pending.has(reqIdZ1) === true);
	const itemZ = (brokerZ as any).pending.get(reqIdZ1)?.item;

	// 2. Render UI card, tick checkbox, click Allow
	const { parent: parentZ, component: compZ } = createMockDomParent();
	const actionsZ: PermissionActions = {
		decide: (requestId, behavior, remember) => {
			if (remember && behavior === 'allow') {
				void sessionZ.rememberPermission(requestId);
			} else {
				sessionZ.decidePermission(requestId, behavior);
			}
		},
	};
	const cardZ = createPermissionCard(parentZ, compZ, itemZ, actionsZ);
	cardZ.rememberCheckbox!.checked = true;
	cardZ.allowEl.click();
	await new Promise((r) => setTimeout(r, 15));

	// 3. Assert decision persisted with exact argv and session cwd (vault root)
	eq('bash decision persisted via saveData', Array.isArray(savedDataZ?.rememberedDecisions) && savedDataZ.rememberedDecisions.length > 0, true);
	const persistedZ = savedDataZ?.rememberedDecisions?.find((d: any) => d.category === 'command' && d.cwd === e2eVaultPathsZ.root);
	check('persisted bash decision has exact argv tokens', persistedZ !== undefined && persistedZ.argv?.join(' ') === bashCmdZ);
	eq('persisted bash decision has exact session canonical cwd', persistedZ?.cwd, e2eVaultPathsZ.root);
	eq('plugin settings holds bash decision', pluginZ.settings.rememberedDecisions.some((d) => d.category === 'command' && d.cwd === e2eVaultPathsZ.root), true);

	// 4. Second identical bash request (also without cwd) -> auto-allowed without prompt
	const reqIdZ2 = 'req-e2e-bash-z2';
	let secondBashWrittenZ = '';
	const socketZ2 = { write: (d: any) => { secondBashWrittenZ = String(d); } };
	(brokerZ as any).handleRequest(socketZ2, { id: reqIdZ2, tool_name: 'Bash', input: { command: bashCmdZ } });
	check('second identical bash request is auto-allowed without prompt', (brokerZ as any).pending.has(reqIdZ2) === false);
	check('second bash received allow decision', secondBashWrittenZ.includes('"behavior":"allow"'));

	// 5. Near-miss 1: extra argument -> prompts
	const reqIdZExtra = 'req-e2e-bash-extra';
	const socketZExtra = { write: () => {} };
	(brokerZ as any).handleRequest(socketZExtra, { id: reqIdZExtra, tool_name: 'Bash', input: { command: 'npm test --run --extra' } });
	check('near-miss extra argument bash request still prompts', (brokerZ as any).pending.has(reqIdZExtra) === true);

	// 6. Near-miss 2: different directory -> prompts
	const reqIdZDir = 'req-e2e-bash-diffdir';
	const socketZDir = { write: () => {} };
	(brokerZ as any).handleRequest(socketZDir, { id: reqIdZDir, tool_name: 'Bash', input: { command: bashCmdZ, cwd: otherDirZ } });
	check('near-miss different directory bash request still prompts', (brokerZ as any).pending.has(reqIdZDir) === true);

	// 7. Near-miss 3: metacharacter -> prompts
	const reqIdZMeta = 'req-e2e-bash-meta';
	const socketZMeta = { write: () => {} };
	(brokerZ as any).handleRequest(socketZMeta, { id: reqIdZMeta, tool_name: 'Bash', input: { command: `${bashCmdZ}; echo evil` } });
	check('near-miss metacharacter bash request still prompts', (brokerZ as any).pending.has(reqIdZMeta) === true);

	rmSync(e2eBaseZ, { recursive: true, force: true });
	rmSync(otherDirZ, { recursive: true, force: true });
}

// --- AA. Phase 7 task 3 round F: Structural floor, cd-relative evasion, and formatting --------

console.log('AA1. Structural floor: candidate verdict allows, wrapper and final verdict floor to ask');
{
	const aaBase = realpathSync(mkdtempSync(join(tmpdir(), 'guki-aa-floor-')));
	const aaVault = join(aaBase, 'vault');
	mkdirSync(join(aaVault, '.obsidian', 'plugins', 'plugin-x'), { recursive: true });
	const aaPaths = await createVaultPaths(aaVault);
	const targetObsidianFile = join(aaVault, '.obsidian', 'plugins', 'plugin-x', 'main.js');
	const allowAllSettings: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, allowEverything: true };

	// 1. Edit path: evaluateCandidateVerdict / evaluateEditCandidate returns allow, but permissionVerdict / editVerdict floors it to ask
	eq(
		'AA1.1: evaluateEditCandidate returns allow candidate under allowEverything',
		evaluateEditCandidate('Write', { file_path: targetObsidianFile, content: 'evil' }, 'file_path', aaPaths, allowAllSettings),
		'allow',
	);
	eq(
		'AA1.2: editVerdict floors candidate allow to ask',
		editVerdict('Write', { file_path: targetObsidianFile, content: 'evil' }, 'file_path', aaPaths, allowAllSettings),
		'ask',
	);
	eq(
		'AA1.3: evaluateCandidateVerdict returns allow candidate for Write under allowEverything',
		evaluateCandidateVerdict('Write', { file_path: targetObsidianFile, content: 'evil' }, aaPaths, allowAllSettings),
		'allow',
	);
	eq(
		'AA1.4: permissionVerdict floors candidate allow to ask for Write into .obsidian',
		permissionVerdict('Write', { file_path: targetObsidianFile, content: 'evil' }, aaPaths, allowAllSettings),
		'ask',
	);

	// 2. Bash path: evaluateBashCandidate returns allow, but bashVerdict and permissionVerdict floor it to ask
	const bashEchoCmd = `echo evil > ${targetObsidianFile}`;
	eq(
		'AA1.5: evaluateBashCandidate returns allow candidate under allowEverything',
		evaluateBashCandidate(bashEchoCmd, aaPaths, allowAllSettings),
		'allow',
	);
	eq(
		'AA1.6: bashVerdict floors candidate allow to ask for Bash into .obsidian',
		bashVerdict(bashEchoCmd, aaPaths, allowAllSettings),
		'ask',
	);
	eq(
		'AA1.7: evaluateCandidateVerdict returns allow candidate for Bash under allowEverything',
		evaluateCandidateVerdict('Bash', { command: bashEchoCmd }, aaPaths, allowAllSettings),
		'allow',
	);
	eq(
		'AA1.8: permissionVerdict floors candidate allow to ask for Bash into .obsidian',
		permissionVerdict('Bash', { command: bashEchoCmd }, aaPaths, allowAllSettings),
		'ask',
	);

	// 3. Metacharacter under allowEverything: candidate returns allow, floor returns ask
	const bashMetaCmd = 'echo hello; rm -rf /';
	eq(
		'AA1.9: evaluateBashCandidate returns allow candidate for metacharacter under allowEverything',
		evaluateBashCandidate(bashMetaCmd, aaPaths, allowAllSettings),
		'allow',
	);
	eq(
		'AA1.10: bashVerdict floors metacharacter candidate allow to ask',
		bashVerdict(bashMetaCmd, aaPaths, allowAllSettings),
		'ask',
	);
	eq(
		'AA1.11: permissionVerdict floors metacharacter candidate allow to ask',
		permissionVerdict('Bash', { command: bashMetaCmd }, aaPaths, allowAllSettings),
		'ask',
	);

	rmSync(aaBase, { recursive: true, force: true });
}

console.log('AA2. Full floor matrix after restructure: 42 cells all prompt');
{
	const aaBase2 = realpathSync(mkdtempSync(join(tmpdir(), 'guki-aa-matrix-')));
	const aaVault2 = join(aaBase2, 'vault');
	mkdirSync(join(aaVault2, '.obsidian', 'plugins', 'test-plugin'), { recursive: true });
	const paths2 = await createVaultPaths(aaVault2);
	const targetFile2 = join(aaVault2, '.obsidian', 'plugins', 'test-plugin', 'main.js');

	const defaultS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS };
	const readAutoS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, readOutsideVault: 'auto-allow' };
	const writeAutoS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, writeOutsideVault: 'auto-allow' };
	const cmdAutoS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, runCommands: 'auto-allow' };
	const allAutoS: PermissionSettings = {
		readOutsideVault: 'auto-allow',
		writeOutsideVault: 'auto-allow',
		runCommands: 'auto-allow',
		allowEverything: false,
		rememberedDecisions: [],
	};
	const allowAllS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, allowEverything: true };

	const matrixTools = [
		{
			name: 'Write',
			fn: (s: PermissionSettings) => permissionVerdict('Write', { file_path: targetFile2, content: 'payload' }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-w', category: 'write' as const, path: targetFile2, existedOnGrant: false }],
			},
		},
		{
			name: 'Bash echo >',
			fn: (s: PermissionSettings) => permissionVerdict('Bash', { command: `echo payload > ${targetFile2}` }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-e', category: 'command' as const, argv: ['echo', 'payload', '>', targetFile2], cwd: paths2.root }],
			},
		},
		{
			name: 'Bash cp',
			fn: (s: PermissionSettings) => permissionVerdict('Bash', { command: `cp /tmp/source.js ${targetFile2}` }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-cp', category: 'command' as const, argv: ['cp', '/tmp/source.js', targetFile2], cwd: paths2.root }],
			},
		},
		{
			name: 'Bash tee',
			fn: (s: PermissionSettings) => permissionVerdict('Bash', { command: `tee ${targetFile2}` }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-tee', category: 'command' as const, argv: ['tee', targetFile2], cwd: paths2.root }],
			},
		},
		{
			name: 'Bash mv',
			fn: (s: PermissionSettings) => permissionVerdict('Bash', { command: `mv /tmp/source.js ${targetFile2}` }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-mv', category: 'command' as const, argv: ['mv', '/tmp/source.js', targetFile2], cwd: paths2.root }],
			},
		},
		{
			name: 'Bash echo >>',
			fn: (s: PermissionSettings) => permissionVerdict('Bash', { command: `echo payload >> ${targetFile2}` }, paths2, s),
			remSettings: {
				...DEFAULT_PERMISSION_SETTINGS,
				rememberedDecisions: [{ id: 'rem-app', category: 'command' as const, argv: ['echo', 'payload', '>>', targetFile2], cwd: paths2.root }],
			},
		},
	];

	const matrixModes = [
		{ name: 'default', getS: (t: typeof matrixTools[0]) => defaultS },
		{ name: 'readOutsideVault: auto-allow', getS: (t: typeof matrixTools[0]) => readAutoS },
		{ name: 'writeOutsideVault: auto-allow', getS: (t: typeof matrixTools[0]) => writeAutoS },
		{ name: 'runCommands: auto-allow', getS: (t: typeof matrixTools[0]) => cmdAutoS },
		{ name: 'all 3 auto-allow', getS: (t: typeof matrixTools[0]) => allAutoS },
		{ name: 'allowEverything: true', getS: (t: typeof matrixTools[0]) => allowAllS },
		{ name: 'remembered decision', getS: (t: typeof matrixTools[0]) => t.remSettings },
	];

	let matrixTotal = 0;
	for (const tool of matrixTools) {
		for (const mode of matrixModes) {
			matrixTotal += 1;
			const v = tool.fn(mode.getS(tool));
			eq(`AA2: ${tool.name} under ${mode.name} prompts`, v, 'ask');
		}
	}
	eq('AA2: exactly 42 matrix cells tested', matrixTotal, 42);

	rmSync(aaBase2, { recursive: true, force: true });
}

console.log('AA3. cd-then-relative evasions and harmless cases');
{
	const aaBase3 = realpathSync(mkdtempSync(join(tmpdir(), 'guki-aa-evasions-')));
	const aaVault3 = join(aaBase3, 'vault');
	const pluginDir = join(aaVault3, '.obsidian', 'plugins', 'test-plugin');
	mkdirSync(pluginDir, { recursive: true });
	const paths3 = await createVaultPaths(aaVault3);
	const allowAllS: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS, allowEverything: true };

	// 1. cd-then-relative write from inside .obsidian cwd (tokens do NOT mention .obsidian)
	eq(
		'AA3.1: relative cp from cwd inside .obsidian prompts under allowEverything',
		permissionVerdict('Bash', { command: 'cp /tmp/source.js main.js', cwd: pluginDir }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.2: relative tee from cwd inside .obsidian prompts under allowEverything',
		permissionVerdict('Bash', { command: 'tee main.js', cwd: pluginDir }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.3: relative cat from cwd inside .obsidian prompts under allowEverything',
		permissionVerdict('Bash', { command: 'cat main.js', cwd: pluginDir }, paths3, allowAllS),
		'ask',
	);

	// 2. cd in compound command
	eq(
		'AA3.4: cd into .obsidian with && prompts under allowEverything',
		permissionVerdict('Bash', { command: `cd ${pluginDir} && echo x > main.js` }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.5: cd .obsidian token prompts under allowEverything',
		permissionVerdict('Bash', { command: 'cd .obsidian' }, paths3, allowAllS),
		'ask',
	);

	// 3. Shell variable and escapes
	eq(
		'AA3.6: path from shell variable prompts under allowEverything',
		permissionVerdict('Bash', { command: 'echo $DIR/main.js' }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.7: backslash escaped .obsidian prompts under allowEverything',
		permissionVerdict('Bash', { command: 'cat .\\obsidian/config.json' }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.8: double quoted .obsidian prompts under allowEverything',
		permissionVerdict('Bash', { command: 'cat ".obsidian/config.json"' }, paths3, allowAllS),
		'ask',
	);
	eq(
		'AA3.9: concatenated quotes .ob\'sidian\' prompts under allowEverything',
		permissionVerdict('Bash', { command: "cat .ob'sidian'/config.json" }, paths3, allowAllS),
		'ask',
	);

	// 4. Harmless non-prompts (must NOT over-prompt)
	eq(
		'AA3.10: note containing obsidian in filename is allowed under allowEverything',
		permissionVerdict('Bash', { command: 'cat my-obsidian-notes.md' }, paths3, allowAllS),
		'allow',
	);
	eq(
		'AA3.11: note containing .obsidian. in filename is allowed under allowEverything',
		permissionVerdict('Bash', { command: 'cat notes/reading-about-.obsidian.md' }, paths3, allowAllS),
		'allow',
	);
	eq(
		'AA3.12: echo text containing obsidian is allowed under allowEverything',
		permissionVerdict('Bash', { command: 'echo "I love obsidian"' }, paths3, allowAllS),
		'allow',
	);

	// 5. Harmless exact token / flag (documented over-prompt on safe side)
	eq(
		'AA3.13: echo bare .obsidian prompts (safe over-prompt)',
		permissionVerdict('Bash', { command: 'echo .obsidian' }, paths3, allowAllS),
		'ask',
	);

	rmSync(aaBase3, { recursive: true, force: true });
}

console.log('AA4. Label and list formatting: directory displayed, distinguishable renderings');
{
	// 1. Card label names directory and shortens long paths
	eq(
		'AA4.1: short directory is shown verbatim',
		rememberLabelText('Bash', '/Users/alice/vault'),
		'Always allow this exact command in /Users/alice/vault',
	);
	eq(
		'AA4.2: long directory is shortened at front keeping meaningful tail',
		rememberLabelText('Bash', '/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat'),
		'Always allow this exact command in …/otherprojects/guki-obsidian-chat',
	);
	eq(
		'AA4.3: missing directory falls back safely',
		rememberLabelText('Bash'),
		'Always allow this exact command in this directory',
	);
	eq(
		'AA4.4: Write label remains unchanged',
		rememberLabelText('Write'),
		'Always allow this exact path',
	);

	// 2. Settings list: long commands are fully represented and distinguishable
	const cmdA = 'git log --oneline --graph --all --decorate --stat --max-count=100 --author=Alice';
	const cmdB = 'git log --oneline --graph --all --decorate --stat --max-count=100 --author=Bob';
	const fmtCmdA = formatRememberedDecision({ id: 'rem-cmd-a', category: 'command', argv: cmdA.split(' '), cwd: '/repo' });
	const fmtCmdB = formatRememberedDecision({ id: 'rem-cmd-b', category: 'command', argv: cmdB.split(' '), cwd: '/repo' });
	eq('AA4.5: long command A is fully represented', fmtCmdA.title, `Bash: ${cmdA}`);
	eq('AA4.6: long command B is fully represented', fmtCmdB.title, `Bash: ${cmdB}`);
	check('AA4.7: two long commands differing at end remain distinguishable', fmtCmdA.title !== fmtCmdB.title);

	// 3. Settings list: long paths are fully represented and distinguishable
	const pathA = '/Users/alice/projects/work/client/subproject/deep/directory/very-long-filename-version-1.0.0.md';
	const pathB = '/Users/alice/projects/work/client/subproject/deep/directory/very-long-filename-version-2.0.0.md';
	const fmtPathA = formatRememberedDecision({ id: 'rem-w-a', category: 'write', path: pathA, existedOnGrant: true });
	const fmtPathB = formatRememberedDecision({ id: 'rem-w-b', category: 'write', path: pathB, existedOnGrant: true });
	eq('AA4.8: long path A is fully represented', fmtPathA.title, `Write: ${pathA}`);
	eq('AA4.9: long path B is fully represented', fmtPathB.title, `Write: ${pathB}`);
	check('AA4.10: two long paths differing at end remain distinguishable', fmtPathA.title !== fmtPathB.title);

	// 4. Settings list: long paths differing at root remain distinguishable
	const rootA = '/Volumes/ExternalBackupDrive/2026/documents/archive/project/overview.md';
	const rootB = '/Users/emregultekir/documents/archive/project/overview.md';
	const fmtRootA = formatRememberedDecision({ id: 'rem-r-a', category: 'read', path: rootA });
	const fmtRootB = formatRememberedDecision({ id: 'rem-r-b', category: 'read', path: rootB });
	check('AA4.11: two long paths differing at start remain distinguishable', fmtRootA.title !== fmtRootB.title);

	// 5. Collision cases that previously failed: entries differing only in the middle
	const revCmd1 = 'git log --oneline --graph --all --author=Alice --decorate --max-count=100 --stat!';
	const revCmd2 = 'git log --oneline --graph --all --author=Bob --decorate --max-count=100 --stat!';
	const fmtRevCmd1 = formatRememberedDecision({ id: 'rem-rev-cmd-1', category: 'command', argv: revCmd1.split(' ') });
	const fmtRevCmd2 = formatRememberedDecision({ id: 'rem-rev-cmd-2', category: 'command', argv: revCmd2.split(' ') });
	check('AA4.12: reviewer command pair differing only in middle render as different strings', fmtRevCmd1.title !== fmtRevCmd2.title);
	eq('AA4.13: reviewer command 1 is fully represented', fmtRevCmd1.title, `Bash: ${revCmd1}`);
	eq('AA4.14: reviewer command 2 is fully represented', fmtRevCmd2.title, `Bash: ${revCmd2}`);

	const revPath1 = '/Users/alice/projects/work/subfolder-alpha/very/deep/directory/notes/file-target.txt';
	const revPath2 = '/Users/alice/projects/work/subfolder-beta/very/deep/directory/notes/file-target.txt';
	const fmtRevPath1 = formatRememberedDecision({ id: 'rem-rev-p-1', category: 'write', path: revPath1, existedOnGrant: true });
	const fmtRevPath2 = formatRememberedDecision({ id: 'rem-rev-p-2', category: 'write', path: revPath2, existedOnGrant: true });
	check('AA4.15: path pair differing only in middle render as different strings', fmtRevPath1.title !== fmtRevPath2.title);
	eq('AA4.16: path 1 is fully represented', fmtRevPath1.title, `Write: ${revPath1}`);
	eq('AA4.17: path 2 is fully represented', fmtRevPath2.title, `Write: ${revPath2}`);

	const revCwd = '/Users/alice/projects/work/client/subproject/deep/directory/subfolder';
	const fmtRevCmdCwd = formatRememberedDecision({ id: 'rem-rev-cmd-cwd', category: 'command', argv: ['ls'], cwd: revCwd });
	eq('AA4.18: directory path in command detail is fully represented without middle truncation', fmtRevCmdCwd.detail, `Directory: ${revCwd}`);
}

// --- AB. Permission resolved summary in transcript end-to-end chain ------

console.log('\nAB1. Approval request: Allow path leaves expandable summary row');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };
	(broker as any).pending.clear?.();

	const reqId = 'req-ab1';
	const bashCmd = 'npm test --run';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Bash',
		input: { command: bashCmd, cwd: POLICY_VAULT.root },
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	check('AB1.1: permission item added to state as pending', item !== undefined && item.status === 'pending');

	// Real permission card DOM entry point
	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const permCard = createPermissionCard(cardContainer, dummyComp, item, {
		decide: (id, b, r) => broker.decide(id, b, undefined, undefined, r),
	});

	// Reader clicks Allow
	permCard.allowEl.click();
	eq('AB1.2: item status transitions to allowed', item.status, 'allowed');

	// Transcript message list sync
	const listWrapper = new FakeElement() as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	check('AB1.3: summary element rendered in message list', summaryContainer !== null);

	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB1.4: collapsed summary header exists', headerEl !== null);
	check('AB1.5: header text shows tool name, target, and allowed',
		Boolean(headerEl?.text?.includes('Bash') && headerEl?.text?.includes(bashCmd) && headerEl?.text?.includes('Allowed')));

	const contentEl = summaryContainer?.querySelector('.guki-perm-summary-content');
	check('AB1.6: detail content exists and starts hidden (collapsed)',
		Boolean(contentEl !== null && contentEl?.classList?.has('guki-hidden')));

	// Click to expand
	headerEl?.click();
	check('AB1.7: clicking header expands detail content',
		Boolean(contentEl !== null && !contentEl?.classList?.has('guki-hidden')));
	check('AB1.8: expanded detail shows tool, target, and decision',
		Boolean(contentEl?.text?.includes('Bash') && contentEl?.text?.includes(bashCmd) && contentEl?.text?.includes('Allowed')));

	// Click again to collapse
	headerEl?.click();
	check('AB1.9: clicking header again collapses detail content',
		Boolean(contentEl !== null && contentEl?.classList?.has('guki-hidden')));
}

console.log('AB2. Approval request: Deny path leaves denied summary row');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab2';
	const bashCmd = 'rm -rf /unwanted';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Bash',
		input: { command: bashCmd, cwd: POLICY_VAULT.root },
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const permCard = createPermissionCard(cardContainer, dummyComp, item, {
		decide: (id, b, r) => broker.decide(id, b, undefined, undefined, r),
	});

	// Reader clicks Deny
	permCard.denyEl.click();
	eq('AB2.1: item status transitions to denied', item.status, 'denied');

	const listWrapper = new FakeElement() as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB2.2: header shows denied outcome', Boolean(headerEl?.text?.includes('Denied')));
	check('AB2.3: row has guki-perm-summary-denied class',
		Boolean(summaryContainer?.querySelector('.guki-perm-summary-denied') !== null || summaryContainer?.classList?.has('guki-perm-summary-denied')));
}

console.log('AB3. Approval request: Cancelled path distinguishes turn ended from reader denial');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab3';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Write',
		input: { file_path: join(POLICY_VAULT.root, 'cancel-test.md'), content: 'hello' },
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;

	// Active turn stopped while card open
	broker.cancelPending('Turn stopped');
	eq('AB3.1: item status transitions to cancelled', item.status, 'cancelled');

	const listWrapper = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB3.2: cancelled outcome does NOT say Denied', !headerEl?.text?.includes('Denied'));
	check('AB3.3: cancelled outcome explicitly mentions not answered / turn ended',
		Boolean(headerEl?.text?.includes('Not answered') || headerEl?.text?.includes('turn ended') || headerEl?.text?.includes('Cancelled')));
	check('AB3.4: row has guki-perm-summary-cancelled class and not denied class',
		Boolean((summaryContainer?.querySelector('.guki-perm-summary-cancelled') !== null || summaryContainer?.classList?.has('guki-perm-summary-cancelled')) &&
		summaryContainer?.querySelector('.guki-perm-summary-denied') === null));
}

console.log('AB4. AskUserQuestion: Multi-question and "Other" free-text selection chain');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab4';
	const input = {
		questions: [
			{
				id: 'action',
				question: 'What do you want to do with this document?',
				header: 'Action',
				options: [
					{ label: 'Read', description: 'Read document content' },
					{ label: 'Edit', description: 'Modify document content' },
					{ label: 'Delete', description: 'Remove document permanently' },
				],
				multiSelect: false,
			},
			{
				id: 'destination',
				question: 'Where should the summary be saved?',
				header: 'Destination',
				options: [
					{ label: 'Vault root', description: 'Save in root' },
					{ label: 'Notes folder', description: 'Save in /notes' },
				],
				multiSelect: true,
			},
		],
	};

	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'AskUserQuestion',
		input,
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	check('AB4.1: item added as pending AskUserQuestion', item !== undefined && item.toolName === 'AskUserQuestion');

	// Mount AskUserQuestionInline DOM card
	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;

	const askCard = new AskUserQuestionInline(
		cardContainer,
		dummyComp,
		item,
		(answers) => {
			const decision = decideAskUserQuestion(item.input, answers);
			broker.decide(
				item.requestId,
				decision.behavior,
				undefined,
				decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : undefined,
			);
		},
	);

	// Reader clicks 'Edit' option on Tab 1
	const tab1Items = cardContainer.querySelectorAll('.guki-ask-item');
	const editOpt = tab1Items.find((el: any) => el.text.includes('Edit'));
	check('AB4.1a: Edit option element exists on Tab 1', editOpt !== undefined);
	editOpt.click();

	// Tab bar rendered tabs; verify Tab 2 navigation
	const tabs = cardContainer.querySelectorAll('.guki-ask-tab');
	check('AB4.1b: tab bar rendered tab buttons', tabs.length === 2);
	tabs[1].click();

	// Reader clicks 'Vault root' option on Tab 2
	const tab2Items = cardContainer.querySelectorAll('.guki-ask-item');
	const vaultOpt = tab2Items.find((el: any) => el.text.includes('Vault root'));
	check('AB4.1c: Vault root option exists on Tab 2', vaultOpt !== undefined);
	vaultOpt.click();

	// Reader enters custom free text into 'Other' input
	const inputEl = cardContainer.querySelector('input');
	check('AB4.1d: Other input element exists on Tab 2', inputEl !== null);
	inputEl.value = 'CustomArchiveDir';
	inputEl.listeners['input']?.({ target: inputEl });

	// Reader clicks Submit button
	const submitBtn = cardContainer.querySelector('.guki-ask-submit-btn');
	check('AB4.1e: submit button exists on Tab 2', submitBtn !== null);
	submitBtn.click();

	eq('AB4.2: item status is allowed', item.status, 'allowed');
	check('AB4.3: item captured answers on state object', (item as any).answers !== undefined);
	eq('AB4.4: action answer captured correctly', ((item as any).answers as any)?.action, 'Edit');
	check('AB4.5: destination answer includes custom text',
		Boolean(Array.isArray(((item as any).answers as any)?.destination) &&
		((item as any).answers as any)?.destination?.includes('Vault root') &&
		((item as any).answers as any)?.destination?.includes('CustomArchiveDir')));

	// Sync to message list
	const listWrapper = new FakeElement() as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	check('AB4.6: AskUserQuestion leaves summary element in message list', summaryContainer !== null);

	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB4.7: collapsed one-line header contains question and choice',
		Boolean(headerEl?.text?.includes('What do you want to do with this document?') && headerEl?.text?.includes('Edit')));

	const contentEl = summaryContainer?.querySelector('.guki-perm-summary-content');
	check('AB4.8: detail content exists and is initially collapsed',
		Boolean(contentEl !== null && contentEl?.classList?.has('guki-hidden')));

	// Expand detail
	headerEl?.click();
	check('AB4.9: clicking header expands detail content',
		Boolean(contentEl !== null && !contentEl?.classList?.has('guki-hidden')));

	// Check question 1 details: shows all options and which is selected
	check('AB4.10: detail contains question 1 text',
		Boolean(contentEl?.text?.includes('What do you want to do with this document?')));
	check('AB4.11: detail lists offered options Read, Edit, Delete',
		Boolean(contentEl?.text?.includes('Read') && contentEl?.text?.includes('Edit') && contentEl?.text?.includes('Delete')));
	check('AB4.12: detail identifies Edit as chosen',
		Boolean(contentEl?.text?.includes('✓ Edit') || contentEl?.querySelector('.is-selected')?.text?.includes('Edit')));

	// Check question 2 details: shows destination question and CustomArchiveDir custom text
	check('AB4.13: detail contains question 2 text and shows which answer belongs to which question',
		Boolean(contentEl?.text?.includes('Where should the summary be saved?')));
	check('AB4.14: detail includes custom free text Other entry',
		Boolean(contentEl?.text?.includes('CustomArchiveDir')));

	// Collapse again
	headerEl?.click();
	check('AB4.15: clicking header again collapses detail',
		Boolean(contentEl !== null && contentEl?.classList?.has('guki-hidden')));
}

console.log('AB5. AskUserQuestion: Deny path via Escape leaves denied summary');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab5';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'AskUserQuestion',
		input: {
			questions: [{ question: 'May I proceed?', options: [{ label: 'Yes' }] }],
		},
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;

	new AskUserQuestionInline(
		cardContainer,
		dummyComp,
		item,
		(answers) => {
			const decision = decideAskUserQuestion(item.input, answers);
			broker.decide(
				item.requestId,
				decision.behavior,
				undefined,
				decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : undefined,
			);
		},
	);

	// User presses Escape on card DOM element
	const inlineEl = cardContainer.querySelector('.guki-ask-question-inline');
	inlineEl.listeners['keydown']({ key: 'Escape', preventDefault: () => {} });
	eq('AB5.1: item status is denied', item.status, 'denied');

	const listWrapper = new FakeElement() as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB5.2: header shows question and Denied',
		Boolean(headerEl?.text?.includes('May I proceed?') && headerEl?.text?.includes('Denied')));
}

console.log('AB6. AskUserQuestion: Cancelled path leaves non-denied cancellation summary');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab6';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'AskUserQuestion',
		input: {
			questions: [{ question: 'Unanswered prompt question?', options: [{ label: 'Opt1' }] }],
		},
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;

	// Cancelled by turn stopping
	broker.cancelPending('Turn stopped');
	eq('AB6.1: item status is cancelled', item.status, 'cancelled');

	const listWrapper = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB6.2: header does not say Denied', !headerEl?.text?.includes('Denied'));
	check('AB6.3: header indicates not answered / turn ended',
		Boolean(headerEl?.text?.includes('Not answered') || headerEl?.text?.includes('turn ended') || headerEl?.text?.includes('Cancelled')));
}

console.log('AB7. Summary row preserves chronological conversation position');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	// 1. User message
	state.addUserMessage('Please run the test suite');

	// 2. Assistant turn begins with tool call block
	const asst = state.addAssistantMessage();
	const toolUseId = 'toolu-ab7';
	asst.blocks.set(0, {
		index: 0,
		kind: 'tool_use',
		text: '',
		final: true,
		toolUseId,
		toolName: 'Bash',
		toolInput: { command: 'npm test', cwd: POLICY_VAULT.root },
		toolPending: true,
	});

	// 3. Permission request arrives mid-turn with matching toolUseId
	const reqId = 'req-ab7';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Bash',
		tool_use_id: toolUseId,
		input: { command: 'npm test', cwd: POLICY_VAULT.root },
	});

	const listWrapper = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	// 4. Reader resolves request
	broker.decide(reqId, 'allow');

	// 5. The reply continues in the same turn
	asst.blocks.set(1, {
		index: 1,
		kind: 'text',
		text: 'All tests passed.',
		final: true,
	});
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission') ?? listWrapper.querySelector('.guki-perm-summary-block');
	const replyEl = listWrapper.querySelector('.guki-block-text');
	const scrollEl = (list as any).scrollEl as FakeElement;

	function isBeforeInDom(root: any, a: any, b: any): boolean {
		const order: any[] = [];
		const walk = (n: any) => {
			order.push(n);
			for (const child of n.children || []) walk(child);
		};
		walk(root);
		const idxA = order.indexOf(a);
		const idxB = order.indexOf(b);
		return idxA !== -1 && idxB !== -1 && idxA < idxB;
	}

	check('AB7.1: summary element and reply element are both rendered', summaryContainer !== null && replyEl !== null);
	check('AB7.2: summary element appears before the model reply in DOM order',
		isBeforeInDom(listWrapper, summaryContainer, replyEl));
	check('AB7.3: summary element is not pinned to the bottom of the transcript',
		!scrollEl.children[scrollEl.children.length - 1]?.classList.has('guki-message-permission'));
}

console.log('AB8. AskUserQuestion: Two questions with identical text and no id preserve separate answers');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab8';
	const input = {
		questions: [
			{
				question: 'Select mode',
				options: [
					{ label: 'Alpha', value: 'Alpha' },
					{ label: 'Beta', value: 'Beta' },
				],
				multiSelect: false,
			},
			{
				question: 'Select mode',
				options: [
					{ label: 'Alpha', value: 'Alpha' },
					{ label: 'Beta', value: 'Beta' },
				],
				multiSelect: false,
			},
		],
	};

	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'AskUserQuestion',
		input,
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	check('AB8.1: item added as pending AskUserQuestion', item !== undefined && item.toolName === 'AskUserQuestion');

	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;

	new AskUserQuestionInline(
		cardContainer,
		dummyComp,
		item,
		(answers) => {
			const decision = decideAskUserQuestion(item.input, answers);
			broker.decide(
				item.requestId,
				decision.behavior,
				undefined,
				decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : undefined,
			);
		},
	);

	// Question 1: Reader clicks 'Alpha'
	const tab1Opts = cardContainer.querySelectorAll('.guki-ask-item');
	const alphaOpt = tab1Opts.find((el: any) => el.text.includes('Alpha'));
	check('AB8.2: Alpha option exists on Question 1', alphaOpt !== undefined);
	alphaOpt.click();

	// Single select auto-advances to Question 2 (Tab 2)
	// Question 2: Reader clicks 'Beta'
	const tab2Opts = cardContainer.querySelectorAll('.guki-ask-item');
	const betaOpt = tab2Opts.find((el: any) => el.text.includes('Beta'));
	check('AB8.3: Beta option exists on Question 2', betaOpt !== undefined);
	betaOpt.click();

	// Single-select on last question automatically submits
	eq('AB8.4: item status transitions to allowed', item.status, 'allowed');
	check('AB8.5: item captured answers on state object', item.answers !== undefined);

	// Both distinct answers must be preserved in item.answers
	eq('AB8.6: question 1 answer is Alpha', item.answers?.['0'], 'Alpha');
	eq('AB8.7: question 2 answer is Beta', item.answers?.['1'], 'Beta');

	// Sync to message list
	const listWrapper = new FakeElement() as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	const summaryContainer = listWrapper.querySelector('.guki-message-permission');
	const headerEl = summaryContainer?.querySelector('.guki-perm-summary-header');
	check('AB8.8: collapsed header contains question 1 answer Alpha', Boolean(headerEl?.text?.includes('Alpha')));
	check('AB8.9: collapsed header contains question 2 answer Beta', Boolean(headerEl?.text?.includes('Beta')));

	const contentEl = summaryContainer?.querySelector('.guki-perm-summary-content');
	headerEl?.click();

	const questionsRendered = contentEl?.querySelectorAll('.guki-perm-summary-question');
	check('AB8.10: renders two separate question sections in detail', questionsRendered?.length === 2);
	check('AB8.11: first question detail marks Alpha as chosen and Beta as unchosen',
		Boolean(questionsRendered?.[0]?.text?.includes('✓ Alpha') && questionsRendered?.[0]?.text?.includes('○ Beta')));
	check('AB8.12: second question detail marks Beta as chosen and Alpha as unchosen',
		Boolean(questionsRendered?.[1]?.text?.includes('✓ Beta') && questionsRendered?.[1]?.text?.includes('○ Alpha')));
}

console.log('AB9. AskUserQuestion: Selection state, tab switching, and auto-submit on last tab');
{
	// 1. Defect-proving check: Answering last tab (Tab 2) before earlier tab (Tab 1)
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	const reqId = 'req-ab9-defect';
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'AskUserQuestion',
		input: {
			questions: [
				{
					question: 'Question 1',
					options: [{ label: 'Q1-A' }, { label: 'Q1-B' }],
					multiSelect: false,
				},
				{
					question: 'Question 2',
					options: [{ label: 'Q2-X' }, { label: 'Q2-Y' }],
					multiSelect: false,
				},
			],
		},
	});

	const item = state.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === reqId) as PermissionItem;
	const cardContainer = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	let decisionSubmitted: any = null;

	new AskUserQuestionInline(
		cardContainer,
		dummyComp,
		item,
		(answers) => {
			decisionSubmitted = answers;
			if (answers) {
				const decision = decideAskUserQuestion(item.input, answers);
				broker.decide(
					item.requestId,
					decision.behavior,
					undefined,
					decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : undefined,
				);
			}
		},
	);

	// Reader navigates directly to Tab 2 before answering Tab 1
	const tabs = cardContainer.querySelectorAll('.guki-ask-tab');
	check('AB9.1: Tab bar rendered 2 tabs', tabs.length === 2);
	tabs[1]?.click();

	// Reader clicks Option Q2-X on Tab 2
	const tab2Items = cardContainer.querySelectorAll('.guki-ask-item');
	const optX = tab2Items.find((el: any) => el.text.includes('Q2-X'));
	check('AB9.2: Option Q2-X element rendered on Tab 2', optX !== undefined);
	optX?.click();

	// Card must not have submitted yet since Tab 1 is unanswered
	check('AB9.3: Card does not falsely submit with Tab 1 unanswered', decisionSubmitted === null && item.status === 'pending');

	// DEFECT ASSERTIONS: Option must be highlighted, tab button marked answered, action button enabled
	const tab2ItemsAfterClick = cardContainer.querySelectorAll('.guki-ask-item');
	const selectedOptX = tab2ItemsAfterClick.find((el: any) => el.text.includes('Q2-X'));
	check(
		'AB9.4: Clicked option Q2-X has guki-ask-selected class in DOM',
		Boolean(selectedOptX?.hasClass('guki-ask-selected')),
		'Option was clicked on Tab 2 but guki-ask-selected was not applied because toggleOption returned early without re-rendering',
	);
	const updatedTabs = cardContainer.querySelectorAll('.guki-ask-tab');
	check(
		'AB9.5: Tab 2 tab button has guki-ask-answered class in DOM',
		Boolean(updatedTabs[1]?.hasClass('guki-ask-answered')),
		'Tab 2 was answered by reader click but guki-ask-answered was not applied to tab header',
	);
	const tab2SubmitBtn = cardContainer.querySelector('.guki-ask-submit-btn');
	check(
		'AB9.6: Tab 2 action button is enabled after answering',
		Boolean(tab2SubmitBtn && tab2SubmitBtn.disabled === false),
		'Tab 2 action button remained disabled after reader clicked option',
	);

	// Complete the flow: reader goes to Tab 1, selects Q1-A, then submits
	updatedTabs[0]?.click();
	const tab1Items = cardContainer.querySelectorAll('.guki-ask-item');
	const optA = tab1Items.find((el: any) => el.text.includes('Q1-A'));
	check('AB9.7: Option Q1-A element rendered on Tab 1', optA !== undefined);
	optA?.click();

	// After answering Tab 1, single-select advances to Tab 2 where both tabs are now answered
	const tabsAfterA = cardContainer.querySelectorAll('.guki-ask-tab');
	check('AB9.8: Tab 1 marked answered', Boolean(tabsAfterA[0]?.hasClass('guki-ask-answered')));
	const finalSubmitBtn = cardContainer.querySelector('.guki-ask-submit-btn');
	check('AB9.9: Submit button enabled when all questions answered', Boolean(finalSubmitBtn && finalSubmitBtn.disabled === false));
	finalSubmitBtn?.click();

	eq('AB9.10: item status allowed after full submission', item.status, 'allowed');
	check('AB9.11: answers captured on state object', item.answers !== undefined);
	eq('AB9.12: Question 1 answer is Q1-A', item.answers?.['0'], 'Q1-A');
	eq('AB9.13: Question 2 answer is Q2-X', item.answers?.['1'], 'Q2-X');

	// 2. Mirrored cases:
	// Case A: Clicking an option on an EARLIER tab while later tabs are unanswered
	// Case B: Clicking on the last tab when all others ARE answered (auto-submits)
	const mirrorState = new ChatState();
	const mirrorBroker = new PermissionBroker(brokerApp(readPaths), mirrorState, POLICY_VAULT.root);
	const mirrorReqId = 'req-ab9-mirror';
	(mirrorBroker as any).handleRequest(fakeSocket, {
		id: mirrorReqId,
		tool_name: 'AskUserQuestion',
		input: {
			questions: [
				{
					question: 'First Question',
					options: [{ label: 'First-1' }, { label: 'First-2' }],
					multiSelect: false,
				},
				{
					question: 'Second Question',
					options: [{ label: 'Second-1' }, { label: 'Second-2' }],
					multiSelect: false,
				},
			],
		},
	});

	const mirrorItem = mirrorState.items.find((i) => i.kind === 'permission' && (i as PermissionItem).requestId === mirrorReqId) as PermissionItem;
	const mirrorCardContainer = new FakeElement() as any;
	let mirrorSubmitted: any = null;

	new AskUserQuestionInline(
		mirrorCardContainer,
		dummyComp,
		mirrorItem,
		(answers) => {
			mirrorSubmitted = answers;
			if (answers) {
				const decision = decideAskUserQuestion(mirrorItem.input, answers);
				mirrorBroker.decide(
					mirrorItem.requestId,
					decision.behavior,
					undefined,
					decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : undefined,
				);
			}
		},
	);

	const mirrorTab1Items = mirrorCardContainer.querySelectorAll('.guki-ask-item');
	const firstOpt = mirrorTab1Items.find((el: any) => el.text.includes('First-1'));
	check('AB9.14: First-1 option exists on Tab 1', firstOpt !== undefined);

	// Reader clicks First-1 on Tab 1 (EARLIER tab, later tab unanswered)
	firstOpt?.click();

	const postClickTabs = mirrorCardContainer.querySelectorAll('.guki-ask-tab');
	// Should mark Tab 1 answered, advance to Tab 2, but NOT submit
	check('AB9.15: Tab 1 marked answered after option click', Boolean(postClickTabs[0]?.hasClass('guki-ask-answered')));
	check('AB9.16: auto-advances to Tab 2', Boolean(postClickTabs[1]?.hasClass('guki-ask-active')));
	check('AB9.17: card does not submit while later tabs are unanswered', mirrorSubmitted === null && mirrorItem.status === 'pending');

	// Now reader is on Tab 2 (the LAST tab) and Tab 1 IS answered
	const mirrorTab2Items = mirrorCardContainer.querySelectorAll('.guki-ask-item');
	const secondOpt = mirrorTab2Items.find((el: any) => el.text.includes('Second-1'));
	check('AB9.18: Second-1 option exists on Tab 2', secondOpt !== undefined);

	// Reader clicks Second-1 on Tab 2 (all others ARE answered)
	secondOpt?.click();

	// Must auto-submit as it does today!
	check('AB9.19: clicking last tab when all others are answered auto-submits', mirrorSubmitted !== null);
	eq('AB9.20: mirror item status is allowed', mirrorItem.status, 'allowed');
	eq('AB9.21: question 1 answer captured', mirrorItem.answers?.['0'], 'First-1');
	eq('AB9.22: question 2 answer captured', mirrorItem.answers?.['1'], 'Second-1');
}

console.log('AB10. Wire-contract: outgoing answers object keys are literal question strings');
{
	// The CLI handler keys answers on question.question (n[P] where P = question.question).
	// Any other key format — index, generated id — produces "The user did not answer the questions."
	// This check drives the real DOM path and asserts the exact outgoing wire payload for four cases.

	const fakeComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;

	// Case 1: Single question, option selected
	{
		let capturedAnswers: any = undefined;
		const q1Input = { questions: [{ question: 'What is your goal?', options: [{ label: 'Ship it' }, { label: 'Review it' }], multiSelect: false }] };
		const card1 = new FakeElement() as any;
		new AskUserQuestionInline(card1, fakeComp, { input: q1Input } as any, (ans) => { capturedAnswers = ans; });
		const opts1 = card1.querySelectorAll('.guki-ask-item');
		opts1.find((el: any) => el.text.includes('Ship it'))?.click();
		const decision1 = capturedAnswers !== undefined ? decideAskUserQuestion(q1Input, capturedAnswers) : null;
		const wire1 = decision1?.updatedInput?.answers as any;
		check('AB10.1: single question — wire key is question text', wire1 !== undefined && 'What is your goal?' in wire1);
		eq('AB10.2: single question — wire key is not "0"', '0' in (wire1 ?? {}), false);
		eq('AB10.3: single question — answer value correct', wire1?.['What is your goal?'], 'Ship it');
		console.log('AB10 case1 wire payload:', JSON.stringify({ answers: wire1 }));
	}

	// Case 2: Two questions, one option each
	{
		let capturedAnswers2: any = undefined;
		const q2Input = {
			questions: [
				{ question: 'Priority', options: [{ label: 'High' }, { label: 'Low' }], multiSelect: false },
				{ question: 'Mode', options: [{ label: 'Auto' }, { label: 'Manual' }], multiSelect: false },
			]
		};
		const card2 = new FakeElement() as any;
		new AskUserQuestionInline(card2, fakeComp, { input: q2Input } as any, (ans) => { capturedAnswers2 = ans; });
		const tab1opts = card2.querySelectorAll('.guki-ask-item');
		tab1opts.find((el: any) => el.text.includes('High'))?.click();
		// After single-select auto-advance to tab 2:
		const tab2opts = card2.querySelectorAll('.guki-ask-item');
		tab2opts.find((el: any) => el.text.includes('Auto'))?.click();
		const decision2 = capturedAnswers2 !== undefined ? decideAskUserQuestion(q2Input, capturedAnswers2) : null;
		const wire2 = decision2?.updatedInput?.answers as any;
		check('AB10.4: two questions — key 1 is question text', wire2 !== undefined && 'Priority' in wire2);
		check('AB10.5: two questions — key 2 is question text', wire2 !== undefined && 'Mode' in wire2);
		eq('AB10.6: two questions — no index key "0"', '0' in (wire2 ?? {}), false);
		eq('AB10.7: two questions — no index key "1"', '1' in (wire2 ?? {}), false);
		eq('AB10.8: two questions — answer 1 correct', wire2?.['Priority'], 'High');
		eq('AB10.9: two questions — answer 2 correct', wire2?.['Mode'], 'Auto');
		console.log('AB10 case2 wire payload:', JSON.stringify({ answers: wire2 }));
	}

	// Case 3: Multi-select answer (comma-separated per CLI schema)
	{
		let capturedAnswers3: any = undefined;
		const q3Input = { questions: [{ question: 'Pick features', options: [{ label: 'Search', value: 'search' }, { label: 'Export', value: 'export' }], multiSelect: true }] };
		const card3 = new FakeElement() as any;
		new AskUserQuestionInline(card3, fakeComp, { input: q3Input } as any, (ans) => { capturedAnswers3 = ans; });
		// Toggle both options
		const opts3 = card3.querySelectorAll('.guki-ask-item');
		opts3.find((el: any) => el.text.includes('Search'))?.click();
		opts3.find((el: any) => el.text.includes('Export'))?.click();
		// Multi-select: click bottom submit button explicitly
		const submitBtn3 = card3.querySelector('.guki-ask-submit-btn');
		submitBtn3?.click();
		const decision3 = capturedAnswers3 !== undefined ? decideAskUserQuestion(q3Input, capturedAnswers3) : null;
		const wire3 = decision3?.updatedInput?.answers as any;
		const multiAnswer = wire3?.['Pick features'];
		check('AB10.10: multi-select — key is question text', wire3 !== undefined && 'Pick features' in wire3);
		eq('AB10.11: multi-select — no index key "0"', '0' in (wire3 ?? {}), false);
		eq('AB10.12: multi-select — comma-separated string answer', multiAnswer, 'search, export');
		console.log('AB10 case3 wire payload:', JSON.stringify({ answers: wire3 }));
	}

	// Case 4: "Other" free-text answer
	{
		let capturedAnswers4: any = undefined;
		const q4Input = { questions: [{ question: 'Describe goal', options: [{ label: 'Opt A' }], multiSelect: false }] };
		const card4 = new FakeElement() as any;
		new AskUserQuestionInline(card4, fakeComp, { input: q4Input } as any, (ans) => { capturedAnswers4 = ans; });
		const inputEl4 = card4.querySelector('input');
		inputEl4?.listeners['focus']?.();
		inputEl4?.listeners['input']?.({ target: { value: 'my custom text' } });
		card4.querySelector('.guki-ask-submit-btn')?.click();
		const decision4 = capturedAnswers4 !== undefined ? decideAskUserQuestion(q4Input, capturedAnswers4) : null;
		const wire4 = decision4?.updatedInput?.answers as any;
		check('AB10.13: other free-text — key is question text', wire4 !== undefined && 'Describe goal' in wire4);
		eq('AB10.14: other free-text — no index key "0"', '0' in (wire4 ?? {}), false);
		eq('AB10.15: other free-text — value is the typed text', wire4?.['Describe goal'], 'my custom text');
		console.log('AB10 case4 wire payload:', JSON.stringify({ answers: wire4 }));
	}
}

console.log('AB11. Re-homing: late tool block moves summary out of fallback into tool block');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	// 1. User message
	state.addUserMessage('Please run the test suite');

	// 2. Assistant turn begins (no tool block yet)
	const asst = state.addAssistantMessage();
	const toolUseId = 'toolu-ab11';
	const reqId = 'req-ab11';

	// 3. Permission request arrives mid-turn BEFORE tool block exists in asst.blocks
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Bash',
		tool_use_id: toolUseId,
		input: { command: 'npm test', cwd: POLICY_VAULT.root },
	});

	const listWrapper = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	// 4. Reader resolves request BEFORE tool block exists in asst.blocks
	broker.decide(reqId, 'allow');
	list.sync(state.items); // Summary placed in fallback position (scrollEl)

	const scrollEl = (list as any).scrollEl as FakeElement;
	check('AB11.1: initially placed in fallback position before tool block arrives',
		scrollEl.children[scrollEl.children.length - 1]?.classList.has('guki-message-permission'));

	// 5. Tool block appears afterwards
	asst.blocks.set(0, {
		index: 0,
		kind: 'tool_use',
		text: '',
		final: true,
		toolUseId,
		toolName: 'Bash',
		toolInput: { command: 'npm test', cwd: POLICY_VAULT.root },
		toolPending: false,
	});

	// 6. Followed by reply
	asst.blocks.set(1, {
		index: 1,
		kind: 'text',
		text: 'All tests passed.',
		final: true,
	});
	list.sync(state.items); // Sync after tool block arrives: should re-home!

	const summaryContainer = listWrapper.querySelector('.guki-message-permission') ?? listWrapper.querySelector('.guki-perm-summary-block');
	const replyEl = listWrapper.querySelector('.guki-block-text');
	const allSummaries = listWrapper.querySelectorAll('.guki-perm-summary-block');

	function isBeforeInDom(root: any, a: any, b: any): boolean {
		const order: any[] = [];
		const walk = (n: any) => {
			order.push(n);
			for (const child of n.children || []) walk(child);
		};
		walk(root);
		const idxA = order.indexOf(a);
		const idxB = order.indexOf(b);
		return idxA !== -1 && idxB !== -1 && idxA < idxB;
	}

	check('AB11.2: summary element and reply element are both rendered', summaryContainer !== null && replyEl !== null);
	check('AB11.3: summary element appears before the model reply in DOM order',
		isBeforeInDom(listWrapper, summaryContainer, replyEl));
	check('AB11.4: summary element is not pinned to the bottom of the transcript',
		!scrollEl.children[scrollEl.children.length - 1]?.classList.has('guki-message-permission'));
	check('AB11.5: re-homing does not duplicate the summary', allSummaries.length === 1);
}

console.log('AB12. Re-homing: expanded state and click handler survive re-homing');
{
	const state = new ChatState();
	const readPaths: string[] = [];
	const broker = new PermissionBroker(brokerApp(readPaths), state, POLICY_VAULT.root);
	const fakeSocket = { write: () => {} };

	// 1. User message
	state.addUserMessage('Run another command');

	// 2. Assistant message created without tool block
	const asst = state.addAssistantMessage();
	const toolUseId = 'toolu-ab12';
	const reqId = 'req-ab12';

	// 3. Permission request arrives
	(broker as any).handleRequest(fakeSocket, {
		id: reqId,
		tool_name: 'Bash',
		tool_use_id: toolUseId,
		input: { command: 'git status', cwd: POLICY_VAULT.root },
	});

	const listWrapper = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	const list = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
	list.sync(state.items);

	// 4. Request is RESOLVED first
	broker.decide(reqId, 'allow');
	list.sync(state.items);

	const summaryBlockFallback = listWrapper.querySelector('.guki-perm-summary-block');
	const contentElFallback = listWrapper.querySelector('.guki-perm-summary-content');
	const headerBtnFallback = listWrapper.querySelector('.guki-perm-summary-header');

	check('AB12.1: summary starts collapsed in fallback position',
		summaryBlockFallback !== null &&
		!summaryBlockFallback.hasClass('guki-perm-summary-open') &&
		contentElFallback.hasClass('guki-hidden'));

	// 5. Reader expands the summary while in fallback position
	headerBtnFallback.click();
	check('AB12.2: reader expanded summary while in fallback position',
		summaryBlockFallback.hasClass('guki-perm-summary-open') &&
		!contentElFallback.hasClass('guki-hidden'));

	// 6. Tool block arrives afterwards
	asst.blocks.set(0, {
		index: 0,
		kind: 'tool_use',
		text: '',
		final: true,
		toolUseId,
		toolName: 'Bash',
		toolInput: { command: 'git status', cwd: POLICY_VAULT.root },
		toolPending: false,
	});
	// Followed by reply
	asst.blocks.set(1, {
		index: 1,
		kind: 'text',
		text: 'On branch main, working tree clean.',
		final: true,
	});
	list.sync(state.items);

	const summaryBlockAfter = listWrapper.querySelector('.guki-perm-summary-block');
	const contentElAfter = listWrapper.querySelector('.guki-perm-summary-content');
	const headerBtnAfter = listWrapper.querySelector('.guki-perm-summary-header');

	// 7. Summary is still expanded afterwards
	check('AB12.3: summary remains expanded after re-homing to tool block',
		summaryBlockAfter !== null &&
		summaryBlockAfter.hasClass('guki-perm-summary-open') &&
		!contentElAfter.hasClass('guki-hidden'));

	// 8. Still responds to a click: collapses on click
	headerBtnAfter.click();
	check('AB12.4: summary collapses on click after re-homing',
		!summaryBlockAfter.hasClass('guki-perm-summary-open') &&
		contentElAfter.hasClass('guki-hidden'));

	// 9. Expands again on second click
	headerBtnAfter.click();
	check('AB12.5: summary re-expands on second click after re-homing',
		summaryBlockAfter.hasClass('guki-perm-summary-open') &&
		!contentElAfter.hasClass('guki-hidden'));
}

console.log('AB13. Multi-question card: tab bar contains only question tabs and no dead submit leftover');
{
	const multiInput = {
		questions: [
			{ question: 'İçecek ne istersin?', header: 'İçecek', options: [{ label: 'Çay' }, { label: 'Kahve' }] },
			{ question: 'Boş zaman aktivitesi?', header: 'Boş zaman', options: [{ label: 'Kitap' }, { label: 'Yürüyüş' }] },
		],
	};
	const card = new FakeElement() as any;
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;
	new AskUserQuestionInline(card, dummyComp, { input: multiInput } as any, () => {});

	const tabBar = card.querySelector('.guki-ask-tab-bar');
	check('AB13.1: tab bar element exists and is not hidden', tabBar !== null && !tabBar.hasClass('guki-hidden'));

	const tabs = tabBar ? tabBar.children : [];
	eq('AB13.2: tab bar contains exactly 2 question tabs', tabs.length, 2);
	check('AB13.3: every tab bar child is a .guki-ask-tab element',
		tabs.every((c: any) => c.tag === 'div' && c.hasClass('guki-ask-tab')));
	check('AB13.4: no tab bar child has empty text content',
		tabs.every((c: any) => typeof c.text === 'string' && c.text.trim().length > 0));
	eq('AB13.5: tab 0 header is İçecek', tabs[0]?.text, 'İçecek');
	eq('AB13.6: tab 1 header is Boş zaman', tabs[1]?.text, 'Boş zaman');

	// Also check 3-question case
	const multi3Input = {
		questions: [
			{ question: 'Q1?', header: 'Tab1' },
			{ question: 'Q2?', header: 'Tab2' },
			{ question: 'Q3?', header: 'Tab3' },
		],
	};
	const card3 = new FakeElement() as any;
	new AskUserQuestionInline(card3, dummyComp, { input: multi3Input } as any, () => {});
	const tabBar3 = card3.querySelector('.guki-ask-tab-bar');
	const tabs3 = tabBar3 ? tabBar3.children : [];
	eq('AB13.7: 3-question tab bar contains exactly 3 question tabs', tabs3.length, 3);
	check('AB13.8: no extra or empty-text elements in 3-question tab bar',
		tabs3.every((c: any) => c.tag === 'div' && c.hasClass('guki-ask-tab') && c.text.trim().length > 0));

	// Stylesheet leftover verification: styles.css must not contain the removed top submit control rules
	const stylesCss = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');
	check('AB13.9: styles.css contains no leftover .guki-ask-tab-submit rule',
		!stylesCss.includes('.guki-ask-tab-submit'),
		'styles.css still contains .guki-ask-tab-submit rule leftover from removed top submit control');
}

// --- AC. Composer dropdown: slash commands and mentions -------------------

console.log('\nAC0. Prompt history data layer');
{
	const first = appendPromptHistory([], 'first prompt', PROMPT_HISTORY_CAP);
	check('AC0.1: append to an empty prompt history creates one entry', first.length === 1 && first[0] === 'first prompt');

	const whitespace = appendPromptHistory(['kept'], '   ', PROMPT_HISTORY_CAP);
	check('AC0.2: whitespace-only prompt leaves history unchanged', whitespace.length === 1 && whitespace[0] === 'kept');

	const duplicate = appendPromptHistory(['kept'], 'kept', PROMPT_HISTORY_CAP);
	check('AC0.3: newest duplicate prompt leaves history unchanged', duplicate.length === 1 && duplicate[0] === 'kept');

	const nonAdjacentDuplicate = appendPromptHistory(['repeat', 'other'], 'repeat', PROMPT_HISTORY_CAP);
	check('AC0.4: non-adjacent duplicate prompt is recorded', nonAdjacentDuplicate.join('|') === 'repeat|other|repeat');

	// The stored value is the trimmed one, so a padded repeat of the newest entry is still a
	// duplicate. Without the trim it would be stored a second time, padding and all.
	const paddedDuplicate = appendPromptHistory(['kept'], '  kept  ', PROMPT_HISTORY_CAP);
	check('AC0.4b: padded repeat of the newest prompt is still a duplicate', paddedDuplicate.length === 1 && paddedDuplicate[0] === 'kept');

	const fullHistory = Array.from({ length: PROMPT_HISTORY_CAP }, (_, index) => `prompt-${String(index)}`);
	const capped = appendPromptHistory(fullHistory, 'newest', PROMPT_HISTORY_CAP);
	check('AC0.5: prompt history cap drops oldest and keeps newest',
		capped.length === PROMPT_HISTORY_CAP && capped[0] === 'prompt-1' && capped[capped.length - 1] === 'newest');
}

console.log('\nAC1. Mandatory end-to-end chain check (simulated keystrokes on real composer input path)');
{
	if (typeof (globalThis as any).ResizeObserver === 'undefined') {
		(globalThis as any).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}

	const testVaultFiles = [
		Object.assign(new TFile(), { path: 'notes/alpha.md', name: 'alpha.md' }),
		Object.assign(new TFile(), { path: 'notes/beta.md', name: 'beta.md' }),
		Object.assign(new TFile(), { path: 'notes/gamma.md', name: 'gamma.md' }),
		Object.assign(new TFile(), { path: 'notes/bad"quote.md', name: 'bad"quote.md' }),
		Object.assign(new TFile(), { path: 'outside/secret.md', name: 'secret.md' }),
	];
	const testVaultAdapter = new FileSystemAdapter();
	testVaultAdapter.getBasePath = () => POLICY_VAULT.root;
	testVaultAdapter.getFullPath = (p: string) => {
		if (p.startsWith('outside/')) {
			return `${POLICY_VAULT.outside}/${p.slice('outside/'.length)}`;
		}
		return `${POLICY_VAULT.root}/${p}`;
	};
	const testApp = {
		vault: {
			adapter: testVaultAdapter,
			getFiles: () => testVaultFiles,
		},
	} as any;

	const slashCommands = ['clear', 'help', 'orchestrate'];
	let submittedText = '';
	let submitCallCount = 0;
	let promptHistory = ['older prompt', 'newest prompt'];

	const container = new FakeElement() as any;
	const panel = new FakeElement() as any;
	const dummyComp = {
		registerDomEvent: (el: any, evt: string, cb: any) => {
			if (el?.addEventListener) el.addEventListener(evt, cb);
		},
	} as any;

	const composer = new Composer(container, panel, dummyComp, {
		app: testApp,
		getSlashCommands: () => slashCommands,
		getVaultPaths: () => Promise.resolve(vaultPaths),
		getPromptHistory: () => promptHistory,
		onPromptRecorded: (text: string) => {
			promptHistory = appendPromptHistory(promptHistory, text, PROMPT_HISTORY_CAP);
		},
		onSubmit: (text: string) => {
			submittedText = text;
			submitCallCount++;
			return true;
		},
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});

	const inputEl = container.querySelector('textarea');
	check('AC1.0: composer textarea element exists', inputEl !== null);

	function simulateInput(value: string, cursor?: number) {
		inputEl.value = value;
		const pos = cursor ?? value.length;
		inputEl.selectionStart = pos;
		inputEl.selectionEnd = pos;
		inputEl.listeners['input']?.();
	}

	function simulateKeydown(key: string, opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {}) {
		let prevented = false;
		const event = {
			key,
			shiftKey: !!opts.shiftKey,
			metaKey: !!opts.metaKey,
			ctrlKey: !!opts.ctrlKey,
			isComposing: !!opts.isComposing,
			preventDefault: () => { prevented = true; },
		};
		inputEl.listeners['keydown']?.(event);
		return { defaultPrevented: prevented };
	}

	// FIX 2a / regression check for FIX 1:
	// First mention keystroke after construction — boundary check must be in force.
	// Fail closed: if vault paths are not known yet, out-of-vault candidate must not be insertable.
	simulateInput('@secret', 7);
	const tabResFirstKeystroke = simulateKeydown('Tab');
	check('FIX2a: boundary check is in force on first mention keystroke after construction (out-of-vault candidate not insertable)',
		!tabResFirstKeystroke.defaultPrevented && !inputEl.value.includes(POLICY_VAULT.outside) && !inputEl.value.includes('secret.md'),
		`got value: ${inputEl.value}, defaultPrevented: ${tabResFirstKeystroke.defaultPrevented}`);

	// FIX 2b: After vault paths promise resolves, out-of-vault candidate is not insertable
	await Promise.resolve();
	inputEl.value = '';
	simulateInput('@secret', 7);
	const tabResOut = simulateKeydown('Tab');
	check('FIX2b: an out-of-vault candidate is not insertable',
		!tabResOut.defaultPrevented && !inputEl.value.includes(POLICY_VAULT.outside) && !inputEl.value.includes('secret.md'),
		`got value: ${inputEl.value}, defaultPrevented: ${tabResOut.defaultPrevented}`);

	// FIX 2c: In-vault candidate still is insertable (inverse check)
	inputEl.value = '';
	simulateInput('@gamma', 6);
	const tabResIn = simulateKeydown('Tab');
	check('FIX2c: an in-vault candidate still is insertable',
		tabResIn.defaultPrevented && inputEl.value.includes(`@"${POLICY_VAULT.root}/notes/gamma.md"`),
		`got value: ${inputEl.value}, defaultPrevented: ${tabResIn.defaultPrevented}`);

	inputEl.value = '';

	// a) @ + query + ArrowDown + Tab -> textarea contains @"<abs path>" for the second match, with whitespace before the @
	simulateInput('@notes', 6);
	const downResA = simulateKeydown('ArrowDown');
	check('AC1.1a: ArrowDown intercepted with preventDefault', downResA.defaultPrevented);
	const tabResA = simulateKeydown('Tab');
	check('AC1.1b: Tab intercepted with preventDefault', tabResA.defaultPrevented);
	const expectedBetaRef = `@"${POLICY_VAULT.root}/notes/beta.md"`;
	check('AC1.1c: textarea contains second match reference', inputEl.value.includes(expectedBetaRef), `got: ${inputEl.value}`);
	check('AC1.1d: whitespace or start-of-text immediately before @',
		inputEl.value.startsWith(expectedBetaRef) || inputEl.value.includes(` ${expectedBetaRef}`),
		`got: ${inputEl.value}`);

	// b) The same insertion performed when the caret directly follows a non-whitespace character -> result still has whitespace before @
	inputEl.value = 'hello';
	simulateInput('hello@notes', 11);
	const tabResB = simulateKeydown('Tab');
	check('AC1.2a: Tab intercepted with preventDefault', tabResB.defaultPrevented);
	const expectedAlphaRef = `@"${POLICY_VAULT.root}/notes/alpha.md"`;
	eq('AC1.2b: result has whitespace before @ (invariant 6)', inputEl.value, `hello ${expectedAlphaRef}`);

	// FIX 3: Structural whitespace invariant at insertion point
	const testDirectInput = new FakeElement() as any;
	testDirectInput.value = 'hello@query';
	testDirectInput.selectionStart = 11;
	testDirectInput.selectionEnd = 11;
	const matchStructural: TriggerMatch = {
		kind: 'mention',
		start: 5,
		end: 11,
		query: 'query',
	};
	const itemWithoutFlag: DropdownItem = {
		id: 'test',
		label: 'test',
		insertText: `@"${POLICY_VAULT.root}/notes/alpha.md"`,
		needsPrecedingSpace: false,
	};
	insertItem(testDirectInput, itemWithoutFlag, matchStructural);
	eq('FIX3: structural whitespace invariant enforced at insertion point without convention flag',
		testDirectInput.value,
		`hello @"${POLICY_VAULT.root}/notes/alpha.md"`);

	// Insertion with caret immediately after non-whitespace character via simulated input
	inputEl.value = 'review';
	simulateInput('review@alpha', 12);
	const tabResStructural = simulateKeydown('Tab');
	check('FIX3b: insertion with caret immediately after non-whitespace character preserves whitespace invariant',
		tabResStructural.defaultPrevented && inputEl.value === `review @"${POLICY_VAULT.root}/notes/alpha.md"`,
		`got: ${inputEl.value}`);

	// c) / + query + Enter -> textarea contains /command and no message was submitted
	submitCallCount = 0;
	submittedText = '';
	simulateInput('/or', 3);
	const enterResC = simulateKeydown('Enter');
	check('AC1.3a: Enter intercepted with preventDefault when dropdown open', enterResC.defaultPrevented);
	eq('AC1.3b: no message submitted', submitCallCount, 0);
	eq('AC1.3c: textarea contains /command with single trailing space', inputEl.value, '/orchestrate ');

	// d) With no dropdown open: Enter still submits, and Tab is not swallowed
	inputEl.value = 'hello world';
	simulateInput('hello world', 11);
	const tabResD = simulateKeydown('Tab');
	check('AC1.4a: Tab is not swallowed when no dropdown open', !tabResD.defaultPrevented);
	const enterResD = simulateKeydown('Enter');
	check('AC1.4b: Enter prevents default when submitting message', enterResD.defaultPrevented);
	eq('AC1.4c: Enter submitted message when no dropdown open', submitCallCount, 1);
	eq('AC1.4d: submitted text is hello world', submittedText, 'hello world');

	// e) A file whose attachmentReference() returns null is not insertable
	simulateInput('@bad', 4);
	const dropdownEl = container.querySelector('.guki-composer-dropdown');
	const badItem = dropdownEl ? dropdownEl.querySelectorAll('.guki-composer-dropdown-item').find((el: any) => el.text.includes('bad"quote')) : null;
	check('AC1.5: file with quotes returning null from attachmentReference is not in dropdown', badItem === null || badItem === undefined);

	// Prompt history navigation uses this same real Composer instance and its real key handler.
	promptHistory = ['older prompt', 'newest prompt'];
	simulateInput('');
	const historyFixtureDown = simulateKeydown('ArrowDown');
	if (
		promptHistory.length !== 2 ||
		promptHistory[0] !== 'older prompt' ||
		promptHistory[1] !== 'newest prompt' ||
		inputEl.value !== '' ||
		historyFixtureDown.defaultPrevented
	) {
		throw new Error('AC1 prompt history fixture must start inactive with exactly older and newest prompts');
	}
	const historyUp = simulateKeydown('ArrowUp');
	check('AC1.6: empty box plus Up recalls the newest submitted prompt',
		historyUp.defaultPrevented && inputEl.value === 'newest prompt');

	simulateInput('x');
	const nonEmptyUp = simulateKeydown('ArrowUp');
	check('AC1.7: non-empty box plus Up leaves text and default behavior alone',
		!nonEmptyUp.defaultPrevented && inputEl.value === 'x');

	simulateInput('');
	const inactiveDown = simulateKeydown('ArrowDown');
	check('AC1.8: empty box plus inactive Down is not intercepted',
		!inactiveDown.defaultPrevented && inputEl.value === '');

	simulateInput('');
	simulateKeydown('ArrowUp');
	const secondHistoryUp = simulateKeydown('ArrowUp');
	check('AC1.9: second Up while navigating recalls the older prompt',
		secondHistoryUp.defaultPrevented && inputEl.value === 'older prompt');

	const oldestUp = simulateKeydown('ArrowUp');
	check('AC1.10: Up at the oldest prompt leaves it unchanged',
		oldestUp.defaultPrevented && inputEl.value === 'older prompt');

	simulateKeydown('ArrowDown');
	simulateKeydown('ArrowDown');
	const afterNewestDown = simulateKeydown('ArrowDown');
	check('AC1.11: Down past newest clears and deactivates prompt navigation',
		inputEl.value === '' && !afterNewestDown.defaultPrevented);

	simulateKeydown('ArrowUp');
	simulateInput('edited recalled prompt');
	const editedUp = simulateKeydown('ArrowUp');
	check('AC1.12: typing while navigating returns Up to the empty-box gate',
		!editedUp.defaultPrevented && inputEl.value === 'edited recalled prompt');

	promptHistory = ['older prompt', 'multi\nline prompt'];
	simulateInput('');
	simulateKeydown('ArrowUp');
	inputEl.selectionStart = inputEl.value.length;
	inputEl.selectionEnd = inputEl.value.length;
	const multilineLastLineUp = simulateKeydown('ArrowUp');
	check('AC1.13: Up on a recalled multi-line prompt last line is ordinary caret movement',
		!multilineLastLineUp.defaultPrevented && inputEl.value === 'multi\nline prompt');

	inputEl.selectionStart = 0;
	inputEl.selectionEnd = 0;
	const multilineFirstLineUp = simulateKeydown('ArrowUp');
	check('AC1.14: Up on a recalled multi-line prompt first line recalls older history',
		multilineFirstLineUp.defaultPrevented && inputEl.value === 'older prompt');

	simulateInput('/');
	simulateKeydown('ArrowDown');
	const selectedBeforeHistoryGuard = container.querySelector('.guki-selected');
	const dropdownUp = simulateKeydown('ArrowUp');
	const selectedAfterHistoryGuard = container.querySelector('.guki-selected');
	check('AC1.15: slash dropdown owns Up before prompt history can handle it',
		dropdownUp.defaultPrevented && selectedBeforeHistoryGuard !== selectedAfterHistoryGuard && inputEl.value === '/');

	promptHistory = ['older prompt'];
	simulateInput('just submitted');
	simulateKeydown('Enter');
	const submittedHistoryUp = simulateKeydown('ArrowUp');
	check('AC1.16: submit resets navigation so Up recalls the prompt just submitted',
		submittedHistoryUp.defaultPrevented && inputEl.value === 'just submitted');
}

console.log('\nAC1b. Prompt history persistence store');
{
	const nonArrayStore = new PromptHistoryStore('not an array' as any, async () => {});
	const filteredStore = new PromptHistoryStore(['kept', '', 3 as any], async () => {});
	check('AC1b.17: prompt history store rejects non-array initial data and invalid array entries',
		nonArrayStore.list().length === 0 && filteredStore.list().length === 1 && filteredStore.list()[0] === 'kept');

	const savedLists: string[][] = [];
	const store = new PromptHistoryStore([], async (list) => {
		savedLists.push(list);
	});
	await store.record('saved prompt');
	const snapshot = store.snapshot();
	snapshot.push('tampered');
	check('AC1b.18: record saves and snapshot mutation cannot corrupt prompt history',
		savedLists.length === 1 && store.list().length === 1 && store.list()[0] === 'saved prompt');
}

console.log('\nAC2. Slash command catalogue plumbing and behavior');
{
	// Cold start: empty catalogue opens no dropdown
	const container = new FakeElement() as any;
	const panel = new FakeElement() as any;
	const dummyComp = {
		registerDomEvent: (el: any, evt: string, cb: any) => {
			if (el?.addEventListener) el.addEventListener(evt, cb);
		},
	} as any;

	const composer = new Composer(container, panel, dummyComp, {
		getSlashCommands: () => [],
		onSubmit: () => true,
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});
	const inputEl = container.querySelector('textarea');
	inputEl.value = '/';
	inputEl.selectionStart = 1;
	inputEl.selectionEnd = 1;
	inputEl.listeners['input']?.();

	const dropdownEl = container.querySelector('.guki-composer-dropdown');
	check('AC2.1: cold start with empty catalogue opens no dropdown',
		dropdownEl === null || dropdownEl.hasClass('guki-hidden') || dropdownEl.children.length === 0);

	// Slash not at start of text opens nothing
	let commandsList = ['clear', 'help', 'orchestrate'];
	const composerWithCommands = new Composer(container, panel, dummyComp, {
		getSlashCommands: () => commandsList,
		onSubmit: () => true,
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});
	const inputEl2 = container.querySelectorAll('textarea').slice(-1)[0];
	inputEl2.value = 'hello /or';
	inputEl2.selectionStart = 9;
	inputEl2.selectionEnd = 9;
	inputEl2.listeners['input']?.();
	const dropdownEl2 = container.querySelectorAll('.guki-composer-dropdown').slice(-1)[0];
	check('AC2.2: slash not at start of text opens nothing',
		dropdownEl2 === null || dropdownEl2 === undefined || dropdownEl2.hasClass('guki-hidden') || dropdownEl2.children.length === 0);
}

console.log('\nAC3. Keyboard contract & Escape while dropdown is open');
{
	const testVaultFiles = [
		Object.assign(new TFile(), { path: 'notes/alpha.md', name: 'alpha.md' }),
		Object.assign(new TFile(), { path: 'notes/beta.md', name: 'beta.md' }),
	];
	const testVaultAdapter = new FileSystemAdapter();
	testVaultAdapter.getBasePath = () => POLICY_VAULT.root;
	testVaultAdapter.getFullPath = (p: string) => `${POLICY_VAULT.root}/${p}`;
	const testApp = {
		vault: {
			adapter: testVaultAdapter,
			getFiles: () => testVaultFiles,
		},
	} as any;

	const container = new FakeElement() as any;
	const panel = new FakeElement() as any;
	const dummyComp = {
		registerDomEvent: (el: any, evt: string, cb: any) => {
			if (el?.addEventListener) el.addEventListener(evt, cb);
		},
	} as any;

	const composer = new Composer(container, panel, dummyComp, {
		app: testApp,
		getSlashCommands: () => ['clear'],
		getVaultPaths: () => Promise.resolve(vaultPaths),
		onSubmit: () => true,
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});
	await Promise.resolve();
	const inputEl = container.querySelector('textarea');
	inputEl.value = '@';
	inputEl.selectionStart = 1;
	inputEl.selectionEnd = 1;
	inputEl.listeners['input']?.();

	// Escape closes dropdown with preventDefault
	let escapePrevented = false;
	inputEl.listeners['keydown']?.({
		key: 'Escape',
		isComposing: false,
		preventDefault: () => { escapePrevented = true; },
	});
	check('AC3.1: Escape calls preventDefault when dropdown open', escapePrevented);
	const dropdownEl = container.querySelector('.guki-composer-dropdown');
	check('AC3.2: dropdown is closed after Escape',
		dropdownEl === null || dropdownEl.hasClass('guki-hidden') || dropdownEl.children.length === 0);

	// Escape does not preventDefault when dropdown is closed
	let escapePreventedClosed = false;
	inputEl.listeners['keydown']?.({
		key: 'Escape',
		isComposing: false,
		preventDefault: () => { escapePreventedClosed = true; },
	});
	check('AC3.3: Escape does not prevent default when dropdown is closed', !escapePreventedClosed);

	// IME isComposing is ignored
	inputEl.value = '@';
	inputEl.selectionStart = 1;
	inputEl.selectionEnd = 1;
	inputEl.listeners['input']?.();
	let imePrevented = false;
	inputEl.listeners['keydown']?.({
		key: 'Enter',
		isComposing: true,
		preventDefault: () => { imePrevented = true; },
	});
	check('AC3.4: isComposing ignores Enter (does not preventDefault or select)', !imePrevented);
}

console.log('\nAC4. Mention ranking: filename matches before path-only matches');
{
	const pathOnlyFile = Object.assign(new TFile(), {
		path: 'draftcvsas/unrelated.md',
		name: 'unrelated.md',
	});
	const nameMatchFile = Object.assign(new TFile(), {
		path: 'notes/draft-cvs-as.md',
		name: 'draft-cvs-as.md',
	});
	const testVaultAdapter = new FileSystemAdapter();
	testVaultAdapter.getBasePath = () => POLICY_VAULT.root;
	testVaultAdapter.getFullPath = (p: string) => `${POLICY_VAULT.root}/${p}`;
	const testApp = {
		vault: {
			adapter: testVaultAdapter,
			getFiles: () => [pathOnlyFile, nameMatchFile],
		},
	} as any;

	const items = filterVaultFiles(testApp, vaultPaths, 'draftcvsas', false);
	check('AC4.1: filename match ranks before path-only match',
		items.length >= 2 && items[0]?.label === 'notes/draft-cvs-as.md' && items[1]?.label === 'draftcvsas/unrelated.md',
		`got: ${items.map((i) => i.label).join(', ')}`);
}

console.log('\nAD. Completed turn work group: collapsed intermediate work with MM:SS header');
{
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el.addEventListener(evt, cb) } as any;

	// (a) Completed turn with thinking + two tool calls + a final answer
	const listWrapperA = new FakeElement() as any;
	const listA = new MessageList({} as any, listWrapperA, dummyComp, { decide: () => {} } as any);
	const itemA: AssistantItem = {
		id: 'asst-1',
		kind: 'assistant',
		status: 'complete',
		meta: {
			durationMs: 67000, // 1:07
		},
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking prose', final: true, startedAt: 1000, endedAt: 3000 }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 'tool-1', toolPending: false }],
			[2, { index: 2, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolUseId: 'tool-2', toolPending: false }],
			[3, { index: 3, kind: 'text', text: 'Final answer.', final: true }],
		]),
	};
	listA.sync([itemA]);

	const msgElA = listWrapperA.querySelector('.guki-message-assistant');
	const bodyElA = msgElA?.querySelector('.guki-message-body');
	check('AD1.1: assistant body element exists', bodyElA !== null);

	const workGroupA = bodyElA?.querySelector('.guki-work-group');
	check('AD1.2: work group wrapper created for completed turn with work blocks', workGroupA !== null);

	const headerElA = workGroupA?.querySelector('.guki-work-header');
	check('AD1.3: work header button created', Boolean(headerElA && headerElA.tag === 'button'));
	eq('AD1.4: header text shows Worked for 1:07', headerElA?.text?.trim(), 'Worked for 1:07');
	eq('AD1.5: header aria-expanded starts false', headerElA?.getAttribute('aria-expanded'), 'false');

	const contentElA = workGroupA?.querySelector('.guki-work-content');
	check('AD1.6: work content container exists', contentElA !== null);
	check('AD1.7: work content container starts hidden (collapsed)', Boolean(contentElA?.hasClass('guki-hidden')));

	// Check elements inside .guki-work-content
	eq('AD1.8: work-content holds exactly 3 intermediate work blocks', contentElA?.children?.length ?? 0, 3);
	check('AD1.9: thinking block ended up inside work-content', Boolean(contentElA?.children?.[0]?.hasClass('guki-block-thinking')));
	check('AD1.10: first tool_use block ended up inside work-content', Boolean(contentElA?.children?.[1]?.hasClass('guki-block-tool_use')));
	check('AD1.11: second tool_use block ended up inside work-content', Boolean(contentElA?.children?.[2]?.hasClass('guki-block-tool_use')));

	// Check elements outside .guki-work-content
	const directChildrenA = bodyElA?.children ?? [];
	check('AD1.12: work group is in bodyEl before the answer text block',
		directChildrenA[0] === workGroupA && directChildrenA[1]?.hasClass('guki-block-text'));
	check('AD1.13: answer text block stayed outside work-content as direct child of bodyEl',
		directChildrenA.some((c: any) => c.hasClass('guki-block-text')));
	check('AD1.14: answer text block is not inside work-content',
		!(contentElA?.children ?? []).some((c: any) => c.hasClass('guki-block-text')));

	// Check toggle expand/collapse on click
	headerElA?.click();
	eq('AD1.15: clicking header sets aria-expanded to true', headerElA?.getAttribute('aria-expanded'), 'true');
	check('AD1.16: clicking header shows work content', Boolean(contentElA && !contentElA.hasClass('guki-hidden')));

	// (b) Idempotency: sync() called twice on the same item while expanded
	listA.sync([itemA]);
	const groupsAfterSecondSync = (bodyElA?.children ?? []).filter((c: any) => c.hasClass('guki-work-group'));
	eq('AD2.1: sync twice does not create a second wrapper', groupsAfterSecondSync.length, 1);
	eq('AD2.2: sync twice does not reset expanded group back to collapsed', headerElA?.getAttribute('aria-expanded'), 'true');
	check('AD2.3: work content remains visible after second sync', Boolean(contentElA && !contentElA.hasClass('guki-hidden')));
	eq('AD2.4: work content blocks not duplicated after second sync', contentElA?.children?.length ?? 0, 3);

	// Click again to collapse
	headerElA?.click();
	eq('AD2.5: clicking header again collapses group (aria-expanded false)', headerElA?.getAttribute('aria-expanded'), 'false');
	check('AD2.6: work content hidden after collapsing again', Boolean(contentElA?.hasClass('guki-hidden')));

	// (c) Turn with only an answer and no work blocks (no group created)
	const listWrapperC = new FakeElement() as any;
	const listC = new MessageList({} as any, listWrapperC, dummyComp, { decide: () => {} } as any);
	const itemC: AssistantItem = {
		id: 'asst-c',
		kind: 'assistant',
		status: 'complete',
		meta: { durationMs: 45000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'text', text: 'Direct reply with no intermediate work.', final: true }],
		]),
	};
	listC.sync([itemC]);
	const bodyElC = listWrapperC.querySelector('.guki-message-body');
	check('AD3.1: no work group created for turn with zero work blocks', bodyElC?.querySelector('.guki-work-group') === null);
	check('AD3.2: answer block rendered directly in bodyEl', bodyElC?.querySelector('.guki-block-text') !== null);

	// (d) stopped or error turns keep every block expanded with no group created
	const listWrapperD1 = new FakeElement() as any;
	const listD1 = new MessageList({} as any, listWrapperD1, dummyComp, { decide: () => {} } as any);
	const itemDStopped: AssistantItem = {
		id: 'asst-stopped',
		kind: 'assistant',
		status: 'stopped',
		meta: { durationMs: 25000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking...', final: true }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 't-stop' }],
			[2, { index: 2, kind: 'text', text: 'interrupted', final: true }],
		]),
	};
	listD1.sync([itemDStopped]);
	const bodyElD1 = listWrapperD1.querySelector('.guki-message-body');
	check('AD4.1: no work group created on stopped turn', bodyElD1?.querySelector('.guki-work-group') === null);
	eq('AD4.2: all blocks stay direct children of bodyEl on stopped turn', bodyElD1?.children.length, 3);

	const listWrapperD2 = new FakeElement() as any;
	const listD2 = new MessageList({} as any, listWrapperD2, dummyComp, { decide: () => {} } as any);
	const itemDError: AssistantItem = {
		id: 'asst-error',
		kind: 'assistant',
		status: 'error',
		errorText: 'Process crashed',
		meta: { durationMs: 15000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking...', final: true }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolUseId: 't-err' }],
			[2, { index: 2, kind: 'text', text: 'error happened', final: true }],
		]),
	};
	listD2.sync([itemDError]);
	const bodyElD2 = listWrapperD2.querySelector('.guki-message-body');
	check('AD4.3: no work group created on error turn', bodyElD2?.querySelector('.guki-work-group') === null);
	eq('AD4.4: all blocks stay direct children of bodyEl on error turn', bodyElD2?.children.length, 3);

	// Extra partition check: text block before tool_use is WORK, not answer
	const listWrapperE = new FakeElement() as any;
	const listE = new MessageList({} as any, listWrapperE, dummyComp, { decide: () => {} } as any);
	const itemE: AssistantItem = {
		id: 'asst-mixed',
		kind: 'assistant',
		status: 'complete',
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'text', text: 'Preliminary explanation before tool.', final: true }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 't-mix' }],
			[2, { index: 2, kind: 'text', text: 'Final answer after tool.', final: true }],
		]),
	};
	listE.sync([itemE]);
	const bodyElE = listWrapperE.querySelector('.guki-message-body');
	const workGroupE = bodyElE?.querySelector('.guki-work-group');
	const headerElE = workGroupE?.querySelector('.guki-work-header');
	const contentElE = workGroupE?.querySelector('.guki-work-content');
	eq('AD5.1: missing duration renders header as Worked', headerElE?.text?.trim(), 'Worked');
	eq('AD5.2: text block before tool is inside work-content', contentElE?.children.length, 2);
	check('AD5.3: trailing text block is outside work-content',
		(bodyElE?.children ?? []).some((c: any) => c.hasClass('guki-block-text') && c !== contentElE?.children[0]));

	// (f) Check 1: A work block created AFTER the group already exists ends up inside the group's content container, in correct slot order.
	const listWrapperF = new FakeElement() as any;
	const listF = new MessageList({} as any, listWrapperF, dummyComp, { decide: () => {} } as any);
	const itemF: AssistantItem = {
		id: 'asst-chk1',
		kind: 'assistant',
		status: 'complete',
		meta: { durationMs: 20000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking', final: true }],
			[2, { index: 2, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolUseId: 't-2' }],
			[3, { index: 3, kind: 'text', text: 'Answer', final: true }],
		]),
	};
	listF.sync([itemF]);
	const entryF = (listF as any).rendered.get('asst-chk1');
	const contentElF = listWrapperF.querySelector('.guki-work-content');

	// A work block created on bodyEl after the group exists
	const block1ElF = entryF.bodyEl.createDiv({ cls: 'guki-block guki-block-tool_use' });
	entryF.blocks.set(1, { el: block1ElF, kind: 'tool_use', renderedText: '', renderedFinal: true });
	itemF.blocks.set(1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 't-1' });

	// Reconcile via syncWorkGroup
	(listF as any).syncWorkGroup(itemF, entryF);

	check('AD6.1: work block created after group exists ends up inside work content container',
		Boolean(contentElF?.children.includes(block1ElF)));
	check('AD6.2: work block is placed in slot order (index 1 between index 0 and index 2)',
		contentElF?.children[1] === block1ElF);

	// (g) Check 2: An item that changes so that a block previously classified as work becomes part of the answer run: that block is moved back OUT of the container, in correct slot order.
	const listWrapperG = new FakeElement() as any;
	const listG = new MessageList({} as any, listWrapperG, dummyComp, { decide: () => {} } as any);
	const itemG: AssistantItem = {
		id: 'asst-chk2',
		kind: 'assistant',
		status: 'complete',
		meta: { durationMs: 15000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking', final: true }],
			[1, { index: 1, kind: 'text', text: 'interim', final: true }],
			[2, { index: 2, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 't-g1' }],
			[3, { index: 3, kind: 'text', text: 'final ans', final: true }],
		]),
	};
	listG.sync([itemG]);
	const entryG = (listG as any).rendered.get('asst-chk2');
	const bodyElG = listWrapperG.querySelector('.guki-message-body');
	const contentElG = listWrapperG.querySelector('.guki-work-content');
	const workGroupG = listWrapperG.querySelector('.guki-work-group');

	eq('AD7.1: initial work content holds 3 blocks', contentElG?.children.length, 3);
	eq('AD7.2: initial bodyEl has workGroup and 1 answer block', bodyElG?.children.length, 2);

	// Block 2 (tool_use) removed -> block 1 becomes part of answer run [block 1, block 3]
	itemG.blocks.delete(2);
	listG.sync([itemG]);

	const block1ElG = entryG.blocks.get(1)?.el;
	const block3ElG = entryG.blocks.get(3)?.el;

	check('AD7.3: block 1 is moved out of work-content', Boolean(!contentElG?.children.includes(block1ElG)));
	check('AD7.4: block 1 is direct child of bodyEl', Boolean(bodyElG?.children.includes(block1ElG)));
	check('AD7.5: bodyEl has work group at child 0', bodyElG?.children[0] === workGroupG);
	check('AD7.6: block 1 is in slot order in bodyEl at child 1', bodyElG?.children[1] === block1ElG);
	check('AD7.7: block 3 is in slot order in bodyEl at child 2', bodyElG?.children[2] === block3ElG);

	// (h) Check 3: Reconciling twice is a no-op, and a group the user has expanded stays expanded.
	const headerElG = workGroupG?.querySelector('.guki-work-header');
	headerElG?.click();
	eq('AD8.1: clicking header sets aria-expanded true', headerElG?.getAttribute('aria-expanded'), 'true');
	check('AD8.2: work content is shown after click', Boolean(contentElG && !contentElG.hasClass('guki-hidden')));

	// First re-sync (reconcile)
	listG.sync([itemG]);
	eq('AD8.3: sync after expand keeps aria-expanded true', headerElG?.getAttribute('aria-expanded'), 'true');
	check('AD8.4: sync after expand keeps work content visible', Boolean(contentElG && !contentElG.hasClass('guki-hidden')));
	eq('AD8.5: bodyEl children count unchanged after re-sync', bodyElG?.children.length, 3);
	eq('AD8.6: contentEl children count unchanged after re-sync', contentElG?.children.length, 1);
	check('AD8.7: bodyEl child 0 still workGroup', bodyElG?.children[0] === workGroupG);
	check('AD8.8: bodyEl child 1 still block 1', bodyElG?.children[1] === block1ElG);
	check('AD8.9: bodyEl child 2 still block 3', bodyElG?.children[2] === block3ElG);

	// Second re-sync (reconcile twice is a no-op)
	listG.sync([itemG]);
	eq('AD8.10: reconciling twice keeps aria-expanded true', headerElG?.getAttribute('aria-expanded'), 'true');
	check('AD8.11: reconciling twice keeps work content visible', Boolean(contentElG && !contentElG.hasClass('guki-hidden')));
	eq('AD8.12: bodyEl children count unchanged after reconciling twice', bodyElG?.children.length, 3);
	eq('AD8.13: contentEl children count unchanged after reconciling twice', contentElG?.children.length, 1);

	// (i) Check AD9: Resolved permission row inside a collapsed group
	const listWrapperH = new FakeElement() as any;
	const listH = new MessageList({} as any, listWrapperH, dummyComp, { decide: () => {} } as any);
	const itemH: AssistantItem = {
		id: 'asst-chk-perm',
		kind: 'assistant',
		status: 'complete',
		meta: { durationMs: 40000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking', final: true }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 'tool-perm-ad9', toolPending: false }],
			[2, { index: 2, kind: 'text', text: 'Answer after tool.', final: true }],
		]),
	};
	// First sync creates the collapsed work group with tool_use block inside it
	listH.sync([itemH]);

	const entryH = (listH as any).rendered.get('asst-chk-perm');
	const bodyElH = listWrapperH.querySelector('.guki-message-body');
	const workGroupH = listWrapperH.querySelector('.guki-work-group');
	const contentElH = workGroupH?.querySelector('.guki-work-content');
	const toolBlockElH = entryH?.blocks.get(1)?.el;

	check('AD9.1: work group exists and is collapsed', Boolean(contentElH?.hasClass('guki-hidden')));
	check('AD9.2: tool_use block lives inside work-content', Boolean(contentElH?.children.includes(toolBlockElH)));

	const permItemH: PermissionItem = {
		id: 'perm-row-ad9',
		kind: 'permission',
		requestId: 'req-perm-ad9',
		toolName: 'Read',
		toolUseId: 'tool-perm-ad9',
		status: 'allowed',
		input: { file_path: 'vault/note.md' },
	};
	// Re-sync with the resolved permission item whose toolUseId matches the tool block
	listH.sync([itemH, permItemH]);

	const permEntryH = (listH as any).rendered.get('perm-row-ad9');
	const permElH = permEntryH?.el;

	check('AD9.3: permission row element exists', permElH !== null && permElH !== undefined);
	check('AD9.4: permission row attached inside tool card element', permElH?.parentElement === toolBlockElH);
	check('AD9.5: tool card element contains permission row', Boolean(toolBlockElH?.contains(permElH)));
	check('AD9.6: permission row lives inside work content container', Boolean(contentElH?.contains(permElH)));
	const scrollElH = (listH as any).scrollEl;
	check('AD9.7: permission row is not direct child of message body', !bodyElH?.children.includes(permElH));
	check('AD9.8: permission row is not loose in scroll container', !scrollElH?.children.includes(permElH));

	// (j) Check AD10: Removing a vanished block from inside the group
	const listWrapperI = new FakeElement() as any;
	const listI = new MessageList({} as any, listWrapperI, dummyComp, { decide: () => {} } as any);
	const itemI: AssistantItem = {
		id: 'asst-vanished-block',
		kind: 'assistant',
		status: 'complete',
		meta: { durationMs: 28000 },
		blocks: new Map<number, MessageBlock>([
			[0, { index: 0, kind: 'thinking', text: 'thinking', final: true }],
			[1, { index: 1, kind: 'tool_use', text: '', final: true, toolName: 'Read', toolUseId: 't-i1', toolPending: false }],
			[2, { index: 2, kind: 'tool_use', text: '', final: true, toolName: 'Write', toolUseId: 't-i2', toolPending: false }],
			[3, { index: 3, kind: 'text', text: 'Final answer.', final: true }],
		]),
	};
	listI.sync([itemI]);

	const entryI = (listI as any).rendered.get('asst-vanished-block');
	const bodyElI = listWrapperI.querySelector('.guki-message-body');
	const workGroupI = listWrapperI.querySelector('.guki-work-group');
	const contentElI = listWrapperI.querySelector('.guki-work-content');

	const block0ElI = entryI?.blocks.get(0)?.el;
	const block1ElI = entryI?.blocks.get(1)?.el;
	const block2ElI = entryI?.blocks.get(2)?.el;
	const block3ElI = entryI?.blocks.get(3)?.el;

	eq('AD10.1: initial work content holds 3 blocks', contentElI?.children.length, 3);
	check('AD10.2: block 1 is inside work content initially', Boolean(contentElI?.children.includes(block1ElI)));

	// Block 1 disappears from item on later sync
	itemI.blocks.delete(1);
	listI.sync([itemI]);

	check('AD10.3: vanished block 1 is removed from work-content', !contentElI?.children.includes(block1ElI));
	check('AD10.4: vanished block 1 is removed from bodyEl', !bodyElI?.children.includes(block1ElI));
	check('AD10.5: vanished block 1 element has null parentElement', block1ElI?.parentElement === null);
	check('AD10.6: vanished block 1 is removed from rendered blocks map', !entryI?.blocks.has(1));
	eq('AD10.7: work content holds exactly 2 remaining blocks', contentElI?.children.length, 2);
	check('AD10.8: remaining block 0 is at slot 0 in work content', contentElI?.children[0] === block0ElI);
	check('AD10.9: remaining block 2 is at slot 1 in work content', contentElI?.children[1] === block2ElI);
	check('AD10.10: bodyEl child 0 is work group', bodyElI?.children[0] === workGroupI);
	check('AD10.11: bodyEl child 1 is answer block 3', bodyElI?.children[1] === block3ElI);
}

console.log('\nAE. Görev 7 — Conversation compacted divider (A1-A5)');
{
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el?.addEventListener?.(evt, cb) } as any;

	// Raw wire event lines from measured evidence (SPEC §2, raw-stream.out)
	const RAW_COMPACT_BOUNDARY_LINE =
		'{"type":"system","subtype":"compact_boundary","session_id":"214d9943-675d-4e9a-a7c7-b3dd55a2c363","uuid":"29916d2f-e8d8-477b-a205-e1daa675e651","compact_metadata":{"trigger":"manual","pre_tokens":26529,"post_tokens":5062,"cumulative_dropped_tokens":21467,"duration_ms":33022},"logical_parent_uuid":"2cd61295-c76d-4db6-a2a9-2121c7fdd71e"}';
	const RAW_NEAR_MISS_STATUS_LINE =
		'{"type":"system","subtype":"status","status":"requesting","session_id":"214d9943-675d-4e9a-a7c7-b3dd55a2c363","uuid":"2546cd8f-0466-462d-a9ba-91e20a4ede57"}';
	const RAW_NEAR_MISS_MICROCOMPACT_LINE =
		'{"type":"system","subtype":"microcompact_boundary","session_id":"214d9943-675d-4e9a-a7c7-b3dd55a2c363","uuid":"micro-boundary-uuid-1"}';
	const RAW_SYNTHETIC_SUMMARY_LINE =
		'{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\\n\\nSummary:\\n1. Primary Request and Intent: test probe\\n\\nContinue the conversation directly."},"session_id":"214d9943-675d-4e9a-a7c7-b3dd55a2c363","parent_tool_use_id":null,"uuid":"751baf78-b60b-4fe3-8f6e-b484da2dd784","timestamp":"2026-09-13T21:12:54.524Z","isReplay":false,"isSynthetic":true}';

	// ------------------------------------------------------------------------
	// A1. End-to-end chain check
	// ------------------------------------------------------------------------
	const stateA1 = new ChatState();
	const reducerA1 = new StreamReducer(stateA1);
	const listWrapperA1 = new FakeElement() as any;
	const messageListA1 = new MessageList({} as any, listWrapperA1, dummyComp, { decide: () => {} } as any);
	stateA1.subscribe(() => messageListA1.sync(stateA1.items));

	stateA1.addUserMessage('Prior user prompt');
	const asstBeforeA1 = stateA1.addAssistantMessage();
	reducerA1.beginTurn(asstBeforeA1);
	asstBeforeA1.blocks.set(0, { index: 0, kind: 'text', text: 'Prior assistant reply.', final: true });
	stateA1.emitChange();

	// Production entry point: parseStreamJsonLine -> reducer.apply
	const evA1 = parseStreamJsonLine(RAW_COMPACT_BOUNDARY_LINE);
	if (evA1) {
		reducerA1.apply(evA1);
	}

	stateA1.addUserMessage('Subsequent user prompt');
	stateA1.emitChange();

	const dividerElA1 = listWrapperA1.querySelector('.guki-message-divider');
	check('A1.1: divider element exists in rendered message list', dividerElA1 !== null && dividerElA1 !== undefined);
	check('A1.2: divider label text is Conversation compacted', Boolean(dividerElA1?.text?.includes('Conversation compacted')));

	const scrollContainerA1 = listWrapperA1.querySelector('.guki-messages') ?? listWrapperA1;
	const childrenA1 = scrollContainerA1.children;
	const idxBeforeA1 = childrenA1.findIndex((c: any) => c.hasClass('guki-message-assistant'));
	const idxDividerA1 = childrenA1.indexOf(dividerElA1);
	const idxAfterA1 = childrenA1.findIndex((c: any) => c.hasClass('guki-message-user') && c.text.includes('Subsequent user prompt'));
	check('A1.3: divider is placed in correct position between prior and subsequent items',
		idxBeforeA1 !== -1 && idxDividerA1 > idxBeforeA1 && idxAfterA1 > idxDividerA1);

	// ------------------------------------------------------------------------
	// A3. Near-miss checks
	// ------------------------------------------------------------------------
	const stateA3 = new ChatState();
	const reducerA3 = new StreamReducer(stateA3);
	const listWrapperA3 = new FakeElement() as any;
	const messageListA3 = new MessageList({} as any, listWrapperA3, dummyComp, { decide: () => {} } as any);
	stateA3.subscribe(() => messageListA3.sync(stateA3.items));

	// (a) system line with different subtype
	const evStatus = parseStreamJsonLine(RAW_NEAR_MISS_STATUS_LINE);
	if (evStatus) reducerA3.apply(evStatus);
	check('A3.1: system event with different subtype produces no divider',
		listWrapperA3.querySelector('.guki-message-divider') === null);

	// (b) microcompact_boundary line
	const evMicro = parseStreamJsonLine(RAW_NEAR_MISS_MICROCOMPACT_LINE);
	if (evMicro) reducerA3.apply(evMicro);
	check('A3.2: microcompact_boundary produces no divider',
		listWrapperA3.querySelector('.guki-message-divider') === null);

	// (c) identical compact_boundary uuid delivered twice -> exactly one divider
	if (evA1) {
		reducerA3.apply(evA1);
		reducerA3.apply(evA1);
	}
	const dividerCountA3 = listWrapperA3.querySelectorAll('.guki-message-divider').length;
	eq('A3.3: identical compact_boundary uuid delivered twice produces exactly one divider', dividerCountA3, 1);

	// ------------------------------------------------------------------------
	// A4. Split-turn check
	// ------------------------------------------------------------------------
	const stateA4 = new ChatState();
	const reducerA4 = new StreamReducer(stateA4);
	const listWrapperA4 = new FakeElement() as any;
	const messageListA4 = new MessageList({} as any, listWrapperA4, dummyComp, { decide: () => {} } as any);
	stateA4.subscribe(() => messageListA4.sync(stateA4.items));

	stateA4.addUserMessage('Explain quantum computing');
	const asstA4 = stateA4.addAssistantMessage();
	reducerA4.beginTurn(asstA4);

	// Assistant produces text before compaction
	reducerA4.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'text', text: '' },
		},
	} as any);
	reducerA4.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text: 'Quantum computing uses qubits.' },
		},
	} as any);
	reducerA4.apply({
		type: 'assistant',
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Quantum computing uses qubits.' }],
		},
	} as any);

	// Boundary arrives mid-turn!
	const boundaryEvA4 = parseStreamJsonLine(
		'{"type":"system","subtype":"compact_boundary","uuid":"split-turn-uuid-a4","compact_metadata":{"trigger":"auto"}}'
	);
	if (boundaryEvA4) {
		reducerA4.apply(boundaryEvA4);
	}

	// Text arrives AFTER compaction in the same turn
	reducerA4.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'text', text: '' },
		},
	} as any);
	reducerA4.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'text_delta', text: 'Superposition enables parallel state evaluation.' },
		},
	} as any);
	reducerA4.apply({
		type: 'assistant',
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Superposition enables parallel state evaluation.' }],
		},
	} as any);

	// Turn ends with result
	reducerA4.apply({
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 15400,
	} as any);

	const scrollContainerA4 = listWrapperA4.querySelector('.guki-messages') ?? listWrapperA4;
	const childrenA4 = scrollContainerA4.children;
	const dividerElA4 = listWrapperA4.querySelector('.guki-message-divider');
	const idxDividerA4 = childrenA4.indexOf(dividerElA4);
	const asstBeforeElA4 = childrenA4.find((c: any) =>
		c.hasClass('guki-message-assistant') && c.text.includes('Quantum computing uses qubits.')
	);
	const asstAfterElA4 = childrenA4.find((c: any) =>
		c.hasClass('guki-message-assistant') && c.text.includes('Superposition enables parallel')
	);
	const idxAsstBeforeA4 = childrenA4.indexOf(asstBeforeElA4);
	const idxAsstAfterA4 = childrenA4.indexOf(asstAfterElA4);

	check('A4.1: earlier text stays above divider',
		idxAsstBeforeA4 !== -1 && idxDividerA4 > idxAsstBeforeA4);
	check('A4.2: text arriving after renders below divider',
		idxAsstAfterA4 !== -1 && idxAsstAfterA4 > idxDividerA4);

	// In-flight empty assistant item dropped on manual /compact:
	stateA4.addUserMessage('/compact');
	const asstEmpty = stateA4.addAssistantMessage();
	reducerA4.beginTurn(asstEmpty);
	// No text rendered; compact_boundary arrives
	const boundaryEvManual = parseStreamJsonLine(
		'{"type":"system","subtype":"compact_boundary","uuid":"split-turn-manual-uuid","compact_metadata":{"trigger":"manual"}}'
	);
	if (boundaryEvManual) {
		reducerA4.apply(boundaryEvManual);
	}
	reducerA4.apply({
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 8000,
	} as any);

	// Check: empty assistant item is removed from ChatState (not left behind)
	check('A4.3: empty assistant item is removed from ChatState after /compact turn',
		!stateA4.items.some((i: any) => i.id === asstEmpty.id));

	// Mid-turn compaction without post-boundary content (Attack 2 / FIX-1):
	stateA4.addUserMessage('Run grep');
	const asstMidComp = stateA4.addAssistantMessage();
	reducerA4.beginTurn(asstMidComp);
	reducerA4.apply({
		type: 'stream_event',
		event: {
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'tool-call-a4', name: 'Bash' }
		}
	} as any);
	reducerA4.apply({
		type: 'stream_event',
		event: { type: 'content_block_stop', index: 0 }
	} as any);
	reducerA4.apply({
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'tool-call-a4', content: 'output' }]
		}
	} as any);
	const boundaryEvTool = parseStreamJsonLine(
		'{"type":"system","subtype":"compact_boundary","uuid":"split-mid-turn-uuid","compact_metadata":{"trigger":"auto"}}'
	);
	if (boundaryEvTool) reducerA4.apply(boundaryEvTool);
	reducerA4.apply({
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 25000,
		total_cost_usd: 0.12
	} as any);

	check('A4.4: mid-turn compaction without post-boundary content preserves durationMs and cost',
		asstMidComp.meta?.durationMs === 25000 && asstMidComp.meta?.costUsd === 0.12);

	stateA4.addUserMessage('Next turn prompt');
	const asstNext = stateA4.addAssistantMessage();
	reducerA4.beginTurn(asstNext);
	reducerA4.apply({
		type: 'result',
		subtype: 'success',
		is_error: false,
		duration_ms: 5000,
		total_cost_usd: 0.15
	} as any);
	check('A4.5: next turn bills delta cost (0.03) after mid-turn compaction',
		asstNext.meta?.costUsd === 0.03);

	// ------------------------------------------------------------------------
	// A5. R8 check: synthetic summary message suppression vs ordinary user message
	// ------------------------------------------------------------------------
	const stateA5 = new ChatState();
	const reducerA5 = new StreamReducer(stateA5);
	const listWrapperA5 = new FakeElement() as any;
	const messageListA5 = new MessageList({} as any, listWrapperA5, dummyComp, { decide: () => {} } as any);
	stateA5.subscribe(() => messageListA5.sync(stateA5.items));

	// Feed synthetic summary line from raw evidence
	const evSynthetic = parseStreamJsonLine(RAW_SYNTHETIC_SUMMARY_LINE);
	if (evSynthetic) {
		reducerA5.apply(evSynthetic);
	}
	stateA5.emitChange();

	const syntheticBubble = listWrapperA5.querySelector('.guki-message-user');
	check('A5.1: synthetic summary message produces no user bubble',
		syntheticBubble === null && stateA5.items.filter((i: any) => i.kind === 'user').length === 0);

	// Reverse check: ordinary user message produces a user bubble
	stateA5.addUserMessage('An ordinary user message');
	const ordinaryBubble = listWrapperA5.querySelector('.guki-message-user');
	check('A5.2: ordinary user message produces user bubble',
		ordinaryBubble !== null && ordinaryBubble.text.includes('An ordinary user message'));
}

console.log('\nAF. Görev 7 Fix 2 — Per-segment work group durations across compaction');
{
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el?.addEventListener?.(evt, cb) } as any;

	// Check AF.1 (Check 2): Split turn shows distinct segment durations that sum to total
	{
		let mockTime = 1000000;
		const origDateNow = Date.now;
		Date.now = () => mockTime;

		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const listWrapper = new FakeElement() as any;
		const messageList = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
		state.subscribe(() => messageList.sync(state.items));

		state.addUserMessage('Explain quantum computing');
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		// Pre-compaction work block (tool use) + text answer
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-af-1', name: 'Bash' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-af-1', content: 'output' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Pre-compaction answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-af-1', name: 'Bash' },
					{ type: 'text', text: 'Pre-compaction answer.' }
				]
			}
		} as any);

		// Advance time by 103 seconds (1:43)
		mockTime += 103000;

		// Boundary arrives
		const boundaryEv = parseStreamJsonLine(
			'{"type":"system","subtype":"compact_boundary","uuid":"boundary-uuid-af-1","compact_metadata":{"trigger":"auto"}}'
		);
		if (boundaryEv) reducer.apply(boundaryEv);

		// Post-compaction work block (thinking) + text answer
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'thinking', thinking: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'Post-compaction thinking...' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Post-compaction answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Post-compaction thinking...' },
					{ type: 'text', text: 'Post-compaction answer.' }
				]
			}
		} as any);

		// Advance time by 16 seconds (0:16)
		mockTime += 16000;

		// Result event with duration_ms: 119000 (1:59 total)
		reducer.apply({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 119000,
			total_cost_usd: 0.15
		} as any);

		Date.now = origDateNow;

		messageList.sync(state.items);

		const workHeaders = listWrapper.querySelectorAll('.guki-work-header');
		check('AF1.1: exactly 2 work headers rendered for split turn', workHeaders.length === 2);
		eq('AF1.2: pre-compaction work header shows its own segment duration (Worked for 1:43)',
			workHeaders[0]?.text?.trim(), 'Worked for 1:43');
		eq('AF1.3: post-compaction work header shows its own segment duration (Worked for 0:16)',
			workHeaders[1]?.text?.trim(), 'Worked for 0:16');
	}

	// Check AF.2 (Check 3): No-compaction regression
	{
		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const listWrapper = new FakeElement() as any;
		const messageList = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
		state.subscribe(() => messageList.sync(state.items));

		state.addUserMessage('Normal query');
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-af-norm', name: 'Read' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-af-norm', content: 'file content' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Normal answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-af-norm', name: 'Read' },
					{ type: 'text', text: 'Normal answer.' }
				]
			}
		} as any);

		reducer.apply({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 45000,
			total_cost_usd: 0.05
		} as any);

		messageList.sync(state.items);

		const workHeaders = listWrapper.querySelectorAll('.guki-work-header');
		check('AF2.1: exactly 1 work header rendered for normal turn without compaction', workHeaders.length === 1);
		eq('AF2.2: normal work header shows full turn duration (Worked for 0:45)',
			workHeaders[0]?.text?.trim(), 'Worked for 0:45');
	}

	// Check AF.3 (Check 4): Two boundaries in one turn -> 3 segments
	{
		let mockTime = 2000000;
		const origDateNow = Date.now;
		Date.now = () => mockTime;

		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const listWrapper = new FakeElement() as any;
		const messageList = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
		state.subscribe(() => messageList.sync(state.items));

		state.addUserMessage('Multi-boundary turn');
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		// Segment 1: tool use + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-af-s1', name: 'Bash' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-af-s1', content: 'out 1' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Answer 1.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-af-s1', name: 'Bash' },
					{ type: 'text', text: 'Answer 1.' }
				]
			}
		} as any);

		mockTime += 45000; // 45s

		const boundary1 = parseStreamJsonLine(
			'{"type":"system","subtype":"compact_boundary","uuid":"boundary-uuid-af-s1","compact_metadata":{"trigger":"auto"}}'
		);
		if (boundary1) reducer.apply(boundary1);

		// Segment 2: tool use + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-af-s2', name: 'Read' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-af-s2', content: 'file content' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Answer 2.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-af-s2', name: 'Read' },
					{ type: 'text', text: 'Answer 2.' }
				]
			}
		} as any);

		mockTime += 35000; // 35s

		const boundary2 = parseStreamJsonLine(
			'{"type":"system","subtype":"compact_boundary","uuid":"boundary-uuid-af-s2","compact_metadata":{"trigger":"auto"}}'
		);
		if (boundary2) reducer.apply(boundary2);

		// Segment 3: thinking + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'thinking', thinking: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'Segment 3 thinking...' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Segment 3 final answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Segment 3 thinking...' },
					{ type: 'text', text: 'Segment 3 final answer.' }
				]
			}
		} as any);

		mockTime += 40000; // 40s. Total = 45s + 35s + 40s = 120s (2:00)

		reducer.apply({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 120000,
			total_cost_usd: 0.25
		} as any);

		Date.now = origDateNow;

		messageList.sync(state.items);

		const workHeaders = listWrapper.querySelectorAll('.guki-work-header');
		check('AF3.1: exactly 3 work headers rendered across two boundaries', workHeaders.length === 3);
		eq('AF3.2: segment 1 work header shows Worked for 0:45', workHeaders[0]?.text?.trim(), 'Worked for 0:45');
		eq('AF3.3: segment 2 work header shows Worked for 0:35', workHeaders[1]?.text?.trim(), 'Worked for 0:35');
		eq('AF3.4: segment 3 work header shows Worked for 0:40', workHeaders[2]?.text?.trim(), 'Worked for 0:40');
	}
}

console.log('\nAG. Görev 7 Fix 3 — Structural accounting (FIX-A) and proportional scaling (FIX-B)');
{
	const dummyComp = { registerDomEvent: (el: any, evt: string, cb: any) => el?.addEventListener?.(evt, cb) } as any;

	// Check AG.1 (FIX-A): Structural accounting via boundaryTimestamps produces correct segment durations
	{
		let mockTime = 5000000;
		const origDateNow = Date.now;
		Date.now = () => mockTime;

		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const listWrapper = new FakeElement() as any;
		const messageList = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
		state.subscribe(() => messageList.sync(state.items));

		state.addUserMessage('Explain quantum computing');
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		// Pre-compaction: tool use + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-ag-1', name: 'Bash' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-ag-1', content: 'output' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Pre-compaction answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-ag-1', name: 'Bash' },
					{ type: 'text', text: 'Pre-compaction answer.' }
				]
			}
		} as any);

		mockTime += 103000; // 1:43

		const boundaryEv = parseStreamJsonLine(
			'{"type":"system","subtype":"compact_boundary","uuid":"boundary-uuid-ag-1","compact_metadata":{"trigger":"auto"}}'
		);
		if (boundaryEv) reducer.apply(boundaryEv);

		// Post-compaction: thinking + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'thinking', thinking: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'Post-compaction thinking...' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Post-compaction answer.' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Post-compaction thinking...' },
					{ type: 'text', text: 'Post-compaction answer.' }
				]
			}
		} as any);

		mockTime += 16000; // 0:16

		reducer.apply({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 119000,
			total_cost_usd: 0.15
		} as any);

		Date.now = origDateNow;
		messageList.sync(state.items);

		const workHeaders = listWrapper.querySelectorAll('.guki-work-header');
		check('AG1.1: exactly 2 work headers rendered for split turn', workHeaders.length === 2);
		eq('AG1.2: pre-compaction work header shows Worked for 1:43', workHeaders[0]?.text?.trim(), 'Worked for 1:43');
		eq('AG1.3: post-compaction work header shows Worked for 0:16', workHeaders[1]?.text?.trim(), 'Worked for 0:16');
	}

	// Check AG.2 (FIX-B): Clock skew / local overshoot (70s local vs 50s CLI total)
	{
		let mockTime = 6000000;
		const origDateNow = Date.now;
		Date.now = () => mockTime;

		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const listWrapper = new FakeElement() as any;
		const messageList = new MessageList({} as any, listWrapper, dummyComp, { decide: () => {} } as any);
		state.subscribe(() => messageList.sync(state.items));

		state.addUserMessage('Clock skew query');
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		// Segment 1: tool use + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'tool-skew-1', name: 'Bash' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: 'tool-skew-1', content: 'out' }]
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Answer 1' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'tool-skew-1', name: 'Bash' },
					{ type: 'text', text: 'Answer 1' }
				]
			}
		} as any);

		mockTime += 60000; // 60s local for segment 1

		const boundaryEv = parseStreamJsonLine(
			'{"type":"system","subtype":"compact_boundary","uuid":"b-skew-1","compact_metadata":{"trigger":"auto"}}'
		);
		if (boundaryEv) reducer.apply(boundaryEv);

		// Segment 2: thinking + text
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'thinking', thinking: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'think' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: { type: 'content_block_stop', index: 0 }
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '' }
			}
		} as any);
		reducer.apply({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'text_delta', text: 'Answer 2' }
			}
		} as any);
		reducer.apply({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'think' },
					{ type: 'text', text: 'Answer 2' }
				]
			}
		} as any);

		mockTime += 10000; // 10s local for segment 2. Total local: 70s

		// CLI reports duration_ms: 50,000 (50s)
		reducer.apply({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 50000,
			total_cost_usd: 0.10
		} as any);

		Date.now = origDateNow;
		messageList.sync(state.items);

		const skewHeaders = listWrapper.querySelectorAll('.guki-work-header');
		check('AG2.1: clock skew produces exactly 2 work headers', skewHeaders.length === 2);
		const h1 = skewHeaders[0]?.text?.trim();
		const h2 = skewHeaders[1]?.text?.trim();
		// Crucial assertion: no segment that performed work may print "Worked for 0:00"
		check('AG2.2: segment 1 does not print Worked for 0:00', h1 !== 'Worked for 0:00');
		check('AG2.3: segment 2 does not print Worked for 0:00', h2 !== 'Worked for 0:00');
		eq('AG2.4: segment 1 proportional duration is Worked for 0:43', h1, 'Worked for 0:43');
		eq('AG2.5: segment 2 proportional duration is Worked for 0:07', h2, 'Worked for 0:07');

		// Displayed segments sum to the CLI's reported total (50s)
		const parseSec = (header: string | undefined): number => {
			if (!header) return -1;
			const m = header.match(/Worked for (\d+):(\d+)/);
			return m ? parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10) : -1;
		};
		const s1 = parseSec(h1);
		const s2 = parseSec(h2);
		check('AG2.6: displayed segment durations sum to CLI total (43s + 7s = 50s)', s1 + s2 === 50, `got ${s1} + ${s2} = ${s1 + s2}`);
	}
}

// --- AH. Görev 7b — Compacting conversation indicator (C1-C6) -------------

console.log('\nAH. Görev 7b — Compacting conversation indicator (C1-C6)');
{
	// C1: Replay docs/capture-phase7b-compaction-status.jsonl through real reducer
	const capture7b = readFileSync(join(process.cwd(), 'docs', 'capture-phase7b-compaction-status.jsonl'), 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0);

	const state = new ChatState();
	const reducer = new StreamReducer(state);
	let changeCount = 0;
	state.subscribe(() => {
		changeCount += 1;
	});

	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);
	changeCount = 0;

	// Line 1: system/status status: "compacting"
	const ev1 = parseStreamJsonLine(capture7b[0]!);
	reducer.apply(ev1!);
	eq('C1.1: after line 1, compacting flag is true', state.compacting, true);
	eq('C1.1: state change emitted once on start', changeCount, 1);

	// Line 2: second system/status status: "compacting" (idempotent)
	const ev2 = parseStreamJsonLine(capture7b[1]!);
	reducer.apply(ev2!);
	eq('C1.2: after line 2, compacting flag is still true', state.compacting, true);
	eq('C1.2: no extra state change emitted on duplicate compacting status', changeCount, 1);

	// Line 3: system/status status: null, compact_result: "success"
	const ev3 = parseStreamJsonLine(capture7b[2]!);
	reducer.apply(ev3!);
	eq('C1.3: after line 3 (compact_result), compacting flag is false', state.compacting, false);
	eq('C1.3: state change emitted on clear', changeCount, 2);

	// Line 4: system/init
	const ev4 = parseStreamJsonLine(capture7b[3]!);
	reducer.apply(ev4!);
	eq('C1.4: after line 4 (init), compacting flag remains false', state.compacting, false);

	// Line 5: system/compact_boundary
	const ev5 = parseStreamJsonLine(capture7b[4]!);
	reducer.apply(ev5!);
	eq('C1.5: after line 5 (compact_boundary), compacting flag remains false', state.compacting, false);
}

{
	// C2: status:"requesting" never sets the flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const requestingEvent = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"requesting","session_id":"test-session","uuid":"req-1"}'
	);
	reducer.apply(requestingEvent!);
	eq('C2: status:"requesting" never sets compacting flag', state.compacting, false);
}

{
	// C3: compact_result with value other than "success" clears the flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const startEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-1"}'
	);
	reducer.apply(startEv!);
	check('C3 precondition: compacting is true', state.compacting === true);

	const failEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":null,"compact_result":"failed","session_id":"test-session","uuid":"end-fail"}'
	);
	reducer.apply(failEv!);
	eq('C3: compact_result with non-success value clears flag', state.compacting, false);
}

{
	// C4: result event clears the flag when no compact_result ever arrived
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const startEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-2"}'
	);
	reducer.apply(startEv!);
	check('C4 precondition: compacting is true', state.compacting === true);

	const resultEv = parseStreamJsonLine(
		'{"type":"result","subtype":"success","duration_ms":1000,"total_cost_usd":0.05}'
	);
	reducer.apply(resultEv!);
	eq('C4: result event clears compacting flag', state.compacting, false);
}

{
	// C5: failActiveTurn() clears the flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const startEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-3"}'
	);
	reducer.apply(startEv!);
	check('C5 precondition: compacting is true', state.compacting === true);

	reducer.failActiveTurn('CLI process crashed');
	eq('C5: failActiveTurn() clears compacting flag', state.compacting, false);
}

{
	// F4: system/compact_boundary clears the flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const startEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-4"}'
	);
	reducer.apply(startEv!);
	check('F4 boundary precondition: compacting is true', state.compacting === true);

	const boundaryEv = parseStreamJsonLine(
		'{"type":"system","subtype":"compact_boundary","uuid":"bound-1"}'
	);
	reducer.apply(boundaryEv!);
	eq('F4: system/compact_boundary clears compacting flag', state.compacting, false);
}

{
	// C6: Chain check — observable output in Composer status line
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const container = new FakeElement() as any;
	const panel = new FakeElement() as any;
	const dummyComp = {
		registerDomEvent: (el: any, evt: string, cb: any) => {
			if (el?.addEventListener) el.addEventListener(evt, cb);
		},
	} as any;

	const composer = new Composer(container, panel, dummyComp, {
		onSubmit: () => true,
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});

	// Trigger compaction
	const startEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-c6"}'
	);
	reducer.apply(startEv!);

	// Production path: currentStatus(state) -> composer.setStatusLine
	const statusCompacting = currentStatus(state);
	composer.setStatusLine(statusCompacting);

	const statusEl = container.querySelector('.guki-composer-status');
	check('C6.1: status element exists in composer toolbar', statusEl !== null);
	const textWhileCompacting = statusEl?.text?.trim() ?? '';
	check(
		'C6.2: rendered status text starts with "Compacting conversation…" while compacting',
		textWhileCompacting.startsWith('Compacting conversation…'),
		`got ${JSON.stringify(textWhileCompacting)}`,
	);

	// Compaction ends
	const endEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"test-session","uuid":"end-c6"}'
	);
	reducer.apply(endEv!);

	const statusCleared = currentStatus(state);
	composer.setStatusLine(statusCleared);

	const textAfterCleared = statusEl?.text?.trim() ?? '';
	check(
		'C6.3: rendered status text does not contain "Compacting conversation…" once cleared',
		!textAfterCleared.includes('Compacting conversation…'),
		`got ${JSON.stringify(textAfterCleared)}`,
	);
}

{
	// Fix 1: streamed assistant content with NO end signal clears compacting flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);
	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	const container = new FakeElement() as any;
	const panel = new FakeElement() as any;
	const dummyComp = {
		registerDomEvent: (el: any, evt: string, cb: any) => {
			if (el?.addEventListener) el.addEventListener(evt, cb);
		},
	} as any;

	const composer = new Composer(container, panel, dummyComp, {
		onSubmit: () => true,
		onStop: () => {},
		onDropped: () => {},
		onPasted: () => false,
		onAttachActiveNote: () => {},
		onPickedFiles: () => {},
	});

	state.subscribe(() => {
		composer.setStatusLine(currentStatus(state));
	});

	// Compacting start signal
	const compactingEv = parseStreamJsonLine(
		'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-fix1"}'
	);
	reducer.apply(compactingEv!);
	check('Fix 1 precondition: compacting is true', state.compacting === true);

	const statusEl = container.querySelector('.guki-composer-status');
	const textBefore = statusEl?.text?.trim() ?? '';
	check('Fix 1 precondition: status line shows compacting', textBefore.startsWith('Compacting conversation…'));

	// Streamed assistant content arrives with NO end signal
	const streamEv = parseStreamJsonLine(
		'{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}}'
	);
	reducer.apply(streamEv!);

	eq('Fix 1: compacting flag is false once content streams', state.compacting, false);
	const textAfter = statusEl?.text?.trim() ?? '';
	check(
		'Fix 1: rendered status text no longer contains "Compacting conversation…"',
		!textAfter.includes('Compacting conversation…'),
		`got ${JSON.stringify(textAfter)}`,
	);
}

{
	// Fix 2: beginTurn directly clears compacting flag
	const state = new ChatState();
	const reducer = new StreamReducer(state);

	state.setCompacting(true);
	check('Fix 2 precondition: compacting is true', state.compacting === true);

	const asst = state.addAssistantMessage();
	reducer.beginTurn(asst);

	eq('Fix 2: beginTurn directly clears compacting flag', state.compacting, false);
}

{
	// Non-streamed assistant message (text, thinking) clears compacting flag and rendered composer status
	const createRig = () => {
		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		const container = new FakeElement() as any;
		const panel = new FakeElement() as any;
		const dummyComp = {
			registerDomEvent: (el: any, evt: string, cb: any) => {
				if (el?.addEventListener) el.addEventListener(evt, cb);
			},
		} as any;

		const composer = new Composer(container, panel, dummyComp, {
			onSubmit: () => true,
			onStop: () => {},
			onDropped: () => {},
			onPasted: () => false,
			onAttachActiveNote: () => {},
			onPickedFiles: () => {},
		});

		state.subscribe(() => {
			composer.setStatusLine(currentStatus(state));
		});

		return { state, reducer, container };
	};

	// Case 1: non-streamed text
	{
		const { state, reducer, container } = createRig();
		const compactingEv = parseStreamJsonLine(
			'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-ns-text"}'
		);
		reducer.apply(compactingEv!);
		check('Non-streamed text precondition: compacting is true', state.compacting === true);

		const statusEl = container.querySelector('.guki-composer-status');
		const textBefore = statusEl?.text?.trim() ?? '';
		check('Non-streamed text precondition: status line shows compacting', textBefore.startsWith('Compacting conversation…'));

		const asstEv = parseStreamJsonLine(
			'{"type":"assistant","message":{"model":"claude-opus-5","id":"msg-ns-text","type":"message","role":"assistant","content":[{"type":"text","text":"Non-streamed answer"}]}}'
		);
		reducer.apply(asstEv!);

		eq('Non-streamed text: compacting flag is false once assistant content arrives', state.compacting, false);
		const textAfter = statusEl?.text?.trim() ?? '';
		check(
			'Non-streamed text: rendered status text no longer contains "Compacting conversation…"',
			!textAfter.includes('Compacting conversation…'),
			`got ${JSON.stringify(textAfter)}`,
		);
	}

	// Case 2: non-streamed thinking
	{
		const { state, reducer, container } = createRig();
		const compactingEv = parseStreamJsonLine(
			'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-ns-thinking"}'
		);
		reducer.apply(compactingEv!);
		check('Non-streamed thinking precondition: compacting is true', state.compacting === true);

		const statusEl = container.querySelector('.guki-composer-status');
		const textBefore = statusEl?.text?.trim() ?? '';
		check('Non-streamed thinking precondition: status line shows compacting', textBefore.startsWith('Compacting conversation…'));

		const asstEv = parseStreamJsonLine(
			'{"type":"assistant","message":{"model":"claude-opus-5","id":"msg-ns-thinking","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"Non-streamed thought"}]}}'
		);
		reducer.apply(asstEv!);

		eq('Non-streamed thinking: compacting flag is false once assistant content arrives', state.compacting, false);
		const textAfter = statusEl?.text?.trim() ?? '';
		check(
			'Non-streamed thinking: rendered status text no longer contains "Compacting conversation…"',
			!textAfter.includes('Compacting conversation…'),
			`got ${JSON.stringify(textAfter)}`,
		);
	}

	// Case 3: non-streamed tool_use
	{
		const { state, reducer, container } = createRig();
		const compactingEv = parseStreamJsonLine(
			'{"type":"system","subtype":"status","status":"compacting","session_id":"test-session","uuid":"start-ns-tool"}'
		);
		reducer.apply(compactingEv!);
		check('Non-streamed tool_use precondition: compacting is true', state.compacting === true);

		const statusEl = container.querySelector('.guki-composer-status');
		const textBefore = statusEl?.text?.trim() ?? '';
		check('Non-streamed tool_use precondition: status line shows compacting', textBefore.startsWith('Compacting conversation…'));

		let sawCompactingWhileContentEmitted = false;
		const emittedStatuses: string[] = [];
		state.subscribe(() => {
			const text = statusEl?.text?.trim() ?? '';
			emittedStatuses.push(text);
			if (text.includes('Compacting conversation…')) {
				sawCompactingWhileContentEmitted = true;
			}
		});

		const asstEv = parseStreamJsonLine(
			'{"type":"assistant","message":{"model":"claude-opus-5","id":"msg-ns-tool","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"ls -la"}}]}}'
		);
		reducer.apply(asstEv!);

		eq('Non-streamed tool_use: compacting flag is false once assistant content arrives', state.compacting, false);
		const textAfter = statusEl?.text?.trim() ?? '';
		check(
			'Non-streamed tool_use: rendered status text no longer contains "Compacting conversation…"',
			!textAfter.includes('Compacting conversation…'),
			`got ${JSON.stringify(textAfter)}`,
		);
		check(
			'Non-streamed tool_use: rendered composer status text does not contain "Compacting conversation…" at any point a state change was emitted',
			!sawCompactingWhileContentEmitted,
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`,
		);
	}
}

// --- C8: SPEC §7 R8 single-site clearing and non-clearing survival checks ---
console.log('\nC8: Compacting indicator choke-point clearing and non-clearing survival (SPEC §7)');
{
	const createRig = () => {
		const state = new ChatState();
		const reducer = new StreamReducer(state);
		const asst = state.addAssistantMessage();
		reducer.beginTurn(asst);

		const container = new FakeElement() as any;
		const panel = new FakeElement() as any;
		const dummyComp = {
			registerDomEvent: (el: any, evt: string, cb: any) => {
				if (el?.addEventListener) el.addEventListener(evt, cb);
			},
		} as any;

		const composer = new Composer(container, panel, dummyComp, {
			onSubmit: () => true,
			onStop: () => {},
			onDropped: () => {},
			onPasted: () => false,
			onAttachActiveNote: () => {},
			onPickedFiles: () => {},
		});

		state.setCompacting(true);
		composer.setStatusLine(currentStatus(state));

		const statusEl = container.querySelector('.guki-composer-status');
		const initialText = statusEl?.text?.trim() ?? '';
		check('C8 precondition: status line shows compacting', initialText.startsWith('Compacting conversation…'));

		const emittedStatuses: string[] = [];
		let sawCompactingWhileEmitted = false;
		state.subscribe(() => {
			composer.setStatusLine(currentStatus(state));
			const text = statusEl?.text?.trim() ?? '';
			emittedStatuses.push(text);
			if (text.includes('Compacting conversation…')) {
				sawCompactingWhileEmitted = true;
			}
		});

		return {
			state,
			reducer,
			container,
			composer,
			statusEl,
			emittedStatuses,
			sawCompactingWhileEmitted: () => sawCompactingWhileEmitted,
		};
	};

	// C8 survival 1: system with subtype status (status: "compacting")
	{
		const { state, reducer, statusEl } = createRig();
		const statusEv = parseStreamJsonLine(
			'{"type":"system","subtype":"status","status":"compacting","session_id":"214d9943-675d-4e9a-a7c7-b3dd55a2c363","uuid":"847bc4b3-1937-4315-b5bd-cb6086c7d99d"}'
		);
		reducer.apply(statusEv!);
		eq('C8 survival: system/status does not clear compacting flag', state.compacting, true);
		check('C8 survival: status line still shows compacting for system/status', (statusEl?.text?.trim() ?? '').startsWith('Compacting conversation…'));
	}

	// C8 survival 2: system with hook_* subtypes (hook_started, hook_progress, hook_response)
	{
		const { state, reducer, statusEl } = createRig();
		const hookStartedEv = parseStreamJsonLine(
			'{"type":"system","subtype":"hook_started","hook_id":"1edaf4d3-f84c-4624-9054-4a7a7290d51f","hook_name":"SessionStart:compact","hook_event":"SessionStart","uuid":"242f6f59-5fee-468a-8dea-ba9b772a82ad","session_id":"32fd66df-10d3-4db6-808d-5b62927361d1"}'
		);
		reducer.apply(hookStartedEv!);
		eq('C8 survival: hook_started does not clear compacting flag', state.compacting, true);

		const hookProgressEv = parseStreamJsonLine(
			'{"type":"system","subtype":"hook_progress","hook_id":"b9abdbb5-1a4b-440d-ac3e-733fcaf9d309","hook_name":"SessionStart:compact","hook_event":"SessionStart","stdout":"","stderr":"","output":"","uuid":"ffd0e41f-bc39-47ef-b8e8-e2c91c4a9b15","session_id":"32fd66df-10d3-4db6-808d-5b62927361d1"}'
		);
		reducer.apply(hookProgressEv!);
		eq('C8 survival: hook_progress does not clear compacting flag', state.compacting, true);

		const hookResponseEv = parseStreamJsonLine(
			'{"type":"system","subtype":"hook_response","hook_id":"42c85ceb-c7b0-4243-9441-e1bf74401b47","hook_name":"SessionStart:compact","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","uuid":"19681699-5f18-4aea-9568-0879badc4434","session_id":"32fd66df-10d3-4db6-808d-5b62927361d1"}'
		);
		reducer.apply(hookResponseEv!);
		eq('C8 survival: hook_response does not clear compacting flag', state.compacting, true);
		check('C8 survival: status line still shows compacting for hook_*', (statusEl?.text?.trim() ?? '').startsWith('Compacting conversation…'));
	}

	// C8 survival 3: rate_limit_event
	{
		const { state, reducer, statusEl } = createRig();
		const rateLimitEv = parseStreamJsonLine(
			'{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1787927400,"rateLimitType":"five_hour","utilization":0.91,"isUsingOverage":false,"surpassedThreshold":0.9,"unifiedWindows":{"five_hour":{"utilization":0.91,"resetsAt":1787927400},"seven_day":{"utilization":0.88,"resetsAt":1788051600}}},"uuid":"02bb3a69-1375-42b3-bd88-d7c281dd0dc2","session_id":"32fd66df-10d3-4db6-808d-5b62927361d1"}'
		);
		reducer.apply(rateLimitEv!);
		eq('C8 survival: rate_limit_event does not clear compacting flag', state.compacting, true);
		check('C8 survival: status line still shows compacting for rate_limit_event', (statusEl?.text?.trim() ?? '').startsWith('Compacting conversation…'));
	}

	// C8 survival 4: control_response
	{
		const { state, reducer, statusEl } = createRig();
		const controlRespEv = parseStreamJsonLine(
			'{"type":"control_response","response":{"subtype":"success","request_id":"guki-int-1","response":{"still_queued":[]}}}'
		);
		reducer.apply(controlRespEv!);
		eq('C8 survival: control_response does not clear compacting flag', state.compacting, true);
		check('C8 survival: status line still shows compacting for control_response', (statusEl?.text?.trim() ?? '').startsWith('Compacting conversation…'));
	}

	// C8 clear 1: assistant
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const asstEv = parseStreamJsonLine(
			'{"type":"assistant","message":{"model":"claude-opus-5","id":"msg-c8-asst","type":"message","role":"assistant","content":[{"type":"text","text":"Authoritative answer"}]}}'
		);
		reducer.apply(asstEv!);
		eq('C8 clear assistant: compacting flag is false', state.compacting, false);
		check(
			'C8 clear assistant: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear assistant: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}

	// C8 clear 2: stream_event (text content_block_start)
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const streamTextEv = parseStreamJsonLine(
			'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}'
		);
		reducer.apply(streamTextEv!);
		eq('C8 clear stream_event text: compacting flag is false', state.compacting, false);
		check(
			'C8 clear stream_event text: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear stream_event text: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}

	// C8 clear 3: stream_event (thinking content_block_start)
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const streamThinkingEv = parseStreamJsonLine(
			'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}'
		);
		reducer.apply(streamThinkingEv!);
		eq('C8 clear stream_event thinking: compacting flag is false', state.compacting, false);
		check(
			'C8 clear stream_event thinking: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear stream_event thinking: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}

	// C8 clear 4: stream_event (tool_use content_block_start)
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const streamToolEv = parseStreamJsonLine(
			'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-c8-leak","name":"Bash","input":{}}}}'
		);
		reducer.apply(streamToolEv!);
		eq('C8 clear stream_event tool_use: compacting flag is false', state.compacting, false);
		check(
			'C8 clear stream_event tool_use: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear stream_event tool_use: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}

	// C8 clear 5: user
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const userEv = parseStreamJsonLine(
			'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"User message"}]}}'
		);
		reducer.apply(userEv!);
		eq('C8 clear user: compacting flag is false', state.compacting, false);
		check(
			'C8 clear user: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear user: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}

	// C8 clear 6: result
	{
		const { state, reducer, statusEl, sawCompactingWhileEmitted, emittedStatuses } = createRig();
		const resultEv = parseStreamJsonLine(
			'{"type":"result","subtype":"success","duration_ms":1000,"total_cost_usd":0.05}'
		);
		reducer.apply(resultEv!);
		eq('C8 clear result: compacting flag is false', state.compacting, false);
		check(
			'C8 clear result: rendered status text does not contain "Compacting conversation…" at any emitted state change',
			!sawCompactingWhileEmitted(),
			`saw compacting in emitted statuses: ${JSON.stringify(emittedStatuses)}`
		);
		check(
			'C8 clear result: final rendered status text does not contain "Compacting conversation…"',
			!(statusEl?.text?.trim() ?? '').includes('Compacting conversation…')
		);
	}
}

// --- AI. Görev 8: DiskTranscriptLoader — DAG branch resolution and paged streaming reads ---

console.log('\nAI. Görev 8: DiskTranscriptLoader (DAG active branch resolution & paged reads)');

const TRANSCRIPT_TEST_DIR = mkdtempSync(join(tmpdir(), 'guki-transcript-checks-'));

// AI1. Synthetic fixture with a fork: abandoned branch must be absent, count lower than total records
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-fork.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'Turn 1 prompt' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant', content: 'Turn 1 answer' } }),
			// Abandoned branch (Fork 1)
			JSON.stringify({ type: 'user', uuid: 'u2-abandoned', parentUuid: 'a1', timestamp: '2026-09-01T10:01:00.000Z', message: { role: 'user', content: 'Fork 1 prompt' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a2-abandoned', parentUuid: 'u2-abandoned', timestamp: '2026-09-01T10:01:05.000Z', message: { role: 'assistant', content: 'Fork 1 answer' } }),
			// Active branch (Fork 2)
			JSON.stringify({ type: 'user', uuid: 'u2-active', parentUuid: 'a1', timestamp: '2026-09-01T10:02:00.000Z', message: { role: 'user', content: 'Fork 2 prompt' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a2-active', parentUuid: 'u2-active', timestamp: '2026-09-01T10:02:05.000Z', message: { role: 'assistant', content: 'Fork 2 answer' } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a2-active', sessionId: 'session-fork' }),
			'',
		].join('\n'),
	);

	const loader = new DiskTranscriptLoader(filePath);
	const branch = await loader.resolveBranch();

	eq('AI1.1 active branch length is 4', branch.activeBranch.length, 4);
	eq('AI1.2 active branch tipUuid is a2-active', branch.tipUuid, 'a2-active');
	eq('AI1.3 fallback was not used', branch.usedFallback, false);
	eq('AI1.4 abandonedRecordCount is 2', branch.abandonedRecordCount, 2);
	check(
		'AI1.5 active count (4) is lower than total conversation records (6)',
		branch.activeBranch.length < 6,
	);
	const activeUuids = branch.activeBranch.map((r) => r.uuid);
	eq('AI1.6 active branch uuids follow root -> tip chain', activeUuids.join(','), 'u1,a1,u2-active,a2-active');
	check('AI1.7 u2-abandoned is absent from active branch', !activeUuids.includes('u2-abandoned'));
	check('AI1.8 a2-abandoned is absent from active branch', !activeUuids.includes('a2-abandoned'));

	const fullRecords = await loader.loadRange(0, 4);
	eq('AI1.9 full record count matches active branch', fullRecords.length, 4);
	eq(
		'AI1.10 full record contents match active branch',
		fullRecords.map((r) => (r.message as { content?: string })?.content).join('|'),
		'Turn 1 prompt|Turn 1 answer|Fork 2 prompt|Fork 2 answer',
	);
}

// AI2. Fixture whose file order contradicts chain order: result must follow chain
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-reordered.jsonl');
	writeFileSync(
		filePath,
		[
			// Reverse order on disk: A2 -> U1 -> A1 -> U2
			JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-09-01T10:00:20.000Z', message: { role: 'assistant', content: 'Fourth' } }),
			JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'First' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant', content: 'Second' } }),
			JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-09-01T10:00:10.000Z', message: { role: 'user', content: 'Third' } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a2', sessionId: 'session-reordered' }),
			'',
		].join('\n'),
	);

	const loader = new DiskTranscriptLoader(filePath);
	const branch = await loader.resolveBranch();

	eq('AI2.1 resolved branch order follows chain causality', branch.activeBranch.map((r) => r.uuid).join(','), 'u1,a1,u2,a2');

	const records = await loader.loadRange(0, 4);
	eq(
		'AI2.2 full records loaded in chain order, NOT file order',
		records.map((r) => (r.message as { content?: string })?.content).join('|'),
		'First|Second|Third|Fourth',
	);
}

// AI3. Edge case: No last-prompt record exists -> fallback to newest leaf with diagnostic
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-no-last-prompt.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:05.000Z' }),
			// Older leaf fork
			JSON.stringify({ type: 'user', uuid: 'u2-old', parentUuid: 'a1', timestamp: '2026-09-01T10:01:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'a2-old', parentUuid: 'u2-old', timestamp: '2026-09-01T10:01:05.000Z' }),
			// Newer leaf fork
			JSON.stringify({ type: 'user', uuid: 'u2-new', parentUuid: 'a1', timestamp: '2026-09-01T10:02:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'a2-new', parentUuid: 'u2-new', timestamp: '2026-09-01T10:02:05.000Z' }),
			// No last-prompt!
			'',
		].join('\n'),
	);

	const branch = await resolveTranscriptBranch(filePath);

	eq('AI3.1 usedFallback is true when last-prompt is missing', branch.usedFallback, true);
	eq('AI3.2 fallbackReason is no-last-prompt', branch.fallbackReason, 'no-last-prompt');
	eq('AI3.3 tipUuid is the leaf with the newest timestamp (a2-new)', branch.tipUuid, 'a2-new');
	eq('AI3.4 active branch follows the newest leaf path', branch.activeBranch.map((r) => r.uuid).join(','), 'u1,a1,u2-new,a2-new');
	eq('AI3.5 older fork records marked abandoned', branch.abandonedRecordCount, 2);
}

// AI4. Edge case: last-prompt points to unknown leafUuid (torn or truncated line)
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-unknown-leaf.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:05.000Z' }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'nonexistent-leaf-uuid', sessionId: 'session-unknown-leaf' }),
			'',
		].join('\n'),
	);

	const branch = await resolveTranscriptBranch(filePath);

	eq('AI4.1 usedFallback is true for unknown leafUuid', branch.usedFallback, true);
	eq('AI4.2 fallbackReason is unknown-leaf-uuid', branch.fallbackReason, 'unknown-leaf-uuid');
	eq('AI4.3 tipUuid falls back to newest available leaf (a1)', branch.tipUuid, 'a1');
	eq('AI4.4 active branch resolves cleanly to a1', branch.activeBranch.map((r) => r.uuid).join(','), 'u1,a1');
}

// AI5. Edge case: Broken parentUuid chain (missing parent) -> returns break to tip, reports break
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-broken-chain.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'u-orphaned-root', timestamp: '2026-09-01T10:00:00.000Z' }),
			// Note: 'missing-asst' record is absent from the file
			JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'missing-asst', timestamp: '2026-09-01T10:01:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-09-01T10:01:05.000Z' }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a2', sessionId: 'session-broken-chain' }),
			'',
		].join('\n'),
	);

	const branch = await resolveTranscriptBranch(filePath);

	check('AI5.1 chainBreak is reported', branch.chainBreak !== undefined);
	eq('AI5.2 chainBreak atUuid is u2', branch.chainBreak?.atUuid, 'u2');
	eq('AI5.3 chainBreak missingParentUuid is missing-asst', branch.chainBreak?.missingParentUuid, 'missing-asst');
	eq('AI5.4 active branch returns portion from break to tip only', branch.activeBranch.map((r) => r.uuid).join(','), 'u2,a2');
	check('AI5.5 orphaned root above break is not returned', !branch.activeBranch.map((r) => r.uuid).includes('u-orphaned-root'));
}

// AI6. Edge case: Cycle in parentUuid -> stops on revisit, does not loop forever
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-cycle.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'node-a', parentUuid: 'node-c', timestamp: '2026-09-01T10:00:00.000Z' }),
			JSON.stringify({ type: 'assistant', uuid: 'node-b', parentUuid: 'node-a', timestamp: '2026-09-01T10:00:05.000Z' }),
			JSON.stringify({ type: 'user', uuid: 'node-c', parentUuid: 'node-b', timestamp: '2026-09-01T10:00:10.000Z' }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'node-c', sessionId: 'session-cycle' }),
			'',
		].join('\n'),
	);

	const branch = await resolveTranscriptBranch(filePath);

	eq('AI6.1 cycleDetected flag is true', branch.cycleDetected, true);
	eq('AI6.2 stops on revisit with exactly 3 nodes', branch.activeBranch.length, 3);
	eq('AI6.3 returned chain contains cycle nodes in walked order', branch.activeBranch.map((r) => r.uuid).join(','), 'node-a,node-b,node-c');
}

// AI7. Edge case: Single unparsable line -> skips line, keeps file
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-unparsable.jsonl');
	writeFileSync(
		filePath,
		[
			JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T10:00:00.000Z' }),
			'{"type":"assistant", broken unparsable json string line',
			JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-01T10:00:05.000Z' }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a1', sessionId: 'session-unparsable' }),
			'',
		].join('\n'),
	);

	const branch = await resolveTranscriptBranch(filePath);

	eq('AI7.1 skippedLines is 1', branch.skippedLines, 1);
	eq('AI7.2 active branch resolves valid records', branch.activeBranch.map((r) => r.uuid).join(','), 'u1,a1');
	eq('AI7.3 totalLines counts all lines', branch.totalLines, 4);
}

// AI8. Edge case: Empty file / missing file / missing directory -> empty result, never throws
{
	// 8a. Empty file
	const emptyPath = join(TRANSCRIPT_TEST_DIR, 'session-empty.jsonl');
	writeFileSync(emptyPath, '');

	const emptyLoader = new DiskTranscriptLoader(emptyPath);
	const emptyBranch = await emptyLoader.resolveBranch();

	eq('AI8.1 empty file active branch length is 0', emptyBranch.activeBranch.length, 0);
	eq('AI8.2 empty file tipUuid is null', emptyBranch.tipUuid, null);
	eq('AI8.3 empty file totalLines is 0', emptyBranch.totalLines, 0);

	const emptyPage = await emptyLoader.loadNewest(10);
	eq('AI8.4 empty file loadNewest records is empty', emptyPage.records.length, 0);
	eq('AI8.5 empty file hasMoreBefore is false', emptyPage.hasMoreBefore, false);

	// 8b. Missing file
	const missingPath = join(TRANSCRIPT_TEST_DIR, 'session-does-not-exist.jsonl');
	const missingLoader = new DiskTranscriptLoader(missingPath);
	const missingBranch = await missingLoader.resolveBranch();

	eq('AI8.6 missing file returns empty active branch', missingBranch.activeBranch.length, 0);
	eq('AI8.7 missing file tipUuid is null', missingBranch.tipUuid, null);

	const missingPage = await missingLoader.loadNewest(5);
	eq('AI8.8 missing file loadNewest does not throw and returns empty', missingPage.records.length, 0);

	// 8c. Missing directory
	const missingDirFile = join(TRANSCRIPT_TEST_DIR, 'nonexistent-subdir', 'session.jsonl');
	const missingDirLoader = new DiskTranscriptLoader(missingDirFile);
	const missingDirBranch = await missingDirLoader.resolveBranch();

	eq('AI8.9 missing directory returns empty active branch', missingDirBranch.activeBranch.length, 0);
	eq('AI8.10 missing directory tipUuid is null', missingDirBranch.tipUuid, null);
}

// AI9. Paging seam: newest N, then N before, with no overlap and no gap
{
	const filePath = join(TRANSCRIPT_TEST_DIR, 'session-paging.jsonl');
	const lines: string[] = [];
	for (let i = 0; i < 10; i++) {
		lines.push(
			JSON.stringify({
				type: i % 2 === 0 ? 'user' : 'assistant',
				uuid: `msg-${String(i)}`,
				parentUuid: i === 0 ? undefined : `msg-${String(i - 1)}`,
				timestamp: `2026-09-01T10:0${String(i)}:00.000Z`,
				message: { content: `Content of message ${String(i)}` },
			}),
		);
	}
	lines.push(JSON.stringify({ type: 'last-prompt', leafUuid: 'msg-9', sessionId: 'session-paging' }));
	lines.push('');
	writeFileSync(filePath, lines.join('\n'));

	const loader = new DiskTranscriptLoader(filePath);

	// Page 1: newest 3 items (indices 7, 8, 9)
	const p1 = await loader.loadNewest(3);
	eq('AI9.1 page 1 record count is 3', p1.records.length, 3);
	eq('AI9.2 page 1 startIndex is 7', p1.startIndex, 7);
	eq('AI9.3 page 1 endIndex is 10', p1.endIndex, 10);
	eq('AI9.4 page 1 hasMoreBefore is true', p1.hasMoreBefore, true);
	eq('AI9.5 page 1 uuids are msg-7,msg-8,msg-9', p1.records.map((r) => r.uuid).join(','), 'msg-7,msg-8,msg-9');

	// Page 2: 3 items before page 1's startIndex (indices 4, 5, 6)
	const p2 = await loader.loadBefore(p1.startIndex, 3);
	eq('AI9.6 page 2 record count is 3', p2.records.length, 3);
	eq('AI9.7 page 2 startIndex is 4', p2.startIndex, 4);
	eq('AI9.8 page 2 endIndex is 7', p2.endIndex, 7);
	eq('AI9.9 page 2 endIndex matches page 1 startIndex (NO GAP, NO OVERLAP)', p2.endIndex, p1.startIndex);
	eq('AI9.10 page 2 hasMoreBefore is true', p2.hasMoreBefore, true);
	eq('AI9.11 page 2 uuids are msg-4,msg-5,msg-6', p2.records.map((r) => r.uuid).join(','), 'msg-4,msg-5,msg-6');

	// Page 3: 3 items before page 2's startIndex (indices 1, 2, 3)
	const p3 = await loader.loadBefore(p2.startIndex, 3);
	eq('AI9.12 page 3 record count is 3', p3.records.length, 3);
	eq('AI9.13 page 3 startIndex is 1', p3.startIndex, 1);
	eq('AI9.14 page 3 endIndex is 4', p3.endIndex, 4);
	eq('AI9.15 page 3 endIndex matches page 2 startIndex (NO GAP, NO OVERLAP)', p3.endIndex, p2.startIndex);
	eq('AI9.16 page 3 hasMoreBefore is true', p3.hasMoreBefore, true);
	eq('AI9.17 page 3 uuids are msg-1,msg-2,msg-3', p3.records.map((r) => r.uuid).join(','), 'msg-1,msg-2,msg-3');

	// Page 4: 3 items requested before page 3's startIndex (1) -> clamped to 1 item (index 0)
	const p4 = await loader.loadBefore(p3.startIndex, 3);
	eq('AI9.18 page 4 record count is clamped to remaining 1', p4.records.length, 1);
	eq('AI9.19 page 4 startIndex is 0', p4.startIndex, 0);
	eq('AI9.20 page 4 endIndex is 1', p4.endIndex, 1);
	eq('AI9.21 page 4 endIndex matches page 3 startIndex', p4.endIndex, p3.startIndex);
	eq('AI9.22 page 4 hasMoreBefore is false at root', p4.hasMoreBefore, false);
	eq('AI9.23 page 4 uuid is msg-0', p4.records.map((r) => r.uuid).join(','), 'msg-0');

	// Page 5: request before index 0 -> returns empty page
	const p5 = await loader.loadBefore(p4.startIndex, 3);
	eq('AI9.24 page 5 record count before 0 is 0', p5.records.length, 0);
	eq('AI9.25 page 5 hasMoreBefore is false', p5.hasMoreBefore, false);

	// Reconstitution: all pages concatenated equal the complete active branch
	const allPagedUuids = [...p4.records, ...p3.records, ...p2.records, ...p1.records].map((r) => r.uuid);
	eq(
		'AI9.26 concatenated pages match full active branch with zero duplicates and zero omissions',
		allPagedUuids.join(','),
		'msg-0,msg-1,msg-2,msg-3,msg-4,msg-5,msg-6,msg-7,msg-8,msg-9',
	);
}

// --- AJ. Görev 8: Title fallback, history list UI, and scrub gitignore reporting ---

console.log('\nAJ. Görev 8: Title fallback, history list UI, and scrub gitignore reporting');

// AJ1. Title fallback & semantic honesty in session-index
{
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-title-fallback-')));

	// File 1: ai-title present wins over user prompt
	writeFileSync(
		join(dir, 'session-ai-title-wins.jsonl'),
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'What is the speed of light?' } }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'Light Speed Calculation', sessionId: 'session-ai-title-wins' }),
			'',
		].join('\n'),
	);

	// File 2: ai-title absent -> derived from first user text (string form)
	writeFileSync(
		join(dir, 'session-derived-string.jsonl'),
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-01T11:00:00.000Z', message: { role: 'user', content: 'Fix the authentication bug' } }),
			'',
		].join('\n'),
	);

	// File 3: content-block array form with text block and non-text image block
	writeFileSync(
		join(dir, 'session-array-blocks.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T12:00:00.000Z',
				message: {
					role: 'user',
					content: [
						{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcd' } },
						{ type: 'text', text: 'Explain the architecture diagram' },
					],
				},
			}),
			'',
		].join('\n'),
	);

	// File 4: non-human/synthetic first message handled: synthetic first message ignored in favor of human message
	writeFileSync(
		join(dir, 'session-synthetic-first.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T13:00:00.000Z',
				origin: { kind: 'synthetic' },
				message: { role: 'user', content: 'Injected system prompt' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T13:00:05.000Z',
				origin: { kind: 'human' },
				promptSource: 'typed',
				message: { role: 'user', content: 'Real human question' },
			}),
			'',
		].join('\n'),
	);

	// File 5: session where all messages are synthetic / tool results -> no derived title
	writeFileSync(
		join(dir, 'session-all-synthetic.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T14:00:00.000Z',
				toolUseResult: true,
				message: { role: 'user', content: 'Tool execution output' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T14:00:05.000Z',
				origin: { kind: 'synthetic' },
				message: { role: 'user', content: 'System message' },
			}),
			'',
		].join('\n'),
	);

	// File 6: no usable text (empty or non-text only) -> no title
	writeFileSync(
		join(dir, 'session-no-text.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T15:00:00.000Z',
				message: {
					role: 'user',
					content: [
						{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } },
					],
				},
			}),
			'',
		].join('\n'),
	);

	// File 7: whitespace and newline collapsing
	writeFileSync(
		join(dir, 'session-whitespace.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T16:00:00.000Z',
				message: { role: 'user', content: '   hello  \n\n\t world\r\n   from\t\tprompt   ' },
			}),
			'',
		].join('\n'),
	);

	// File 8: over-length trimming (longer than 60 chars)
	writeFileSync(
		join(dir, 'session-overlength.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-01T17:00:00.000Z',
				message: {
					role: 'user',
					content: 'This is an exceedingly long user prompt that contains far more than sixty characters and must be trimmed cleanly',
				},
			}),
			'',
		].join('\n'),
	);

	const sessions = await scanSessionsDir(dir);

	const aiTitleWins = sessions.find((s) => s.sessionId === 'session-ai-title-wins');
	eq('AJ1.1 ai-title present wins: title is set', aiTitleWins?.title, 'Light Speed Calculation');
	eq('AJ1.2 ai-title present wins: derivedTitle is undefined', aiTitleWins?.derivedTitle, undefined);

	const derivedStr = sessions.find((s) => s.sessionId === 'session-derived-string');
	eq('AJ1.3 ai-title absent: title is undefined', derivedStr?.title, undefined);
	eq('AJ1.4 ai-title absent: derivedTitle comes from first user text', derivedStr?.derivedTitle, 'Fix the authentication bug');

	// Semantic honesty / real vs derived distinction
	const dtReal = sessionDisplayTitle(aiTitleWins!);
	eq('AJ1.5 real title distinction: isDerived is false', dtReal?.isDerived, false);
	eq('AJ1.6 real title distinction: text is ai-title', dtReal?.text, 'Light Speed Calculation');
	const dtDerived = sessionDisplayTitle(derivedStr!);
	eq('AJ1.7 derived title distinction: isDerived is true', dtDerived?.isDerived, true);
	eq('AJ1.8 derived title distinction: text is derivedTitle', dtDerived?.text, 'Fix the authentication bug');

	const arrayBlocks = sessions.find((s) => s.sessionId === 'session-array-blocks');
	eq('AJ1.9 content-block array form: non-text ignored, text extracted', arrayBlocks?.derivedTitle, 'Explain the architecture diagram');

	const syntheticFirst = sessions.find((s) => s.sessionId === 'session-synthetic-first');
	eq('AJ1.10 non-human synthetic first message skipped, human message preferred', syntheticFirst?.derivedTitle, 'Real human question');

	const allSynthetic = sessions.find((s) => s.sessionId === 'session-all-synthetic');
	eq('AJ1.11 all synthetic / tool records yield no derived title', allSynthetic?.derivedTitle, undefined);

	const noText = sessions.find((s) => s.sessionId === 'session-no-text');
	eq('AJ1.12 no usable text yields undefined title', noText?.title, undefined);
	eq('AJ1.13 no usable text yields undefined derivedTitle', noText?.derivedTitle, undefined);
	eq('AJ1.14 sessionDisplayTitle on no usable text returns null', sessionDisplayTitle(noText!), null);

	const whitespace = sessions.find((s) => s.sessionId === 'session-whitespace');
	eq('AJ1.15 whitespace and newlines collapsed to single spaces', whitespace?.derivedTitle, 'hello world from prompt');

	const overlength = sessions.find((s) => s.sessionId === 'session-overlength');
	eq('AJ1.16 over-length trimming: length is capped at MAX_DERIVED_TITLE_LENGTH', overlength?.derivedTitle?.length, MAX_DERIVED_TITLE_LENGTH);
	eq('AJ1.17 over-length trimming: matches prefix slice of 60 characters', overlength?.derivedTitle, 'This is an exceedingly long user prompt that contains far mo');

	rmSync(dir, { recursive: true, force: true });
}

// AJ2. History List UI data shaping & keyboard handling
{
	// 2.1 Data shaping: ordering preserved, missing cost handled
	const summaryWithCost: SessionSummary = {
		sessionId: 'sess-1',
		title: 'Real Title',
		startedAt: '2026-09-01T10:00:00.000Z',
		costUsd: 0.1234,
	};
	const summaryWithoutCost: SessionSummary = {
		sessionId: 'sess-2',
		derivedTitle: 'Derived Title',
		startedAt: '2026-08-30T15:30:00.000Z',
	};
	const summaryUntitled: SessionSummary = {
		sessionId: 'sess-3',
		startedAt: '2026-08-25T08:00:00.000Z',
	};

	const row1 = shapeSessionRow(summaryWithCost);
	eq('AJ2.1 shapeSessionRow real title used', row1.title, 'Real Title');
	eq('AJ2.2 shapeSessionRow real title isDerivedTitle is false', row1.isDerivedTitle, false);
	eq('AJ2.3 shapeSessionRow cost formatted as $0.12', row1.costText, '$0.12');
	eq('AJ2.4 shapeSessionRow date formatted', row1.dateText, formatSessionDate('2026-09-01T10:00:00.000Z'));

	const row2 = shapeSessionRow(summaryWithoutCost);
	eq('AJ2.5 shapeSessionRow derived title used', row2.title, 'Derived Title');
	eq('AJ2.6 shapeSessionRow derived title isDerivedTitle is true', row2.isDerivedTitle, true);
	eq('AJ2.7 shapeSessionRow missing cost is null', row2.costText, null);

	const row3 = shapeSessionRow(summaryUntitled);
	eq('AJ2.8 shapeSessionRow untitled fallback used when no title exists', row3.title, 'Untitled session');
	eq('AJ2.9 shapeSessionRow untitled cost is null', row3.costText, null);

	// 2.2 Ordering preserved in HistoryDropdown
	const orderedSummaries = [summaryWithCost, summaryWithoutCost, summaryUntitled];
	let selectedSessionId: string | null = null;
	const container = new FakeElement() as any;
	const dropdown = new HistoryDropdown({
		containerEl: container,
		getSessions: async () => orderedSummaries,
		onSelectSession: (id) => {
			selectedSessionId = id;
		},
	});

	await dropdown.openDropdown();
	eq('AJ2.10 dropdown isOpen is true after openDropdown', dropdown.isOpen(), true);
	eq('AJ2.11 dropdown item count matches input summaries', dropdown.getItems().length, 3);
	eq('AJ2.12 ordering preserved: first item is sess-1', dropdown.getItems()[0]?.sessionId, 'sess-1');
	eq('AJ2.13 ordering preserved: second item is sess-2', dropdown.getItems()[1]?.sessionId, 'sess-2');
	eq('AJ2.14 ordering preserved: third item is sess-3', dropdown.getItems()[2]?.sessionId, 'sess-3');

	// Check DOM elements rendered
	const dropdownEl = dropdown.getDropdownEl() as any;
	const renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	eq('AJ2.15 rendered row count is 3', renderedRows.length, 3);

	const costElPresent = renderedRows[0]?.querySelector('.guki-history-cost');
	check('AJ2.16 first row has cost element', costElPresent !== null);
	eq('AJ2.17 first row cost element displays $0.12', costElPresent?.text, '$0.12');

	const costElAbsent = renderedRows[1]?.querySelector('.guki-history-cost');
	check('AJ2.18 second row has NO cost element (clean visual, not broken)', costElAbsent === null);

	// 2.3 Keyboard navigation: ArrowDown, ArrowUp, Escape, Enter
	eq('AJ2.19 initial selectedIndex is 0', dropdown.getSelectedIndex(), 0);
	dropdown.handleKeyDown({ key: 'ArrowDown', preventDefault: () => {} } as any);
	eq('AJ2.20 ArrowDown advances selectedIndex to 1', dropdown.getSelectedIndex(), 1);
	dropdown.handleKeyDown({ key: 'ArrowDown', preventDefault: () => {} } as any);
	eq('AJ2.21 ArrowDown advances selectedIndex to 2', dropdown.getSelectedIndex(), 2);
	dropdown.handleKeyDown({ key: 'ArrowUp', preventDefault: () => {} } as any);
	eq('AJ2.22 ArrowUp moves selectedIndex back to 1', dropdown.getSelectedIndex(), 1);

	dropdown.handleKeyDown({ key: 'Enter', preventDefault: () => {} } as any);
	eq('AJ2.23 Enter emits selection of active row (sess-2)', selectedSessionId, 'sess-2');
	eq('AJ2.24 Enter closes dropdown', dropdown.isOpen(), false);

	// Escape closes
	await dropdown.openDropdown();
	eq('AJ2.25 reopened dropdown isOpen is true', dropdown.isOpen(), true);
	dropdown.handleKeyDown({ key: 'Escape', preventDefault: () => {} } as any);
	eq('AJ2.26 Escape closes dropdown', dropdown.isOpen(), false);

	// 2.4 Empty list state
	const emptyContainer = new FakeElement() as any;
	const emptyDropdown = new HistoryDropdown({
		containerEl: emptyContainer,
		getSessions: async () => [],
		onSelectSession: () => {},
	});
	await emptyDropdown.openDropdown();
	eq('AJ2.27 empty list dropdown isOpen is true', emptyDropdown.isOpen(), true);
	eq('AJ2.28 empty list has 0 items', emptyDropdown.getItems().length, 0);
	const emptyEl = (emptyDropdown.getDropdownEl() as any).querySelector('.guki-history-empty');
	check('AJ2.29 empty state element exists', emptyEl !== null);
	eq('AJ2.30 empty state text explains vault has no past sessions', emptyEl?.text, 'No past conversations found in this vault.');
	emptyDropdown.close();
}

// AJ3. scrub-capture.py gitignored file reporting and exit codes
{
	// 3.1 Gitignored file reported as skipped
	const resIgnored = spawnSync('python3', ['docs/scrub-capture.py', '--check', 'docs/NEXT.md'], { encoding: 'utf8' });
	eq('AJ3.1 gitignored file exits 0 during check', resIgnored.status, 0);
	check('AJ3.2 gitignored file output explicitly reports skipped', resIgnored.stdout.includes('docs/NEXT.md: skipped'));

	// 3.2 Clean non-ignored file exits 0 and reports clean
	const resClean = spawnSync('python3', ['docs/scrub-capture.py', '--check', 'docs/capture-phase8-resume.jsonl'], { encoding: 'utf8' });
	eq('AJ3.3 clean file exits 0 during check', resClean.status, 0);
	check('AJ3.4 clean file output reports clean', resClean.stdout.includes('docs/capture-phase8-resume.jsonl: clean'));

	// 3.3 Dirty file exits 1 and reports dirty
	const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-scrub-')));
	const dirtyCapturePath = join(tempDir, 'dirty.jsonl');
	writeFileSync(
		dirtyCapturePath,
		JSON.stringify({
			type: 'system',
			subtype: 'init',
			plugins: ['personal-plugin-leak'],
		}) + '\n',
	);
	const resDirty = spawnSync('python3', ['docs/scrub-capture.py', '--check', dirtyCapturePath], { encoding: 'utf8' });
	eq('AJ3.5 dirty file exits 1 during check', resDirty.status, 1);
	check('AJ3.6 dirty file output reports DIRTY', resDirty.stdout.includes('DIRTY'));

	// 3.4 Combined check with both a skipped file and a clean file exits 0
	const resCombinedClean = spawnSync('python3', ['docs/scrub-capture.py', '--check', 'docs/NEXT.md', 'docs/capture-phase8-resume.jsonl'], { encoding: 'utf8' });
	eq('AJ3.7 combined skipped and clean files exit 0', resCombinedClean.status, 0);
	check('AJ3.8 combined output reports skipped for gitignored file', resCombinedClean.stdout.includes('docs/NEXT.md: skipped'));
	check('AJ3.9 combined output reports clean for clean file', resCombinedClean.stdout.includes('docs/capture-phase8-resume.jsonl: clean'));

	// 3.5 Combined check with a skipped file and a dirty file exits 1
	const resCombinedDirty = spawnSync('python3', ['docs/scrub-capture.py', '--check', 'docs/NEXT.md', dirtyCapturePath], { encoding: 'utf8' });
	eq('AJ3.10 combined skipped and dirty files exit 1', resCombinedDirty.status, 1);
	check('AJ3.11 combined dirty output still reports skipped for gitignored file', resCombinedDirty.stdout.includes('docs/NEXT.md: skipped'));
	check('AJ3.12 combined dirty output reports DIRTY for dirty file', resCombinedDirty.stdout.includes('DIRTY'));

	rmSync(tempDir, { recursive: true, force: true });
}

// AJ4. Real-world record shape fixtures and defect regressions
{
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-shapes-')));

	// Defect 1 unit checks: toolUseResult presence (object, str, list variants)
	// Real corpus measurement (21,059 user records across 1,194 sessions):
	// toolUseResult is present on 17,151 records (15,496 dicts, 1,617 strs, 38 lists) and is NEVER boolean true.
	const toolObjRecord: Record<string, unknown> = {
		type: 'user',
		toolUseResult: { stdout: 'invented tool output' },
		message: { role: 'user', content: 'Invented tool output text' },
	};
	const toolStrRecord: Record<string, unknown> = {
		type: 'user',
		toolUseResult: 'invented tool error string',
		message: { role: 'user', content: 'Invented tool error text' },
	};
	const toolListRecord: Record<string, unknown> = {
		type: 'user',
		toolUseResult: [{ text: 'invented list output' }],
		message: { role: 'user', content: 'Invented list output text' },
	};

	eq('AJ4.1 defect 1: extractUserPromptText returns undefined for real object toolUseResult', extractUserPromptText(toolObjRecord), undefined);
	eq('AJ4.2 defect 1: isSyntheticUser returns true for real object toolUseResult', isSyntheticUser(toolObjRecord), true);
	eq('AJ4.3 defect 1: isExplicitHumanUser returns false for real object toolUseResult', isExplicitHumanUser(toolObjRecord), false);
	eq('AJ4.4 extractUserPromptText returns undefined for string toolUseResult variant', extractUserPromptText(toolStrRecord), undefined);
	eq('AJ4.5 extractUserPromptText returns undefined for list toolUseResult variant', extractUserPromptText(toolListRecord), undefined);

	// Defect 3 unit checks: isMeta presence
	// Real corpus measurement: isMeta is boolean true on 317 records, absent on 20,742 records.
	const metaRecord: Record<string, unknown> = {
		type: 'user',
		isMeta: true,
		message: { role: 'user', content: 'Invented skill instructions metadata prompt' },
	};
	eq('AJ4.6 defect 3: extractUserPromptText returns undefined for isMeta record', extractUserPromptText(metaRecord), undefined);
	eq('AJ4.7 defect 3: isSyntheticUser returns true for isMeta record', isSyntheticUser(metaRecord), true);
	eq('AJ4.8 defect 3: isExplicitHumanUser returns false for isMeta record', isExplicitHumanUser(metaRecord), false);

	// Real-world origin variants
	// Real corpus measurement: absent on 19,126, human on 1,737, task-notification on 191, auto-continuation on 5.
	const originTaskRecord: Record<string, unknown> = {
		type: 'user',
		origin: { kind: 'task-notification' },
		message: { role: 'user', content: 'Invented task completion notification' },
	};
	const originAutoRecord: Record<string, unknown> = {
		type: 'user',
		origin: { kind: 'auto-continuation' },
		message: { role: 'user', content: 'Invented auto continuation prompt' },
	};
	eq('AJ4.9 origin variant: isSyntheticUser returns true for task-notification', isSyntheticUser(originTaskRecord), true);
	eq('AJ4.10 origin variant: isSyntheticUser returns true for auto-continuation', isSyntheticUser(originAutoRecord), true);

	// Real-world isCompactSummary variant
	// Real corpus measurement: isCompactSummary is boolean true on 27 records.
	const compactRecord: Record<string, unknown> = {
		type: 'user',
		isCompactSummary: true,
		message: { role: 'user', content: 'Invented conversation compaction summary' },
	};
	eq('AJ4.11 compact variant: extractUserPromptText returns undefined', extractUserPromptText(compactRecord), undefined);
	eq('AJ4.12 compact variant: isSyntheticUser returns true', isSyntheticUser(compactRecord), true);

	// Real-world promptSource variants
	// Real corpus measurement: typed (1,301), sdk (1,782), system (158), suggestion_accepted (18), queued (9), absent (17,791).
	const typedRecord: Record<string, unknown> = {
		type: 'user',
		promptSource: 'typed',
		message: { role: 'user', content: 'Invented typed query' },
	};
	const sdkRecord: Record<string, unknown> = {
		type: 'user',
		origin: { kind: 'human' },
		promptSource: 'sdk',
		message: { role: 'user', content: 'Invented sdk query' },
	};
	eq('AJ4.13 promptSource variant: isExplicitHumanUser returns true for typed', isExplicitHumanUser(typedRecord), true);
	eq('AJ4.14 promptSource variant: isExplicitHumanUser returns true for sdk with human origin', isExplicitHumanUser(sdkRecord), true);

	// Real-world content block variants (tool_result, text, image, document)
	// Real corpus measurement: 17,151 tool_result, 1,344 text, 181 image, 4 document blocks.
	const docBlockRecord: Record<string, unknown> = {
		type: 'user',
		message: {
			role: 'user',
			content: [
				{ type: 'document', title: 'spec' },
				{ type: 'text', text: 'Invented document analysis query' },
			],
		},
	};
	eq('AJ4.15 content block variant: document block ignored, text block extracted', extractUserPromptText(docBlockRecord), 'Invented document analysis query');

	// Session-level files in dir:
	// File A (Defect 1 session test): first turn is a toolUseResult object with text block; second turn is real human prompt
	writeFileSync(
		join(dir, 'session-defect1-tool-object.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T10:00:00.000Z',
				toolUseResult: { stdout: 'invented compiler output', exitCode: 0 },
				message: { role: 'user', content: 'invented compiler output' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T10:00:05.000Z',
				message: { role: 'user', content: 'Invented subsequent question after tool result' },
			}),
			'',
		].join('\n'),
	);

	// File B (Defect 2 session test): Turn 1 has no origin metadata (candidate), Turn 2 has origin: { kind: "human" }
	// Rule: once an acceptable first message is found, later messages cannot replace it.
	writeFileSync(
		join(dir, 'session-defect2-turn-order.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T11:00:00.000Z',
				message: { role: 'user', content: 'Invented first question without origin metadata' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T11:00:05.000Z',
				origin: { kind: 'human' },
				promptSource: 'typed',
				message: { role: 'user', content: 'Invented second question with human origin' },
			}),
			'',
		].join('\n'),
	);

	// File C (Defect 3 session test): Turn 1 isMeta: true, Turn 2 is real user question
	writeFileSync(
		join(dir, 'session-defect3-is-meta.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T12:00:00.000Z',
				isMeta: true,
				message: { role: 'user', content: 'Invented skill instructions metadata prompt' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T12:00:05.000Z',
				message: { role: 'user', content: 'Invented actual user question' },
			}),
			'',
		].join('\n'),
	);

	// File D: Session where only user record is isMeta: true -> derived title is undefined
	writeFileSync(
		join(dir, 'session-only-meta.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T13:00:00.000Z',
				isMeta: true,
				message: { role: 'user', content: 'Invented metadata only prompt' },
			}),
			'',
		].join('\n'),
	);

	// File E: Session where only user record has real toolUseResult object -> derived title is undefined
	writeFileSync(
		join(dir, 'session-only-tool-obj.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T14:00:00.000Z',
				toolUseResult: { status: 'complete' },
				message: { role: 'user', content: 'Invented solitary tool output' },
			}),
			'',
		].join('\n'),
	);

	// File F: Session with task-notification origin followed by human prompt
	writeFileSync(
		join(dir, 'session-task-notification.jsonl'),
		[
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T15:00:00.000Z',
				origin: { kind: 'task-notification' },
				message: { role: 'user', content: 'Invented task notification body' },
			}),
			JSON.stringify({
				type: 'user',
				timestamp: '2026-09-02T15:00:05.000Z',
				message: { role: 'user', content: 'Invented user prompt after notification' },
			}),
			'',
		].join('\n'),
	);

	const realShapeSessions = await scanSessionsDir(dir);

	const sToolObj = realShapeSessions.find((s) => s.sessionId === 'session-defect1-tool-object');
	eq('AJ4.16 defect 1: session skips object toolUseResult and derives title from subsequent prompt', sToolObj?.derivedTitle, 'Invented subsequent question after tool result');

	const sOrder = realShapeSessions.find((s) => s.sessionId === 'session-defect2-turn-order');
	eq('AJ4.17 defect 2: first usable prompt without origin is not replaced by later human turn', sOrder?.derivedTitle, 'Invented first question without origin metadata');

	const sMeta = realShapeSessions.find((s) => s.sessionId === 'session-defect3-is-meta');
	eq('AJ4.18 defect 3: session skips isMeta and derives title from subsequent prompt', sMeta?.derivedTitle, 'Invented actual user question');

	const sOnlyMeta = realShapeSessions.find((s) => s.sessionId === 'session-only-meta');
	eq('AJ4.19 defect 3: session with only isMeta records yields undefined derivedTitle', sOnlyMeta?.derivedTitle, undefined);

	const sOnlyTool = realShapeSessions.find((s) => s.sessionId === 'session-only-tool-obj');
	eq('AJ4.20 defect 1: session with only object toolUseResult yields undefined derivedTitle', sOnlyTool?.derivedTitle, undefined);

	const sTaskNotif = realShapeSessions.find((s) => s.sessionId === 'session-task-notification');
	eq('AJ4.21 task-notification skipped, subsequent user prompt derived', sTaskNotif?.derivedTitle, 'Invented user prompt after notification');

	rmSync(dir, { recursive: true, force: true });
}

console.log('\nAK. Görev 8: On-disk transcript to ChatItem translation, sidecars, and readSession');

// AK1: One per ChatItem variant in the mappability table, built from measured real shapes
{
	console.log('AK1. Mappability table ChatItem variants from measured real shapes');

	const userTextRec = {
		type: 'user',
		uuid: 'u-text-1',
		parentUuid: undefined,
		timestamp: '2026-09-14T10:00:00.000Z',
		message: {
			role: 'user',
			content: 'Invented user question text for testing',
		},
	};

	const userImgRec = {
		type: 'user',
		uuid: 'u-img-1',
		parentUuid: 'u-text-1',
		timestamp: '2026-09-14T10:00:05.000Z',
		message: {
			role: 'user',
			content: [
				{ type: 'text', text: 'Invented text preceding image' },
				{
					type: 'image',
					source: {
						type: 'base64',
						media_type: 'image/png',
						data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
					},
				},
			],
		},
	};

	const asstRec = {
		type: 'assistant',
		uuid: 'a-1',
		parentUuid: 'u-img-1',
		timestamp: '2026-09-14T10:00:10.000Z',
		message: {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: '', signature: 'invented-sig-1' },
				{
					type: 'tool_use',
					id: 'toolu_1',
					name: 'Glob',
					input: { pattern: '*.md' },
				},
				{ type: 'text', text: 'Invented assistant concluding answer' },
			],
		},
	};

	const toolResultRec = {
		type: 'user',
		uuid: 'u-res-1',
		parentUuid: 'a-1',
		timestamp: '2026-09-14T10:00:12.000Z',
		toolUseResult: { status: 'success' },
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_1',
					content: 'file1.md\nfile2.md',
				},
			],
		},
	};

	const dividerRec = {
		type: 'system',
		subtype: 'compact_boundary',
		uuid: 'div-1',
		parentUuid: 'u-res-1',
		timestamp: '2026-09-14T10:00:15.000Z',
		compactMetadata: {
			preTokens: 10000,
			postTokens: 2000,
			durationMs: 15000,
		},
	};

	const asstAskRec = {
		type: 'assistant',
		uuid: 'a-ask-1',
		parentUuid: 'div-1',
		timestamp: '2026-09-14T10:00:20.000Z',
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_ask_1',
					name: 'AskUserQuestion',
					input: {
						questions: [
							{
								question: 'Invented question: proceed with changes?',
								header: 'Confirmation',
								options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }],
							},
						],
					},
				},
			],
		},
	};

	const toolResultAskRec = {
		type: 'user',
		uuid: 'u-ask-res-1',
		parentUuid: 'a-ask-1',
		timestamp: '2026-09-14T10:00:25.000Z',
		toolUseResult: { status: 'success' },
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_ask_1',
					content: 'The user answered: "Invented question: proceed with changes?"="Yes". You can now continue.',
				},
			],
		},
	};

	const items = await translateTranscriptRecords([
		userTextRec,
		userImgRec,
		asstRec,
		toolResultRec,
		dividerRec,
		asstAskRec,
		toolResultAskRec,
	]);

	const uText = items.find((it): it is UserItem => it.kind === 'user' && it.id === 'u-text-1');
	check('AK1.1 UserItem text mapped from string content', uText !== undefined && uText.text === 'Invented user question text for testing');

	const uImg = items.find((it): it is UserItem => it.kind === 'user' && it.id === 'u-img-1');
	check('AK1.2 UserItem with image has images array', uImg !== undefined && Array.isArray(uImg.images) && uImg.images.length === 1);
	eq('AK1.3 UserItem synthetic displayName image-1.png', uImg?.images?.[0]?.displayName, 'image-1.png');
	eq('AK1.4 UserItem image mediaType image/png', uImg?.images?.[0]?.mediaType, 'image/png');

	const asst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-1');
	check('AK1.5 AssistantItem mapped directly from uuid', asst !== undefined && asst.id === 'a-1');
	eq('AK1.6 AssistantItem historical status is complete', asst?.status, 'complete');
	eq('AK1.7 AssistantItem blocks count is 3', asst?.blocks.size, 3);
	eq('AK1.8 AssistantItem block 0 is thinking', asst?.blocks.get(0)?.kind, 'thinking');
	eq('AK1.9 AssistantItem block 1 is tool_use', asst?.blocks.get(1)?.kind, 'tool_use');
	eq('AK1.10 AssistantItem block 1 toolResultText matches inline result', asst?.blocks.get(1)?.toolResultText, 'file1.md\nfile2.md');
	eq('AK1.11 AssistantItem block 2 is text', asst?.blocks.get(2)?.kind, 'text');

	const div = items.find((it): it is DividerItem => it.kind === 'divider');
	check('AK1.12 DividerItem mapped from compact_boundary', div !== undefined && div.id === 'div-1');
	eq('AK1.13 DividerItem text is Conversation compacted', div?.text, 'Conversation compacted');

	const perm = items.find((it): it is PermissionItem => it.kind === 'permission');
	check('AK1.14 PermissionItem produced for AskUserQuestion', perm !== undefined && perm.toolName === 'AskUserQuestion');
	eq('AK1.15 PermissionItem status is allowed', perm?.status, 'allowed');
	eq('AK1.16 PermissionItem question extracted', perm?.askQuestions?.[0]?.question, 'Invented question: proceed with changes?');
	eq('AK1.17 PermissionItem answer extracted', perm?.answers?.['Invented question: proceed with changes?'], 'Yes');
}

// AK2: The absences asserted as absences
{
	console.log('AK2. Absences asserted as absences');

	const userRec = {
		type: 'user',
		uuid: 'u-abs-1',
		message: { role: 'user', content: 'Invented question' },
	};
	const asstRec = {
		type: 'assistant',
		uuid: 'a-abs-1',
		parentUuid: 'u-abs-1',
		message: { role: 'assistant', content: [{ type: 'text', text: 'Invented reply' }] },
	};
	const divRec = {
		type: 'system',
		subtype: 'compact_boundary',
		uuid: 'div-abs-1',
		parentUuid: 'a-abs-1',
		compactMetadata: { durationMs: 99999 },
	};
	const asstWithDurRec = {
		type: 'assistant',
		uuid: 'a-dur-1',
		parentUuid: 'div-abs-1',
		message: { role: 'assistant', content: [{ type: 'text', text: 'Invented reply with duration' }] },
	};
	const durRec = {
		type: 'system',
		subtype: 'turn_duration',
		uuid: 's-dur-1',
		parentUuid: 'a-dur-1',
		durationMs: 4500,
	};
	const permToolRec = {
		type: 'assistant',
		uuid: 'a-perm-1',
		parentUuid: 's-dur-1',
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_abs_perm',
					name: 'AskUserQuestion',
					input: { questions: [{ question: 'Invented?' }] },
				},
			],
		},
	};

	const items = await translateTranscriptRecords([
		userRec,
		asstRec,
		divRec,
		asstWithDurRec,
		durRec,
		permToolRec,
	]);

	const u = items.find((it): it is UserItem => it.kind === 'user');
	const asstNoDur = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-abs-1');
	const div = items.find((it): it is DividerItem => it.kind === 'divider');
	const asstDur = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-dur-1');
	const perm = items.find((it): it is PermissionItem => it.kind === 'permission');

	check('AK2.1 user item has no costUsd', (u as Record<string, unknown>)?.costUsd === undefined);
	check('AK2.2 assistant without duration has no meta costUsd', asstNoDur?.meta?.costUsd === undefined);
	check('AK2.3 divider item has no costUsd', (div as Record<string, unknown>)?.costUsd === undefined);
	check('AK2.4 permission item has no costUsd', (perm as Record<string, unknown>)?.costUsd === undefined);

	check('AK2.5 assistant without turn_duration leaves durationMs undefined', asstNoDur?.meta?.durationMs === undefined);
	check('AK2.6 assistant without turn_duration leaves meta undefined entirely', asstNoDur?.meta === undefined);

	eq('AK2.7 duration present where turn_duration links via parentUuid', asstDur?.meta?.durationMs, 4500);
	check('AK2.8 assistant with duration still has no costUsd', asstDur?.meta?.costUsd === undefined);

	check('AK2.9 divider has no durationMs', (div as Record<string, unknown>)?.durationMs === undefined);
}

// AK3: Thinking block handling (empty vs non-empty)
{
	console.log('AK3. Thinking block empty vs non-empty');

	const user1 = { type: 'user', uuid: 'u-think-1', message: { role: 'user', content: 'Invented question 1' } };
	const asstEmptyThinking = {
		type: 'assistant',
		uuid: 'a-think-empty',
		parentUuid: 'u-think-1',
		message: {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: '', signature: 'sig-empty' },
				{ type: 'text', text: 'Invented answer after empty thinking' },
			],
		},
	};
	const user2 = { type: 'user', uuid: 'u-think-2', parentUuid: 'a-think-empty', message: { role: 'user', content: 'Invented question 2' } };
	const asstNonEmptyThinking = {
		type: 'assistant',
		uuid: 'a-think-nonempty',
		parentUuid: 'u-think-2',
		message: {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'Invented thought process monologue', signature: 'sig-nonempty' },
				{ type: 'text', text: 'Invented answer after non-empty thinking' },
			],
		},
	};

	const items = await translateTranscriptRecords([user1, asstEmptyThinking, user2, asstNonEmptyThinking]);

	const emptyAsst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-think-empty');
	const emptyBlock = emptyAsst?.blocks.get(0);
	eq('AK3.1 empty thinking block renders text as empty string', emptyBlock?.text, '');
	eq('AK3.2 empty thinking block kind is thinking', emptyBlock?.kind, 'thinking');
	check('AK3.3 empty thinking block timing startedAt is undefined', emptyBlock?.startedAt === undefined);

	const nonEmptyAsst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-think-nonempty');
	const nonEmptyBlock = nonEmptyAsst?.blocks.get(0);
	eq('AK3.4 non-empty thinking block renders text as-is', nonEmptyBlock?.text, 'Invented thought process monologue');
	eq('AK3.5 non-empty thinking block kind is thinking', nonEmptyBlock?.kind, 'thinking');
}

// AK4: Sidecar tool result reading
{
	console.log('AK4. Sidecar tool results reading');

	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-sidecar-')));
	const toolResultsDir = join(dir, 'tool-results');
	mkdirSync(toolResultsDir, { recursive: true });

	const sidecarFilePath = join(toolResultsDir, 'toolu_sc_1.txt');
	writeFileSync(sidecarFilePath, 'Invented large tool output read from disk sidecar file');

	const asstRec = {
		type: 'assistant',
		uuid: 'a-sidecar-1',
		message: {
			role: 'assistant',
			content: [
				{ type: 'tool_use', id: 'toolu_sc_1', name: 'Bash', input: { command: 'test' } },
				{ type: 'tool_use', id: 'toolu_sc_missing', name: 'Bash', input: { command: 'test2' } },
			],
		},
	};

	const userResultPresent = {
		type: 'user',
		uuid: 'u-sc-1',
		toolUseResult: { status: 'success' },
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_sc_1',
					content: `<persisted-output>\nOutput too large (55KB). Full output saved to: ${sidecarFilePath}\n\nPreview (first 2KB):\nInvented preview output text\n</persisted-output>`,
				},
				{
					type: 'tool_result',
					tool_use_id: 'toolu_sc_missing',
					content: `<persisted-output>\nOutput too large (55KB). Full output saved to: ${join(toolResultsDir, 'toolu_sc_nonexistent.txt')}\n\nPreview (first 2KB):\nInvented fallback preview text\n</persisted-output>`,
				},
			],
		},
	};

	let sidecarReadCount = 0;
	const items = await translateTranscriptRecords([asstRec, userResultPresent], {
		sessionDir: dir,
		onSidecarRead: () => {
			sidecarReadCount++;
		},
	});

	const asst = items.find((it): it is AssistantItem => it.kind === 'assistant');
	const bPresent = asst?.blocks.get(0);
	const bMissing = asst?.blocks.get(1);

	eq('AK4.1 present sidecar file is read in full', bPresent?.toolResultText, 'Invented large tool output read from disk sidecar file');
	eq('AK4.2 missing sidecar file falls back to embedded preview', bMissing?.toolResultText, 'Invented fallback preview text');
	eq('AK4.3 exactly one sidecar file was read from disk', sidecarReadCount, 1);

	// Untouched records test: record whose sidecar is never requested causes 0 reads
	let untouchedReadCount = 0;
	const plainAsst = {
		type: 'assistant',
		uuid: 'a-plain-1',
		message: {
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_plain', name: 'Glob', input: {} }],
		},
	};
	const plainResult = {
		type: 'user',
		uuid: 'u-plain-1',
		toolUseResult: { status: 'success' },
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_plain', content: 'inline-content' }],
		},
	};
	await translateTranscriptRecords([plainAsst, plainResult], {
		sessionDir: dir,
		onSidecarRead: () => {
			untouchedReadCount++;
		},
	});
	eq('AK4.4 record without sidecar causes zero sidecar reads', untouchedReadCount, 0);

	rmSync(dir, { recursive: true, force: true });
}

// AK5: Denied tool, cancelled turn, AskUserQuestion summary
{
	console.log('AK5. Denied tool, cancelled turn, AskUserQuestion summary');

	const userPrompt1 = { type: 'user', uuid: 'u-prompt-1', message: { role: 'user', content: 'Invented prompt 1' } };
	const asstDeniedRec = {
		type: 'assistant',
		uuid: 'a-denied-1',
		parentUuid: 'u-prompt-1',
		message: {
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_denied_1', name: 'Write', input: { path: 'foo.txt' } }],
		},
	};
	const userDeniedRec = {
		type: 'user',
		uuid: 'u-denied-1',
		parentUuid: 'a-denied-1',
		toolUseResult: { status: 'error' },
		toolDenialKind: 'user-rejected',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_denied_1',
					is_error: true,
					content: 'User rejected the write operation.',
				},
			],
		},
	};

	const userPrompt2 = { type: 'user', uuid: 'u-prompt-2', parentUuid: 'u-denied-1', message: { role: 'user', content: 'Invented prompt 2' } };
	const asstCancelledRec = {
		type: 'assistant',
		uuid: 'a-cancelled-1',
		parentUuid: 'u-prompt-2',
		message: {
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_cancelled_1', name: 'Bash', input: { command: 'sleep 10' } }],
		},
	};
	const userInterruptRec = {
		type: 'user',
		uuid: 'u-interrupt-1',
		parentUuid: 'a-cancelled-1',
		message: {
			role: 'user',
			content: '[Request interrupted by user]',
		},
	};

	const items = await translateTranscriptRecords([
		userPrompt1,
		asstDeniedRec,
		userDeniedRec,
		userPrompt2,
		asstCancelledRec,
		userInterruptRec,
	]);

	const deniedAsst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-denied-1');
	const deniedBlock = deniedAsst?.blocks.get(0);
	check('AK5.1 denied tool has toolDenied true', deniedBlock?.toolDenied === true);
	check('AK5.2 denied tool has toolIsError false (cleared for denial)', deniedBlock?.toolIsError === false);
	check('AK5.3 denied tool has toolPending false', deniedBlock?.toolPending === false);
	eq('AK5.4 denied assistant turn status is complete', deniedAsst?.status, 'complete');

	const cancelledAsst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-cancelled-1');
	const cancelledBlock = cancelledAsst?.blocks.get(0);
	eq('AK5.5 cancelled assistant turn status is stopped', cancelledAsst?.status, 'stopped');
	check('AK5.6 cancelled tool has toolPending false', cancelledBlock?.toolPending === false);

	// Test AskUserQuestion summary helper
	const sampleQ = [{ question: 'Invented question: accept refactor?' }];
	const sampleA = { 'Invented question: accept refactor?': 'Accepted' };

	eq('AK5.7 formatAskUserQuestionSummary allowed', formatAskUserQuestionSummary(sampleQ, sampleA, 'allowed'), 'Question: Invented question: accept refactor? → Accepted');
	eq('AK5.8 formatAskUserQuestionSummary denied', formatAskUserQuestionSummary(sampleQ, sampleA, 'denied'), 'Question: Invented question: accept refactor? → Denied');
	eq('AK5.9 formatAskUserQuestionSummary cancelled', formatAskUserQuestionSummary(sampleQ, sampleA, 'cancelled'), 'Question: Invented question: accept refactor? → Not answered (turn ended)');
	eq('AK5.10 formatAskUserQuestionSummary empty questions allowed', formatAskUserQuestionSummary([], {}, 'allowed'), 'Question: Answered');
	eq('AK5.11 formatAskUserQuestionSummary empty questions denied', formatAskUserQuestionSummary([], {}, 'denied'), 'Question: (unreadable question) → Denied');
}

// AK6: readSession on real-shaped, empty, and missing transcript
{
	console.log('AK6. readSession on real-shaped, empty, and missing transcript');

	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-readsession-')));

	// 1. Real-shaped transcript
	const realFile = join(dir, 'sess-real.jsonl');
	writeFileSync(
		realFile,
		[
			JSON.stringify({ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'Invented prompt text' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Invented answer' }] } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a-1', sessionId: 'sess-real' }),
			'',
		].join('\n'),
	);

	// 2. Empty transcript (0 bytes)
	const emptyFile = join(dir, 'sess-empty.jsonl');
	writeFileSync(emptyFile, '');

	const store = new NodeTranscriptStore(dir);

	// Real session read
	const realItems = await store.readSession('sess-real');
	check('AK6.1 readSession on real transcript returns items array', Array.isArray(realItems) && realItems.length === 2);
	eq('AK6.2 real transcript first item is UserItem', realItems[0]?.kind, 'user');
	eq('AK6.3 real transcript second item is AssistantItem', realItems[1]?.kind, 'assistant');
	eq('AK6.4 UserItem text matches', (realItems[0] as UserItem)?.text, 'Invented prompt text');
	eq('AK6.5 AssistantItem block text matches', (realItems[1] as AssistantItem)?.blocks.get(0)?.text, 'Invented answer');

	// Empty session read
	const emptyItems = await store.readSession('sess-empty');
	check('AK6.6 readSession on empty transcript returns empty array', Array.isArray(emptyItems) && emptyItems.length === 0);

	// Missing session read
	let threwMissing = false;
	let missingError = '';
	try {
		await store.readSession('sess-missing-xyz');
	} catch (err) {
		threwMissing = true;
		missingError = String(err);
	}
	check('AK6.7 readSession on missing transcript throws', threwMissing);
	check('AK6.8 readSession missing error mentions session id', missingError.includes('sess-missing-xyz'));
	check('AK6.9 readSession missing error includes v2', missingError.includes('v2'));

	rmSync(dir, { recursive: true, force: true });
}

// AK7: Defect 1 - readSession paging seam prevents eager loading of full active branch
{
	console.log('AK7. Defect 1: readSession paging seam');

	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-paging-')));
	const pagedFile = join(dir, 'sess-paged.jsonl');

	// 10 active records (5 user-assistant pairs)
	const lines: string[] = [];
	for (let i = 1; i <= 5; i++) {
		const uId = `u-paged-${String(i)}`;
		const aId = `a-paged-${String(i)}`;
		const prevId = i === 1 ? undefined : `a-paged-${String(i - 1)}`;
		lines.push(JSON.stringify({
			type: 'user',
			uuid: uId,
			parentUuid: prevId,
			message: { role: 'user', content: `Invented prompt ${String(i)}` },
		}));
		lines.push(JSON.stringify({
			type: 'assistant',
			uuid: aId,
			parentUuid: uId,
			message: { role: 'assistant', content: [{ type: 'text', text: `Invented answer ${String(i)}` }] },
		}));
	}
	lines.push(JSON.stringify({ type: 'last-prompt', leafUuid: 'a-paged-5', sessionId: 'sess-paged' }));
	lines.push('');
	writeFileSync(pagedFile, lines.join('\n'));

	const store = new NodeTranscriptStore(dir);
	const page: any = await (store as any).readSession('sess-paged', undefined, { count: 4 });

	// Assert mechanism: requested 4 newest records (2 turns = 4 chat items)
	check('AK7.1 readSession returns requested slice not whole branch', page && page.length === 4, `got length ${page?.length}`);
	check('AK7.2 page exposes startIndex', page && page.startIndex === 6, `got ${page?.startIndex}`);
	check('AK7.3 page exposes endIndex', page && page.endIndex === 10, `got ${page?.endIndex}`);
	check('AK7.4 page exposes hasMoreBefore', page && page.hasMoreBefore === true, `got ${page?.hasMoreBefore}`);
	check('AK7.5 page exposes totalActiveRecords', page && page.totalActiveRecords === 10, `got ${page?.totalActiveRecords}`);

	if (page && typeof page.loadBefore === 'function') {
		const olderPage: any = await page.loadBefore(4);
		check('AK7.6 loadBefore loads previous slice', olderPage && olderPage.startIndex === 2 && olderPage.endIndex === 6);
		check('AK7.7 loadBefore preserves hasMoreBefore', olderPage && olderPage.hasMoreBefore === true);
	} else {
		check('AK7.6 loadBefore loads previous slice', false, 'loadBefore method missing on page');
		check('AK7.7 loadBefore preserves hasMoreBefore', false, 'loadBefore method missing on page');
	}

	rmSync(dir, { recursive: true, force: true });
}

// AK8: Defect 2 - Sidecar read only for records returned in requested page
{
	console.log('AK8. Defect 2: Sidecar read only for records in requested page');

	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guki-checks-sidecar-paged-')));
	const toolResultsDir = join(dir, 'tool-results');
	mkdirSync(toolResultsDir, { recursive: true });

	const oldSidecarPath = join(toolResultsDir, 'toolu_sc_old.txt');
	writeFileSync(oldSidecarPath, 'Invented old tool result payload on disk');

	const lines = [
		// Turn 1: user, assistant with tool_use, user tool_result with sidecar
		JSON.stringify({ type: 'user', uuid: 'u-sc-turn1', message: { role: 'user', content: 'Invented prompt 1' } }),
		JSON.stringify({
			type: 'assistant',
			uuid: 'a-sc-turn1',
			parentUuid: 'u-sc-turn1',
			message: {
				role: 'assistant',
				content: [{ type: 'tool_use', id: 'toolu_sc_old', name: 'Bash', input: { command: 'invented' } }],
			},
		}),
		JSON.stringify({
			type: 'user',
			uuid: 'u-sc-res1',
			parentUuid: 'a-sc-turn1',
			toolUseResult: { status: 'success' },
			message: {
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: 'toolu_sc_old',
					content: `<persisted-output>\nFull output saved to: ${oldSidecarPath}\nPreview:\nInvented preview\n</persisted-output>`,
				}],
			},
		}),
		// Turn 2: user, assistant simple text
		JSON.stringify({ type: 'user', uuid: 'u-sc-turn2', parentUuid: 'u-sc-res1', message: { role: 'user', content: 'Invented prompt 2' } }),
		JSON.stringify({
			type: 'assistant',
			uuid: 'a-sc-turn2',
			parentUuid: 'u-sc-turn2',
			message: { role: 'assistant', content: [{ type: 'text', text: 'Invented final answer' }] },
		}),
		JSON.stringify({ type: 'last-prompt', leafUuid: 'a-sc-turn2', sessionId: 'sess-sc-paged' }),
		'',
	];
	writeFileSync(join(dir, 'sess-sc-paged.jsonl'), lines.join('\n'));

	let sidecarReads = 0;
	const store = new NodeTranscriptStore(dir);

	// Request ONLY Turn 2 (newest 2 records)
	const page2: any = await (store as any).readSession('sess-sc-paged', undefined, {
		count: 2,
		sessionDir: dir,
		onSidecarRead: () => {
			sidecarReads++;
		},
	});

	// Assert mechanism: Turn 1 was not requested -> zero sidecar reads must have occurred
	check('AK8.1 unrequested older record sidecar is NOT read from disk', sidecarReads === 0, `expected 0 sidecar reads, got ${String(sidecarReads)}`);

	// Now ask for older page including Turn 1
	if (page2 && typeof page2.loadBefore === 'function') {
		await page2.loadBefore(3);
		check('AK8.2 requested older record sidecar IS read when requested', sidecarReads === 1, `expected 1 sidecar read, got ${String(sidecarReads)}`);
	} else {
		check('AK8.2 requested older record sidecar IS read when requested', false, 'loadBefore missing');
	}

	rmSync(dir, { recursive: true, force: true });
}

// AK9: Defect 3 - Mappability table missing checks (isApiErrorMessage, un-denied tool error, toolPermissionRequested)
{
	console.log('AK9. Defect 3: Mappability rows without checks');

	// Row 1: isApiErrorMessage: true with error undefined and content block array
	const apiErrRec = {
		type: 'assistant',
		uuid: 'a-api-err-1',
		isApiErrorMessage: true,
		apiErrorStatus: 400,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Invented API error description' }],
		},
	};
	const items1 = await translateTranscriptRecords([apiErrRec]);
	const asstErr = items1.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-api-err-1');
	eq('AK9.1 isApiErrorMessage sets status to error', asstErr?.status, 'error');
	eq('AK9.2 isApiErrorMessage extracts errorText from content block', asstErr?.errorText, 'Invented API error description');

	// Row 2: un-denied tool error (is_error: true on tool_result without toolDenialKind)
	const asstToolUse = {
		type: 'assistant',
		uuid: 'a-tool-use-err',
		message: {
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_fail_1', name: 'Bash', input: { command: 'invented' } }],
		},
	};
	const userToolErr = {
		type: 'user',
		uuid: 'u-tool-res-err',
		parentUuid: 'a-tool-use-err',
		toolUseResult: { status: 'error' },
		message: {
			role: 'user',
			content: [{
				type: 'tool_result',
				tool_use_id: 'toolu_fail_1',
				is_error: true,
				content: 'Invented execution failure message',
			}],
		},
	};
	const items2 = await translateTranscriptRecords([asstToolUse, userToolErr]);
	const asstTool = items2.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-tool-use-err');
	const blockErr = asstTool?.blocks.get(0);
	check('AK9.3 un-denied tool result preserves toolIsError true', blockErr?.toolIsError === true);
	check('AK9.4 un-denied tool result leaves toolDenied undefined', blockErr?.toolDenied === undefined);

	// Row 3: toolPermissionRequested is false
	check('AK9.5 toolPermissionRequested is false', blockErr?.toolPermissionRequested === false);
}

// AK10: Defect 4 - Synthetic task-notification records omitted
{
	console.log('AK10. Defect 4: Synthetic task-notification records omitted');

	const notifRec = {
		type: 'user',
		uuid: 'u-task-notif-1',
		timestamp: '2026-09-14T10:00:00.000Z',
		origin: { kind: 'task-notification' },
		message: { role: 'user', content: 'Invented machine notification: subagent complete' },
	};
	const humanPrompt = {
		type: 'user',
		uuid: 'u-human-1',
		parentUuid: 'u-task-notif-1',
		timestamp: '2026-09-14T10:00:05.000Z',
		message: { role: 'user', content: 'Invented genuine human prompt' },
	};
	const items = await translateTranscriptRecords([notifRec, humanPrompt]);
	eq('AK10.1 task-notification record omitted yielding single human item', items.length, 1);
	eq('AK10.2 retained item is genuine human user prompt', (items[0] as UserItem)?.text, 'Invented genuine human prompt');
}

// AK11: Defect 5 - AssistantItem string content handling
{
	console.log('AK11. Defect 5: AssistantItem string content handling');

	const asstStrRec = {
		type: 'assistant',
		uuid: 'a-str-content-1',
		message: {
			role: 'assistant',
			content: 'Invented assistant reply as plain string',
		},
	};
	const items = await translateTranscriptRecords([asstStrRec]);
	const asst = items.find((it): it is AssistantItem => it.kind === 'assistant' && it.id === 'a-str-content-1');
	eq('AK11.1 assistant string content yields one block', asst?.blocks.size, 1);
	eq('AK11.2 assistant string block kind is text', asst?.blocks.get(0)?.kind, 'text');
	eq('AK11.3 assistant string block text matches', asst?.blocks.get(0)?.text, 'Invented assistant reply as plain string');
}

// AL: ChatView offline constructibility and open lifecycle harness
{
	console.log('AL. ChatView offline constructibility and open lifecycle harness');

	const container = new FakeElement() as any;
	const app = new App();
	const leaf = new WorkspaceLeaf(app, container);
	const state = new ChatState();

	const session = {
		state,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const view = new ChatView(leaf, session);

	eq('AL.1 view returns expected view type', view.getViewType(), 'guki-chat-view');
	eq('AL.2 view returns expected display text', view.getDisplayText(), 'GuKi Chat');
	eq('AL.3 view returns expected icon', view.getIcon(), 'message-square');

	// Run open lifecycle
	await (view as any).onOpen();

	const rootEl = container.querySelector('.guki-root');
	check('AL.4 root container is mounted into DOM', rootEl !== null);

	const messagesEl = container.querySelector('.guki-messages-wrap');
	check('AL.5 messages area is mounted into DOM', messagesEl !== null);

	const textareaEl = container.querySelector('textarea');
	check('AL.6 composer input textarea is mounted into DOM', textareaEl !== null);

	const dropdown = view.getHistoryDropdown();
	check('AL.7 history dropdown is instantiated', dropdown !== null);

	const actionEl = container.querySelector('.view-action');
	check('AL.8 view registers no action in view chrome', actionEl === null);

	// Prove event wiring (registerDomEvent) works under the harness:
	// Clicking the in-panel trigger element triggers toggle() on the dropdown component
	check('AL.9 history dropdown initially closed', dropdown?.isOpen() === false);
	const triggerEl = view.getHistoryTriggerEl();
	triggerEl?.click();
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('AL.10 clicking in-panel trigger toggles history dropdown open', dropdown?.isOpen() === true);

	// Run close lifecycle
	await (view as any).onClose();
	check('AL.11 onClose empties contentEl and cleans up references', container.querySelector('.guki-root') === null && view.getHistoryDropdown() === null);
}

// AM: Görev 8: Drawing historical conversations on screen (round T4a)
{
	console.log('AM. Görev 8: Drawing historical conversations on screen');

	// Fixture 1: Standard conversation with 2 user and 2 assistant turns
	const basicFile = join(TRANSCRIPT_TEST_DIR, 'sess-am-basic.jsonl');
	writeFileSync(
		basicFile,
		[
			JSON.stringify({ type: 'user', uuid: 'u-b1', message: { role: 'user', content: 'Question 1: What is Obsidian?' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a-b1', parentUuid: 'u-b1', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer 1: Obsidian is a markdown note-taking app.' }] } }),
			JSON.stringify({ type: 'user', uuid: 'u-b2', parentUuid: 'a-b1', message: { role: 'user', content: 'Question 2: Does it work offline?' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a-b2', parentUuid: 'u-b2', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer 2: Yes, all notes are local markdown files.' }] } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a-b2', sessionId: 'sess-am-basic' }),
			'',
		].join('\n'),
	);

	// Fixture 2: Shuffled file order where disk lines contradict DAG causality (for red/green pair b)
	const dagFile = join(TRANSCRIPT_TEST_DIR, 'sess-am-dag-order.jsonl');
	writeFileSync(
		dagFile,
		[
			JSON.stringify({ type: 'assistant', uuid: 'a-ord-2', parentUuid: 'u-ord-2', message: { role: 'assistant', content: [{ type: 'text', text: 'Fourth turn: Finished' }] } }),
			JSON.stringify({ type: 'user', uuid: 'u-ord-1', message: { role: 'user', content: 'First turn: Begun' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a-ord-1', parentUuid: 'u-ord-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Second turn: Working' }] } }),
			JSON.stringify({ type: 'user', uuid: 'u-ord-2', parentUuid: 'a-ord-1', message: { role: 'user', content: 'Third turn: Continuing' } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a-ord-2', sessionId: 'sess-am-dag-order' }),
			'',
		].join('\n'),
	);

	// Fixture 3: Empty file (0 bytes)
	const emptyFile = join(TRANSCRIPT_TEST_DIR, 'sess-am-empty.jsonl');
	writeFileSync(emptyFile, '');

	// Fixture 4: Long transcript with 70 active branch turns (> HISTORY_PAGE_SIZE = 50)
	const longFile = join(TRANSCRIPT_TEST_DIR, 'sess-am-long-real.jsonl');
	const longLines: string[] = [];
	for (let i = 1; i <= 70; i++) {
		const isUser = i % 2 === 1;
		longLines.push(
			JSON.stringify({
				type: isUser ? 'user' : 'assistant',
				uuid: `msg-turn-${String(i)}`,
				parentUuid: i === 1 ? undefined : `msg-turn-${String(i - 1)}`,
				message: isUser
					? { role: 'user', content: `Prompt for turn ${String(i)}` }
					: { role: 'assistant', content: [{ type: 'text', text: `Reply for turn ${String(i)}` }] },
			}),
		);
	}
	longLines.push(JSON.stringify({ type: 'last-prompt', leafUuid: 'msg-turn-70', sessionId: 'sess-am-long-real' }));
	longLines.push('');
	writeFileSync(longFile, longLines.join('\n'));

	// Set up harness
	const container = new FakeElement() as any;
	const app = new App();
	const leaf = new WorkspaceLeaf(app, container);
	const state = new ChatState();

	const session = {
		state,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: TRANSCRIPT_TEST_DIR, outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const store = new NodeTranscriptStore(TRANSCRIPT_TEST_DIR);
	const view = new ChatView(leaf, session, store);
	await (view as any).onOpen();

	// AM1. Basic historical conversation draw
	await view.handleSelectSession('sess-am-basic');
	eq('AM1.1 state item count matches active branch', state.items.length, 4);
	eq('AM1.2 currentSessionId tracks selected session', view.getCurrentSessionId(), 'sess-am-basic');
	check('AM1.3 DOM contains first user message text', container.text.includes('Question 1: What is Obsidian?'));
	check('AM1.4 DOM contains first assistant reply text', container.text.includes('Answer 1: Obsidian is a markdown note-taking app.'));
	check('AM1.5 DOM contains second user message text', container.text.includes('Question 2: Does it work offline?'));
	check('AM1.6 DOM contains second assistant reply text', container.text.includes('Answer 2: Yes, all notes are local markdown files.'));
	eq('AM1.7 DOM renders four message elements', container.querySelectorAll('.guki-message').length, 4);

	// AM2. Selection clears previous conversation before drawing (Required red/green pair a)
	state.addUserMessage('Active conversation message to clear');
	check('AM2.0 active message is on screen before selection', container.text.includes('Active conversation message to clear'));

	const secondFile = join(TRANSCRIPT_TEST_DIR, 'sess-am-second.jsonl');
	writeFileSync(
		secondFile,
		[
			JSON.stringify({ type: 'user', uuid: 'u-sec-1', message: { role: 'user', content: 'Fresh prompt second session' } }),
			JSON.stringify({ type: 'assistant', uuid: 'a-sec-1', parentUuid: 'u-sec-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Fresh reply second session' }] } }),
			JSON.stringify({ type: 'last-prompt', leafUuid: 'a-sec-1', sessionId: 'sess-am-second' }),
			'',
		].join('\n'),
	);

	await view.handleSelectSession('sess-am-second');
	eq('AM2.1 state contains only new session items', state.items.length, 2);
	check('AM2.2 previous active message removed from state', !state.items.some((it) => (it as any).text === 'Active conversation message to clear'));
	check('AM2.3 previous active message removed from DOM', !container.text.includes('Active conversation message to clear'));
	check('AM2.4 previous session messages removed from DOM', !container.text.includes('Question 1: What is Obsidian?'));
	check('AM2.5 new session message rendered in DOM', container.text.includes('Fresh prompt second session'));
	check('AM2.6 new session reply rendered in DOM', container.text.includes('Fresh reply second session'));
	eq('AM2.7 DOM renders exactly two messages', container.querySelectorAll('.guki-message').length, 2);

	// AM3. Drawn items arrive in conversation DAG order, NOT file order (Required red/green pair b)
	await view.handleSelectSession('sess-am-dag-order');
	const messageEls = container.querySelectorAll('.guki-message');
	const renderedTexts = messageEls.map((el: any) => el.text.trim());
	eq('AM3.1 dag-order session renders four messages', renderedTexts.length, 4);
	check('AM3.2 first rendered message is turn 1 in DAG order (not turn 4 from disk line 1)', renderedTexts[0].includes('First turn: Begun'));
	check('AM3.3 second rendered message is turn 2 in DAG order', renderedTexts[1].includes('Second turn: Working'));
	check('AM3.4 third rendered message is turn 3 in DAG order', renderedTexts[2].includes('Third turn: Continuing'));
	check('AM3.5 fourth rendered message is turn 4 in DAG order', renderedTexts[3].includes('Fourth turn: Finished'));

	// AM4. Re-selecting conversation already on screen does not redraw or duplicate
	const countBefore = container.querySelectorAll('.guki-message').length;
	const firstElBefore = container.querySelector('.guki-message');
	await view.handleSelectSession('sess-am-dag-order');
	eq('AM4.1 re-selection leaves message count unchanged', container.querySelectorAll('.guki-message').length, countBefore);
	eq('AM4.2 re-selection leaves state item count unchanged', state.items.length, 4);
	check('AM4.3 re-selection does not recreate DOM nodes', container.querySelector('.guki-message') === firstElBefore);

	// AM5. Plain-language notice when readSession comes back empty
	await view.handleSelectSession('sess-am-empty');
	eq('AM5.1 empty session produces one notice item', state.items.length, 1);
	eq('AM5.2 notice kind is notice', state.items[0]?.kind, 'notice');
	eq('AM5.3 notice level is info', (state.items[0] as any)?.level, 'info');
	check('AM5.4 DOM displays plain-language empty notice text', container.text.includes('This conversation has no messages to display.'));
	check('AM5.5 previous conversation cleared from DOM', !container.text.includes('Fourth turn: Finished'));

	// AM6. Plain-language notice when readSession throws (missing / unreadable file)
	await view.handleSelectSession('sess-does-not-exist-xyz');
	eq('AM6.1 missing session produces one notice item', state.items.length, 1);
	eq('AM6.2 notice kind is notice', state.items[0]?.kind, 'notice');
	eq('AM6.3 notice level is error', (state.items[0] as any)?.level, 'error');
	check('AM6.4 DOM displays plain-language error notice text', container.text.includes('Could not load conversation'));
	check('AM6.5 DOM contains error styling', container.querySelector('.guki-message-error') !== null);

	// AM7. Real conversation on disk drawn on screen, newest page is a strict subset
	await view.handleSelectSession('sess-am-long-real');
	eq('AM7.1 UI layer page size constant is 50', HISTORY_PAGE_SIZE, 50);
	eq('AM7.2 newest page draws exactly 50 items (strict subset of 70)', state.items.length, 50);
	check('AM7.3 newest item is 70th turn tip', container.text.includes('Reply for turn 70'));
	check('AM7.4 oldest drawn item is turn 21', container.text.includes('Prompt for turn 21'));
	check('AM7.5 unpaged items turn 1-20 are omitted from drawn page', !container.text.includes('Prompt for turn 20'));
	eq('AM7.6 cost and duration left blank without invention', (state.items[0] as any)?.costUsd, undefined);
	eq('AM7.7 assistant duration left blank without invention', (state.items[1] as any)?.meta?.durationMs, undefined);
	eq('AM7.8 DOM renders all 50 paged messages', container.querySelectorAll('.guki-message').length, 50);

	// Also verify against an actual ~/.claude/projects/ transcript on disk if present
	const realClaudeFile = join(homedir(), '.claude', 'projects', '-Users-emregultekir-Documents-otherprojects-guki-obsidian-chat', '011fb901-bdfe-4df1-ba50-04a1808fbc07.jsonl');
	if (existsSync(realClaudeFile)) {
		const realSession = {
			state: new ChatState(),
			busy: false,
			blocked: false,
			vaultPaths: async () => ({ root: '/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat', outside: '/fake/outside' }),
			getSlashCommands: () => ['clear', 'help'],
			send: () => {},
			interrupt: () => {},
			decidePermission: () => {},
			rememberPermission: async () => {},
		} as unknown as SessionManager;
		const realContainer = new FakeElement() as any;
		const realLeaf = new WorkspaceLeaf(app, realContainer);
		const realView = new ChatView(realLeaf, realSession);
		await (realView as any).onOpen();
		await realView.handleSelectSession('011fb901-bdfe-4df1-ba50-04a1808fbc07');
		check('AM7.9 real transcript on disk draws message items', realSession.state.items.length >= 1);
		check('AM7.10 real transcript DOM renders messages', realContainer.querySelectorAll('.guki-message').length >= 1);
	}
}

// AN: Görev 8: Real dropdown selection path and 'load older' paging
{
	console.log("AN. Görev 8: Real dropdown selection path and 'load older' paging");

	// Harness setup for AN
	const container = new FakeElement() as any;
	const app = new App();
	const leaf = new WorkspaceLeaf(app, container);
	const state = new ChatState();

	const session = {
		state,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: TRANSCRIPT_TEST_DIR, outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const store = new NodeTranscriptStore(TRANSCRIPT_TEST_DIR);
	const view = new ChatView(leaf, session, store);
	await (view as any).onOpen();

	// AN1: The gap: Real user path from dropdown row click through onSelectSession to DOM messages
	const triggerEl = view.getHistoryTriggerEl();
	triggerEl?.click();
	await new Promise((resolve) => setTimeout(resolve, 20));

	const dropdown = view.getHistoryDropdown();
	check('AN1.1 history dropdown is open after action click', dropdown?.isOpen() === true);

	const rowEls = container.querySelectorAll('.guki-history-item');
	check('AN1.2 history items are rendered in dropdown', rowEls.length > 0);

	// Find the item for sess-am-basic
	const basicRow = rowEls.find((el: any) => el.text.includes('Question 1: What is Obsidian?') || el.text.includes('sess-am-basic'));
	const targetRow = basicRow ?? rowEls[0];
	check('AN1.3 target session row found in dropdown', targetRow !== undefined);

	// User clicks the session row in the dropdown
	targetRow?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	eq('AN1.4 state items populated via dropdown click', state.items.length > 0, true);
	check('AN1.5 DOM contains conversation messages from clicked session', container.querySelectorAll('.guki-message').length > 0);
	eq('AN1.6 dropdown closed upon selection', dropdown?.isOpen(), false);

	// AN2: "Load older" control presence and absence (Required red/green pair b)
	// On a short conversation (sess-am-basic with 4 turns), nothing older remains -> control must be GONE
	await view.handleSelectSession('sess-am-basic');
	eq('AN2.1 short session state items is 4', state.items.length, 4);
	check('AN2.2 load older control is absent for short session with no older items', view.getLoadOlderEl() === null);
	check('AN2.3 DOM does not contain load older button', container.querySelector('.guki-load-older') === null);

	// On a long conversation (>50 turns, e.g. sess-am-long-real with 70 turns), control must be PRESENT above messages
	await view.handleSelectSession('sess-am-long-real');
	eq('AN2.4 initial draw has 50 items', state.items.length, 50);
	check('AN2.5 load older control is present when older items exist', view.getLoadOlderEl() !== null);
	check('AN2.6 DOM contains load older button', container.querySelector('.guki-load-older') !== null);
	check('AN2.7 load older button sits above conversation in DOM', container.querySelector('.guki-messages')?.children[0] === view.getLoadOlderEl());

	// AN3: Viewport preservation and prepend order on "load older" (Required red/green pair c)
	// Before prepend: oldest drawn item is turn 21, message list scroll position captured
	const scrollEl = container.querySelector('.guki-messages');
	scrollEl.scrollHeight = 5000;
	scrollEl.scrollTop = 100;
	scrollEl.clientHeight = 800;

	const firstMsgBefore = scrollEl.querySelector('.guki-message');
	check('AN3.1 first message before prepend is turn 21', firstMsgBefore?.text?.includes('Prompt for turn 21'));

	// Track whether scrollIntoView was called on anchor
	let anchorScrolledIntoView = false;
	if (firstMsgBefore) {
		firstMsgBefore.scrollIntoView = () => { anchorScrolledIntoView = true; };
	}

	// User clicks "load older"
	const loadOlderBtn = view.getLoadOlderEl();
	loadOlderBtn?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	eq('AN3.2 all 70 items now loaded in state', state.items.length, 70);
	eq('AN3.3 all 70 items rendered in DOM', container.querySelectorAll('.guki-message').length, 70);

	// Required red/green pair c: older items must be PREPENDED, not appended at bottom
	const messagesAfter = container.querySelectorAll('.guki-message');
	check('AN3.4 first rendered message is now turn 1 (prepended at top)', messagesAfter[0]?.text?.includes('Prompt for turn 1'));
	check('AN3.5 last rendered message is turn 70 (newest stays at bottom)', messagesAfter[69]?.text?.includes('Reply for turn 70'));

	// Viewport jump prevention assertions:
	// 1. Did NOT scroll to bottom (scrollTop was not set to scrollHeight)
	check('AN3.6 prepend did not scroll to bottom', scrollEl.scrollTop < scrollEl.scrollHeight);
	// 2. Anchor element scrollIntoView called to preserve eye position
	check('AN3.7 anchor element scrollIntoView called to preserve eye position', anchorScrolledIntoView === true);

	// With all 70 turns loaded, nothing older remains -> control must be GONE
	check('AN3.8 load older control is gone after all older items loaded', view.getLoadOlderEl() === null);
	check('AN3.9 DOM no longer contains load older button', container.querySelector('.guki-load-older') === null);

	// AN4: Multi-press paging integrity across at least 2 presses
	// Fixture: 120 turns (requires 3 pages: 50 + 50 + 20)
	const multiFile = join(TRANSCRIPT_TEST_DIR, 'sess-an-multipress.jsonl');
	const multiLines: string[] = [];
	for (let i = 1; i <= 120; i++) {
		const isUser = i % 2 === 1;
		multiLines.push(
			JSON.stringify({
				type: isUser ? 'user' : 'assistant',
				uuid: `msg-multi-${String(i)}`,
				parentUuid: i === 1 ? undefined : `msg-multi-${String(i - 1)}`,
				message: isUser
					? { role: 'user', content: `Multi prompt ${String(i)}` }
					: { role: 'assistant', content: [{ type: 'text', text: `Multi reply ${String(i)}` }] },
			}),
		);
	}
	multiLines.push(JSON.stringify({ type: 'last-prompt', leafUuid: 'msg-multi-120', sessionId: 'sess-an-multipress' }));
	multiLines.push('');
	writeFileSync(multiFile, multiLines.join('\n'));

	await view.handleSelectSession('sess-an-multipress');
	eq('AN4.1 initial page loads 50 newest turns', state.items.length, 50);
	check('AN4.2 oldest initial item is turn 71', state.items[0]?.id === 'msg-multi-71' || container.text.includes('Multi prompt 71'));
	check('AN4.3 newest initial item is turn 120', container.text.includes('Multi reply 120'));
	check('AN4.4 load older control present before press 1', view.getLoadOlderEl() !== null);

	// Press 1: loads turns 21-70 (50 items)
	view.getLoadOlderEl()?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	eq('AN4.5 after press 1, state items count is 100', state.items.length, 100);
	check('AN4.6 after press 1, oldest item is turn 21', container.text.includes('Multi prompt 21'));
	check('AN4.7 after press 1, turn 70 is present', container.text.includes('Multi reply 70'));
	check('AN4.8 load older control STILL present before press 2', view.getLoadOlderEl() !== null);

	// Press 2: loads turns 1-20 (20 items)
	view.getLoadOlderEl()?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	eq('AN4.9 after press 2, all 120 items loaded', state.items.length, 120);
	check('AN4.10 after press 2, oldest item is turn 1', container.text.includes('Multi prompt 1'));
	check('AN4.11 after press 2, newest item is turn 120', container.text.includes('Multi reply 120'));

	// Integrity checks across 120 items:
	// No duplicate item IDs
	const itemIds = state.items.map((it) => it.id);
	const uniqueIds = new Set(itemIds);
	eq('AN4.12 no duplicate item ids across paged presses', uniqueIds.size, 120);

	// No gap
	let hasGap = false;
	for (let i = 1; i <= 120; i++) {
		if (!uniqueIds.has(`msg-multi-${String(i)}`)) {
			hasGap = true;
			break;
		}
	}
	eq('AN4.13 no gap across the full conversation history', hasGap, false);

	// Chain order preserved
	const multiMessages = container.querySelectorAll('.guki-message');
	eq('AN4.14 DOM renders all 120 messages in order', multiMessages.length, 120);
	check('AN4.15 first DOM message is turn 1', multiMessages[0]?.text?.includes('Multi prompt 1'));
	check('AN4.16 71st DOM message is turn 71', multiMessages[70]?.text?.includes('Multi prompt 71'));
	check('AN4.17 120th DOM message is turn 120', multiMessages[119]?.text?.includes('Multi reply 120'));

	// Truthful end-of-conversation: control is gone
	check('AN4.18 load older control gone at conversation root', view.getLoadOlderEl() === null);
	check('AN4.19 DOM has no load older button at root', container.querySelector('.guki-load-older') === null);

	// Subsequent press attempt does nothing (no-op)
	await view.handleLoadOlder();
	eq('AN4.20 calling handleLoadOlder at root leaves item count unchanged', state.items.length, 120);
}

// AO: In-panel conversation history control in panel container
{
	console.log('AO. In-panel conversation history control in panel container');

	const container = new FakeElement() as any;
	const app = new App();
	const leaf = new WorkspaceLeaf(app, container);
	const state = new ChatState();

	const session = {
		state,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: TRANSCRIPT_TEST_DIR, outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const store = new NodeTranscriptStore(TRANSCRIPT_TEST_DIR);
	const view = new ChatView(leaf, session, store);
	await (view as any).onOpen();

	const rootEl = container.querySelector('.guki-root');
	const triggerEl = view.getHistoryTriggerEl();
	const actionEl = container.querySelector('.view-action');

	check('AO.1 history trigger element exists', triggerEl !== null && triggerEl !== undefined);
	check('AO.2 trigger element is inside panel root container', rootEl !== null && triggerEl !== null && rootEl.contains(triggerEl) === true);
	check('AO.3 view registers no view-action chrome element', actionEl === null);

	const dropdown = view.getHistoryDropdown();
	check('AO.4 history dropdown initially closed', dropdown?.isOpen() === false);
	triggerEl?.click();
	await new Promise((resolve) => setTimeout(resolve, 50));
	check('AO.5 clicking in-panel trigger element toggles history dropdown open', dropdown?.isOpen() === true);

	await (view as any).onClose();
	check('AO.6 onClose cleans up history trigger reference', view.getHistoryTriggerEl() === null);
}

// AP. Görev 8 Round T4b: Resume past conversation on first message
{
	console.log('AP. Görev 8 Round T4b: Resume past conversation on first message');

	const { EventEmitter } = createRequire(import.meta.url)('node:events');
	const cp = (window as any).require('child_process');
	const origSpawn = cp.spawn;
	const spawnCalls: Array<{ binary: string; argv: string[]; options: any }> = [];
	let activeChild: any = null;

	cp.spawn = (binary: string, argv: string[], options: any) => {
		const stdout = new EventEmitter() as any;
		stdout.setEncoding = () => {};
		const stderr = new EventEmitter() as any;
		stderr.setEncoding = () => {};
		const stdin = new EventEmitter() as any;
		stdin.write = () => true;
		stdin.end = () => {
			if (activeChild && !activeChild._exited) {
				activeChild._exited = true;
				activeChild.emit('exit', 0, null);
			}
		};

		const child = new EventEmitter() as any;
		child.stdout = stdout;
		child.stderr = stderr;
		child.stdin = stdin;
		child.pid = 99000 + spawnCalls.length;
		child.kill = (sig?: string) => {
			if (!child._exited) {
				child._exited = true;
				child.emit('exit', 0, sig ?? null);
			}
		};
		spawnCalls.push({ binary, argv: [...argv], options });
		activeChild = child;
		return child;
	};

	const realAdapter = new FileSystemAdapter();
	realAdapter.getBasePath = () => TRANSCRIPT_TEST_DIR;
	(realAdapter as any).read = () => Promise.resolve(
		readFileSync(join(process.cwd(), 'src', 'cli', 'mcp-permission-server.mjs'), 'utf8'),
	);

	const app = {
		vault: {
			adapter: realAdapter,
			configDir: '.obsidian',
		},
	} as unknown as App;

	const container = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(app, container);
	const session = new SessionManager(app, undefined, process.execPath);
	const store = new NodeTranscriptStore(TRANSCRIPT_TEST_DIR);
	const view = new ChatView(leaf, session, store);
	await (view as any).onOpen();

	const targetSessionId = 'sess-am-basic';

	// (a) Selection alone spawns NOTHING
	await view.handleSelectSession(targetSessionId);
	eq('AP.1 selection alone spawns nothing', spawnCalls.length, 0);

	const textarea = container.querySelector('textarea');
	const sendBtn = container.querySelector('.guki-composer-send');

	// Drive real send path: composer textarea input -> send button click
	textarea.value = 'First message continuing sess-am-basic';
	textarea.listeners['input']?.();
	sendBtn.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	// (b) First message after selection spawns exactly once with --resume <id> and broker flags
	eq('AP.2 first message after selection spawns exactly once', spawnCalls.length, 1);
	const firstSpawnArgv = spawnCalls[0]?.argv ?? [];
	const resumeIndex = firstSpawnArgv.indexOf('--resume');
	check('AP.3 --resume flag is present in argv', resumeIndex !== -1);
	eq('AP.4 --resume argument matches selected session ID', firstSpawnArgv[resumeIndex + 1], targetSessionId);
	const resumeCount = firstSpawnArgv.filter((a) => a === '--resume').length;
	eq('AP.5 --resume flag appears exactly once', resumeCount, 1);
	check('AP.6 broker flags present alongside --resume', firstSpawnArgv.includes('--permission-prompt-tool'));

	// (d) Second message of a resumed conversation does not respawn and does not re-add flag
	textarea.value = 'Second message in resumed conversation';
	textarea.listeners['input']?.();
	sendBtn.click();
	await new Promise((resolve) => setTimeout(resolve, 50));
	eq('AP.7 second message does not respawn process', spawnCalls.length, 1);

	// (e) Switching away from a live conversation ends the running process, and manager can still send
	const prevChild = activeChild;
	let prevChildStopped = false;
	if (prevChild) {
		prevChild.on('exit', () => { prevChildStopped = true; });
	}
	await view.handleSelectSession('sess-am-second');
	check('AP.8 switching away stops the running process', prevChildStopped === true || prevChild?._exited === true);
	eq('AP.9 switching conversation alone does not spawn', spawnCalls.length, 1);

	textarea.value = 'Message in second resumed session';
	textarea.listeners['input']?.();
	sendBtn.click();
	await new Promise((resolve) => setTimeout(resolve, 50));
	eq('AP.10 manager spawns for newly selected session', spawnCalls.length, 2);
	const secondSpawnArgv = spawnCalls[1]?.argv ?? [];
	const secondResumeIndex = secondSpawnArgv.indexOf('--resume');
	check('AP.11 second session argv has --resume', secondResumeIndex !== -1);
	eq('AP.12 second session argv has second session ID', secondSpawnArgv[secondResumeIndex + 1], 'sess-am-second');
	check('AP.13 broker flags survived and present in second session', secondSpawnArgv.includes('--permission-prompt-tool'));

	// (c) A fresh conversation with no selection spawns with NO --resume anywhere in argv
	const freshContainer = new FakeElement() as any;
	const freshLeaf = new WorkspaceLeaf(app, freshContainer);
	const freshSession = new SessionManager(app, undefined, process.execPath);
	const freshView = new ChatView(freshLeaf, freshSession, store);
	await (freshView as any).onOpen();

	const freshTextarea = freshContainer.querySelector('textarea');
	const freshSendBtn = freshContainer.querySelector('.guki-composer-send');
	freshTextarea.value = 'Message in fresh unresumed conversation';
	freshTextarea.listeners['input']?.();
	freshSendBtn.click();
	await new Promise((resolve) => setTimeout(resolve, 50));

	eq('AP.14 fresh conversation spawns on first message', spawnCalls.length, 3);
	const freshArgv = spawnCalls[2]?.argv ?? [];
	check('AP.15 fresh conversation has NO --resume flag in argv', !freshArgv.includes('--resume'));
	check('AP.16 fresh conversation has broker flags', freshArgv.includes('--permission-prompt-tool'));

	// Teardown
	session.dispose();
	freshSession.dispose();
	cp.spawn = origSpawn;
}

// Counts the HISTORY control only, in either layout.
// It used to count every `.view-action` in the panel, which was fine while the history button was
// the only one. Görev 9b added a second view action (new conversation), and a blanket count then
// read 2 and failed — the assertion's intent ("no duplicate history control after a layout move")
// was never about the total number of view actions. Narrowed, not weakened: AX6 asserts the same
// exactly-one property for the new control.
function countHistoryControls(container: any): number {
	const actions = Array.from(container.querySelectorAll('.view-action') as any[]).filter((el: any) => {
		const label = el?.getAttribute?.('aria-label') ?? el?.attrs?.['aria-label'];
		return label === 'Conversation history';
	});
	return actions.length + container.querySelectorAll('.guki-header-history-btn').length;
}

// AQ: Görev 8: Dynamic conversation-history button placement
{
	console.log('AQ. Görev 8: Dynamic conversation-history button placement');

	const app = new App();
	const state = new ChatState();
	const session = {
		state,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: TRANSCRIPT_TEST_DIR, outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;
	const store = new NodeTranscriptStore(TRANSCRIPT_TEST_DIR);

	// (a) Docked in a side panel -> in-panel button present, no view action registered
	{
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		(leaf as any).setRoot((app.workspace as any).rightSplit);
		const view = new ChatView(leaf, session, store);
		await (view as any).onOpen();

		const inPanelBtn = container.querySelector('.guki-header-history-btn');
		const viewActionEl = container.querySelector('.view-action');
		const headerEl = container.querySelector('.guki-header');

		check('AQ.a1 in-panel button present when docked in side panel', inPanelBtn !== null);
		check('AQ.a2 in-panel header strip present in side panel', headerEl !== null);
		check('AQ.a3 no view action registered in side panel', viewActionEl === null);
		check('AQ.a4 exactly one control in side panel', inPanelBtn !== null && viewActionEl === null);

		await (view as any).onClose();
	}

	// (b) Docked in the main area -> view action registered, no in-panel header strip in the DOM
	{
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		(leaf as any).setRoot((app.workspace as any).rootSplit);
		const view = new ChatView(leaf, session, store);
		await (view as any).onOpen();

		const inPanelBtn = container.querySelector('.guki-header-history-btn');
		const headerEl = container.querySelector('.guki-header');
		const viewActionEl = container.querySelector('.view-action');

		check('AQ.b1 view action registered when docked in main area', viewActionEl !== null);
		check('AQ.b2 no in-panel header strip in DOM in main area', headerEl === null);
		check('AQ.b3 no in-panel button in main area', inPanelBtn === null);
		check('AQ.b4 exactly one control in main area', viewActionEl !== null && inPanelBtn === null);

		await (view as any).onClose();
	}

	// (c) In both placements, clicking the visible control opens the dropdown, and trigger is that control
	{
		// Side panel placement
		const sideContainer = new FakeElement() as any;
		const sideLeaf = new WorkspaceLeaf(app, sideContainer);
		(sideLeaf as any).setRoot((app.workspace as any).rightSplit);
		const sideView = new ChatView(sideLeaf, session, store);
		await (sideView as any).onOpen();

		const sideDropdown = sideView.getHistoryDropdown();
		const sideControl = sideView.getHistoryTriggerEl();
		check('AQ.c1 side panel dropdown trigger matches visible control', sideDropdown?.getTriggerEl() === sideControl && sideControl !== null);
		check('AQ.c2 side panel history dropdown initially closed', sideDropdown?.isOpen() === false);
		sideControl?.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		check('AQ.c3 clicking side panel trigger opens dropdown', sideDropdown?.isOpen() === true);
		await (sideView as any).onClose();

		// Main area placement
		const mainContainer = new FakeElement() as any;
		const mainLeaf = new WorkspaceLeaf(app, mainContainer);
		(mainLeaf as any).setRoot((app.workspace as any).rootSplit);
		const mainView = new ChatView(mainLeaf, session, store);
		await (mainView as any).onOpen();

		const mainDropdown = mainView.getHistoryDropdown();
		const mainControl = mainView.getHistoryTriggerEl();
		check('AQ.c4 main area dropdown trigger matches visible control', mainDropdown?.getTriggerEl() === mainControl && mainControl !== null);
		check('AQ.c5 main area dropdown trigger is the view action', mainControl === mainContainer.querySelector('.view-action'));
		check('AQ.c6 main area history dropdown initially closed', mainDropdown?.isOpen() === false);
		mainControl?.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
		check('AQ.c7 clicking main area view action opens dropdown', mainDropdown?.isOpen() === true);
		await (mainView as any).onClose();
	}

	// (d) Moving the panel sidebar -> main -> sidebar leaves exactly one control after each move
	{
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		(leaf as any).setRoot((app.workspace as any).rightSplit);
		const view = new ChatView(leaf, session, store);
		await (view as any).onOpen();

		// Initial: sidebar
		const sideBtn = container.querySelector('.guki-header-history-btn');
		const sideAction = container.querySelector('.view-action');
		check('AQ.d1 initially in sidebar has in-panel button and no view action', sideBtn !== null && sideAction === null);

		// Move to main area
		(leaf as any).setRoot((app.workspace as any).rootSplit);
		(app.workspace as any).trigger('layout-change');

		const mainBtn = container.querySelector('.guki-header-history-btn');
		const mainHeader = container.querySelector('.guki-header');
		const mainAction = container.querySelector('.view-action');
		const dropdown = view.getHistoryDropdown();
		const activeTriggerAfterMoveToMain = view.getHistoryTriggerEl();
		const controlsCountAfterMoveToMain = countHistoryControls(container);

		eq('AQ.d2 move sidebar to main leaves exactly one control (old control torn down)', controlsCountAfterMoveToMain, 1);
		check('AQ.d3 move sidebar to main has view action and no in-panel header', mainAction !== null && mainBtn === null && mainHeader === null);
		check('AQ.d4 dropdown trigger updated to view action after move to main', dropdown?.getTriggerEl() === mainAction && activeTriggerAfterMoveToMain === mainAction);

		// Move back to sidebar
		(leaf as any).setRoot((app.workspace as any).rightSplit);
		(app.workspace as any).trigger('layout-change');

		const returnBtn = container.querySelector('.guki-header-history-btn');
		const returnHeader = container.querySelector('.guki-header');
		const returnAction = container.querySelector('.view-action');
		const activeTriggerAfterReturn = view.getHistoryTriggerEl();
		const controlsCountAfterReturn = countHistoryControls(container);

		eq('AQ.d5 move main back to sidebar leaves exactly one control (view action torn down)', controlsCountAfterReturn, 1);
		check('AQ.d6 move main back to sidebar has in-panel button and no view action', returnBtn !== null && returnHeader !== null && returnAction === null);
		check('AQ.d7 dropdown trigger updated to in-panel button after return', dropdown?.getTriggerEl() === returnBtn && activeTriggerAfterReturn === returnBtn);

		await (view as any).onClose();
	}

	// (e) Trap 1 safeguard: cramped main area leaf falls back to in-panel button (never zero controls)
	{
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		(leaf as any).setRoot((app.workspace as any).rootSplit);
		const view = new ChatView(leaf, session, store);
		await (view as any).onOpen();

		// Initially wide main area -> view action present
		check('AQ.e1 wide main area has view action', container.querySelector('.view-action') !== null);

		// Resize main leaf to narrow (< 480px)
		container.clientWidth = 320;
		(view as any).rootEl.clientWidth = 320;
		view.onResize();

		const narrowInPanelBtn = container.querySelector('.guki-header-history-btn');
		const narrowViewAction = container.querySelector('.view-action');
		const dropdown = view.getHistoryDropdown();
		const narrowControlsCount = countHistoryControls(container);

		check('AQ.e2 narrow main leaf falls back to in-panel button', narrowInPanelBtn !== null);
		check('AQ.e3 narrow main leaf tears down view action', narrowViewAction === null);
		eq('AQ.e4 narrow main leaf has exactly one control (never zero)', narrowControlsCount, 1);
		check('AQ.e5 dropdown trigger updated to in-panel button in narrow main leaf', dropdown?.getTriggerEl() === narrowInPanelBtn);

		// Resize back to wide (>= 480px)
		container.clientWidth = 800;
		(view as any).rootEl.clientWidth = 800;
		view.onResize();

		const wideInPanelBtn = container.querySelector('.guki-header-history-btn');
		const wideViewAction = container.querySelector('.view-action');
		const wideControlsCount = countHistoryControls(container);

		check('AQ.e6 wide main leaf restores view action', wideViewAction !== null);
		check('AQ.e7 wide main leaf removes in-panel button', wideInPanelBtn === null);
		eq('AQ.e8 wide main leaf has exactly one control (never zero)', wideControlsCount, 1);

		await (view as any).onClose();
	}
}

// AR: Phase 7 Task 9 Lane 1: Title data layer, precedence, and listSessions overlay
{
	console.log('AR. Phase 7 Task 9 Lane 1: Title data layer and listSessions overlay');

	// --- AR1: ConversationTitleStore exact surface and semantics ---
	{
		let savedMap: ConversationTitleMap | null = null;
		let saveCount = 0;
		const mockSave = async (map: ConversationTitleMap) => {
			savedMap = map;
			saveCount++;
		};

		// Degradation of malformed initial data
		const badStore1 = new ConversationTitleStore(null as any, mockSave);
		eq('AR1.1 malformed null initial data degrades to empty snapshot', Object.keys(badStore1.snapshot()).length, 0);

		const badStore2 = new ConversationTitleStore('not-an-object' as any, mockSave);
		eq('AR1.2 malformed non-object initial data degrades to empty snapshot', Object.keys(badStore2.snapshot()).length, 0);

		const badStore3 = new ConversationTitleStore({ 's1': { bad: true } } as any, mockSave);
		eq('AR1.3 entries missing title degrade to empty', Object.keys(badStore3.snapshot()).length, 0);

		// Basic get on empty store
		const store = new ConversationTitleStore({}, mockSave);
		eq('AR1.4 get returns undefined for non-existent session', store.get('unknown-session'), undefined);

		// Set trims title and stamps updatedAt
		const beforeSet = Date.now();
		await store.set('session-1', '  User Given Name  ');
		const afterSet = Date.now();

		eq('AR1.5 get returns stored trimmed name', store.get('session-1'), 'User Given Name');
		const snap = store.snapshot();
		eq('AR1.6 snapshot contains stored entry', snap['session-1']?.title, 'User Given Name');
		check('AR1.7 updatedAt is stamped with current time', (snap['session-1']?.updatedAt ?? 0) >= beforeSet && (snap['session-1']?.updatedAt ?? 0) <= afterSet);
		eq('AR1.8 save callback was called once', saveCount, 1);
		eq('AR1.9 save callback received current snapshot', savedMap?.['session-1']?.title, 'User Given Name');

		// Snapshot is a defensive copy
		if (snap['session-1']) {
			snap['session-1'].title = 'Mutated Snapshot';
		}
		eq('AR1.10 mutating snapshot does not affect store', store.get('session-1'), 'User Given Name');

		// Undo path: empty or whitespace-only title removes the entry
		await store.set('session-1', '');
		eq('AR1.11 setting empty string removes the entry', store.get('session-1'), undefined);
		eq('AR1.12 save callback was called on removal', saveCount, 2);
		eq('AR1.13 snapshot after empty set has no session-1', store.snapshot()['session-1'], undefined);

		// Re-set, then whitespace-only undo
		await store.set('session-1', 'Temp Title');
		eq('AR1.14 entry re-added', store.get('session-1'), 'Temp Title');
		await store.set('session-1', '   \t\n  ');
		eq('AR1.15 setting whitespace-only string removes the entry', store.get('session-1'), undefined);

		// Remove method
		await store.set('session-2', 'Keep Me');
		saveCount = 0;
		await store.remove('session-2');
		eq('AR1.16 remove method deletes entry', store.get('session-2'), undefined);
		eq('AR1.17 remove calls save callback when entry was present', saveCount, 1);

		saveCount = 0;
		await store.remove('session-nonexistent');
		eq('AR1.18 remove does not call save when nothing was deleted', saveCount, 0);

		// PruneTo
		await store.set('s-keep-1', 'Keep 1');
		await store.set('s-keep-2', 'Keep 2');
		await store.set('s-drop-1', 'Drop 1');
		saveCount = 0;

		const pruned = await store.pruneTo(['s-keep-1', 's-keep-2', 's-other']);
		eq('AR1.19 pruneTo returns true when entries were dropped', pruned, true);
		eq('AR1.20 dropped entry removed from store', store.get('s-drop-1'), undefined);
		eq('AR1.21 kept entry 1 remains', store.get('s-keep-1'), 'Keep 1');
		eq('AR1.22 kept entry 2 remains', store.get('s-keep-2'), 'Keep 2');
		eq('AR1.23 pruneTo called save callback once', saveCount, 1);

		saveCount = 0;
		const prunedNothing = await store.pruneTo(['s-keep-1', 's-keep-2']);
		eq('AR1.24 pruneTo returns false when nothing removed', prunedNothing, false);
		eq('AR1.25 pruneTo does not call save when nothing changed', saveCount, 0);
	}

	// --- AR2: Precedence and helpers in session-index.ts ---
	{
		const summaryCustomAi: SessionSummary = {
			sessionId: 's-c-ai',
			customTitle: 'My Custom Name',
			title: 'AI Given Title',
			derivedTitle: 'Derived prompt text',
			startedAt: '2026-09-01T10:00:00.000Z',
		};
		const rCustomAi = resolveSessionTitle(summaryCustomAi);
		eq('AR2.1 custom+ai precedence: custom wins text', rCustomAi.text, 'My Custom Name');
		eq('AR2.2 custom+ai precedence: source is custom', rCustomAi.source, 'custom');
		eq('AR2.3 panelTitleFor returns custom title', panelTitleFor(summaryCustomAi), 'My Custom Name');
		const dtCustom = sessionDisplayTitle(summaryCustomAi);
		eq('AR2.4 sessionDisplayTitle on custom returns text', dtCustom?.text, 'My Custom Name');
		eq('AR2.5 sessionDisplayTitle on custom isDerived is false', dtCustom?.isDerived, false);

		const summaryCustomDerived: SessionSummary = {
			sessionId: 's-c-der',
			customTitle: 'Renamed Project',
			derivedTitle: 'First user prompt text',
			startedAt: '2026-09-01T10:00:00.000Z',
		};
		const rCustomDer = resolveSessionTitle(summaryCustomDerived);
		eq('AR2.6 custom+derived precedence: custom wins text', rCustomDer.text, 'Renamed Project');
		eq('AR2.7 custom+derived precedence: source is custom', rCustomDer.source, 'custom');
		eq('AR2.8 panelTitleFor on custom+derived returns custom title', panelTitleFor(summaryCustomDerived), 'Renamed Project');

		const summaryAiOnly: SessionSummary = {
			sessionId: 's-ai',
			title: 'Claude AI Generated Title',
			derivedTitle: 'First message trim',
			startedAt: '2026-09-01T10:00:00.000Z',
		};
		const rAi = resolveSessionTitle(summaryAiOnly);
		eq('AR2.9 ai-only precedence: ai title wins text', rAi.text, 'Claude AI Generated Title');
		eq('AR2.10 ai-only precedence: source is ai', rAi.source, 'ai');
		eq('AR2.11 panelTitleFor on ai returns ai title', panelTitleFor(summaryAiOnly), 'Claude AI Generated Title');
		const dtAi = sessionDisplayTitle(summaryAiOnly);
		eq('AR2.12 sessionDisplayTitle on ai returns text', dtAi?.text, 'Claude AI Generated Title');
		eq('AR2.13 sessionDisplayTitle on ai isDerived is false', dtAi?.isDerived, false);

		const summaryDerivedOnly: SessionSummary = {
			sessionId: 's-der',
			derivedTitle: 'Help me fix the compiler error',
			startedAt: '2026-09-01T10:00:00.000Z',
		};
		const rDer = resolveSessionTitle(summaryDerivedOnly);
		eq('AR2.14 derived-only precedence: derived text wins', rDer.text, 'Help me fix the compiler error');
		eq('AR2.15 derived-only precedence: source is derived', rDer.source, 'derived');
		eq('AR2.16 panelTitleFor on derived returns null (never show trim in header)', panelTitleFor(summaryDerivedOnly), null);
		const dtDer = sessionDisplayTitle(summaryDerivedOnly);
		eq('AR2.17 sessionDisplayTitle on derived returns text', dtDer?.text, 'Help me fix the compiler error');
		eq('AR2.18 sessionDisplayTitle on derived isDerived is true', dtDer?.isDerived, true);

		const summaryNone: SessionSummary = {
			sessionId: 's-none',
			startedAt: '2026-09-01T10:00:00.000Z',
		};
		const rNone = resolveSessionTitle(summaryNone);
		eq('AR2.19 none precedence: text is Untitled session', rNone.text, 'Untitled session');
		eq('AR2.20 none precedence: source is none', rNone.source, 'none');
		eq('AR2.21 panelTitleFor on none returns null', panelTitleFor(summaryNone), null);
		eq('AR2.22 panelTitleFor on null returns null', panelTitleFor(null), null);
		eq('AR2.23 panelTitleFor on undefined returns null', panelTitleFor(undefined), null);
		eq('AR2.24 sessionDisplayTitle on none returns null', sessionDisplayTitle(summaryNone), null);
	}

	// --- AR3: shapeSessionRow delegates to resolveSessionTitle ---
	{
		const rowCustom = shapeSessionRow({
			sessionId: 's1',
			customTitle: 'Manual Session Title',
			title: 'AI Title',
			derivedTitle: 'Trimmed prompt',
			startedAt: '2026-09-01T10:00:00.000Z',
			costUsd: 0.15,
		});
		eq('AR3.1 shapeSessionRow uses customTitle when present', rowCustom.title, 'Manual Session Title');
		eq('AR3.2 shapeSessionRow isDerivedTitle is false for customTitle', rowCustom.isDerivedTitle, false);
		check('AR3.3 derived trim is absent from row title', !rowCustom.title.includes('Trimmed prompt'));

		const rowAi = shapeSessionRow({
			sessionId: 's2',
			title: 'AI Title',
			derivedTitle: 'Trimmed prompt',
			startedAt: '2026-09-01T10:00:00.000Z',
		});
		eq('AR3.4 shapeSessionRow uses AI title when customTitle absent', rowAi.title, 'AI Title');
		eq('AR3.5 shapeSessionRow isDerivedTitle is false for AI title', rowAi.isDerivedTitle, false);

		const rowDerived = shapeSessionRow({
			sessionId: 's3',
			derivedTitle: 'Trimmed prompt',
			startedAt: '2026-09-01T10:00:00.000Z',
		});
		eq('AR3.6 shapeSessionRow uses derivedTitle when both custom and ai absent', rowDerived.title, 'Trimmed prompt');
		eq('AR3.7 shapeSessionRow isDerivedTitle is true for derivedTitle', rowDerived.isDerivedTitle, true);

		const rowNone = shapeSessionRow({
			sessionId: 's4',
			startedAt: '2026-09-01T10:00:00.000Z',
		});
		eq('AR3.8 shapeSessionRow falls back to Untitled session', rowNone.title, 'Untitled session');
		eq('AR3.9 shapeSessionRow isDerivedTitle is false for Untitled session', rowNone.isDerivedTitle, false);
	}

	// --- AR4: scanSessionsDir isolation and customTitle never set by scanner ---
	{
		const fixtureDir = mkdtempSync(join(tmpdir(), 'guki-ar-scan-'));
		const s1File = join(fixtureDir, 'session-scan-1.jsonl');
		writeFileSync(
			s1File,
			[
				JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: 'Hello world prompt' }),
				JSON.stringify({ type: 'ai-title', aiTitle: 'Scanned AI Title' }),
			].join('\n') + '\n',
			'utf8',
		);

		const scanned = await scanSessionsDir(fixtureDir);
		eq('AR4.1 scanned sessions count is 1', scanned.length, 1);
		eq('AR4.2 scanned session title is aiTitle', scanned[0]?.title, 'Scanned AI Title');
		eq('AR4.3 scanSessionsDir NEVER sets customTitle', scanned[0]?.customTitle, undefined);

		rmSync(fixtureDir, { recursive: true, force: true });
	}

	// --- AR5: NodeTranscriptStore overlay and pruning semantics ---
	{
		const fixtureDir = mkdtempSync(join(tmpdir(), 'guki-ar-store-'));
		const sLive1 = join(fixtureDir, 'live-1.jsonl');
		const sLive2 = join(fixtureDir, 'live-2.jsonl');
		writeFileSync(sLive1, JSON.stringify({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: 'First prompt' }) + '\n', 'utf8');
		writeFileSync(sLive2, JSON.stringify({ type: 'user', timestamp: '2026-09-01T11:00:00.000Z', message: 'Second prompt' }) + '\n', 'utf8');

		let saveCount = 0;
		let lastSavedMap: ConversationTitleMap | null = null;
		const mockSave = async (map: ConversationTitleMap) => {
			saveCount++;
			lastSavedMap = map;
		};

		const titleStore = new ConversationTitleStore(
			{
				'live-1': { title: 'Custom One', updatedAt: 1000 },
				'dead-session': { title: 'Ghost Session', updatedAt: 2000 },
			},
			mockSave,
		);

		const store = new NodeTranscriptStore(fixtureDir, titleStore);
		const list = await store.listSessions('dummy-vault');

		eq('AR5.1 listSessions returned two scanned sessions', list.length, 2);
		const live1Summary = list.find((s) => s.sessionId === 'live-1');
		const live2Summary = list.find((s) => s.sessionId === 'live-2');
		eq('AR5.2 live-1 has customTitle overlaid from store', live1Summary?.customTitle, 'Custom One');
		eq('AR5.3 live-2 without customTitle has customTitle undefined', live2Summary?.customTitle, undefined);

		// Pruning occurred on scan because dead-session was not in scanned sessions
		eq('AR5.4 dead-session was pruned from titleStore', titleStore.get('dead-session'), undefined);
		eq('AR5.5 live-1 survived in titleStore', titleStore.get('live-1'), 'Custom One');
		eq('AR5.6 save callback called once on scan pruning dead entry', saveCount, 1);
		eq('AR5.7 saved map does not contain dead-session', lastSavedMap?.['dead-session'], undefined);
		eq('AR5.8 saved map contains live-1', lastSavedMap?.['live-1']?.title, 'Custom One');

		// Prune safety invariant: scanning an empty directory MUST NOT prune titles!
		const emptyDir = mkdtempSync(join(tmpdir(), 'guki-ar-empty-'));
		saveCount = 0;
		const emptyStore = new NodeTranscriptStore(emptyDir, titleStore);
		const emptyList = await emptyStore.listSessions('dummy-vault');

		eq('AR5.9 empty scan returned 0 sessions', emptyList.length, 0);
		eq('AR5.10 prune safety invariant: save callback was NOT called on zero sessions scan', saveCount, 0);
		eq('AR5.11 stored titles survive empty scan', titleStore.get('live-1'), 'Custom One');

		rmSync(fixtureDir, { recursive: true, force: true });
		rmSync(emptyDir, { recursive: true, force: true });
	}

	// --- AR6: Settings persistence through saveData in GukiChatPlugin ---
	{
		const plugin = new GukiChatPlugin(createMockPluginApp() as any, { dir: 'plugins/guki-chat' } as any);

		let savedData: any = null;
		plugin.loadData = async () => ({
			claudeBinaryPath: '/custom/claude',
			slashCommands: ['help', 'clear'],
			permissionMode: 'plan',
			conversationTitles: {
				's-existing': { title: 'Existing Name', updatedAt: 12345 },
			},
		});
		plugin.saveData = async (data: any) => {
			savedData = data;
		};

		await plugin.onload();

		// Invariant: whole settings object is preserved
		eq('AR6.1 loadSettings restores conversationTitles', plugin.settings.conversationTitles?.['s-existing']?.title, 'Existing Name');
		eq('AR6.2 loadSettings preserves claudeBinaryPath', plugin.settings.claudeBinaryPath, '/custom/claude');
		eq('AR6.3 loadSettings preserves slashCommands', plugin.settings.slashCommands?.length, 2);

		// Now simulate updating a title via titleStore save callback
		const titleStore = (plugin as any).titleStore as ConversationTitleStore;
		check('AR6.4 plugin created titleStore', titleStore !== undefined && titleStore !== null);

		// Deliberately NOT guarded by `if (titleStore)`: a check that skips itself when the thing
		// it guards is missing proves nothing. If the wiring regresses, these must go red, not quiet.
		await titleStore?.set('s-new', 'Newly Added Title');
		check('AR6.5 saveData was called with whole settings object', savedData !== null);
		eq('AR6.6 saved data has newly added title', savedData?.conversationTitles?.['s-new']?.title, 'Newly Added Title');
		eq('AR6.7 saved data preserves claudeBinaryPath', savedData?.claudeBinaryPath, '/custom/claude');
		eq('AR6.8 saved data preserves slashCommands', savedData?.slashCommands?.length, 2);
		eq('AR6.9 saved data preserves permissionMode', savedData?.permissionMode, 'plan');

		// A session id that collides with a JS object key must survive a snapshot round trip:
		// `copy['__proto__'] = v` on a plain object sets the prototype instead of an own key.
		{
			const protoStore = new ConversationTitleStore(undefined, async () => {});
			await protoStore.set('__proto__', 'Prototype Named Session');
			const snap = protoStore.snapshot();
			eq('AR6.10 snapshot keeps a __proto__ session id as an own key', Object.keys(snap).includes('__proto__'), true);
			eq('AR6.11 snapshot survives JSON round trip for __proto__ id', JSON.parse(JSON.stringify(snap))['__proto__']?.title, 'Prototype Named Session');
		}

		plugin.onunload();
	}
}

// AS. Phase 7 Task 9 Lane 2: Manual rename in the history list
{
	console.log('AS. Phase 7 Task 9 Lane 2: Manual rename in the history list');

	const mockSummaries: SessionSummary[] = [
		{
			sessionId: 'sess-l2-1',
			title: 'CLI Title 1',
			startedAt: '2026-09-15T01:00:00.000Z',
			costUsd: 0.12,
		},
		{
			sessionId: 'sess-l2-2',
			derivedTitle: 'Derived Prompt 2',
			startedAt: '2026-09-15T02:00:00.000Z',
		},
	];

	let savedSettings: any = null;
	const settings = {
		claudeBinaryPath: '/custom/claude',
		permissionMode: 'plan',
		conversationTitles: {} as Record<string, any>,
	};
	const titleStore = new ConversationTitleStore(
		settings.conversationTitles,
		async (map) => {
			settings.conversationTitles = map;
			savedSettings = JSON.parse(JSON.stringify(settings));
		},
	);

	let selectedSessionId: string | null = null;
	const container = new FakeElement() as any;
	const dropdown = new HistoryDropdown({
		containerEl: container,
		getSessions: async () => mockSummaries,
		onSelectSession: (id) => {
			selectedSessionId = id;
		},
		titleStore,
	});

	await dropdown.openDropdown();
	const dropdownEl = dropdown.getDropdownEl() as any;
	let renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	eq('AS1.1 rendered row count is 2', renderedRows.length, 2);

	const renameBtn0 = renderedRows[0]?.querySelector('.guki-history-rename-btn');
	const renameBtn1 = renderedRows[1]?.querySelector('.guki-history-rename-btn');
	check('AS1.2 first row has pencil rename button', renameBtn0 !== null);
	check('AS1.3 second row has pencil rename button', renameBtn1 !== null);

	// AS1: Clicking pencil button does NOT select the row or close the dropdown
	renameBtn0?.click();
	eq('AS1.4 clicking pencil does not trigger session selection', selectedSessionId, null);
	check('AS1.5 dropdown remains open after clicking pencil', dropdown.isOpen() === true);

	// AS2: Clicking pencil opens input pre-filled with row's current name and selected
	const inputEl0 = dropdownEl.querySelector('input');
	check('AS2.1 clicking pencil opened input in first row', inputEl0 !== null);
	eq('AS2.2 input is pre-filled with current row name', inputEl0?.value, 'CLI Title 1');
	eq('AS2.3 input selection starts at 0', inputEl0?.selectionStart, 0);
	eq('AS2.4 input selection covers full title length', inputEl0?.selectionEnd, 'CLI Title 1'.length);

	// AS3: While input is open, ArrowDown/ArrowUp do NOT move dropdown selection
	const initialIndex = dropdown.getSelectedIndex();
	dropdown.handleKeyDown({ key: 'ArrowDown', preventDefault: () => {} } as any);
	eq('AS3.1 ArrowDown while input open does not advance selection', dropdown.getSelectedIndex(), initialIndex);
	dropdown.handleKeyDown({ key: 'ArrowUp', preventDefault: () => {} } as any);
	eq('AS3.2 ArrowUp while input open does not change selection', dropdown.getSelectedIndex(), initialIndex);

	// AS4: Enter stores name, updates row, writes saveData, dropdown stays open
	if (inputEl0) {
		inputEl0.value = 'My Custom Session Name';
	}
	dropdown.handleKeyDown({ key: 'Enter', preventDefault: () => {} } as any);
	await (dropdown as any).commitEdit?.();

	check('AS4.1 dropdown remains open across Enter save', dropdown.isOpen() === true);
	eq('AS4.2 row item title updated to custom name', dropdown.getItems()[0]?.title, 'My Custom Session Name');
	eq('AS4.3 row item is NOT marked derived', dropdown.getItems()[0]?.isDerivedTitle, false);
	eq('AS4.4 titleStore snapshot contains new custom title', titleStore.get('sess-l2-1'), 'My Custom Session Name');
	check('AS4.5 saveData was called with full settings object', savedSettings !== null);
	eq('AS4.6 saveData preserved claudeBinaryPath', savedSettings?.claudeBinaryPath, '/custom/claude');
	eq('AS4.7 saveData stored new title in conversationTitles', savedSettings?.conversationTitles?.['sess-l2-1']?.title, 'My Custom Session Name');

	renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	check('AS4.8 DOM row element displays updated title', renderedRows[0]?.text.includes('My Custom Session Name'));
	check('AS4.9 input element removed after save', renderedRows[0]?.querySelector('input') === null);

	// AS5: Escape cancels, stores nothing, restores row text, dropdown stays open
	const renameBtn1Before = renderedRows[1]?.querySelector('.guki-history-rename-btn');
	renameBtn1Before?.click();
	const inputEl1 = dropdownEl.querySelector('input');
	check('AS5.1 second row input opened', inputEl1 !== null);
	eq('AS5.2 second row input pre-filled with derived title', inputEl1?.value, 'Derived Prompt 2');

	if (inputEl1) {
		inputEl1.value = 'Discarded Edit';
	}
	dropdown.handleKeyDown({ key: 'Escape', preventDefault: () => {} } as any);

	check('AS5.3 dropdown remains open across Escape cancel', dropdown.isOpen() === true);
	eq('AS5.4 row item retains original derived title', dropdown.getItems()[1]?.title, 'Derived Prompt 2');
	eq('AS5.5 row item retains derived status', dropdown.getItems()[1]?.isDerivedTitle, true);
	eq('AS5.6 titleStore does NOT contain canceled edit', titleStore.get('sess-l2-2'), undefined);
	renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	check('AS5.7 input element removed after Escape', renderedRows[1]?.querySelector('input') === null);
	check('AS5.8 DOM row displays original derived title', renderedRows[1]?.text.includes('Derived Prompt 2'));

	// AS6: Blur stores the name
	const renameBtn1Again = renderedRows[1]?.querySelector('.guki-history-rename-btn');
	renameBtn1Again?.click();
	const inputEl1Blur = dropdownEl.querySelector('input');
	if (inputEl1Blur) {
		inputEl1Blur.value = 'Saved By Blur';
		inputEl1Blur.blur();
	}
	await (dropdown as any).commitEdit?.();

	check('AS6.1 dropdown remains open after blur save', dropdown.isOpen() === true);
	eq('AS6.2 titleStore contains name saved via blur', titleStore.get('sess-l2-2'), 'Saved By Blur');
	eq('AS6.3 row item displays name saved via blur', dropdown.getItems()[1]?.title, 'Saved By Blur');
	eq('AS6.4 name saved via blur is NOT marked derived', dropdown.getItems()[1]?.isDerivedTitle, false);

	// AS7: Saving empty or whitespace-only box removes name and falls back correctly
	// Case A: with CLI title (sess-l2-1 has CLI title 'CLI Title 1')
	renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	const renameBtn0Again = renderedRows[0]?.querySelector('.guki-history-rename-btn');
	renameBtn0Again?.click();
	const inputEl0Clear = dropdownEl.querySelector('input');
	if (inputEl0Clear) {
		inputEl0Clear.value = '   ';
	}
	dropdown.handleKeyDown({ key: 'Enter', preventDefault: () => {} } as any);
	await (dropdown as any).commitEdit?.();

	check('AS7.1 whitespace save removes entry from titleStore', titleStore.get('sess-l2-1') === undefined);
	eq('AS7.2 row falls back to CLI title', dropdown.getItems()[0]?.title, 'CLI Title 1');
	eq('AS7.3 CLI title fallback is NOT marked derived', dropdown.getItems()[0]?.isDerivedTitle, false);
	check('AS7.4 dropdown stays open after removing custom name', dropdown.isOpen() === true);

	// Case B: with only derived trim (sess-l2-2 has only derivedTitle 'Derived Prompt 2')
	renderedRows = dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));
	const renameBtn1Clear = renderedRows[1]?.querySelector('.guki-history-rename-btn');
	renameBtn1Clear?.click();
	const inputEl1Clear = dropdownEl.querySelector('input');
	if (inputEl1Clear) {
		inputEl1Clear.value = '';
	}
	dropdown.handleKeyDown({ key: 'Enter', preventDefault: () => {} } as any);
	await (dropdown as any).commitEdit?.();

	check('AS7.5 empty save removes entry from titleStore', titleStore.get('sess-l2-2') === undefined);
	eq('AS7.6 row falls back to derived prompt trim', dropdown.getItems()[1]?.title, 'Derived Prompt 2');
	eq('AS7.7 derived trim fallback IS marked derived', dropdown.getItems()[1]?.isDerivedTitle, true);
	check('AS7.8 dropdown stays open after empty save', dropdown.isOpen() === true);

	// AS8: ChatView integration passes titleStore to HistoryDropdown
	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);
	const session = {
		state: new ChatState(),
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => ['clear', 'help'],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;
	const transcriptStore = new NodeTranscriptStore('/tmp/test-vault');
	const view = new ChatView(leaf as any, session as any, transcriptStore, titleStore);
	await (view as any).onOpen();
	const viewDropdown = view.getHistoryDropdown();
	check('AS8.1 view has history dropdown', viewDropdown !== null);
	eq('AS8.2 ChatView passes titleStore to HistoryDropdown', (viewDropdown as any).options?.titleStore, titleStore);
	await (view as any).onClose();

	dropdown.close();
}

// ---------------------------------------------------------------------------
// AT. Rename edge cases found by the V2 verification round (orchestrator fixes)
// ---------------------------------------------------------------------------
{
	const mockSummaries: SessionSummary[] = [
		{ sessionId: 'sess-at-1', title: 'CLI Title 1', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-at-2', title: 'CLI Title 2', startedAt: '2026-09-15T02:00:00.000Z' },
	];

	const settings = { conversationTitles: {} as Record<string, any> };
	// A save that does not resolve until we let it: this is the whole point of the check —
	// a second rename must not be swallowed while the first one is still writing.
	let releaseFirstSave: (() => void) | null = null;
	let saveCount = 0;
	const titleStore = new ConversationTitleStore(
		settings.conversationTitles,
		async (map) => {
			settings.conversationTitles = map;
			saveCount += 1;
			if (saveCount === 1) {
				await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
			}
		},
	);

	let selectedSessionId: string | null = null;
	const container = new FakeElement() as any;
	const dropdown = new HistoryDropdown({
		containerEl: container,
		getSessions: async () => mockSummaries,
		onSelectSession: (id) => { selectedSessionId = id; },
		titleStore,
	});

	await dropdown.openDropdown();
	const dropdownEl = dropdown.getDropdownEl() as any;
	const rows = () => dropdownEl.children.filter((c: any) => c.hasClass('guki-history-item'));

	// AT1: renaming a second row while the first save is still in flight must not be dropped.
	rows()[0]?.querySelector('.guki-history-rename-btn')?.click();
	let input = dropdownEl.querySelector('input');
	input.value = 'First New Name';
	const firstCommit = dropdown.commitEdit();

	rows()[1]?.querySelector('.guki-history-rename-btn')?.click();
	input = dropdownEl.querySelector('input');
	check('AT1.1 second row editor opened while the first save is in flight', input !== null);
	input.value = 'Second New Name';
	const secondCommit = dropdown.commitEdit();

	// The save callback runs a microtask later, so the release handle does not exist yet.
	while (releaseFirstSave === null) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	releaseFirstSave();
	await firstCommit;
	await secondCommit;

	eq('AT1.2 first rename survived', titleStore.get('sess-at-1'), 'First New Name');
	eq('AT1.3 second rename was not dropped by the in-flight save', titleStore.get('sess-at-2'), 'Second New Name');
	eq('AT1.4 both renames reached the store', saveCount, 2);

	// AT2: Enter twice in a row must not fall through into opening whatever row is highlighted.
	selectedSessionId = null;
	rows()[1]?.querySelector('.guki-history-rename-btn')?.click();
	input = dropdownEl.querySelector('input');
	input.value = 'Renamed By Keyboard';
	const enter = { key: 'Enter', preventDefault: () => {} } as unknown as KeyboardEvent;
	dropdown.handleKeyDown(enter);
	dropdown.handleKeyDown(enter);
	await dropdown.commitEdit();
	eq('AT2.1 the rename itself committed', titleStore.get('sess-at-2'), 'Renamed By Keyboard');
	eq('AT2.2 the second Enter did not open a conversation', selectedSessionId, null);
	check('AT2.3 the dropdown is still open after the second Enter', dropdown.isOpen() === true);

	// AT3: an Enter that is not a leftover from committing still works normally.
	dropdown.handleKeyDown(enter);
	check('AT3.1 a later Enter still selects a conversation', selectedSessionId !== null);
}

// ---------------------------------------------------------------------------
// AU. Phase 7 Task 9 Lane 3: History dropdown refresh and panel header title
// ---------------------------------------------------------------------------
console.log('AU. Phase 7 Task 9 Lane 3: History dropdown refresh and panel header title');

// AU1: Dropdown closed vs open scan counts & on-disk title refresh (F1)
{
	let scanCount = 0;
	let currentSummaries: SessionSummary[] = [
		{ sessionId: 'sess-au-1', title: 'Old Disk Title', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-au-2', title: 'Session 2 Title', startedAt: '2026-09-15T02:00:00.000Z' },
	];

	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);

	const mockReducer = {
		onTurnEnd: null as (() => void) | null,
	};
	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const mockStore = {
		listSessions: async () => {
			scanCount++;
			return [...currentSummaries];
		},
		readSession: async () => Object.assign([], { hasMoreBefore: false, loadBefore: async () => [] }) as any,
		resumeArgs: () => [],
	} as unknown as TranscriptStore;

	const titleStore = new ConversationTitleStore({}, async () => {});
	const view = new ChatView(leaf as any, session as any, mockStore, titleStore);
	await (view as any).onOpen();

	const dropdown = view.getHistoryDropdown()!;
	check('AU1.0 dropdown exists', dropdown !== null);
	eq('AU1.0b dropdown is closed initially', dropdown.isOpen(), false);

	// Dropdown closed + turn ends -> scan count is exactly zero
	scanCount = 0;
	// Unconditional on purpose: if the view never wires a turn-end handler, this must go red.
	// Guarding the call would let the check pass by doing nothing at all.
	check('AU1.0c view attached a turn-end handler to the reducer', typeof mockReducer.onTurnEnd === 'function');
	mockReducer.onTurnEnd!();
	eq('AU1.1 dropdown closed + turn ends has scan count exactly zero', scanCount, 0);

	// Open dropdown -> initial scan
	await view.toggleHistory();
	check('AU1.2a dropdown is open', dropdown.isOpen() === true);
	const initialScanCount = scanCount;
	check('AU1.2b initial open scanned once', initialScanCount >= 1);

	// Row shows old title initially
	const rows = () => dropdown.getDropdownEl().children.filter((c: any) => c.hasClass?.('guki-history-item'));
	const firstTitleEl = rows()[0]?.querySelector('.guki-history-title');
	eq('AU1.2c first row shows old title', firstTitleEl?.text, 'Old Disk Title');

	// Simulate title changed on disk while dropdown is open
	currentSummaries = [
		{ sessionId: 'sess-au-1', title: 'New Disk Title Arrived', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-au-2', title: 'Session 2 Title', startedAt: '2026-09-15T02:00:00.000Z' },
	];

	// Turn ends while dropdown is open -> rescanned
	const prevScanCount = scanCount;
	if (mockReducer.onTurnEnd) {
		mockReducer.onTurnEnd();
	} else if (typeof (view as any).handleTurnEnd === 'function') {
		await (view as any).handleTurnEnd();
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 10));

	eq('AU1.3 dropdown open + turn ends triggered rescan', scanCount, prevScanCount + 1);
	const updatedTitleEl = rows()[0]?.querySelector('.guki-history-title');
	eq('AU1.4 row title updated on disk shows new text', updatedTitleEl?.text, 'New Disk Title Arrived');

	await (view as any).onClose();
}

// AU2: Refresh preserves keyboard-selected row by sessionId and handles missing session fallback
{
	let currentSummaries: SessionSummary[] = [
		{ sessionId: 'sess-a', title: 'Session A', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-b', title: 'Session B', startedAt: '2026-09-15T02:00:00.000Z' },
		{ sessionId: 'sess-c', title: 'Session C', startedAt: '2026-09-15T03:00:00.000Z' },
	];

	const dropdownContainer = new FakeElement() as any;
	const dropdown = new HistoryDropdown({
		containerEl: dropdownContainer,
		getSessions: async () => [...currentSummaries],
		onSelectSession: () => {},
	});

	await dropdown.openDropdown();
	check('AU2.1 dropdown is open', dropdown.isOpen() === true);
	eq('AU2.2 initial selected index is 0', dropdown.getSelectedIndex(), 0);

	// Select Session B (ArrowDown)
	dropdown.handleKeyDown({ key: 'ArrowDown', preventDefault: () => {} } as any);
	eq('AU2.3 selected index is 1 (Session B)', dropdown.getSelectedIndex(), 1);
	eq('AU2.4 selected item is sess-b', dropdown.getItems()[dropdown.getSelectedIndex()]?.sessionId, 'sess-b');

	// Simulate new session arrived at the top: [sess-new, sess-a, sess-b, sess-c]
	currentSummaries = [
		{ sessionId: 'sess-new', title: 'Session New', startedAt: '2026-09-15T04:00:00.000Z' },
		{ sessionId: 'sess-a', title: 'Session A', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-b', title: 'Session B', startedAt: '2026-09-15T02:00:00.000Z' },
		{ sessionId: 'sess-c', title: 'Session C', startedAt: '2026-09-15T03:00:00.000Z' },
	];

	check('AU2.5a dropdown has refresh method', typeof (dropdown as any).refresh === 'function');
	await (dropdown as any).refresh();
	eq('AU2.5 selected item after refresh is still sess-b', dropdown.getItems()[dropdown.getSelectedIndex()]?.sessionId, 'sess-b');
	eq('AU2.6 selected index followed sess-b to 2', dropdown.getSelectedIndex(), 2);

	// Simulate sess-b disappearing from the scan: [sess-new, sess-a, sess-c]
	currentSummaries = [
		{ sessionId: 'sess-new', title: 'Session New', startedAt: '2026-09-15T04:00:00.000Z' },
		{ sessionId: 'sess-a', title: 'Session A', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-c', title: 'Session C', startedAt: '2026-09-15T03:00:00.000Z' },
	];

	await (dropdown as any).refresh();
	check('AU2.7 dropdown remains open when selected session disappears', dropdown.isOpen() === true);
	eq('AU2.8 selection moved to nearest row index 2', dropdown.getSelectedIndex(), 2);
	eq('AU2.9 selection is now sess-c', dropdown.getItems()[dropdown.getSelectedIndex()]?.sessionId, 'sess-c');

	dropdown.close();
}

// AU3: Refresh preserves open rename editor and typed text
{
	let currentSummaries: SessionSummary[] = [
		{ sessionId: 'sess-edit-1', title: 'Edit Session 1', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-edit-2', title: 'Edit Session 2', startedAt: '2026-09-15T02:00:00.000Z' },
	];

	const dropdownContainer = new FakeElement() as any;
	const titleStore = new ConversationTitleStore({}, async () => {});
	const dropdown = new HistoryDropdown({
		containerEl: dropdownContainer,
		getSessions: async () => [...currentSummaries],
		onSelectSession: () => {},
		titleStore,
	});

	await dropdown.openDropdown();
	dropdown.startEditing('sess-edit-1');
	check('AU3.1 dropdown is editing', dropdown.isEditing() === true);
	eq('AU3.2 editing sessionId is sess-edit-1', dropdown.getEditingSessionId(), 'sess-edit-1');

	const input = dropdown.getDropdownEl().querySelector('input') as any;
	check('AU3.3 input element exists before refresh', input !== null);
	input.value = 'User In-Progress Typing...';
	input.setSelectionRange?.(5, 12);

	check('AU3.3b dropdown has refresh method', typeof (dropdown as any).refresh === 'function');
	await (dropdown as any).refresh();

	check('AU3.4 dropdown is still editing after refresh', dropdown.isEditing() === true);
	eq('AU3.5 editing sessionId is still sess-edit-1', dropdown.getEditingSessionId(), 'sess-edit-1');
	const inputAfter = dropdown.getDropdownEl().querySelector('input') as any;
	check('AU3.6 input element exists after refresh', inputAfter !== null);
	eq('AU3.7 typed text is intact after refresh', inputAfter?.value, 'User In-Progress Typing...');
	eq('AU3.8 selectionStart preserved', inputAfter?.selectionStart, 5);
	eq('AU3.9 selectionEnd preserved', inputAfter?.selectionEnd, 12);

	dropdown.close();
}

// AU4: F3 Panel Header precedence and derived trim never produced on header path
{
	const leaf = new WorkspaceLeaf(new App() as any);
	const session = {
		state: new ChatState(),
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
	} as unknown as SessionManager;

	const titleStore = new ConversationTitleStore(
		{ 'sess-custom': { title: 'User Custom Name', updatedAt: 1000 } },
		async () => {},
	);
	const view = new ChatView(leaf as any, session as any, undefined, titleStore);

	check('AU4.0a view has setCurrentSessionSummary', typeof (view as any).setCurrentSessionSummary === 'function');
	check('AU4.0b view has getPanelTitle', typeof (view as any).getPanelTitle === 'function');

	// 1. Session with stored name + CLI title + derived trim -> stored name wins
	(view as any).setCurrentSessionSummary?.({
		sessionId: 'sess-custom',
		title: 'CLI Title',
		derivedTitle: 'Derived Prompt Trim',
		startedAt: '2026-09-15T01:00:00.000Z',
	});
	eq('AU4.1 header shows stored custom name', view.getDisplayText(), 'User Custom Name');
	eq('AU4.1b getPanelTitle produces stored name', (view as any).getPanelTitle?.(), 'User Custom Name');

	// 2. Session with CLI title + derived trim (no stored name) -> CLI title wins
	(view as any).setCurrentSessionSummary?.({
		sessionId: 'sess-cli',
		title: 'CLI Title Only',
		derivedTitle: 'Derived Prompt Trim',
		startedAt: '2026-09-15T02:00:00.000Z',
	});
	eq('AU4.2 header shows CLI title when no stored name', view.getDisplayText(), 'CLI Title Only');
	eq('AU4.2b getPanelTitle produces CLI title', (view as any).getPanelTitle?.(), 'CLI Title Only');

	// AU4.3/AU4.5 (and AU5.1/AU5.11/AU5.13) expect the fallback constant, which is also what the
	// pre-change code returned, so on their own they cannot tell the two apart. They are not
	// hardened by twisting the fixture — `GuKi Chat` IS the required answer here. What makes the
	// block discriminating is the positive check beside them: AU4.2 demands a real name, and a
	// getDisplayText() that went back to returning a constant fails it.
	// 3. Session with derived trim only -> GuKi Chat (CHAT_VIEW_TITLE)
	(view as any).setCurrentSessionSummary?.({
		sessionId: 'sess-derived',
		derivedTitle: 'Derived Prompt Trim',
		startedAt: '2026-09-15T03:00:00.000Z',
	});
	eq('AU4.3 header shows GuKi Chat when only label is derived trim', view.getDisplayText(), 'GuKi Chat');
	eq('AU4.4 getPanelTitle returns null for derived trim (never produced on header path)', (view as any).getPanelTitle?.(), null);

	// 4. Session with no label at all -> GuKi Chat
	(view as any).setCurrentSessionSummary?.({
		sessionId: 'sess-empty',
		startedAt: '2026-09-15T04:00:00.000Z',
	});
	eq('AU4.5 header shows GuKi Chat when no label at all', view.getDisplayText(), 'GuKi Chat');
	eq('AU4.6 getPanelTitle returns null when no label at all', (view as any).getPanelTitle?.(), null);
}

// AU5: Header updates after turn ends, rename save/remove, and switching conversations
{
	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);
	let currentSummaries: SessionSummary[] = [
		{ sessionId: 'sess-named', title: 'Conversation Alpha', startedAt: '2026-09-15T01:00:00.000Z' },
		{ sessionId: 'sess-nameless', derivedTitle: 'Prompt trim only', startedAt: '2026-09-15T02:00:00.000Z' },
	];

	const mockReducer = {
		onTurnEnd: null as (() => void) | null,
	};
	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		switchConversation: () => {},
	} as unknown as SessionManager;

	const mockStore = {
		listSessions: async () => [...currentSummaries],
		readSession: async () => Object.assign([], { hasMoreBefore: false, loadBefore: async () => [] }) as any,
		resumeArgs: () => [],
	} as unknown as TranscriptStore;

	const settings = { conversationTitles: {} as Record<string, any> };
	const titleStore = new ConversationTitleStore(settings.conversationTitles, async () => {});

	const view = new ChatView(leaf as any, session as any, mockStore, titleStore);
	await (view as any).onOpen();

	const initialHeaderUpdates = (leaf as any).headerUpdates ?? 0;
	eq('AU5.1 initial header is GuKi Chat', view.getDisplayText(), 'GuKi Chat');

	// Switch conversation to sess-named
	await view.handleSelectSession('sess-named');
	eq('AU5.2 header updated to Conversation Alpha on conversation switch', view.getDisplayText(), 'Conversation Alpha');
	eq('AU5.3 leaf title updated to Conversation Alpha', (leaf as any).title, 'Conversation Alpha');
	check('AU5.4 header was re-asked after switching conversation', ((leaf as any).headerUpdates ?? 0) > initialHeaderUpdates);

	// Rename conversation via dropdown save
	const updatesBeforeRename = (leaf as any).headerUpdates ?? 0;
	const dropdown = view.getHistoryDropdown()!;
	await dropdown.openDropdown();
	dropdown.startEditing('sess-named');
	const renameInput = dropdown.getDropdownEl().querySelector('input') as any;
	renameInput.value = 'Custom Alpha Renamed';
	await dropdown.commitEdit();

	eq('AU5.5 header updated to Custom Alpha Renamed after rename', view.getDisplayText(), 'Custom Alpha Renamed');
	eq('AU5.6 leaf title updated to Custom Alpha Renamed', (leaf as any).title, 'Custom Alpha Renamed');
	check('AU5.7 header was re-asked after rename save', ((leaf as any).headerUpdates ?? 0) > updatesBeforeRename);

	// Remove rename (empty string)
	const updatesBeforeRemove = (leaf as any).headerUpdates ?? 0;
	dropdown.startEditing('sess-named');
	const renameInput2 = dropdown.getDropdownEl().querySelector('input') as any;
	renameInput2.value = '';
	await dropdown.commitEdit();

	eq('AU5.8 header reverted to Conversation Alpha after rename removal', view.getDisplayText(), 'Conversation Alpha');
	check('AU5.9 header was re-asked after rename removal', ((leaf as any).headerUpdates ?? 0) > updatesBeforeRemove);

	// Turn ends triggers header update
	const updatesBeforeTurnEnd = (leaf as any).headerUpdates ?? 0;
	if (mockReducer.onTurnEnd) {
		mockReducer.onTurnEnd();
	} else if (typeof (view as any).handleTurnEnd === 'function') {
		await (view as any).handleTurnEnd();
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	check('AU5.10 header was re-asked after turn ends', ((leaf as any).headerUpdates ?? 0) > updatesBeforeTurnEnd);

	// Switch to nameless conversation -> reverts to GuKi Chat, does not stick
	const updatesBeforeNameless = (leaf as any).headerUpdates ?? 0;
	await view.handleSelectSession('sess-nameless');
	eq('AU5.11 switching to nameless conversation reverts header to GuKi Chat', view.getDisplayText(), 'GuKi Chat');
	eq('AU5.12 leaf title reverted to GuKi Chat', (leaf as any).title, 'GuKi Chat');
	check('AU5.13 previous conversation name did not stick', view.getDisplayText() !== 'Conversation Alpha');
	check('AU5.14 header was re-asked after switching to nameless conversation', ((leaf as any).headerUpdates ?? 0) > updatesBeforeNameless);

	await (view as any).onClose();
}


// ---------------------------------------------------------------------------
// AV. Phase 7 Task 9 Lane 5: Panel header when history list is closed (§8 amendment)
// ---------------------------------------------------------------------------
console.log('AV. Phase 7 Task 9 Lane 5: Panel header when history list is closed');

// AV1: NodeTranscriptStore.sessionTitle — reads one file, returns correct summary
{
	const avDir = mkdtempSync(join(tmpdir(), 'guki-av-title-'));

	// AV1.1: File with ai-title — summary has title field and custom overlay is applied
	const sessAiFile = join(avDir, 'sess-av-ai.jsonl');
	writeFileSync(
		sessAiFile,
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: 'Hello world' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'CLI Generated Title' }),
		].join('\n') + '\n',
		'utf8',
	);

	// AV1.2: File with only a first-message (derived trim only — no ai-title)
	const sessDerivedFile = join(avDir, 'sess-av-derived.jsonl');
	writeFileSync(
		sessDerivedFile,
		JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:01:00.000Z', message: 'A question with no title yet' }) + '\n',
		'utf8',
	);

	// No custom title overlay
	const plainStore = new NodeTranscriptStore(avDir);

	const aiSummary = await plainStore.sessionTitle('sess-av-ai');
	check('AV1.1 sessionTitle returns non-null for file with ai-title', aiSummary !== null);
	eq('AV1.2 sessionTitle title matches ai-title', aiSummary?.title, 'CLI Generated Title');
	eq('AV1.3 sessionTitle sessionId is correct', aiSummary?.sessionId, 'sess-av-ai');
	eq('AV1.4 sessionTitle customTitle is absent without overlay', aiSummary?.customTitle, undefined);

	// AV1.5: Derived trim only → summary returned but panelTitleFor returns null
	const derivedSummary = await plainStore.sessionTitle('sess-av-derived');
	check('AV1.5 sessionTitle returns non-null for derived-only file', derivedSummary !== null);
	check('AV1.6 derived-only file has derivedTitle set', typeof derivedSummary?.derivedTitle === 'string');
	eq('AV1.7 derived-only file has no ai-title', derivedSummary?.title, undefined);
	eq('AV1.8 panelTitleFor returns null for derived-only summary', panelTitleFor(derivedSummary ?? null), null);

	// AV1.9: Missing file → null, no throw
	const missingSummary = await plainStore.sessionTitle('sess-av-does-not-exist');
	eq('AV1.9 sessionTitle returns null for missing file', missingSummary, null);

	// AV1.10: Custom title overlay — store has a custom name
	const titleStore = new ConversationTitleStore(
		{ 'sess-av-ai': { title: 'User Custom Override', updatedAt: 9999 } },
		async () => {},
	);
	const overlayStore = new NodeTranscriptStore(avDir, titleStore);
	const overlaySummary = await overlayStore.sessionTitle('sess-av-ai');
	eq('AV1.10 sessionTitle applies custom-title overlay', overlaySummary?.customTitle, 'User Custom Override');
	eq('AV1.11 panelTitleFor returns custom name when overlay is applied', panelTitleFor(overlaySummary ?? null), 'User Custom Override');

	rmSync(avDir, { recursive: true, force: true });
}

// AV2: ChatView.handleTurnEnd with dropdown CLOSED — header reflects ai-title, scan count = 0
// This is the main acceptance criterion from amendment §8. The view must NOT use
// setCurrentSessionSummary — it must fetch the title itself via sessionTitle.
{
	const avDir2 = mkdtempSync(join(tmpdir(), 'guki-av-view-'));

	// Write a transcript file with an ai-title for the "current" session
	const sessFile = join(avDir2, 'sess-av-current.jsonl');
	writeFileSync(
		sessFile,
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: 'First message' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'My Conversation Title' }),
		].join('\n') + '\n',
		'utf8',
	);

	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);

	let scanCount = 0;
	const mockReducer = { onTurnEnd: null as (() => void) | null };

	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: avDir2, outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	// mockStore counts directory scans but delegates sessionTitle to the real NodeTranscriptStore
	const realStore = new NodeTranscriptStore(avDir2);
	const mockStore = {
		listSessions: async () => {
			scanCount++;
			return await realStore.listSessions(avDir2);
		},
		readSession: async () => Object.assign([], { hasMoreBefore: false, loadBefore: async () => [] }) as any,
		resumeArgs: () => [],
		sessionTitle: async (sessionId: string, vaultPath?: string) => {
			// Deliberately NOT incrementing scanCount — this is a single-file read, not a scan.
			return await realStore.sessionTitle(sessionId, vaultPath);
		},
	} as unknown as TranscriptStore;

	const view = new ChatView(leaf as any, session as any, mockStore as any);
	await (view as any).onOpen();

	// Set the current session id directly (simulates a session started from the CLI)
	(view as any).currentSessionId = 'sess-av-current';

	check('AV2.0 dropdown is closed initially', !(view.getHistoryDropdown()?.isOpen()));
	check('AV2.1 view attached a turn-end handler', typeof mockReducer.onTurnEnd === 'function');

	// Baseline: header is GuKi Chat before turn ends
	eq('AV2.2 header is GuKi Chat before turn ends', view.getDisplayText(), 'GuKi Chat');

	// Reset scan counter AFTER open (open may have triggered no scan since dropdown is closed)
	scanCount = 0;
	const headerUpdatesBefore = (leaf as any).headerUpdates ?? 0;

	// Fire turn-end via the reducer hook (NOT via setCurrentSessionSummary)
	mockReducer.onTurnEnd!();
	// Allow any microtasks / async callbacks to settle
	await new Promise<void>((resolve) => setTimeout(resolve, 20));

	eq('AV2.3 scan count stays exactly zero with dropdown closed', scanCount, 0);
	eq('AV2.4 header shows ai-title after turn ends with dropdown closed', view.getDisplayText(), 'My Conversation Title');
	check('AV2.5 leaf header was updated after turn ends', ((leaf as any).headerUpdates ?? 0) > headerUpdatesBefore);

	await (view as any).onClose();
	rmSync(avDir2, { recursive: true, force: true });
}

// AV3: ChatView.handleTurnEnd with dropdown CLOSED and file has only derived trim — header stays GuKi Chat
{
	const avDir3 = mkdtempSync(join(tmpdir(), 'guki-av-derived-'));

	const sessFile = join(avDir3, 'sess-av-derived2.jsonl');
	writeFileSync(
		sessFile,
		JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: 'A question with no title' }) + '\n',
		'utf8',
	);

	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);

	const mockReducer = { onTurnEnd: null as (() => void) | null };
	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: avDir3, outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const realStore3 = new NodeTranscriptStore(avDir3);
	const view = new ChatView(leaf as any, session as any, realStore3 as any);
	await (view as any).onOpen();
	(view as any).currentSessionId = 'sess-av-derived2';

	check('AV3.1 dropdown is closed', !(view.getHistoryDropdown()?.isOpen()));
	mockReducer.onTurnEnd!();
	await new Promise<void>((resolve) => setTimeout(resolve, 20));

	eq('AV3.2 header stays GuKi Chat for derived-only session', view.getDisplayText(), 'GuKi Chat');

	await (view as any).onClose();
	rmSync(avDir3, { recursive: true, force: true });
}

// AV4: ChatView.handleTurnEnd with dropdown CLOSED and file does not exist yet — no throw, header stays GuKi Chat
{
	const avDir4 = mkdtempSync(join(tmpdir(), 'guki-av-missing-'));

	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);

	const mockReducer = { onTurnEnd: null as (() => void) | null };
	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: avDir4, outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const realStore4 = new NodeTranscriptStore(avDir4);
	const view = new ChatView(leaf as any, session as any, realStore4 as any);
	await (view as any).onOpen();
	// Point to a session file that doesn't exist yet
	(view as any).currentSessionId = 'sess-av-not-on-disk-yet';

	let threw = false;
	try {
		mockReducer.onTurnEnd!();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	} catch {
		threw = true;
	}

	check('AV4.1 turn-end does not throw when file does not exist', !threw);
	eq('AV4.2 header stays GuKi Chat when file does not exist', view.getDisplayText(), 'GuKi Chat');

	await (view as any).onClose();
	rmSync(avDir4, { recursive: true, force: true });
}

// AV5: Custom title overlay wins over ai-title in the closed-list path
{
	const avDir5 = mkdtempSync(join(tmpdir(), 'guki-av-custom-'));

	const sessFile = join(avDir5, 'sess-av-cust.jsonl');
	writeFileSync(
		sessFile,
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: 'Hello' }),
			JSON.stringify({ type: 'ai-title', aiTitle: 'CLI Title' }),
		].join('\n') + '\n',
		'utf8',
	);

	const leafContainer = new FakeElement() as any;
	const leafContent = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(new App() as any, leafContainer, leafContent);

	const titleStore5 = new ConversationTitleStore(
		{ 'sess-av-cust': { title: 'Stored Custom Name', updatedAt: 9999 } },
		async () => {},
	);

	const mockReducer = { onTurnEnd: null as (() => void) | null };
	const session = {
		state: new ChatState(),
		reducer: mockReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: avDir5, outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const realStore5 = new NodeTranscriptStore(avDir5, titleStore5);
	const view = new ChatView(leaf as any, session as any, realStore5 as any, titleStore5);
	await (view as any).onOpen();
	(view as any).currentSessionId = 'sess-av-cust';

	check('AV5.1 dropdown is closed', !(view.getHistoryDropdown()?.isOpen()));
	mockReducer.onTurnEnd!();
	await new Promise<void>((resolve) => setTimeout(resolve, 20));

	eq('AV5.2 custom title wins over ai-title in closed-list path', view.getDisplayText(), 'Stored Custom Name');

	await (view as any).onClose();
	rmSync(avDir5, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// AW. The view must learn a fresh conversation's session id from the REAL reducer surface.
// Why this section exists: the closed-list header fix read `reducer.getSessionId?.()`, a method
// that exists nowhere in src/. Optional chaining made it evaluate to undefined, so on a brand new
// conversation the view never learned its id and the header stayed on the fallback — while every
// offline check passed, because no check drove the path the real app takes.
// ---------------------------------------------------------------------------
{
	// AW1: the real StreamReducer's surface, asserted by name. If this getter is ever renamed,
	// this check fails here rather than silently disabling the panel header in the real app.
	const realReducer = new StreamReducer(new ChatState());
	eq('AW1.1 real reducer starts with no session id', realReducer.currentSessionId, null);
	realReducer.apply({ type: 'system', subtype: 'init', session_id: 'sess-aw-real' } as any);
	eq('AW1.2 real reducer exposes the id through currentSessionId', realReducer.currentSessionId, 'sess-aw-real');
	eq('AW1.3 the real reducer has no getSessionId method', typeof (realReducer as any).getSessionId, 'undefined');

	// AW2: a fresh conversation — the view is given a reducer with the REAL surface only
	// (a `currentSessionId` property, no invented method) and must still learn the id at turn end.
	const awDir = mkdtempSync(join(tmpdir(), 'guki-aw-'));
	const awSession = 'sess-aw-fresh';
	writeFileSync(
		join(awDir, `${awSession}.jsonl`),
		[
			JSON.stringify({ type: 'user', timestamp: '2026-09-15T10:00:00.000Z', message: { content: 'ilk mesaj burada' } }),
			JSON.stringify({ type: 'ai-title', sessionId: awSession, aiTitle: 'Gercek Oturum Basligi' }),
		].join('\n') + '\n',
		'utf8',
	);

	const awLeaf = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	const awReducer = {
		onTurnEnd: null as (() => void) | null,
		currentSessionId: null as string | null,
	};
	const awSessionObj = {
		state: new ChatState(),
		reducer: awReducer,
		busy: false,
		blocked: false,
		vaultPaths: async () => ({ root: awDir, outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
	} as unknown as SessionManager;

	const awView = new ChatView(awLeaf as any, awSessionObj, new NodeTranscriptStore(awDir));
	await (awView as any).onOpen();

	eq('AW2.1 header starts at the fallback', awView.getDisplayText(), 'GuKi Chat');
	check('AW2.2 the view attached a turn-end handler', typeof awReducer.onTurnEnd === 'function');

	// The CLI announces the id mid-turn, exactly as system/init does in the real app.
	awReducer.currentSessionId = awSession;
	await awReducer.onTurnEnd!();
	// The turn-end handler is fired as `void handleTurnEnd()` and now reads a file, so its chain
	// settles over several ticks. Waiting a fixed tick made this check flake one run in five.
	// Poll with a bound instead: a genuinely broken header still fails, it just takes 50 ticks.
	for (let tick = 0; tick < 50 && awView.getDisplayText() === 'GuKi Chat'; tick++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	eq('AW2.3 the view learned the session id from the real accessor', (awView as any).getCurrentSessionId?.() ?? (awView as any).currentSessionId, awSession);
	eq('AW2.4 the panel header shows the conversation name on a fresh conversation', awView.getDisplayText(), 'Gercek Oturum Basligi');

	await (awView as any).onClose?.();
	rmSync(awDir, { recursive: true, force: true });
}

// Clean up temporary test files
rmSync(TRANSCRIPT_TEST_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// AX. L7 — New-conversation control
// ---------------------------------------------------------------------------
console.log('\nAX. L7 — New-conversation control');

// AX1: switchConversation(null) is called when the new-conversation button is clicked.
// Mirrors how AW2 drives the turn-end handler — the view must expose a public path, and the
// check must call the real method the real class has, not an invented one.
{
	const axLeaf = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	let switchCallCount = 0;
	let lastSwitchArg: string | null | undefined = undefined;
	const axSession = {
		state: new ChatState(),
		reducer: { onTurnEnd: null as (() => void) | null, currentSessionId: null as string | null },
		busy: false,
		blocked: null,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
		switchConversation: (id: string | null) => {
			switchCallCount++;
			lastSwitchArg = id;
		},
	} as unknown as SessionManager;

	const axView = new ChatView(axLeaf as any, axSession);
	await (axView as any).onOpen();

	// Manually set a session id and summary to simulate an open historical conversation.
	(axView as any).currentSessionId = 'sess-ax-old';
	(axView as any).currentSessionSummary = { sessionId: 'sess-ax-old', title: 'Old Chat', startedAt: '' };

	check('AX1.1 ChatView has handleNewConversation method', typeof (axView as any).handleNewConversation === 'function');
	check('AX1.2 ChatView has getNewConvTriggerEl method or newConvTriggerEl field', typeof (axView as any).getNewConvTriggerEl === 'function' || typeof (axView as any).newConvTriggerEl !== 'undefined');

	const switchBefore = switchCallCount;
	(axView as any).handleNewConversation?.();

	eq('AX1.3 switchConversation was called exactly once', switchCallCount, switchBefore + 1);
	eq('AX1.4 switchConversation was called with null', lastSwitchArg, null);

	await (axView as any).onClose?.();
}

// AX2: After handleNewConversation the view's session id and summary are cleared
// and the header reads CHAT_VIEW_TITLE (GuKi Chat).
{
	const axLeaf2 = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	const axSession2 = {
		state: new ChatState(),
		reducer: { onTurnEnd: null as (() => void) | null, currentSessionId: null as string | null },
		busy: false,
		blocked: null,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
		switchConversation: (_id: string | null) => {},
	} as unknown as SessionManager;

	const axView2 = new ChatView(axLeaf2 as any, axSession2);
	await (axView2 as any).onOpen();

	(axView2 as any).currentSessionId = 'sess-ax-2';
	(axView2 as any).currentSessionSummary = { sessionId: 'sess-ax-2', title: 'Running Chat', startedAt: '' };
	// Give it a non-default display text first so we can prove it reverted.
	// The leaf title is what updateHeader() sets.
	(axView2 as any).updateHeader?.();
	const titleBeforeReset = axView2.getDisplayText();
	check('AX2.0 title is non-default before reset (sanity)', titleBeforeReset !== 'GuKi Chat');

	(axView2 as any).handleNewConversation?.();

	eq('AX2.1 currentSessionId is null after reset', (axView2 as any).currentSessionId ?? (axView2 as any).getCurrentSessionId?.(), null);
	eq('AX2.2 currentSessionSummary is null after reset', (axView2 as any).currentSessionSummary, null);
	eq('AX2.3 header reads GuKi Chat after reset', axView2.getDisplayText(), 'GuKi Chat');

	await (axView2 as any).onClose?.();
}

// AX3: Clicking new-conversation when already in a fresh (no session id) panel does not
// call switchConversation — the session is already fresh, nothing to reset.
{
	const axLeaf3 = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	let switchCount3 = 0;
	const axSession3 = {
		state: new ChatState(),
		reducer: { onTurnEnd: null as (() => void) | null, currentSessionId: null as string | null },
		busy: false,
		blocked: null,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
		switchConversation: (_id: string | null) => { switchCount3++; },
	} as unknown as SessionManager;

	const axView3 = new ChatView(axLeaf3 as any, axSession3);
	await (axView3 as any).onOpen();

	// currentSessionId is null (fresh panel): handleNewConversation must be a no-op.
	eq('AX3.0 currentSessionId starts null', (axView3 as any).currentSessionId ?? null, null);
	(axView3 as any).handleNewConversation?.();
	eq('AX3.1 switchConversation NOT called when panel is already fresh', switchCount3, 0);

	await (axView3 as any).onClose?.();
}

// AX4: The history dropdown is closed when the new-conversation button is clicked.
{
	const axLeaf4 = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	const axSession4 = {
		state: new ChatState(),
		reducer: { onTurnEnd: null as (() => void) | null, currentSessionId: null as string | null },
		busy: false,
		blocked: null,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
		switchConversation: (_id: string | null) => {},
	} as unknown as SessionManager;
	const axMockStore4 = {
		listSessions: async () => [{ sessionId: 'sess-ax-4', title: 'Old', startedAt: '2026-09-15T00:00:00Z' }],
		readSession: async () => Object.assign([], { hasMoreBefore: false, loadBefore: async () => [] }) as any,
		resumeArgs: () => [],
	} as unknown as TranscriptStore;

	const axView4 = new ChatView(axLeaf4 as any, axSession4, axMockStore4);
	await (axView4 as any).onOpen();

	(axView4 as any).currentSessionId = 'sess-ax-4';
	(axView4 as any).currentSessionSummary = { sessionId: 'sess-ax-4', title: 'Old', startedAt: '' };

	// Open the history dropdown first.
	await axView4.toggleHistory();
	check('AX4.0 history dropdown is open before new-conv click', axView4.getHistoryDropdown()?.isOpen() === true);

	(axView4 as any).handleNewConversation?.();

	check('AX4.1 history dropdown is closed after new-conv click', axView4.getHistoryDropdown()?.isOpen() !== true);

	await (axView4 as any).onClose?.();
}

// AX5: After handleNewConversation, a subsequent message (send) arrives with no --resume flag.
// Mirrors the existing C1–C4 style: stub ensureProcess, capture written lines.
{
	const axSession5 = new SessionManager(app);
	const written5: string[] = [];
	let spawnCount5 = 0;
	stub(axSession5, () => { spawnCount5++; return Promise.resolve(true); }, written5);

	// Set a resume id to simulate a previously-opened conversation.
	(axSession5 as any).resumeSessionId = 'old-session-to-resume';

	// Call switchConversation(null) the way the view would.
	axSession5.switchConversation(null);

	eq('AX5.1 resumeSessionId is null after switchConversation(null)', axSession5.getResumeSessionId(), null);

	// Send a message — it must NOT include --resume.
	axSession5.send('hello from fresh session');
	for (let i = 0; i < 8; i++) await Promise.resolve();

	const anyResume = written5.some((line) => line.includes('--resume'));
	check('AX5.2 no --resume in spawned argv after switchConversation(null)', !anyResume);
	check('AX5.3 a message was sent (spawn happened)', spawnCount5 > 0);

	axSession5.dispose();
}

// AX6: Exactly one new-conversation control is present at a time (view-action layout vs. header layout).
// The ChatView must expose the new-conv element so this can be checked.
{
	const axLeaf6 = new WorkspaceLeaf(new App() as any, new FakeElement() as any, new FakeElement() as any);
	const axSession6 = {
		state: new ChatState(),
		reducer: { onTurnEnd: null as (() => void) | null, currentSessionId: null as string | null },
		busy: false,
		blocked: null,
		vaultPaths: async () => ({ root: '/fake/vault', outside: '/fake/outside' }),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
		rememberPermission: async () => {},
		switchConversation: (_id: string | null) => {},
	} as unknown as SessionManager;

	const axView6 = new ChatView(axLeaf6 as any, axSession6);
	await (axView6 as any).onOpen();

	check('AX6.1 ChatView exposes getNewConvTriggerEl', typeof (axView6 as any).getNewConvTriggerEl === 'function');

	const newConvEl = (axView6 as any).getNewConvTriggerEl?.();
	const historyEl = axView6.getHistoryTriggerEl?.();

	// Exactly one of the two layouts is active, so exactly one element is non-null.
	const newConvCount = (newConvEl !== null && newConvEl !== undefined) ? 1 : 0;
	const historyCount = (historyEl !== null && historyEl !== undefined) ? 1 : 0;
	eq('AX6.2 exactly one new-conv control is present (not zero, not two)', newConvCount, 1);
	eq('AX6.3 exactly one history control is present (sanity)', historyCount, 1);

	await (axView6 as any).onClose?.();
	// After close, the control must be torn down.
	const newConvElAfterClose = (axView6 as any).getNewConvTriggerEl?.() ?? (axView6 as any).newConvTriggerEl ?? (axView6 as any).newConvActionEl;
	eq('AX6.4 new-conv control is torn down on close', newConvElAfterClose ?? null, null);
}

console.log('\nAY. Görev 13 — Send message with preference');
{
	if (typeof (globalThis as any).ResizeObserver === 'undefined') {
		(globalThis as any).ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
	}

	// AY1: the seven-row decision table stays DOM-free.
	check('AY1.1 enter + Enter sends', shouldSend('enter', { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false }));
	check('AY1.2 enter + Shift+Enter does not send', !shouldSend('enter', { key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false }));
	check('AY1.3 enter + Cmd+Enter sends', shouldSend('enter', { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false }));
	check('AY1.4 mod-enter + Enter does not send', !shouldSend('mod-enter', { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false }));
	check('AY1.5 mod-enter + Shift+Enter does not send', !shouldSend('mod-enter', { key: 'Enter', shiftKey: true, metaKey: false, ctrlKey: false }));
	check('AY1.6 mod-enter + Cmd+Enter sends', shouldSend('mod-enter', { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false }));
	check('AY1.7 mod-enter + Ctrl+Enter sends', shouldSend('mod-enter', { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true }));
	check('AY1.8 both modes reject a, Tab, and ArrowUp',
		(['enter', 'mod-enter'] as const).every((mode) =>
			['a', 'Tab', 'ArrowUp'].every((key) => !shouldSend(mode, { key, shiftKey: false, metaKey: false, ctrlKey: false }))),
	);

	function makeSendKeyComposer(mode: 'enter' | 'mod-enter' | (() => 'enter' | 'mod-enter'), history: readonly string[] = [], commands: readonly string[] = []) {
		let submitted = 0;
		const container = new FakeElement() as any;
		const panel = new FakeElement() as any;
		const composer = new Composer(container, panel, {
			registerDomEvent: (el: any, event: string, callback: any) => el.addEventListener(event, callback),
		} as any, {
			getSendKey: () => typeof mode === 'function' ? mode() : mode,
			getPromptHistory: () => history,
			getSlashCommands: () => commands,
			onSubmit: () => {
				submitted++;
				return true;
			},
			onStop: () => {},
			onDropped: () => {},
			onPasted: () => false,
			onAttachActiveNote: () => {},
			onPickedFiles: () => {},
		});
		const input = required(container.querySelector('textarea'), 'AY composer textarea');
		const simulateKeydown = (key: string, opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {}) => {
			let prevented = false;
			input.listeners['keydown']?.({
				key,
				shiftKey: !!opts.shiftKey,
				metaKey: !!opts.metaKey,
				ctrlKey: !!opts.ctrlKey,
				isComposing: !!opts.isComposing,
				preventDefault: () => { prevented = true; },
			});
			return { defaultPrevented: prevented, submitted };
		};
		const inputText = (value: string) => {
			input.value = value;
			input.selectionStart = value.length;
			input.selectionEnd = value.length;
			input.listeners['input']?.();
		};
		return { composer, input, inputText, simulateKeydown, submitted: () => submitted };
	}

	// AY2: real Composer keydown path, including both sides of every mode.
	{
		const fixture = makeSendKeyComposer('enter');
		fixture.inputText('send');
		const result = fixture.simulateKeydown('Enter');
		check('AY2.1 enter mode + Enter submits and prevents default', result.submitted === 1 && result.defaultPrevented);
	}
	{
		const fixture = makeSendKeyComposer('enter');
		fixture.inputText('line');
		const result = fixture.simulateKeydown('Enter', { shiftKey: true });
		check('AY2.2 enter mode + Shift+Enter does not submit or prevent default', result.submitted === 0 && !result.defaultPrevented);
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		fixture.inputText('line');
		const result = fixture.simulateKeydown('Enter');
		check('AY2.3 mod-enter mode + Enter does not submit or prevent default', result.submitted === 0 && !result.defaultPrevented);
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		fixture.inputText('send');
		const result = fixture.simulateKeydown('Enter', { metaKey: true });
		check('AY2.4 mod-enter mode + Cmd+Enter submits and prevents default', result.submitted === 1 && result.defaultPrevented);
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		fixture.inputText('send');
		const result = fixture.simulateKeydown('Enter', { ctrlKey: true });
		check('AY2.5 mod-enter mode + Ctrl+Enter submits and prevents default', result.submitted === 1 && result.defaultPrevented);
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		fixture.inputText('ime');
		const result = fixture.simulateKeydown('Enter', { metaKey: true, isComposing: true });
		check('AY2.6 composing Cmd+Enter does not submit', result.submitted === 0);
	}

	// AY3: the dropdown and prompt-history gates remain ahead of the final Enter decision.
	{
		const fixture = makeSendKeyComposer('mod-enter', ['older prompt', 'newest prompt'], ['orchestrate']);
		fixture.inputText('/or');
		const menuEnter = fixture.simulateKeydown('Enter');
		check('AY3.1 open slash menu owns plain Enter in mod-enter mode',
			fixture.input.value === '/orchestrate ' && menuEnter.submitted === 0 && menuEnter.defaultPrevented);

		fixture.inputText('');
		const historyUp = fixture.simulateKeydown('ArrowUp');
		check('AY3.2 mod-enter empty box + ArrowUp recalls newest prompt',
			fixture.input.value === 'newest prompt' && historyUp.defaultPrevented);

		fixture.inputText('filled');
		const filledUp = fixture.simulateKeydown('ArrowUp');
		check('AY3.3 mod-enter filled box + ArrowUp leaves default behavior alone', !filledUp.defaultPrevented);
	}

	// AY4: persisted input is narrowed to the only non-default valid value.
	check('AY4.1 DEFAULT_SETTINGS.sendKey is enter', DEFAULT_SETTINGS.sendKey === DEFAULT_SEND_KEY);
	async function loadSendKey(data: unknown): Promise<unknown> {
		const plugin = new GukiChatPlugin(createMockPluginApp() as any, { dir: 'plugins/guki-chat' } as any);
		plugin.loadData = async () => data as any;
		await (plugin as any).loadSettings();
		return plugin.settings.sendKey;
	}
	eq('AY4.2 persisted mod-enter is retained', await loadSendKey({ sendKey: 'mod-enter' }), 'mod-enter');
	check('AY4.3 garbage, number, null, and absent sendKey fall back to enter',
		(await Promise.all([
			loadSendKey({ sendKey: 'garbage' }),
			loadSendKey({ sendKey: 42 }),
			loadSendKey({ sendKey: null }),
			loadSendKey({}),
		])).every((mode) => mode === DEFAULT_SEND_KEY),
	);

	// AY5: every visible placeholder follows the live preference, including unblock.
	const placeholder = (input: any): string => input.placeholder ?? input.getAttribute('placeholder') ?? '';
	{
		const fixture = makeSendKeyComposer('enter');
		check('AY5.1 enter composer placeholder says Enter to send', placeholder(fixture.input).includes('Enter to send'));
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		const value = placeholder(fixture.input);
		check('AY5.2 mod-enter placeholder says Cmd/Ctrl+Enter and not Enter to send', value.includes('Cmd/Ctrl+Enter to send') && !value.includes('(Enter to send'));
	}
	{
		let mode: 'enter' | 'mod-enter' = 'enter';
		const fixture = makeSendKeyComposer(() => mode);
		mode = 'mod-enter';
		fixture.composer.refreshPlaceholder();
		check('AY5.3 refreshPlaceholder updates an open composer to mod-enter text', placeholder(fixture.input).includes('Cmd/Ctrl+Enter to send'));
	}
	{
		const fixture = makeSendKeyComposer('mod-enter');
		fixture.composer.setBlocked('...');
		fixture.composer.setBlocked(null);
		const value = placeholder(fixture.input);
		check('AY5.4 unblocking mod-enter restores mod-enter placeholder', value.includes('Cmd/Ctrl+Enter to send') && !value.includes('(Enter to send'));
	}

	// AY6: the preference travels through the view factory and refreshes existing views.
	{
		let submitted = 0;
		const app = new App();
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		const plugin = new GukiChatPlugin(app as any, { dir: 'plugins/guki-chat' } as any);
		plugin.settings = { ...plugin.settings, sendKey: 'mod-enter' };
		const session = {
			state: new ChatState(),
			busy: false,
			blocked: null,
			vaultPaths: async () => ({
				root: '/fake/vault',
				resolve: (raw: string) => raw,
				isInside: () => true,
			}),
			getSlashCommands: () => [],
			send: () => { submitted++; },
			interrupt: () => {},
			decidePermission: () => {},
		} as unknown as SessionManager;
		const view = plugin.createChatViewFactory(session)(leaf);
		await (view as any).onOpen();
		const input = required(container.querySelector('textarea'), 'AY6.1 ChatView composer textarea');
		const keydown = (metaKey: boolean) => {
			let defaultPrevented = false;
			input.listeners['keydown']?.({
				key: 'Enter', shiftKey: false, metaKey, ctrlKey: false, isComposing: false,
				preventDefault: () => { defaultPrevented = true; },
			});
			return defaultPrevented;
		};
		input.value = 'plain Enter';
		const plainPrevented = keydown(false);
		input.value = 'Cmd Enter';
		const commandPrevented = keydown(true);
		check('AY6.1 ChatView passes its mod-enter preference to the real Composer',
			submitted === 1 && !plainPrevented && commandPrevented && placeholder(input).includes('Cmd/Ctrl+Enter to send'));
		await (view as any).onClose();
	}
	{
		const app = new App();
		const container = new FakeElement() as any;
		const leaf = new WorkspaceLeaf(app, container);
		(app.workspace as any).getLeavesOfType = (type: string) => type === 'guki-chat-view' ? [leaf] : [];
		const plugin = new GukiChatPlugin(app as any, { dir: 'plugins/guki-chat' } as any);
		plugin.saveData = async () => {};
		const session = {
			state: new ChatState(),
			busy: false,
			blocked: null,
			vaultPaths: async () => ({
				root: '/fake/vault',
				resolve: (raw: string) => raw,
				isInside: () => true,
			}),
			getSlashCommands: () => [],
			send: () => {},
			interrupt: () => {},
			decidePermission: () => {},
		} as unknown as SessionManager;
		const view = plugin.createChatViewFactory(session)(leaf);
		await (view as any).onOpen();
		const input = required(container.querySelector('textarea'), 'AY6.2 open ChatView composer textarea');
		const before = placeholder(input);
		plugin.settings = { ...plugin.settings, sendKey: 'mod-enter' };
		await plugin.saveSettings();
		check('AY6.2 saveSettings refreshes an open real ChatView composer placeholder',
			before.includes('Enter to send') && placeholder(input).includes('Cmd/Ctrl+Enter to send'));
		await (view as any).onClose();
	}
}

// --- AZ. i18n foundation -------------------------------------------------

console.log('\nAZ. i18n foundation');

const i18nSlices = [settingsStrings, chatStrings, transcriptStrings, coreStrings] as const;
const i18nAll = {
	...settingsStrings,
	...chatStrings,
	...transcriptStrings,
	...coreStrings,
};
const placeholderNames = (value: string): string[] =>
	[...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? '').sort();

check('AZ1. placeholder parity holds for every merged dictionary key',
	Object.values(i18nAll).every((message) =>
		JSON.stringify(placeholderNames(message.en)) === JSON.stringify(placeholderNames(message.tr))),
);

check('AZ2. merged dictionary has no overwritten keys or empty Turkish values',
	Object.keys(i18nAll).length === i18nSlices.reduce((sum, slice) => sum + Object.keys(slice).length, 0) &&
		Object.values(i18nAll).every((message) => message.tr.length > 0),
);

setLocale('en');
const englishInterpolated = t('settings.remembered.count.one', { count: 2 });
const missingPlaceholder = t('settings.remembered.count.one');
setLocale('tr');
const turkishInterpolated = t('settings.remembered.count.one', { count: 2 });
check('AZ3. translator switches locales, interpolates, and preserves missing placeholders',
	englishInterpolated === '2 remembered decision.' &&
		turkishInterpolated === '2 hatırlanan karar.' &&
		missingPlaceholder === '{count} remembered decision.' &&
		getLocale() === 'tr',
);

{
	const container = new FakeElement() as any;
	const app = new App();
	(app.vault as any).configDir = '.obsidian';
	const plugin = new GukiChatPlugin(app as any, { dir: 'plugins/guki-chat' } as any);
	plugin.settings = { ...DEFAULT_SETTINGS, rememberedDecisions: [] };
	const tab = new GukiSettingTab(app as any, plugin);
	(tab as any).app = app;
	(tab as any).containerEl = container;

	const settingPrototype = Setting.prototype as any;
	const originalMethods = {
		setName: settingPrototype.setName,
		setDesc: settingPrototype.setDesc,
		setHeading: settingPrototype.setHeading,
		addText: settingPrototype.addText,
		addDropdown: settingPrototype.addDropdown,
		addToggle: settingPrototype.addToggle,
		addButton: settingPrototype.addButton,
	};
	const addText = (value: string) => container.createSpan({ text: value });
	settingPrototype.setName = function(value: string) { addText(value); return this; };
	settingPrototype.setDesc = function(value: string) { addText(value); return this; };
	settingPrototype.setHeading = function() { return this; };
	settingPrototype.addText = function(callback: (control: any) => void) {
		const control = {
			setPlaceholder: (value: string) => { addText(value); return control; },
			setValue: () => control,
			onChange: () => control,
		};
		callback(control);
		return this;
	};
	settingPrototype.addDropdown = function(callback: (control: any) => void) {
		const control = {
			addOption: (_value: string, label: string) => { addText(label); return control; },
			setValue: () => control,
			onChange: () => control,
		};
		callback(control);
		return this;
	};
	settingPrototype.addToggle = function(callback: (control: any) => void) {
		const control = { setValue: () => control, onChange: () => control };
		callback(control);
		return this;
	};
	settingPrototype.addButton = function(callback: (control: any) => void) {
		const control = {
			setButtonText: (value: string) => { addText(value); return control; },
			setWarning: () => control,
			onClick: () => control,
		};
		callback(control);
		return this;
	};

	setLocale('tr');
	tab.display();
	Object.assign(settingPrototype, originalMethods);
	check('AZ4. real settings tab renders specific Turkish strings',
		container.text.includes('Dil') &&
			container.text.includes('İngilizce') &&
			container.text.includes('Claude code ikili dosya yolu') &&
			container.text.includes('Kasa dışındaki izinler') &&
			container.text.includes('Her şeye izin ver (yüksek risk)') &&
			container.text.includes('Hatırlanan izin yok.'),
	);
}

{
	setLocale('en');
	const app = new App();
	const container = new FakeElement() as any;
	const leaf = new WorkspaceLeaf(app, container);
	const plugin = new GukiChatPlugin(app as any, { dir: 'plugins/guki-chat' } as any);
	plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
	plugin.saveData = async () => {};
	const session = {
		state: new ChatState(),
		busy: false,
		blocked: null,
		vaultPaths: async () => ({
			root: '/fake/vault',
			resolve: (raw: string) => raw,
			isInside: () => true,
		}),
		getSlashCommands: () => [],
		send: () => {},
		interrupt: () => {},
		decidePermission: () => {},
	} as unknown as SessionManager;
	const factory = plugin.createChatViewFactory(session);
	const originalView = factory(leaf);
	await leaf.open(originalView);
	const originalInput = required(container.querySelector('textarea'), 'AZ5 initial composer textarea');
	originalInput.value = 'Taslak mesajım kaybolmasın';

	let localeDuringRebuild = '';
	let rebuiltView: ChatView | null = null;
	const removedCommands: string[] = [];
	const addedCommands: Array<{ id: string; name: string }> = [];
	(app.workspace as any).getLeavesOfType = (type: string) => type === 'guki-chat-view' ? [leaf] : [];
	(leaf as any).getViewState = () => ({ type: 'guki-chat-view', active: true });
	(leaf as any).setViewState = async (viewState: { type: string }) => {
		if (viewState.type === 'empty') {
			await (leaf.view as any).onClose();
			return;
		}
		localeDuringRebuild = getLocale();
		rebuiltView = factory(leaf);
		await leaf.open(rebuiltView);
	};
	(plugin as any).removeCommand = (id: string) => removedCommands.push(id);
	(plugin as any).addCommand = (command: { id: string; name: string }) => addedCommands.push(command);

	plugin.settings.language = 'tr';
	await plugin.saveSettings();
	const rebuiltInput = required(container.querySelector('textarea'), 'AZ5 rebuilt composer textarea');
	check('AZ5. production language door rebuilds the panel in Turkish and preserves the draft',
		rebuiltView !== null && rebuiltView !== originalView &&
			localeDuringRebuild === 'tr' && getLocale() === 'tr' &&
			rebuiltInput.value === 'Taslak mesajım kaybolmasın' &&
			removedCommands.includes('open-chat') &&
			addedCommands.some((command) => command.id === 'open-chat' && command.name === 'Sohbeti aç'),
	);
	await (leaf.view as any).onClose();
}

setLocale('en');
check('AZ6. locale is restored to English after i18n checks', getLocale() === 'en');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
