/**
 * Renders `ChatState` into the scroll area.
 *
 * Sync is incremental and keyed by item id: a full rebuild on every change would re-run the
 * markdown renderer on the whole transcript and lose the scroll position. Markdown is rendered
 * only when a message's text actually changes, which in Phase 2 means once, when the
 * authoritative `assistant` event arrives (architectural rule #4).
 */
import type { App, Component } from 'obsidian';
import { visibleText, type AssistantItem, type ChatItem, type NoticeItem, type UserItem } from '../core/chat-state';
import { renderChatMarkdown } from './markdown';

/** Treat the view as "at the bottom" within this many pixels, so new content keeps following. */
const STICKY_BOTTOM_SLACK_PX = 48;

interface RenderedItem {
	el: HTMLElement;
	bodyEl: HTMLElement;
	metaEl: HTMLElement;
	/** Last markdown handed to the renderer, to avoid re-rendering identical content. */
	renderedText: string;
	status: string;
}

export class MessageList {
	private readonly rendered = new Map<string, RenderedItem>();

	constructor(
		private readonly app: App,
		private readonly containerEl: HTMLElement,
		/** The view. Passed to the markdown renderer as the owning component. */
		private readonly component: Component,
	) {}

	/** Re-syncs the DOM with `items`. Cheap to call on every state change. */
	sync(items: readonly ChatItem[]): void {
		const wasAtBottom = this.isAtBottom();
		const seen = new Set<string>();

		for (const item of items) {
			seen.add(item.id);
			const existing = this.rendered.get(item.id);
			const entry = existing ?? this.createItem(item);
			this.updateItem(item, entry);
		}

		for (const [id, entry] of this.rendered) {
			if (!seen.has(id)) {
				entry.el.remove();
				this.rendered.delete(id);
			}
		}

		if (wasAtBottom) {
			this.scrollToBottom();
		}
	}

	private createItem(item: ChatItem): RenderedItem {
		const el = this.containerEl.createDiv({ cls: `guki-message guki-message-${item.kind}` });
		const bodyEl = el.createDiv({ cls: 'guki-message-body' });
		const metaEl = el.createDiv({ cls: 'guki-message-meta' });
		const entry: RenderedItem = { el, bodyEl, metaEl, renderedText: '', status: '' };
		this.rendered.set(item.id, entry);
		return entry;
	}

	private updateItem(item: ChatItem, entry: RenderedItem): void {
		switch (item.kind) {
			case 'user':
				this.updateUser(item, entry);
				return;
			case 'assistant':
				this.updateAssistant(item, entry);
				return;
			case 'notice':
				this.updateNotice(item, entry);
				return;
		}
	}

	private updateUser(item: UserItem, entry: RenderedItem): void {
		if (entry.renderedText === item.text) {
			return;
		}
		// The user's own text is shown verbatim, not as rendered markdown.
		entry.bodyEl.setText(item.text);
		entry.renderedText = item.text;
	}

	private updateAssistant(item: AssistantItem, entry: RenderedItem): void {
		const text = visibleText(item);
		const statusKey = `${item.status}:${item.errorText ?? ''}`;

		if (text !== entry.renderedText) {
			entry.renderedText = text;
			if (text.length === 0) {
				entry.bodyEl.empty();
			} else {
				void renderChatMarkdown(this.app, text, entry.bodyEl, this.component);
			}
		}

		if (statusKey === entry.status) {
			return;
		}
		entry.status = statusKey;
		entry.el.toggleClass('guki-message-error', item.status === 'error');
		entry.metaEl.empty();

		switch (item.status) {
			case 'pending':
				entry.metaEl.setText('Working…');
				break;
			case 'streaming':
				entry.metaEl.setText('');
				break;
			case 'stopped':
				entry.metaEl.setText('Stopped.');
				break;
			case 'error':
				entry.metaEl.setText(item.errorText ?? 'Something went wrong.');
				break;
			case 'complete':
				entry.metaEl.setText(formatTurnMeta(item));
				break;
		}
	}

	private updateNotice(item: NoticeItem, entry: RenderedItem): void {
		const key = `${item.level}:${item.text}:${item.detail ?? ''}`;
		if (entry.status === key) {
			return;
		}
		entry.status = key;
		entry.el.toggleClass('guki-message-error', item.level === 'error');
		entry.bodyEl.setText(item.text);
		entry.metaEl.empty();
		if (item.detail) {
			entry.metaEl.createEl('code', { text: item.detail });
		}
	}

	private isAtBottom(): boolean {
		const el = this.containerEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_BOTTOM_SLACK_PX;
	}

	scrollToBottom(): void {
		this.containerEl.scrollTop = this.containerEl.scrollHeight;
	}
}

/** Cost and duration come free in the `result` event (RESEARCH B6). */
function formatTurnMeta(item: AssistantItem): string {
	const parts: string[] = [];
	if (typeof item.meta?.durationMs === 'number') {
		parts.push(`${(item.meta.durationMs / 1000).toFixed(1)} s`);
	}
	if (typeof item.meta?.costUsd === 'number') {
		parts.push(`$${item.meta.costUsd.toFixed(4)}`);
	}
	return parts.join(' · ');
}
