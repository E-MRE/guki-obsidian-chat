/**
 * stream-json events → `ChatState`.
 *
 * Phase 2 consumes `assistant` (text blocks) and `result` only. Everything else is deliberately
 * ignored, with two rules that came out of RESEARCH the hard way:
 *
 * - `system/init` arrives at the start of **every** turn (RESEARCH B1). The first one is session
 *   setup; later ones mean "a turn started" and must not reset anything on screen.
 * - The `result` event of a cancelled turn has **no `result` field** (RESEARCH B4). Nothing here
 *   dereferences it without a check.
 */
import {
	isAssistantEvent,
	isResultEvent,
	isSystemInitEvent,
	type AssistantEvent,
	type ContentBlock,
	type ResultEvent,
	type StreamJsonEvent,
} from '../cli/events';
import type { AssistantItem, BlockKind, ChatState, MessageBlock } from './chat-state';

/** `terminal_reason` for a turn the user interrupted — "stopped", not an error (RESEARCH B4). */
const ABORTED_STREAMING = 'aborted_streaming';

export class StreamReducer {
	private sessionId: string | null = null;
	private turnCount = 0;
	private active: AssistantItem | null = null;

	constructor(private readonly state: ChatState) {}

	/** The session id from the first `system/init`. Phase 2 only logs it; v2 resumes with it. */
	get currentSessionId(): string | null {
		return this.sessionId;
	}

	/** Number of turns this reducer has seen — the CLI's `num_turns` is intra-turn (RESEARCH B1). */
	get turns(): number {
		return this.turnCount;
	}

	/** Called by the SessionManager when a message is handed to the CLI. */
	beginTurn(item: AssistantItem): void {
		this.active = item;
		item.status = 'pending';
		this.state.emitChange();
	}

	apply(event: StreamJsonEvent): void {
		if (isSystemInitEvent(event)) {
			this.applyInit(event.session_id ?? null);
			return;
		}
		if (isAssistantEvent(event)) {
			this.applyAssistant(event);
			return;
		}
		if (isResultEvent(event)) {
			this.applyResult(event);
			return;
		}
		// system/status, system/thinking_tokens, hook_*, stream_event, user, rate_limit_event,
		// control_response: not part of Phase 2.
	}

	private applyInit(sessionId: string | null): void {
		this.turnCount += 1;
		if (this.sessionId === null) {
			// First init only: session setup. No UI reset here or on any later init.
			this.sessionId = sessionId;
		}
	}

	private applyAssistant(event: AssistantEvent): void {
		// Subagent output is hidden in v1 (closed decision); it is identified by this field.
		if (event.parent_tool_use_id) {
			return;
		}
		const item = this.active;
		if (!item) {
			return;
		}

		const content = event.message.content ?? [];
		content.forEach((block, index) => {
			const mapped = mapBlock(block, index);
			if (mapped) {
				// Replace, not append: this event is authoritative for the block (RESEARCH B3).
				item.blocks.set(index, mapped);
			}
		});

		if (item.status === 'pending') {
			item.status = 'streaming';
		}
		this.state.emitChange();
	}

	private applyResult(event: ResultEvent): void {
		const item = this.active;
		this.active = null;
		if (!item) {
			return;
		}

		item.meta = {
			costUsd: event.total_cost_usd,
			durationMs: event.duration_ms,
		};

		if (event.terminal_reason === ABORTED_STREAMING) {
			item.status = 'stopped';
			this.state.emitChange();
			return;
		}

		if (event.is_error === true) {
			item.status = 'error';
			// `result` may be absent entirely; fall back to the subtype rather than reading it.
			item.errorText =
				typeof event.result === 'string' && event.result.length > 0
					? event.result
					: `The turn ended with ${event.subtype}.`;
			this.state.emitChange();
			return;
		}

		// A denied tool is not a failed turn: subtype 'success', is_error false, and the denial
		// shows up only in permission_denials[] (RESEARCH B5). Nothing to render as an error.
		if (item.blocks.size === 0 && typeof event.result === 'string' && event.result.length > 0) {
			// Defensive: no assistant event carried text, but the result did.
			item.blocks.set(0, { index: 0, kind: 'text', text: event.result, final: true });
		}
		item.status = 'complete';
		this.state.emitChange();
	}

	/**
	 * Fails the in-flight turn from outside the stream — the subprocess died, or the binary could
	 * not be resolved. Without this the panel would sit on "pending" forever.
	 */
	failActiveTurn(message: string): boolean {
		const item = this.active;
		this.active = null;
		if (!item) {
			return false;
		}
		item.status = 'error';
		item.errorText = message;
		this.state.emitChange();
		return true;
	}

	hasActiveTurn(): boolean {
		return this.active !== null;
	}
}

function mapBlock(block: ContentBlock, index: number): MessageBlock | null {
	switch (block.type) {
		case 'text':
			return { index, kind: 'text', text: block.text, final: true };
		case 'thinking':
			// Stored but not rendered until Phase 3, where it gets its own collapsible surface.
			return { index, kind: 'thinking', text: block.thinking, final: true };
		case 'tool_use':
			return {
				index,
				kind: 'tool_use' satisfies BlockKind,
				text: '',
				final: true,
				toolUseId: block.id,
				toolName: block.name,
			};
		default:
			// tool_result blocks arrive on `user` events, not here.
			return null;
	}
}
