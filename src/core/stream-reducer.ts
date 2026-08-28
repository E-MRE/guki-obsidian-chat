/**
 * stream-json events → `ChatState`.
 *
 * Four rules, each of which cost a measurement to learn:
 *
 * - `system/init` arrives at the start of **every** turn (RESEARCH B1). The first one is session
 *   setup; later ones mean "a turn started" and must not reset anything on screen.
 * - The `result` event of a cancelled turn has **no `result` field** (RESEARCH B4, re-confirmed at
 *   CLI 2.1.250 in PHASE3-STATE F5). Nothing here dereferences it without a check.
 * - An `assistant` event carries **one block, always at `message.content[0]`**, whatever that
 *   block's real position in the message is (PHASE3-STATE F2). Keying blocks by their array
 *   position — which Phase 2 did — makes the second block overwrite the first. Slots are assigned
 *   here instead, by a running counter.
 * - `stream_event.index` restarts at 0 at every `message_start`, and one turn can contain several
 *   messages (a tool-use round trip). `blockBase` absorbs that so slots stay unique per turn.
 */
import {
	isAssistantEvent,
	isResultEvent,
	isStreamPartialEvent,
	isSystemInitEvent,
	isThinkingTokensEvent,
	type AssistantEvent,
	type ContentBlock,
	type ResultEvent,
	type SseContentBlockDelta,
	type SseContentBlockStart,
	type SseContentBlockStop,
	type StreamJsonEvent,
	type StreamPartialEvent,
	type SystemThinkingTokensEvent,
} from '../cli/events';
import type { AssistantItem, BlockKind, ChatState, MessageBlock } from './chat-state';

/** `terminal_reason` for a turn the user interrupted — "stopped", not an error (RESEARCH B4). */
const ABORTED_STREAMING = 'aborted_streaming';

export class StreamReducer {
	private sessionId: string | null = null;
	private turnCount = 0;
	private active: AssistantItem | null = null;

	/** Slot bookkeeping for the turn in flight. All three are reset in `beginTurn`. */
	private blockBase = 0;
	private nextFreeSlot = 0;
	private assistantSlot = 0;

	/**
	 * Called whenever the active turn ends, for any reason. The SessionManager uses it to send the
	 * next queued message — nothing else was pumping the queue after a turn finished.
	 */
	onTurnEnd: (() => void) | null = null;

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
		this.blockBase = 0;
		this.nextFreeSlot = 0;
		this.assistantSlot = 0;
		item.status = 'pending';
		this.state.emitChange();
	}

	apply(event: StreamJsonEvent): void {
		if (isSystemInitEvent(event)) {
			this.applyInit(event.session_id ?? null);
			return;
		}
		if (isThinkingTokensEvent(event)) {
			this.applyThinkingTokens(event);
			return;
		}
		if (isStreamPartialEvent(event)) {
			this.applyStreamEvent(event);
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
		// system/status, hook_*, user, rate_limit_event, control_response: nothing to render yet.
		// `user` carries tool_result blocks and the synthetic "[Request interrupted by user]" text;
		// both belong to Phase 4 and to the "stopped" badge respectively, neither needs the text.
	}

	private applyInit(sessionId: string | null): void {
		this.turnCount += 1;
		if (this.sessionId === null) {
			// First init only: session setup. No UI reset here or on any later init.
			this.sessionId = sessionId;
		}
	}

	// --- live streaming ----------------------------------------------------

	private applyStreamEvent(event: StreamPartialEvent): void {
		// Subagent output is hidden in v1; on a stream_event the marker is on the outer envelope.
		if (event.parent_tool_use_id) {
			return;
		}
		const item = this.active;
		const sse = event.event;
		if (!item || !sse) {
			return;
		}

		switch (sse.type) {
			case 'message_start':
				// A second message inside the same turn restarts `index` at 0; keep slots unique.
				this.blockBase = this.nextFreeSlot;
				return;
			case 'content_block_start':
				this.openBlock(item, sse as SseContentBlockStart);
				return;
			case 'content_block_delta':
				this.appendDelta(item, sse as SseContentBlockDelta);
				return;
			case 'content_block_stop':
				this.closeBlock(item, (sse as SseContentBlockStop).index);
				return;
			default:
				// message_delta / message_stop carry only usage and stop_reason.
				return;
		}
	}

	private slotFor(index: number): number {
		const slot = this.blockBase + index;
		this.nextFreeSlot = Math.max(this.nextFreeSlot, slot + 1);
		return slot;
	}

	private openBlock(item: AssistantItem, sse: SseContentBlockStart): void {
		const slot = this.slotFor(sse.index);
		const opening = sse.content_block;
		const kind = blockKindOf(opening?.type);
		if (!kind) {
			return;
		}
		const block: MessageBlock = {
			index: slot,
			kind,
			text: '',
			final: false,
			startedAt: Date.now(),
		};
		if (opening?.type === 'tool_use') {
			block.toolUseId = opening.id;
			block.toolName = opening.name;
		}
		item.blocks.set(slot, block);
		this.markStreaming(item);
	}

	private appendDelta(item: AssistantItem, sse: SseContentBlockDelta): void {
		const slot = this.slotFor(sse.index);
		const delta = sse.delta;
		if (!delta) {
			return;
		}

		let addition: string;
		if (delta.type === 'text_delta') {
			addition = (delta as { text?: string }).text ?? '';
		} else if (delta.type === 'thinking_delta') {
			addition = (delta as { thinking?: string }).thinking ?? '';
		} else {
			// signature_delta and input_json_delta carry nothing the reader sees.
			return;
		}

		const kind: BlockKind = delta.type === 'thinking_delta' ? 'thinking' : 'text';
		// A delta for a block we never saw open is not fatal — create it rather than drop the text.
		const block = item.blocks.get(slot) ?? {
			index: slot,
			kind,
			text: '',
			final: false,
			startedAt: Date.now(),
		};
		if (block.final) {
			// The authoritative content already landed; a late delta must not append to it.
			return;
		}
		block.text += addition;
		item.blocks.set(slot, block);
		this.markStreaming(item);
	}

	private closeBlock(item: AssistantItem, index: number): void {
		const block = item.blocks.get(this.slotFor(index));
		if (block) {
			block.endedAt ??= Date.now();
			this.state.emitChange();
		}
	}

	/**
	 * The live thinking counter. `estimated_tokens` is cumulative within the message, so it is
	 * assigned to the open thinking block, never added to it (PHASE3-STATE F3).
	 */
	private applyThinkingTokens(event: SystemThinkingTokensEvent): void {
		const item = this.active;
		if (!item || typeof event.estimated_tokens !== 'number') {
			return;
		}
		let open: MessageBlock | null = null;
		for (const block of item.blocks.values()) {
			if (block.kind === 'thinking' && !block.final && (!open || block.index > open.index)) {
				open = block;
			}
		}
		if (open) {
			open.thinkingTokens = event.estimated_tokens;
			this.state.emitChange();
		}
	}

	private markStreaming(item: AssistantItem): void {
		if (item.status === 'pending') {
			item.status = 'streaming';
		}
		this.state.emitChange();
	}

	// --- authoritative content ---------------------------------------------

	private applyAssistant(event: AssistantEvent): void {
		// Subagent output is hidden in v1 (closed decision); it is identified by this field.
		if (event.parent_tool_use_id) {
			return;
		}
		const item = this.active;
		if (!item) {
			return;
		}

		for (const block of event.message.content ?? []) {
			// Slots come from the running counter, not from the array position: this event carries
			// one block, always at content[0], whatever its real position is (PHASE3-STATE F2).
			const slot = this.assistantSlot;
			this.assistantSlot += 1;
			this.nextFreeSlot = Math.max(this.nextFreeSlot, slot + 1);

			const mapped = mapBlock(block, slot);
			if (!mapped) {
				continue;
			}
			// Carry the streaming timings over — they are what the thinking header reads.
			const streamed = item.blocks.get(slot);
			mapped.startedAt = streamed?.startedAt;
			mapped.endedAt = streamed?.endedAt ?? Date.now();
			mapped.thinkingTokens = streamed?.thinkingTokens;
			// Replace, not append: this event is authoritative for the block (RESEARCH B3).
			item.blocks.set(slot, mapped);
		}

		if (item.status === 'pending') {
			item.status = 'streaming';
		}
		this.state.emitChange();
	}

	private applyResult(event: ResultEvent): void {
		const item = this.active;
		this.active = null;
		if (!item) {
			this.onTurnEnd?.();
			return;
		}

		item.meta = {
			costUsd: event.total_cost_usd,
			durationMs: event.duration_ms,
		};
		// Whatever the outcome, no block is still streaming once the turn is over — otherwise a
		// cancelled turn leaves a thinking header saying "Thinking…" forever.
		closeOpenBlocks(item);

		if (event.terminal_reason === ABORTED_STREAMING) {
			item.status = 'stopped';
		} else if (event.is_error === true) {
			item.status = 'error';
			// `result` may be absent entirely; fall back to the subtype rather than reading it.
			item.errorText =
				typeof event.result === 'string' && event.result.length > 0
					? event.result
					: `The turn ended with ${event.subtype}.`;
		} else {
			// A denied tool is not a failed turn: subtype 'success', is_error false, and the denial
			// shows up only in permission_denials[] (RESEARCH B5). Nothing to render as an error.
			if (item.blocks.size === 0 && typeof event.result === 'string' && event.result.length > 0) {
				// Defensive: no assistant event carried text, but the result did.
				item.blocks.set(0, { index: 0, kind: 'text', text: event.result, final: true });
			}
			item.status = 'complete';
		}

		this.state.emitChange();
		this.onTurnEnd?.();
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
		closeOpenBlocks(item);
		item.status = 'error';
		item.errorText = message;
		this.state.emitChange();
		return true;
	}

	hasActiveTurn(): boolean {
		return this.active !== null;
	}
}

/** Marks every still-streaming block as done, so no header is left mid-animation. */
function closeOpenBlocks(item: AssistantItem): void {
	const now = Date.now();
	for (const block of item.blocks.values()) {
		block.endedAt ??= now;
		block.final = true;
	}
}

function blockKindOf(type: string | undefined): BlockKind | null {
	switch (type) {
		case 'text':
			return 'text';
		case 'thinking':
			return 'thinking';
		case 'tool_use':
			return 'tool_use';
		default:
			return null;
	}
}

function mapBlock(block: ContentBlock, index: number): MessageBlock | null {
	switch (block.type) {
		case 'text':
			return { index, kind: 'text', text: block.text, final: true };
		case 'thinking':
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
