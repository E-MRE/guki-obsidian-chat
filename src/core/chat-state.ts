/**
 * The DOM-agnostic conversation model. The UI subscribes; nothing here touches an element.
 *
 * Assistant content is held as `Map<number, MessageBlock>` keyed by the content-block index, not
 * as one accumulated string. Phase 2 only ever fills it from the authoritative `assistant` event,
 * but Phase 3's `text_delta`s arrive tagged with a block `index` (RESEARCH B3) and must land in
 * the same structure — flat concatenation would have to be torn out again.
 */

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
	/** `tool_use` only — kept so Phase 4 can match results by id. */
	toolUseId?: string;
	toolName?: string;
}

export type TurnStatus = 'pending' | 'streaming' | 'complete' | 'stopped' | 'error';

export interface TurnMeta {
	costUsd?: number;
	durationMs?: number;
}

export interface UserItem {
	kind: 'user';
	id: string;
	text: string;
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

export type ChatItem = UserItem | AssistantItem | NoticeItem;

let nextId = 0;
function newId(prefix: string): string {
	nextId += 1;
	return `${prefix}-${String(nextId)}`;
}

export class ChatState {
	private readonly itemList: ChatItem[] = [];
	private readonly listeners = new Set<() => void>();

	get items(): readonly ChatItem[] {
		return this.itemList;
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

	addUserMessage(text: string): UserItem {
		const item: UserItem = { kind: 'user', id: newId('user'), text };
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
	}
	return false;
}
