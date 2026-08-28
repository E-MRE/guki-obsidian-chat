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
	isTaskEvent,
	isThinkingTokensEvent,
	isUserEvent,
	type AssistantEvent,
	type ContentBlock,
	type ResultEvent,
	type SseContentBlockDelta,
	type SseContentBlockStart,
	type SseContentBlockStop,
	type StreamJsonEvent,
	type StreamPartialEvent,
	type SystemTaskEvent,
	type SystemThinkingTokensEvent,
	type ToolResultBlock,
	type UserEvent,
} from '../cli/events';
import { toolResultText } from './tool-policy';
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
	 * `tool_use_id` → slot, for the turn in flight.
	 *
	 * This is what makes a `tool_result` find its card. Results **interleave**: in the captured
	 * turn a result arrives in the middle of a message, before the next `tool_use` block has even
	 * opened (PHASE4-STATE F4). Consuming results in arrival order would line up on that capture
	 * and put the output under the wrong tool on the next one, silently.
	 */
	private toolSlots = new Map<string, number>();

	/**
	 * Set when the user pressed Stop and the interrupt control request actually went out for the
	 * turn in flight. Cleared by `beginTurn`.
	 *
	 * `terminal_reason: "aborted_streaming"` is not a reliable cancellation marker on its own. When
	 * Stop lands while a tool call is waiting for permission, the CLI closes the turn with
	 * `subtype: "error_during_execution"` and **no `terminal_reason` at all** — found in Emre's
	 * Phase 4 acceptance run, step 10, which showed a red "The turn ended with
	 * error_during_execution." for a turn the user had simply stopped.
	 *
	 * The subtype cannot be mapped to "stopped" on its own either: `error_during_execution` also
	 * arrives with no Stop involved, and that is a real error the reader has to see. What separates
	 * the two is knowing whether *we* asked for the cancellation, and only the SessionManager knows
	 * that — hence this flag rather than a wider subtype check.
	 */
	private interruptSent = false;

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
		this.toolSlots = new Map();
		this.interruptSent = false;
		item.status = 'pending';
		this.state.emitChange();
	}

	/**
	 * The SessionManager put an interrupt control request on stdin for the turn in flight. From
	 * here on this turn ends as "stopped" whatever the CLI reports, because the user asked for it.
	 *
	 * A turn that had already finished when the request went out is marked stopped too. That is
	 * deliberate: the alternative is deciding after the fact which of a completed reply and a
	 * pressed Stop button was "really" the outcome, and the one thing that must never happen is a
	 * cancellation surfacing as a failure (the closed Phase 3 decision).
	 */
	noteInterruptSent(): void {
		if (this.active) {
			this.interruptSent = true;
		}
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
		if (isTaskEvent(event)) {
			this.applyTaskEvent(event);
			return;
		}
		if (isUserEvent(event)) {
			this.applyUser(event);
			return;
		}
		if (isResultEvent(event)) {
			this.applyResult(event);
			return;
		}
		// system/status, hook_*, rate_limit_event, control_response: nothing to render yet.
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
		// Hidden, but not silent: the parent card is told that work is happening under it.
		if (event.parent_tool_use_id) {
			this.noteSubagentActivity(event.parent_tool_use_id);
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
			// `input` is `{}` here and stays unparseable until the block closes: the
			// `input_json_delta` fragments split mid-token and the first one is always the empty
			// string (PHASE4-STATE F2). The complete object arrives on the `assistant` event, so
			// the card shows "running" until then rather than a half-parsed argument.
			block.toolPending = true;
			this.toolSlots.set(opening.id, slot);
		}
		item.blocks.set(slot, block);
		this.markStreaming(item);
	}

	// --- tool results -------------------------------------------------------

	/**
	 * Fills a tool card from a `user` event's `tool_result` blocks.
	 *
	 * Matched by `tool_use_id` against `toolSlots`, never by arrival order — see the field's own
	 * comment for why the capture makes that difference load-bearing. An id we do not know is
	 * dropped: guessing a slot would put a tool's output under a different tool's name.
	 */
	private applyUser(event: UserEvent): void {
		const item = this.active;
		// A subagent's own tool results arrive as `user` events under the parent's id. Their
		// content stays hidden in v1; what they contribute is the knowledge that work is still
		// happening. Their inner `tool_use_id`s are not in `toolSlots` anyway — the subagent's
		// `assistant` events never registered them — so they could not match a card by accident.
		if (event.parent_tool_use_id) {
			this.noteSubagentActivity(event.parent_tool_use_id);
			return;
		}
		const content = event.message.content;
		if (!item || typeof content === 'string' || content === undefined) {
			// A `string` content is the synthetic "[Request interrupted by user]" message; the
			// "stopped" badge already comes from `result.terminal_reason` (RESEARCH B4).
			return;
		}

		let touched = false;
		for (const block of content) {
			if (block.type !== 'tool_result') {
				continue;
			}
			touched = this.applyToolResult(item, block) || touched;
		}
		if (touched) {
			this.state.emitChange();
		}
	}

	private applyToolResult(item: AssistantItem, result: ToolResultBlock): boolean {
		const slot = this.toolSlots.get(result.tool_use_id);
		if (slot === undefined) {
			return false;
		}
		const block = item.blocks.get(slot);
		if (!block) {
			return false;
		}

		block.toolPending = false;
		// Strict `=== true`: the key is absent on a successful result, so `!== false` would mark
		// every success as an error (PHASE4-STATE F4).
		block.toolIsError = result.is_error === true;
		block.toolResultText = toolResultText(result.content);
		// The parent `Task` call has returned, so its subagent is no longer running.
		block.subagentActive = false;
		return true;
	}

	/**
	 * A subagent event arrived under `parentId`. Its content stays hidden (closed v1 decision);
	 * what the parent card gains is a live "subagent running…" line. Emre's rule: silence reads as
	 * a frozen plugin, and a `Task` call can run for minutes with nothing else on screen.
	 */
	private noteSubagentActivity(parentId: string): void {
		const block = this.toolBlockFor(parentId);
		if (!block || block.subagentActive === true) {
			// Already flagged. Subagent events arrive by the hundred; re-emitting on each one
			// would re-render the transcript for no visible change.
			return;
		}
		block.subagentActive = true;
		this.state.emitChange();
	}

	/**
	 * `system/task_started` / `task_progress` / `task_notification` — what makes the subagent line
	 * *live* rather than a fixed string. `description` tracks the subagent's current step and
	 * `usage.tool_uses` counts up, so a `Agent` call that runs for a minute keeps showing movement.
	 * That is the entire reason PLAN 4.5 exists: silence reads as a frozen plugin.
	 *
	 * `task_updated` is not handled: it carries `task_id` with no `tool_use_id`, so it cannot be
	 * tied to a card without a second index, and `task_notification` already reports completion.
	 */
	private applyTaskEvent(event: SystemTaskEvent): void {
		if (event.tool_use_id === undefined) {
			return;
		}
		const block = this.toolBlockFor(event.tool_use_id);
		if (!block) {
			return;
		}

		if (event.subtype === 'task_notification') {
			// The subagent is done. The parent card's own `tool_result` will follow and carry the
			// summary; the live line has nothing left to say.
			block.subagentActive = false;
			block.subagentLabel = undefined;
			this.state.emitChange();
			return;
		}

		block.subagentActive = true;
		if (typeof event.description === 'string' && event.description.length > 0) {
			block.subagentLabel = event.description;
		}
		if (typeof event.usage?.tool_uses === 'number') {
			block.subagentToolUses = event.usage.tool_uses;
		}
		this.state.emitChange();
	}

	/** The `tool_use` block a `tool_use_id` belongs to, or null. Never guesses a slot. */
	private toolBlockFor(toolUseId: string): MessageBlock | null {
		const item = this.active;
		if (!item) {
			return null;
		}
		const slot = this.toolSlots.get(toolUseId);
		if (slot === undefined) {
			return null;
		}
		return item.blocks.get(slot) ?? null;
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
			this.noteSubagentActivity(event.parent_tool_use_id);
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

			if (mapped.kind === 'tool_use') {
				// This event replaces the block, so anything the tool card already gained has to
				// survive it. A `tool_result` is not ordered against this event by anything we
				// control, so it can already have landed; without this the output would be wiped
				// and the card would sit on "running" forever.
				mapped.toolResultText = streamed?.toolResultText;
				mapped.toolIsError = streamed?.toolIsError;
				mapped.subagentActive = streamed?.subagentActive;
				mapped.subagentLabel = streamed?.subagentLabel;
				mapped.subagentToolUses = streamed?.subagentToolUses;
				mapped.toolPending = streamed?.toolResultText === undefined;
				if (mapped.toolUseId !== undefined) {
					// Also registered here, not only at `content_block_start`: without
					// `--include-partial-messages` there is no opening event at all.
					this.toolSlots.set(mapped.toolUseId, slot);
				}
			}

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

		// The interrupt flag is checked first and independently of the subtype: see its declaration
		// for why `terminal_reason` alone misses a Stop pressed during a pending tool call.
		if (this.interruptSent || event.terminal_reason === ABORTED_STREAMING) {
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
	 *
	 * This ends the turn, so it fires `onTurnEnd` exactly like `applyResult` does — including when
	 * there was no turn to fail. Not firing it left a message queued behind a dead turn stranded
	 * forever, because `pump` is only reached from `send` and from this callback. Callers that must
	 * *not* have the queue drained (a spawn failure, an unexpected exit) clear it first.
	 */
	failActiveTurn(message: string): boolean {
		const item = this.active;
		this.active = null;
		if (!item) {
			this.onTurnEnd?.();
			return false;
		}
		closeOpenBlocks(item);
		item.status = 'error';
		item.errorText = message;
		this.state.emitChange();
		this.onTurnEnd?.();
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
		// A tool whose result never arrived — the turn was cancelled, or the call was denied
		// before it ran — must stop claiming it is running. Leaving `toolPending` set is the
		// tool-card version of the thinking header stuck on "Thinking…".
		block.toolPending = false;
		block.subagentActive = false;
		block.subagentLabel = undefined;
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
				// The fully parsed arguments arrive here and only here (PHASE4-STATE F3). Phase 3
				// dropped this field, which is why the card had nothing to summarise.
				toolInput: block.input,
			};
		default:
			// tool_result blocks arrive on `user` events, not here.
			return null;
	}
}
