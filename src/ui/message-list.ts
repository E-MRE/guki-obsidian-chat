/**
 * Renders `ChatState` into the scroll area.
 *
 * Two levels of incremental sync, both keyed rather than rebuilt: items by `item.id`, and an
 * assistant turn's content blocks by their slot. A full rebuild on every change would re-run the
 * markdown renderer over the whole transcript sixty times a second once tokens start streaming.
 *
 * Architectural rule #4 lives here: a block that is still streaming is written with `setText`,
 * plain; the markdown renderer only runs when the authoritative `assistant` event has marked the
 * block final. Rendering half a fenced code block on every delta is both expensive and looks
 * broken.
 */
import type { App, Component } from 'obsidian';
import {
	hasRenderableContent,
	orderedBlocks,
	type AssistantItem,
	type ChatItem,
	type MessageBlock,
	type NoticeItem,
	type UserItem,
} from '../core/chat-state';
import { renderChatMarkdown } from './markdown';

/** Treat the view as "at the bottom" within this many pixels, so new content keeps following. */
const STICKY_BOTTOM_SLACK_PX = 48;

interface RenderedBlock {
	el: HTMLElement;
	kind: MessageBlock['kind'];
	/** Last content handed to the DOM, so an unchanged block is not touched. */
	renderedText: string;
	/** Whether that content went through the markdown renderer or `setText`. */
	renderedFinal: boolean;
	/** Thinking blocks only. */
	headerEl?: HTMLElement;
	contentEl?: HTMLElement;
	headerText?: string;
	expanded?: boolean;
}

interface RenderedItem {
	el: HTMLElement;
	bodyEl: HTMLElement;
	metaEl: HTMLElement;
	/** Last markdown handed to the renderer, to avoid re-rendering identical content. */
	renderedText: string;
	status: string;
	blocks: Map<number, RenderedBlock>;
}

export class MessageList {
	private readonly rendered = new Map<string, RenderedItem>();
	private readonly scrollEl: HTMLElement;
	private readonly jumpEl: HTMLElement;
	/** True when content arrived while the reader was scrolled away from the bottom. */
	private missedContent = false;

	constructor(
		private readonly app: App,
		/** A positioned wrapper. The scroller and the jump button are both created inside it. */
		wrapperEl: HTMLElement,
		/** The view. Passed to the markdown renderer as the owning component. */
		private readonly component: Component,
	) {
		this.scrollEl = wrapperEl.createDiv({ cls: 'guki-messages' });

		// Not yanking the reader back down is correct, but silence is not: without this, a reply
		// that lands while they are scrolled up leaves no sign at all that it arrived.
		this.jumpEl = wrapperEl.createEl('button', {
			cls: 'guki-jump',
			text: 'Jump to latest',
		});
		this.jumpEl.hide();

		this.component.registerDomEvent(this.jumpEl, 'click', () => {
			this.scrollToBottom();
			this.missedContent = false;
			this.updateJumpButton();
		});
		this.component.registerDomEvent(this.scrollEl, 'scroll', () => {
			if (this.isAtBottom()) {
				this.missedContent = false;
			}
			this.updateJumpButton();
		});
	}

	/** Re-syncs the DOM to `items`. Cheap enough to call on every state change. */
	sync(items: readonly ChatItem[]): void {
		const wasAtBottom = this.isAtBottom();
		const seen = new Set<string>();
		let changed = false;

		for (const item of items) {
			seen.add(item.id);
			const existing = this.rendered.get(item.id);
			const entry = existing ?? this.createItem(item);
			changed = this.updateItem(item, entry) || !existing || changed;
		}

		for (const [id, entry] of this.rendered) {
			if (!seen.has(id)) {
				entry.el.remove();
				this.rendered.delete(id);
				changed = true;
			}
		}

		if (wasAtBottom) {
			this.scrollToBottom();
		} else if (changed) {
			this.missedContent = true;
		}
		this.updateJumpButton();
	}

	private createItem(item: ChatItem): RenderedItem {
		const el = this.scrollEl.createDiv({ cls: `guki-message guki-message-${item.kind}` });
		const bodyEl = el.createDiv({ cls: 'guki-message-body' });
		const metaEl = el.createDiv({ cls: 'guki-message-meta' });
		const entry: RenderedItem = {
			el,
			bodyEl,
			metaEl,
			renderedText: '',
			status: '',
			blocks: new Map(),
		};
		this.rendered.set(item.id, entry);
		return entry;
	}

	/** Returns true when it touched the DOM — the jump-to-bottom hint keys off that. */
	private updateItem(item: ChatItem, entry: RenderedItem): boolean {
		switch (item.kind) {
			case 'user':
				return this.updateUser(item, entry);
			case 'assistant':
				return this.updateAssistant(item, entry);
			case 'notice':
				return this.updateNotice(item, entry);
		}
	}

	private updateUser(item: UserItem, entry: RenderedItem): boolean {
		if (entry.renderedText === item.text) {
			return false;
		}
		// The user's own text is shown verbatim, not as rendered markdown.
		entry.bodyEl.setText(item.text);
		entry.renderedText = item.text;
		return true;
	}

	// --- assistant turns ----------------------------------------------------

	private updateAssistant(item: AssistantItem, entry: RenderedItem): boolean {
		let changed = this.syncBlocks(item, entry);

		const statusKey = `${item.status}:${item.errorText ?? ''}:${String(hasRenderableContent(item))}`;
		if (statusKey === entry.status) {
			return changed;
		}
		entry.status = statusKey;
		changed = true;
		entry.el.toggleClass('guki-message-error', item.status === 'error');
		entry.metaEl.empty();

		switch (item.status) {
			case 'pending':
				entry.metaEl.setText('Working…');
				break;
			case 'streaming':
				// Deferred item D1: blanking this while nothing is on screen yet read as "no reply
				// is coming". The thinking header now normally fills that gap, but a turn whose
				// first block is neither text nor thinking would still be silent.
				entry.metaEl.setText(hasRenderableContent(item) ? '' : 'Working…');
				break;
			case 'stopped':
				entry.metaEl.setText(withTurnMeta('Stopped.', item));
				break;
			case 'error':
				entry.metaEl.setText(item.errorText ?? 'Something went wrong.');
				break;
			case 'complete':
				entry.metaEl.setText(formatTurnMeta(item));
				break;
		}
		return changed;
	}

	/** Keys the block elements by slot so a streaming block is updated, never re-created. */
	private syncBlocks(item: AssistantItem, entry: RenderedItem): boolean {
		let changed = false;
		const blocks = orderedBlocks(item);
		const seen = new Set<number>();

		for (const block of blocks) {
			// tool_use is Phase 4; it is held in the model but has no surface yet.
			if (block.kind === 'tool_use') {
				continue;
			}
			seen.add(block.index);
			let rendered = entry.blocks.get(block.index);
			if (!rendered) {
				rendered = this.createBlock(block, entry);
				changed = true;
			}
			changed = this.updateBlock(block, rendered) || changed;
		}

		for (const [index, rendered] of entry.blocks) {
			if (!seen.has(index)) {
				rendered.el.remove();
				entry.blocks.delete(index);
				changed = true;
			}
		}
		return changed;
	}

	private createBlock(block: MessageBlock, entry: RenderedItem): RenderedBlock {
		const el = entry.bodyEl.createDiv({ cls: `guki-block guki-block-${block.kind}` });
		const rendered: RenderedBlock = {
			el,
			kind: block.kind,
			renderedText: '',
			renderedFinal: false,
		};

		if (block.kind === 'thinking') {
			// Collapsed, never hidden: the header is present from the first thinking delta, so a
			// long silent stretch reads as work in progress rather than as a freeze.
			const headerEl = el.createEl('button', { cls: 'guki-thinking-header' });
			const contentEl = el.createDiv({ cls: 'guki-thinking-content' });
			contentEl.hide();
			rendered.headerEl = headerEl;
			rendered.contentEl = contentEl;
			rendered.expanded = false;
			this.component.registerDomEvent(headerEl, 'click', () => {
				rendered.expanded = !rendered.expanded;
				el.toggleClass('guki-thinking-open', rendered.expanded);
				if (rendered.expanded) {
					contentEl.show();
				} else {
					contentEl.hide();
				}
			});
		}

		// Insert in slot order rather than appending: blocks can be created out of order if an
		// event is missed, and the reading order is the slot order.
		this.placeInOrder(entry, block.index, el);
		entry.blocks.set(block.index, rendered);
		return rendered;
	}

	private placeInOrder(entry: RenderedItem, index: number, el: HTMLElement): void {
		// `entry.blocks` is in insertion order, not slot order, so the successor has to be found.
		const successor = [...entry.blocks.keys()]
			.filter((other) => other > index)
			.sort((a, b) => a - b)[0];
		if (successor !== undefined) {
			const other = entry.blocks.get(successor);
			if (other) {
				entry.bodyEl.insertBefore(el, other.el);
			}
		}
	}

	private updateBlock(block: MessageBlock, rendered: RenderedBlock): boolean {
		if (block.kind === 'thinking') {
			return this.updateThinkingBlock(block, rendered);
		}
		return this.updateTextBlock(block, rendered);
	}

	private updateTextBlock(block: MessageBlock, rendered: RenderedBlock): boolean {
		if (rendered.renderedText === block.text && rendered.renderedFinal === block.final) {
			return false;
		}
		rendered.renderedText = block.text;
		rendered.renderedFinal = block.final;

		// `guki-block-streaming` carries `white-space: pre-wrap`, and is dropped again on the final
		// render so it cannot turn a paragraph's soft wraps into hard breaks.
		rendered.el.toggleClass('guki-block-streaming', !block.final);

		if (block.final) {
			// Architectural rule #4: the markdown renderer runs exactly once per block, here.
			void renderChatMarkdown(this.app, block.text, rendered.el, this.component);
		} else {
			// Plain text while streaming — rendering half a fenced code block looks broken.
			rendered.el.setText(block.text);
		}
		return true;
	}

	private updateThinkingBlock(block: MessageBlock, rendered: RenderedBlock): boolean {
		let changed = false;
		const headerText = thinkingHeaderText(block);
		if (headerText !== rendered.headerText) {
			rendered.headerEl?.setText(headerText);
			rendered.headerText = headerText;
			changed = true;
		}
		rendered.el.toggleClass('guki-thinking-live', !block.final);

		if (rendered.renderedText !== block.text) {
			// Never markdown: it is prose, it changes on every delta, and it is collapsed anyway.
			rendered.contentEl?.setText(block.text);
			rendered.renderedText = block.text;
			changed = true;
		}
		return changed;
	}

	// --- notices ------------------------------------------------------------

	private updateNotice(item: NoticeItem, entry: RenderedItem): boolean {
		const key = `${item.level}:${item.text}:${item.detail ?? ''}`;
		if (entry.status === key) {
			return false;
		}
		entry.status = key;
		entry.el.toggleClass('guki-message-error', item.level === 'error');
		entry.bodyEl.setText(item.text);
		entry.metaEl.empty();
		if (item.detail) {
			entry.metaEl.createEl('code', { text: item.detail });
		}
		return true;
	}

	// --- scrolling ----------------------------------------------------------

	private isAtBottom(): boolean {
		const el = this.scrollEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_BOTTOM_SLACK_PX;
	}

	scrollToBottom(): void {
		this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
	}

	private updateJumpButton(): void {
		if (this.isAtBottom()) {
			this.jumpEl.hide();
			return;
		}
		this.jumpEl.show();
		this.jumpEl.toggleClass('guki-jump-new', this.missedContent);
		this.jumpEl.setText(this.missedContent ? 'New reply ↓' : 'Jump to latest ↓');
	}
}

/** "Thinking…" from the first delta, "Thought for 2.9s" once the block closes (PLAN Phase 3.4). */
function thinkingHeaderText(block: MessageBlock): string {
	const seconds =
		block.startedAt !== undefined && block.endedAt !== undefined
			? (block.endedAt - block.startedAt) / 1000
			: null;

	if (block.final) {
		return seconds === null ? 'Thought' : `Thought for ${seconds.toFixed(1)} s`;
	}
	// The token counter is what makes a long silent stretch legible as progress.
	return block.thinkingTokens === undefined
		? 'Thinking…'
		: `Thinking… ${String(block.thinkingTokens)} tokens`;
}

/** Cost and duration, from the `result` event (RESEARCH B2). Either half may be absent. */
function formatTurnMeta(item: AssistantItem): string {
	const parts: string[] = [];
	if (item.meta?.durationMs !== undefined) {
		parts.push(`${(item.meta.durationMs / 1000).toFixed(1)} s`);
	}
	if (item.meta?.costUsd !== undefined) {
		parts.push(`$${item.meta.costUsd.toFixed(4)}`);
	}
	return parts.join(' · ');
}

/** A cancelled turn still carries `duration_ms` and `total_cost_usd` (PHASE3-STATE F5). */
function withTurnMeta(prefix: string, item: AssistantItem): string {
	const meta = formatTurnMeta(item);
	return meta.length > 0 ? `${prefix} ${meta}` : prefix;
}
