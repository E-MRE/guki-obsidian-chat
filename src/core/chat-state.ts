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
	index: number;
	kind: BlockKind;
	/** Rendered content for `text`/`thinking`. Empty for `tool_use` in v1. */
	text: string;
	/** True once the authoritative `assistant` event has replaced the streamed content. */
	final: boolean;
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

/** Ordered `text` blocks — what Phase 2 renders. */
export function visibleText(item: AssistantItem): string {
	return [...item.blocks.values()]
		.filter((block) => block.kind === 'text')
		.sort((a, b) => a.index - b.index)
		.map((block) => block.text)
		.join('\n\n')
		.trim();
}
