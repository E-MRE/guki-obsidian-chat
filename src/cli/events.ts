/**
 * `--output-format stream-json` event schema.
 *
 * Every type, field name and optionality here comes from the raw CLI output captured in
 * RESEARCH B1–B4/B6 — not from guesswork. Two shapes matter more than the rest:
 *
 * - `system` arrives with `subtype: 'init'` at the start of **every** turn (RESEARCH B1), so
 *   `init` is setup only the first time it is seen.
 * - `result.result` is **optional**: a cancelled turn's result event carries no `result` field at
 *   all, and `ev.result.slice(...)` threw during research (RESEARCH B4).
 *
 * Fields the plan does not consume yet are typed anyway when RESEARCH recorded them, so Phase 3+
 * does not have to re-derive the schema. Anything not observed in the raw output is left out.
 */

/** A content block inside `assistant.message.content[]` (a full Anthropic API message). */
export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ThinkingBlock {
	type: 'thinking';
	thinking: string;
	signature?: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input?: unknown;
}

/**
 * Arrives on a `user` event, one per completed tool call (PHASE4-STATE F4).
 *
 * `content` is typed `unknown` because it genuinely has more than one runtime shape: a plain
 * `string` on the two error results in the capture, an **array of blocks** on the success result.
 * `toolResultText()` in `core/tool-policy.ts` is what narrows it.
 */
export interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content?: unknown;
	/**
	 * Three observed states, not two: **absent** (most successes), explicit `false` (Bash results
	 * in the Phase 4 capture), and `true`. So every test must be `=== true` — `!== false` marks
	 * every absent-key success as a failure (PHASE4-STATE F4).
	 */
	is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface SystemInitEvent {
	type: 'system';
	subtype: 'init';
	session_id?: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	mcp_servers?: unknown[];
	permissionMode?: string;
	claude_code_version?: string;
	capabilities?: string[];
}

/** `system` with any other subtype: hook_started / hook_response / hook_progress / status / thinking_tokens / permission_denied. */
export interface SystemOtherEvent {
	type: 'system';
	subtype: string;
	session_id?: string;
}

export type SystemEvent =
	| SystemInitEvent
	| SystemThinkingTokensEvent
	| SystemTaskEvent
	| SystemOtherEvent;

export interface AssistantEvent {
	type: 'assistant';
	session_id?: string;
	/** Populated when the message belongs to a subagent (RESEARCH B2). Hidden in v1. */
	parent_tool_use_id?: string | null;
	message: {
		id?: string;
		role?: string;
		model?: string;
		content?: ContentBlock[];
		stop_reason?: string | null;
		usage?: unknown;
	};
}

/** Carries `tool_result` blocks, and the synthetic `[Request interrupted by user]` text on cancel. */
export interface UserEvent {
	type: 'user';
	session_id?: string;
	parent_tool_use_id?: string | null;
	message: {
		role?: string;
		content?: ContentBlock[] | string;
	};
}

/**
 * The raw Anthropic SSE events carried inside `stream_event.event`, captured verbatim in
 * PHASE3-STATE F1. The index lives on the event, the content on `delta`; the outer
 * `StreamPartialEvent` — not the inner event — is what carries `parent_tool_use_id`.
 */
export interface SseMessageStart {
	type: 'message_start';
	message?: {
		id?: string;
		model?: string;
		usage?: unknown;
	};
}

export interface SseContentBlockStart {
	type: 'content_block_start';
	index: number;
	/** The empty shell of the block that is opening: `{"type":"thinking","thinking":"","signature":""}`. */
	content_block?: ContentBlock;
}

export interface SseTextDelta {
	type: 'text_delta';
	text: string;
}

export interface SseThinkingDelta {
	type: 'thinking_delta';
	thinking: string;
	/** Observed as `null` throughout; the usable counter is `system/thinking_tokens` instead. */
	estimated_tokens?: number | null;
}

/** The redacted-thinking signature. Carries no user-visible content. */
export interface SseSignatureDelta {
	type: 'signature_delta';
	signature: string;
}

export type SseDelta = SseTextDelta | SseThinkingDelta | SseSignatureDelta | { type: string };

export interface SseContentBlockDelta {
	type: 'content_block_delta';
	index: number;
	delta?: SseDelta;
}

export interface SseContentBlockStop {
	type: 'content_block_stop';
	index: number;
}

export interface SseMessageDelta {
	type: 'message_delta';
	delta?: { stop_reason?: string | null };
	usage?: unknown;
}

export type SseEvent =
	| SseMessageStart
	| SseContentBlockStart
	| SseContentBlockDelta
	| SseContentBlockStop
	| SseMessageDelta
	| { type: string };

/** Only present with `--include-partial-messages` (Phase 3). Carries the raw Anthropic SSE event. */
export interface StreamPartialEvent {
	type: 'stream_event';
	session_id?: string;
	/** Populated for subagent output, which is hidden in v1. Sits here, not on `event`. */
	parent_tool_use_id?: string | null;
	event?: SseEvent;
	ttft_ms?: number;
}

/**
 * `system/thinking_tokens`. `estimated_tokens` is cumulative within the message and restarts on the
 * next turn (PHASE3-STATE F3), so it is written to the open thinking block, not accumulated.
 */
export interface SystemThinkingTokensEvent {
	type: 'system';
	subtype: 'thinking_tokens';
	estimated_tokens?: number;
	estimated_tokens_delta?: number;
	session_id?: string;
}

/**
 * `system/task_started`, `task_progress` and `task_notification` — the subagent lifecycle
 * (PHASE4-STATE F7, captured in `docs/capture-phase4-tools.jsonl`).
 *
 * These are what make the "subagent running…" line *live* rather than static: `description`
 * changes as the subagent works — in the capture it runs "Running List dir and find sample.txt",
 * then "Finding sample.txt by glob", then "Reading sample.txt" — and `usage.tool_uses` counts up.
 *
 * All three carry `tool_use_id`, which is what ties them to the parent `Agent` card.
 * `task_updated` is deliberately **not** modelled: it carries `task_id` only, with no
 * `tool_use_id`, so it would need a second index to be useful and it says nothing the
 * `task_notification` does not.
 */
export interface SystemTaskEvent {
	type: 'system';
	subtype: 'task_started' | 'task_progress' | 'task_notification';
	task_id?: string;
	/** The parent `Agent` tool call's id. */
	tool_use_id?: string;
	/** A live, human-readable description of what the subagent is doing right now. */
	description?: string;
	subagent_type?: string;
	usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
	last_tool_name?: string;
	/** `task_notification` only: `'completed'` when the subagent has finished. */
	status?: string;
	session_id?: string;
}

export interface ResultEvent {
	type: 'result';
	subtype: string;
	is_error?: boolean;
	/** Absent on a cancelled turn (RESEARCH B4). Never dereference without checking. */
	result?: string;
	session_id?: string;
	total_cost_usd?: number;
	duration_ms?: number;
	duration_api_ms?: number;
	/** Intra-turn counter, not cumulative (RESEARCH B1). */
	num_turns?: number;
	usage?: unknown;
	permission_denials?: unknown[];
	stop_reason?: string | null;
	/** `'aborted_streaming'` means the user cancelled — show "stopped", not an error (RESEARCH B4). */
	terminal_reason?: string;
	ttft_ms?: number;
}

/**
 * The reply to a `control_request`. The payload nests twice — the subtype and the echoed
 * `request_id` are inside `response`, not at the top level (PHASE3-STATE F4):
 * `{"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}`
 */
export interface ControlResponseEvent {
	type: 'control_response';
	response?: {
		subtype?: string;
		request_id?: string;
		error?: string;
		response?: unknown;
	};
}

export interface RateLimitEvent {
	type: 'rate_limit_event';
	rate_limit_info?: unknown;
}

/** A `type` we have not modelled. Kept so the reducer can ignore it instead of throwing. */
export interface UnknownEvent {
	type: string;
}

export type StreamJsonEvent =
	| SystemEvent
	| AssistantEvent
	| UserEvent
	| StreamPartialEvent
	| ResultEvent
	| ControlResponseEvent
	| RateLimitEvent
	| UnknownEvent;

export function isSystemInitEvent(ev: StreamJsonEvent): ev is SystemInitEvent {
	return ev.type === 'system' && (ev as SystemOtherEvent).subtype === 'init';
}

export function isAssistantEvent(ev: StreamJsonEvent): ev is AssistantEvent {
	return ev.type === 'assistant';
}

export function isResultEvent(ev: StreamJsonEvent): ev is ResultEvent {
	return ev.type === 'result';
}

export function isUserEvent(ev: StreamJsonEvent): ev is UserEvent {
	return ev.type === 'user';
}

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_notification']);

export function isTaskEvent(ev: StreamJsonEvent): ev is SystemTaskEvent {
	return ev.type === 'system' && TASK_SUBTYPES.has((ev as SystemOtherEvent).subtype);
}

export function isStreamPartialEvent(ev: StreamJsonEvent): ev is StreamPartialEvent {
	return ev.type === 'stream_event';
}

export function isThinkingTokensEvent(ev: StreamJsonEvent): ev is SystemThinkingTokensEvent {
	return ev.type === 'system' && (ev as SystemOtherEvent).subtype === 'thinking_tokens';
}

/**
 * Parses one NDJSON line. Returns `null` for blank lines, malformed JSON, or anything that is not
 * an object with a string `type` — the caller logs and keeps reading rather than tearing the
 * stream down (PLAN Phase 2, task 3).
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (typeof parsed !== 'object' || parsed === null) {
		return null;
	}
	const type: unknown = (parsed as { type?: unknown }).type;
	if (typeof type !== 'string') {
		return null;
	}
	return parsed as StreamJsonEvent;
}

/** The stdin payload shape verified in RESEARCH B1. */
export function userMessageLine(text: string): string {
	const payload = {
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'text', text }],
		},
	};
	return `${JSON.stringify(payload)}\n`;
}

/**
 * The stdin payload that stops the turn in flight (RESEARCH B4, re-measured in PHASE3-STATE F4:
 * 2 ms to the `control_response`). The process stays alive and the next turn is normal.
 */
export function interruptRequestLine(requestId: string): string {
	const payload = {
		type: 'control_request',
		request_id: requestId,
		request: { subtype: 'interrupt' },
	};
	return `${JSON.stringify(payload)}\n`;
}
