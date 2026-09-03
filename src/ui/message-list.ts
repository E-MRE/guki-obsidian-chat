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
import { setIcon, type App, type Component } from 'obsidian';
import { imageDataUrl, imageSummary } from '../core/attachments';
import {
	assistantCopyText,
	assistantCopyVisible,
	hasRenderableContent,
	orderedBlocks,
	type AssistantItem,
	type ChatItem,
	type MessageBlock,
	type NoticeItem,
	type PermissionItem,
	type UserItem,
} from '../core/chat-state';
import { renderChatMarkdown } from './markdown';
import {
	createPermissionCard,
	updatePermissionCard,
	type PermissionActions,
	type RenderedPermissionCard,
} from './permission-card';
import { createToolCard, updateToolCard, type RenderedToolCard } from './tool-card';

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
	headerEl?: HTMLButtonElement;
	/** Created lazily, on the first character of thinking text — see `setThinkingExpandable`. */
	contentEl?: HTMLElement;
	headerText?: string;
	expanded?: boolean;
	/** Whether the header currently offers an expander. Starts false: there is nothing to open. */
	expandable?: boolean;
	/** `tool_use` blocks only. Holds its own expansion state, so it is updated, never rebuilt. */
	toolCard?: RenderedToolCard;
}

interface RenderedItem {
	el: HTMLElement;
	bodyEl: HTMLElement;
	metaEl: HTMLElement;
	/** Last markdown handed to the renderer, to avoid re-rendering identical content. */
	renderedText: string;
	status: string;
	blocks: Map<number, RenderedBlock>;
	/** Permission items only. Holds the buttons, so it is updated in place, never rebuilt. */
	permissionCard?: RenderedPermissionCard;
	/**
	 * User items that carried pasted images. Its presence is what says they have been rendered —
	 * a `UserItem` never changes after it is created, so there is nothing to re-sync.
	 */
	userImagesEl?: HTMLElement;
	/**
	 * Copies the whole bubble's text (Phase 6 task 8). User and assistant items only — a notice or
	 * a permission card is not a conversation bubble, and Emre never asked for one there.
	 */
	copyEl?: HTMLButtonElement;
}

/** How long the icon shows "copied" before reverting — long enough to register, not a toast. */
const COPY_FEEDBACK_MS = 1500;

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
		/** Where Allow / Deny go. The list never decides a permission itself. */
		private readonly permissionActions: PermissionActions,
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
		// One row, not two stacked elements (task 8 follow-up, ask 2): the copy button and the meta
		// pill are row siblings inside this wrapper, copy button first so it lands to the pill's
		// left. Created for every kind, same as `.guki-message-meta` was before it, so notice/
		// permission items keep the exact same DOM shape they always had.
		const footerEl = el.createDiv({ cls: 'guki-message-footer' });

		// Not notices or permission cards (scope, task 8 brief) — those are not conversation
		// bubbles, and Emre never asked for a copy affordance on either. Created first so it is the
		// left-hand sibling of the meta pill created just below.
		const copyEl =
			item.kind === 'user' || item.kind === 'assistant'
				? this.createCopyButton(footerEl, item)
				: undefined;

		const metaEl = footerEl.createDiv({ cls: 'guki-message-meta' });
		const entry: RenderedItem = {
			el,
			bodyEl,
			metaEl,
			copyEl,
			renderedText: '',
			status: '',
			blocks: new Map(),
		};

		this.rendered.set(item.id, entry);
		return entry;
	}

	/**
	 * Reads `item.text` (user) or `assistantCopyText(item)` (assistant) at click time, never the
	 * DOM — the whole reason this exists is to copy the raw markdown the model sent, not whatever
	 * Obsidian's renderer turned it into (`docs/NEXT.md` Open items, task 8 brief).
	 *
	 * `item` is closed over rather than re-looked-up: `ChatState` mutates a `UserItem`/`AssistantItem`
	 * in place and never replaces the object (`SessionManager`/`StreamReducer` write through the same
	 * reference for the item's whole life), so the reference captured here stays current.
	 */
	private createCopyButton(el: HTMLElement, item: UserItem | AssistantItem): HTMLButtonElement {
		const copyEl = el.createEl('button', {
			cls: 'guki-message-copy',
			attr: { 'aria-label': 'Copy message' },
		});
		setIcon(copyEl, 'copy');

		this.component.registerDomEvent(copyEl, 'click', () => {
			const text = item.kind === 'user' ? item.text : assistantCopyText(item);
			void navigator.clipboard.writeText(text).then(() => {
				setIcon(copyEl, 'check');
				copyEl.addClass('guki-message-copy-done');
				window.setTimeout(() => {
					setIcon(copyEl, 'copy');
					copyEl.removeClass('guki-message-copy-done');
				}, COPY_FEEDBACK_MS);
			});
		});

		return copyEl;
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
			case 'permission':
				return this.updatePermission(item, entry);
		}
	}

	private updateUser(item: UserItem, entry: RenderedItem): boolean {
		let changed = false;

		/*
		 * The images this message carried, above its text — the same order the composer showed
		 * them in, and the same order they sit in on the wire.
		 *
		 * **A sent image has to leave a visible trace.** An image-only message has no text at all,
		 * so without this the bubble renders empty, which reads as a bug and hides the one
		 * mechanism in the whole attachment design that sends bytes. Rendered once: a `UserItem`
		 * is immutable, and the bytes are already in memory, so there is nothing to decode.
		 */
		if (item.images && item.images.length > 0 && !entry.userImagesEl) {
			const imagesEl = entry.el.createDiv({ cls: 'guki-message-images' });
			// Before the body, not after it: the text is the question *about* the pictures.
			entry.el.insertBefore(imagesEl, entry.bodyEl);
			for (const image of item.images) {
				const imgEl = imagesEl.createEl('img', { cls: 'guki-message-image' });
				imgEl.src = imageDataUrl(image);
				imgEl.alt = image.displayName;
				imgEl.title = imageSummary(image);
			}
			entry.userImagesEl = imagesEl;
			changed = true;
		}

		if (entry.renderedText === item.text) {
			return changed;
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

		// Fix 1 (task 8 follow-up): the button must not read as available before the turn's
		// blocks are done mutating — `pending`/`streaming` hide it outright rather than merely
		// disabling it, so it does not sit under the bubble looking clickable during the exact
		// window Emre caught it in.
		if (entry.copyEl) {
			if (assistantCopyVisible(item)) {
				entry.copyEl.show();
			} else {
				entry.copyEl.hide();
			}
		}

		switch (item.status) {
			case 'pending':
				entry.metaEl.setText('Working…');
				break;
			case 'streaming':
				// Deferred item D1: blanking this while nothing is on screen yet read as "no reply
				// is coming". The thinking header fills that gap, and since Phase 4 a tool card
				// does too — `hasRenderableContent` counts one, so a turn that opens with a tool
				// call drops "Working…" as soon as the card appears rather than holding it.
				entry.metaEl.setText(hasRenderableContent(item) ? '' : 'Working…');
				break;
			case 'stopped':
				entry.metaEl.setText(withTurnMeta('Stopped.', item));
				break;
			case 'error':
				// Trap 3: an errored turn still cost money. `withTurnMeta` appends the badge to the
				// error text exactly as the `stopped` case does above.
				entry.metaEl.setText(withTurnMeta(item.errorText ?? 'Something went wrong.', item));
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

		if (block.kind === 'tool_use') {
			// Drawn from `content_block_start`, before the arguments have finished streaming — the
			// header appearing at all is what tells the reader the turn is still moving.
			rendered.toolCard = createToolCard(el, this.component);
		}

		if (block.kind === 'thinking') {
			// Collapsed, never hidden: the header is present from the first thinking delta, so a
			// long silent stretch reads as work in progress rather than as a freeze.
			//
			// It starts `disabled`, i.e. as a plain label. Thinking text is model-dependent and is
			// usually encrypted, in which case the deltas carry `""` for the whole turn — offering
			// an expander then opens an empty box. `setThinkingExpandable` turns the label into a
			// real control if, and only if, text actually arrives.
			const headerEl = el.createEl('button', { cls: 'guki-thinking-header' });
			headerEl.disabled = true;
			rendered.headerEl = headerEl;
			rendered.expanded = false;
			rendered.expandable = false;
			this.component.registerDomEvent(headerEl, 'click', () => {
				const contentEl = rendered.contentEl;
				if (rendered.expandable !== true || !contentEl) {
					return;
				}
				rendered.expanded = rendered.expanded !== true;
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
		if (block.kind === 'tool_use') {
			return rendered.toolCard ? updateToolCard(block, rendered.toolCard) : false;
		}
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
			this.setThinkingExpandable(rendered, block.text.length > 0);
			// Never markdown: it is prose, it changes on every delta, and it is collapsed anyway.
			rendered.contentEl?.setText(block.text);
			rendered.renderedText = block.text;
			changed = true;
		}
		return changed;
	}

	/**
	 * Adds or removes the expander, keeping the header itself untouched.
	 *
	 * The header's duration and live token counter are the only signal the reader gets during a
	 * silent stretch — with an encrypted thinking block that stretch can be 20 s and more — so the
	 * header always renders. What is conditional is whether it is a *control*. With no text there
	 * is no content element at all, and the button is `disabled`, so it neither looks nor behaves
	 * clickable.
	 *
	 * Text arriving after the header was drawn as a label upgrades it in place and leaves the block
	 * **collapsed**: expanding on its own would push the answer down mid-read, and thinking is
	 * secondary content by decision. The reverse transition (text replaced by an empty
	 * authoritative block) collapses and disables it again rather than leaving an empty box behind.
	 */
	private setThinkingExpandable(rendered: RenderedBlock, expandable: boolean): void {
		if (rendered.expandable === expandable) {
			return;
		}
		rendered.expandable = expandable;
		if (rendered.headerEl) {
			rendered.headerEl.disabled = !expandable;
		}
		if (expandable) {
			rendered.contentEl ??= rendered.el.createDiv({ cls: 'guki-thinking-content' });
			if (rendered.expanded !== true) {
				rendered.contentEl.hide();
			}
			return;
		}
		rendered.expanded = false;
		rendered.el.removeClass('guki-thinking-open');
		rendered.contentEl?.hide();
	}

	// --- permission requests -------------------------------------------------

	/**
	 * The card is created on first sight and only ever updated after that: rebuilding it would take
	 * the buttons out from under the pointer, and `createPermissionCard` binds the click handlers to
	 * the request id the card was created for.
	 */
	private updatePermission(item: PermissionItem, entry: RenderedItem): boolean {
		entry.permissionCard ??= createPermissionCard(
			entry.bodyEl,
			this.component,
			item,
			this.permissionActions,
		);
		return updatePermissionCard(item, entry.permissionCard);
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

/**
 * Duration, this turn's own cost, and the session total — from the `result` event (RESEARCH B2,
 * PHASE6-TASK5-STATE §M1). Any part may be absent.
 *
 * **The total is shown only when it differs from the turn's own cost.** On the first turn of a
 * process they are the same number (`StreamReducer.turnCostUsd` has no baseline yet), and printing
 * it twice reads as a bug — Emre's call, task 5 brief. Compared as the same 4-decimal string this
 * function prints, not as raw floats, so two values that round to the same display never repeat.
 */
export function formatTurnMeta(item: AssistantItem): string {
	const parts: string[] = [];
	if (item.meta?.durationMs !== undefined) {
		parts.push(`${(item.meta.durationMs / 1000).toFixed(1)} s`);
	}
	if (item.meta?.costUsd !== undefined) {
		const turnCost = `$${item.meta.costUsd.toFixed(4)}`;
		parts.push(turnCost);
		if (item.meta.sessionCostUsd !== undefined) {
			const total = `$${item.meta.sessionCostUsd.toFixed(4)}`;
			if (total !== turnCost) {
				parts.push(`${total} total`);
			}
		}
	}
	return parts.join(' · ');
}

/**
 * A cancelled turn still carries `duration_ms` and `total_cost_usd` (PHASE3-STATE F5) — and so
 * does an errored one (trap 3, PHASE6-TASK5-STATE): a turn that ends in error was billed the same
 * way as any other, so `updateAssistant`'s `error` branch runs its text through this too rather
 * than writing `errorText` alone.
 */
export function withTurnMeta(prefix: string, item: AssistantItem): string {
	const meta = formatTurnMeta(item);
	return meta.length > 0 ? `${prefix} ${meta}` : prefix;
}
