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
	contextUsageFromResult,
	isAssistantEvent,
	isRateLimitEvent,
	isResultEvent,
	isStreamPartialEvent,
	isSystemInitEvent,
	isTaskEvent,
	isThinkingTokensEvent,
	isUserEvent,
	deniedToolUseIds,
	parseQuotaSnapshot,
	type AssistantEvent,
	type ContentBlock,
	type ContextUsage,
	type QuotaSnapshot,
	type RateLimitEvent,
	type ResultEvent,
	type SseContentBlockDelta,
	type SseContentBlockStart,
	type SseContentBlockStop,
	type StreamJsonEvent,
	type StreamPartialEvent,
	type SystemInitEvent,
	type SystemTaskEvent,
	type SystemThinkingTokensEvent,
	type ToolResultBlock,
	type UserEvent,
} from '../cli/events';
import { toolResultText } from './tool-policy';
import type { AssistantItem, BlockKind, ChatState, MessageBlock } from './chat-state';

/**
 * `terminal_reason` values that mean the user interrupted — "stopped", not an error.
 *
 * Two, not one. `aborted_streaming` came from RESEARCH B4, where the Stop landed mid-text.
 * `aborted_tools` is what a Stop pressed **while a tool call is in flight** produces, captured
 * in `docs/capture-phase5a-stop.jsonl` — on the same event as `subtype:
 * 'error_during_execution'` and `is_error: true`, so every other field on it says "failure".
 * The `interruptSent` flag already catches this case and stays the primary signal; recognising
 * the value too costs nothing and stops the constant from quietly describing half the reality.
 */
const ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools']);

export class StreamReducer {
	private sessionId: string | null = null;
	private turnCount = 0;
	private active: AssistantItem | null = null;
	/**
	 * The turn's item, kept until the **next** `beginTurn` rather than cleared when the turn ends.
	 *
	 * `active` means "a turn is in flight" and `applyResult` nulls it before firing `onTurnEnd` —
	 * so anything reached from that callback looked the block up against `null` and silently did
	 * nothing. That is exactly how a Stop-cancelled permission kept its red "Error" badge: the
	 * broker's `cancelPending` runs from `onTurnEnd`, and the stamp it triggered was dropped on
	 * the floor (Emre's Phase 5a acceptance round 2, finding 3).
	 */
	private turnItem: AssistantItem | null = null;

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
	 * `tool_use_id`s that the permission bridge has shown a card for, and the subset of those the
	 * reader did not allow. Both are per-turn and both are cleared by `beginTurn`.
	 *
	 * They exist because **the wire cannot tell these two cases apart.** A tool call the reader
	 * denied comes back as a `tool_result` with `is_error: true`, exactly like a tool that genuinely
	 * failed — so `applyToolResult` reading `is_error` alone painted a red "Error" badge on a card
	 * for something the reader had deliberately declined (Emre's Phase 5a acceptance run, step 3).
	 * That is trap 6 applied at the turn level but not at the card level: `applyResult` already
	 * knows a denied tool is not a failed turn.
	 *
	 * The distinction is not recoverable from the event. Matching the result text would be guessing
	 * at a message we have never captured. What *is* certain is what our own broker answered, so
	 * that is what is recorded — by id, never by ordering.
	 */
	private permissionRequestedTools = new Set<string>();
	private permissionDeniedTools = new Set<string>();

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
	 * The last `result.total_cost_usd` this reducer has seen, and the reducer's own running sum of
	 * per-turn deltas. `null` means "no result yet" — the state a fresh process starts in, and the
	 * state a restarted one returns to without recreating the reducer (`SessionManager.handleExit`
	 * fails the in-flight turn but does not replace `this.reducer`).
	 *
	 * `total_cost_usd` accumulates over the CLI **process**, not the session id (measured
	 * 2026-09-03, PHASE6-TASK5-STATE §M1: a session resumed in a fresh process reported a low
	 * cumulative, not the old one carried forward). So a reported total *lower* than the last one
	 * means a new process started, not that the turn cost a negative amount — see `applyResult`.
	 */
	private lastCumulativeCostUsd: number | null = null;
	private sessionCostUsd = 0;

	/**
	 * Called whenever the active turn ends, for any reason. The SessionManager uses it to send the
	 * next queued message — nothing else was pumping the queue after a turn finished.
	 */
	onTurnEnd: (() => void) | null = null;

	/**
	 * Called for every `rate_limit_event` whose `rate_limit_info` parses at all
	 * (`parseQuotaSnapshot`). Never called for one that doesn't — there is nothing observed to show
	 * for any other shape, and a callback fired with `null` would ask every caller to repeat the
	 * same "is there anything here" check `parseQuotaSnapshot` already did.
	 */
	onQuota: ((snapshot: QuotaSnapshot) => void) | null = null;

	/**
	 * Called with the current turn's context percentage, once its `result` event carries `usage`
	 * and `modelUsage` (`contextUsageFromResult`). Absent on a cancelled turn and on any turn whose
	 * `result` didn't carry the fields — the status line keeps showing the last value it has rather
	 * than blanking (task 7 brief).
	 */
	onContextUsage: ((usage: ContextUsage) => void) | null = null;

	/**
	 * Called for **every** `system/init`, not just the first — it arrives at the start of every
	 * turn (RESEARCH B1). Phase 5's startup self-check reads `mcp_servers` off it to confirm the
	 * permission server registered; running that on every turn costs nothing and catches a server
	 * that dies mid-session. The reducer itself does nothing with the field.
	 */
	onInit: ((event: SystemInitEvent) => void) | null = null;

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
		this.turnItem = item;
		this.blockBase = 0;
		this.nextFreeSlot = 0;
		this.assistantSlot = 0;
		this.toolSlots = new Map();
		this.permissionRequestedTools = new Set();
		this.permissionDeniedTools = new Set();
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

	/**
	 * The permission bridge has put a card on screen for this tool call.
	 *
	 * What the card changes is the tool card's *body*: the approval card already shows the diff, in
	 * full and with the file path spelled out, so repeating it one card above is duplication rather
	 * than information (Emre's Phase 5a acceptance run, finding 2). The header still appears the
	 * moment the block opens — that is the "something is happening" signal Phase 4 exists for.
	 */
	notePermissionRequested(toolUseId: string): void {
		this.permissionRequestedTools.add(toolUseId);
		this.stampPermissionState(toolUseId);
	}

	/**
	 * The reader denied this tool call, or the turn ended before they answered it.
	 *
	 * Either way the failure is ours, not the tool's, and it must not render as one — see
	 * `permissionDeniedTools`. Called by the SessionManager, which owns both the broker and this
	 * reducer; the broker itself knows nothing about chat state beyond the card it created.
	 */
	notePermissionDenied(toolUseId: string): void {
		this.permissionDeniedTools.add(toolUseId);
		this.stampPermissionState(toolUseId);
	}

	/**
	 * Copies both flags onto the block, if it exists yet.
	 *
	 * Called from every point that creates or replaces a `tool_use` block as well as from the two
	 * `note*` methods, because the ordering between the bridge call and the `assistant` event that
	 * carries the block is **not** something we control. Phase 0 saw the `assistant` event first,
	 * but "usually first" is not a contract, and `applyAssistant` replaces the block wholesale — so
	 * a flag set at the wrong moment would silently vanish.
	 */
	private stampPermissionState(toolUseId: string): void {
		// `turnItem`, not `active`: this is reached from `onTurnEnd`, by which point the turn
		// has already been closed and `active` is null.
		const block = this.blockInTurn(this.turnItem, toolUseId);
		if (!block) {
			return;
		}
		const requested = this.permissionRequestedTools.has(toolUseId);
		const denied = this.permissionDeniedTools.has(toolUseId);
		if (
			block.toolPermissionRequested === requested &&
			block.toolDenied === denied &&
			!(denied && block.toolIsError === true)
		) {
			return;
		}
		block.toolPermissionRequested = requested;
		this.markDenied(block, denied);
		this.state.emitChange();
	}

	/**
	 * Marks a block as denied, **clearing `toolIsError`**.
	 *
	 * The order the CLI uses makes this necessary rather than tidy: the synthetic
	 * `tool_result` carrying `is_error: true` arrives *before* the `result` event — 1 ms
	 * before, in `docs/capture-phase5a-stop.jsonl` — so `applyToolResult` has already set the
	 * error flag by the time anything knows the call was cancelled. Setting `toolDenied`
	 * without clearing it leaves the card's red border and its expand-on-error rule in place,
	 * even though the badge would read "Denied".
	 */
	private markDenied(block: MessageBlock, denied: boolean): void {
		block.toolDenied = denied;
		if (denied) {
			block.toolIsError = false;
		}
	}

	/** A turn's `tool_use` block by id. Never guesses a slot; returns null when unknown. */
	private blockInTurn(item: AssistantItem | null, toolUseId: string): MessageBlock | null {
		if (!item) {
			return null;
		}
		const slot = this.toolSlots.get(toolUseId);
		if (slot === undefined) {
			return null;
		}
		return item.blocks.get(slot) ?? null;
	}

	apply(event: StreamJsonEvent): void {
		if (isSystemInitEvent(event)) {
			this.applyInit(event);
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
		if (isRateLimitEvent(event)) {
			this.applyRateLimit(event);
			return;
		}
		// system/status, hook_*, control_response: nothing to render yet.
	}

	private applyInit(event: SystemInitEvent): void {
		this.turnCount += 1;
		if (this.sessionId === null) {
			// First init only: session setup. No UI reset here or on any later init.
			this.sessionId = event.session_id ?? null;
		}
		this.onInit?.(event);
	}

	/**
	 * Repeats within a turn (three in one turn, utilization climbing, in
	 * `docs/capture-phase4-tools.jsonl`) — the caller's job is to update one strip, not append one
	 * row per call. That is why this only ever calls `onQuotaWarning`, never anything that could
	 * accumulate.
	 */
	private applyRateLimit(event: RateLimitEvent): void {
		const snapshot = parseQuotaSnapshot(event);
		if (snapshot) {
			this.onQuota?.(snapshot);
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
		if (opening?.type === 'tool_use') {
			// After the block is in the map, so `toolBlockFor` can find it: a permission request
			// that arrived before this event has flags waiting to be applied.
			this.stampPermissionState(opening.id);
		}
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
		// A denial our own broker issued comes back carrying `is_error: true`, indistinguishable on
		// the wire from a tool that genuinely failed. Reading `is_error` alone put a red "Error"
		// badge on a call the reader had simply declined. What we know that the event does not is
		// which ids we answered, so that wins over the flag.
		// Strict `=== true`: the key is absent on a successful result, so `!== false` would mark
		// every success as an error (PHASE4-STATE F4).
		block.toolIsError = result.is_error === true;
		// ...and this overrides it when the call was declined rather than failed, which the event
		// itself cannot say. `markDenied` is the only place that decision is applied — guarding
		// the line above as well would be a second copy of the same rule, and a reversion sweep
		// showed it was already dead: this call undoes it on the very next statement, before
		// anything emits.
		this.markDenied(block, this.permissionDeniedTools.has(result.tool_use_id));
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
		// Deliberately still `active`: subagent and task events belong to the turn in flight,
		// and letting them land on a turn that has already ended would revive a finished card.
		return this.blockInTurn(this.active, toolUseId);
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
				mapped.toolPermissionRequested = streamed?.toolPermissionRequested;
				mapped.toolDenied = streamed?.toolDenied;
				if (mapped.toolUseId !== undefined) {
					// Also registered here, not only at `content_block_start`: without
					// `--include-partial-messages` there is no opening event at all.
					this.toolSlots.set(mapped.toolUseId, slot);
				}
			}

			// Replace, not append: this event is authoritative for the block (RESEARCH B3).
			item.blocks.set(slot, mapped);
			if (mapped.toolUseId !== undefined) {
				// The block was just rebuilt; re-apply from the authoritative sets rather than
				// trusting what the streamed copy happened to be carrying.
				this.stampPermissionState(mapped.toolUseId);
			}
		}

		if (item.status === 'pending') {
			item.status = 'streaming';
		}
		this.state.emitChange();
	}

	/**
	 * Turns a cumulative `total_cost_usd` into this turn's own cost, and folds it into
	 * `sessionCostUsd` — the reducer's own running total, not the CLI's echoed number (Emre's
	 * decision, 2026-09-03: a total that silently drops because a subprocess died is the same
	 * class of lie this task exists to fix).
	 *
	 * **The restart guard.** A reported total *lower* than the last one means a new CLI process
	 * started — `total_cost_usd` accumulates over the process, not the session id (measured), and
	 * `SessionManager.handleExit` does not recreate this reducer. Read that way rather than
	 * subtracted, so the turn's cost is the fresh process's own total instead of a negative number.
	 */
	private turnCostUsd(reported: number | undefined): number | undefined {
		if (reported === undefined) {
			return undefined;
		}
		const baseline = this.lastCumulativeCostUsd;
		const turnCost = baseline === null || reported < baseline ? reported : reported - baseline;
		this.lastCumulativeCostUsd = reported;
		this.sessionCostUsd += turnCost;
		return turnCost;
	}

	private applyResult(event: ResultEvent): void {
		const item = this.active;
		this.active = null;
		if (!item) {
			this.onTurnEnd?.();
			return;
		}

		item.meta = {
			costUsd: this.turnCostUsd(event.total_cost_usd),
			durationMs: event.duration_ms,
			sessionCostUsd: event.total_cost_usd === undefined ? undefined : this.sessionCostUsd,
		};
		const usage = contextUsageFromResult(event);
		if (usage) {
			this.onContextUsage?.(usage);
		}
		// Whatever the outcome, no block is still streaming once the turn is over — otherwise a
		// cancelled turn leaves a thinking header saying "Thinking…" forever.
		closeOpenBlocks(item);
		this.applyPermissionDenials(item, event);

		// The interrupt flag is checked first and independently of the subtype: see its declaration
		// for why `terminal_reason` alone misses a Stop pressed during a pending tool call.
		if (this.interruptSent || ABORTED_TERMINAL_REASONS.has(event.terminal_reason ?? '')) {
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
	 * Marks every tool the **CLI itself** reports as denied, from `result.permission_denials[]`.
	 *
	 * This is the authoritative source and the one that fixes the ordering, so it runs here
	 * rather than depending on the broker's own bookkeeping arriving in time. A Stop pressed
	 * while a card is open produces, within 1 ms (`docs/capture-phase5a-stop.jsonl`):
	 *
	 *   `user`/`tool_result` — `is_error: true`, generic "the user doesn't want to proceed" text
	 *   `result`            — `permission_denials: [{tool_name, tool_use_id, tool_input}]`
	 *
	 * The first sets the error flag; the second is the CLI saying it was a *denial*. Nothing
	 * else on the result event does: `subtype` is `error_during_execution`, `is_error` is `true`
	 * and `stop_reason` is `tool_use`, so on every other field a cancelled turn is a failure.
	 *
	 * `item` is the local from `applyResult`, not `this.active` — that is already null here.
	 */
	private applyPermissionDenials(item: AssistantItem, event: ResultEvent): void {
		for (const toolUseId of deniedToolUseIds(event)) {
			this.permissionDeniedTools.add(toolUseId);
			const block = this.blockInTurn(item, toolUseId);
			if (block) {
				this.markDenied(block, true);
			}
		}
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
