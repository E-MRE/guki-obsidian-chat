/**
 * The DOM-agnostic conversation model. The UI subscribes; nothing here touches an element.
 *
 * Assistant content is held as `Map<number, MessageBlock>` keyed by the content-block index, not
 * as one accumulated string. Phase 2 only ever fills it from the authoritative `assistant` event,
 * but Phase 3's `text_delta`s arrive tagged with a block `index` (RESEARCH B3) and must land in
 * the same structure — flat concatenation would have to be torn out again.
 */

import type { QuotaSnapshot } from '../cli/events';
import type { ImageAttachment } from './attachments';

export type BlockKind = 'text' | 'thinking' | 'tool_use';

export interface MessageBlock {
	/**
	 * The block's slot in the turn. **Not** the position in `assistant.message.content[]** — an
	 * assistant event carries one block at array index 0 whatever its real position is
	 * (PHASE3-STATE F2). The reducer assigns slots; nothing else may.
	 */
	index: number;
	kind: BlockKind;
	/** Rendered content for `text`/`thinking`. Empty for `tool_use` in v1. */
	text: string;
	/** True once the authoritative `assistant` event has replaced the streamed content. */
	final: boolean;
	/** `Date.now()` at `content_block_start`. Absent when the block was never streamed. */
	startedAt?: number;
	/** `Date.now()` when the block closed — drives "thought for Ns". */
	endedAt?: number;
	/** Live `system/thinking_tokens.estimated_tokens`, thinking blocks only (PHASE3-STATE F3). */
	thinkingTokens?: number;
	/** `tool_use` only — the id a `tool_result` is matched against. Never matched by order. */
	toolUseId?: string;
	toolName?: string;
	/**
	 * The tool's arguments, as the authoritative `assistant` event carried them. `unknown` on
	 * purpose: this is off the wire and its shape differs per tool, so every read is guarded.
	 * Absent while the `input_json_delta`s are still streaming (PHASE4-STATE D1).
	 */
	toolInput?: unknown;
	/** True from the block opening until its `tool_result` arrives — drives the "running" state. */
	toolPending?: boolean;
	/** The matched `tool_result.content`, flattened for display. Absent until the result lands. */
	toolResultText?: string;
	/**
	 * `tool_result.is_error === true`. The key is **absent** on a successful result
	 * (PHASE4-STATE F4), so this is set from a strict `=== true`, never from truthiness.
	 */
	toolIsError?: boolean;
	/**
	 * True once the permission bridge has put an approval card on screen for this call.
	 *
	 * The card carries the diff and the full target path, so the tool card stops repeating them —
	 * two identical Before/After panes, one passive and one actionable, is noise rather than
	 * information (Emre's Phase 5a acceptance run, finding 2).
	 */
	toolPermissionRequested?: boolean;
	/**
	 * The reader denied this call, or the turn ended before they answered it.
	 *
	 * **Distinct from `toolIsError`, and it has to be.** The CLI reports a denial as a
	 * `tool_result` with `is_error: true`, exactly as it reports a tool that genuinely failed, so
	 * the wire cannot separate them — only our own broker knows which ids it declined. A denial is
	 * a normal outcome and the turn continues (RESEARCH B5, trap 6), so it gets no error colour and
	 * no failure badge.
	 */
	toolDenied?: boolean;
	/**
	 * An `Agent` block with subagent events arriving under its id. v1 hides the content and shows
	 * one live line instead (PLAN Phase 4.5): silence reads as a frozen plugin.
	 */
	subagentActive?: boolean;
	/**
	 * What that one line says. Fed by `system/task_progress`, so it tracks what the subagent is
	 * actually doing ("Reading sample.txt") instead of standing still on a fixed string for the
	 * minute or more a subagent can run. Falls back to a plain running label when absent.
	 */
	subagentLabel?: string;
	/** `usage.tool_uses` from the same events — the count that shows the line is still moving. */
	subagentToolUses?: number;
}

export type TurnStatus = 'pending' | 'streaming' | 'complete' | 'stopped' | 'error';

export interface TurnMeta {
	/** This turn's own cost — `total_cost_usd` minus the reducer's remembered baseline. */
	costUsd?: number;
	durationMs?: number;
	/**
	 * The reducer's own running sum of every turn's `costUsd` this process has seen — **not**
	 * `total_cost_usd` echoed back. The CLI's own cumulative resets to near-zero when the
	 * subprocess restarts mid-session (measured, PHASE6-TASK5-STATE §M1); a total that can drop
	 * mid-conversation is the defect this field exists to avoid repeating.
	 */
	sessionCostUsd?: number;
}

export interface UserItem {
	kind: 'user';
	id: string;
	text: string;
	/**
	 * The pasted images this message carried, if any.
	 *
	 * **A sent image has to leave a visible trace.** The panel's standing rule is that it shows what
	 * was actually sent — that is why the `@` references are in the bubble rather than hidden — and
	 * an image contributes nothing to `text`, so an image-only message would otherwise render an
	 * empty bubble. An empty bubble reads as a bug and hides the mechanism.
	 */
	images?: readonly ImageAttachment[];
}

export interface AssistantItem {
	kind: 'assistant';
	id: string;
	blocks: Map<number, MessageBlock>;
	status: TurnStatus;
	/** Set when `status` is `'error'`. */
	errorText?: string;
	meta?: TurnMeta;
}

/** Out-of-band panel message: binary not found, subprocess died, and the like. */
export interface NoticeItem {
	kind: 'notice';
	id: string;
	level: 'info' | 'error';
	text: string;
	detail?: string;
}

/**
 * `pending` until the reader answers. `cancelled` is **not** a decision they made — it means the
 * turn ended (Stop, or the server went away) while the card was still open, and the request was
 * answered on their behalf so the CLI is not left waiting (PHASE5A-STATE D5).
 *
 * `denied` is a normal outcome, not a failure: a denied tool leaves `result.subtype === 'success'`
 * and `is_error === false`, and the turn carries on (RESEARCH B5, trap 6).
 */
export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'cancelled';

/**
 * What the target file held *before* a call, for the tools whose own input does not carry it.
 *
 * Three states, and the third one is the point. `Write` sends only the new content, so the approval
 * card's Before pane can only be honest if someone looks at the file — and "we looked and it was
 * empty" must never render the same as "we did not look". Emre's acceptance run hit exactly that: a
 * `Write` about to destroy `merhaba\ndünya` showed `Before: (empty)`. That is the one case where
 * the card is load-bearing — PLAN §2b carves "an existing file being emptied" out of the edit allow
 * — and it was the case where the card said the opposite of the truth.
 *
 * It lives here rather than in `ui/diff-view.ts` because `core` may not depend on `ui`: this is a
 * fact about the conversation, and the diff surface is one renderer of it.
 */
export type PriorContent =
	/** Read, and this is what it held. */
	| { kind: 'content'; text: string }
	/** Looked, and there is no such file — a create. `(empty)` is the truth here. */
	| { kind: 'absent' }
	/** Could not look: unreadable, a directory, too large, or never attempted. */
	| { kind: 'unknown' };

/**
 * A permission request from the CLI, awaiting an Allow / Deny (PLAN Phase 5.4).
 *
 * It is a top-level item rather than a field on the `tool_use` block it belongs to. `tool_use_id`
 * does tie the two together and is carried here for it — but the ordering between the `assistant`
 * event that opens the block and the bridge call is not a contract we control, and a card that
 * fails to render is a turn that hangs with no way out. A standalone item always renders, and the
 * sticky-bottom scroll brings it into view for free (PHASE5A-STATE D4).
 */
export interface PermissionItem {
	kind: 'permission';
	id: string;
	/** The broker's own id for the request. What `PermissionBroker.decide` is called with. */
	requestId: string;
	toolName: string;
	/** The tool's arguments, straight off the wire. `unknown`: every read of it is guarded. */
	input: unknown;
	/** Matches the `tool_use` block in the `assistant` event (RESEARCH B5). Unused in 5a. */
	toolUseId?: string;
	/**
	 * What the target file held before this call, for a `Write` — whose input carries only the new
	 * content, so the card's Before pane would otherwise be a guess. Read once by the broker, before
	 * the card exists, so the card is never on screen in a state the reader could act on wrongly.
	 * `undefined` means the same as `{kind:'unknown'}`.
	 */
	priorContent?: PriorContent;
	status: PermissionStatus;
}

export type ChatItem = UserItem | AssistantItem | NoticeItem | PermissionItem;

let nextId = 0;
function newId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${String(nextId)}`;
}

export class ChatState {
	private readonly itemList: ChatItem[] = [];
	private readonly listeners = new Set<() => void>();
	/**
	 * The most recent `rate_limit_event`, if any — ambient session state, not a transcript entry
	 * (Phase 6 task 7 turned this into a live gauge, both windows, replacing task 5's single-window
	 * warning-only strip — see `parseQuotaSnapshot`'s own comment for why the threshold gate went
	 * away). Replaced by a later snapshot, never cleared by this class: there is no measured event
	 * that means "nothing to report" to clear it with.
	 */
	private quota: QuotaSnapshot | null = null;

	/** `system/init.model`, from the most recent init — tracks a mid-session model change (task 7 Trap 4). */
	private modelName: string | null = null;

	/** The most recent turn's context percentage (`contextUsageFromResult`). Sticky across turns. */
	private contextPct: number | null = null;

	get items(): readonly ChatItem[] {
		return this.itemList;
	}

	get quotaSnapshot(): QuotaSnapshot | null {
		return this.quota;
	}

	setQuotaSnapshot(snapshot: QuotaSnapshot): void {
		this.quota = snapshot;
		this.emitChange();
	}

	get model(): string | null {
		return this.modelName;
	}

	setModel(model: string | null): void {
		if (model === this.modelName) {
			return;
		}
		this.modelName = model;
		this.emitChange();
	}

	get contextPercent(): number | null {
		return this.contextPct;
	}

	setContextPercent(percent: number): void {
		this.contextPct = percent;
		this.emitChange();
	}

	/** Returns an unsubscribe function; callers hold it for their own teardown. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitChange(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	addUserMessage(text: string, images: readonly ImageAttachment[] = []): UserItem {
		const item: UserItem = { kind: 'user', id: newId('user'), text };
		if (images.length > 0) {
			item.images = images;
		}
		this.itemList.push(item);
		this.emitChange();
		return item;
	}

	addAssistantMessage(): AssistantItem {
		const item: AssistantItem = {
			kind: 'assistant',
			id: newId('assistant'),
			blocks: new Map(),
			status: 'pending',
		};
		this.itemList.push(item);
		this.emitChange();
		return item;
	}

	addPermissionRequest(request: {
		requestId: string;
		toolName: string;
		input: unknown;
		toolUseId?: string;
		priorContent?: PriorContent;
	}): PermissionItem {
		const item: PermissionItem = {
			kind: 'permission',
			id: newId('permission'),
			requestId: request.requestId,
			toolName: request.toolName,
			input: request.input,
			toolUseId: request.toolUseId,
			priorContent: request.priorContent,
			status: 'pending',
		};
		this.itemList.push(item);
		this.emitChange();
		return item;
	}

	addNotice(level: NoticeItem['level'], text: string, detail?: string): NoticeItem {
		const item: NoticeItem = { kind: 'notice', id: newId('notice'), level, text, detail };
		this.itemList.push(item);
		this.emitChange();
		return item;
	}
}

/**
 * The turn's blocks in slot order. The UI renders each one on its own surface — a thinking block
 * needs its own collapsible header, and flattening the map into one string would lose both the
 * ordering and the per-block streaming state.
 */
export function orderedBlocks(item: AssistantItem): MessageBlock[] {
	return [...item.blocks.values()].sort((a, b) => a.index - b.index);
}

/** True when the turn has produced something the reader can see yet. Drives the "Working…" meta. */
export function hasRenderableContent(item: AssistantItem): boolean {
	for (const block of item.blocks.values()) {
		if (block.kind === 'text' && block.text.trim().length > 0) {
			return true;
		}
		if (block.kind === 'thinking') {
			return true;
		}
		// Since Phase 4 a tool_use block has a card of its own, so it counts as something the
		// reader can see. Before that it did not, and a turn that opened with a tool call sat on
		// "Working…" for its whole length — the "looks frozen" complaint this phase exists for.
		if (block.kind === 'tool_use') {
			return true;
		}
	}
	return false;
}
