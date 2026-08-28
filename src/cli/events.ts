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

export interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content?: unknown;
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

export type SystemEvent = SystemInitEvent | SystemOtherEvent;

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

/** Only present with `--include-partial-messages` (Phase 3). Carries the raw Anthropic SSE event. */
export interface StreamPartialEvent {
	type: 'stream_event';
	session_id?: string;
	parent_tool_use_id?: string | null;
	event?: unknown;
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

export interface ControlResponseEvent {
	type: 'control_response';
	request_id?: string;
	subtype?: string;
	response?: unknown;
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
