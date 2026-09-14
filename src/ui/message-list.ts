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
	statusText,
	type PermissionActions,
	type RenderedPermissionCard,
} from './permission-card';
import { toolSummary } from '../core/tool-policy';
import { formatAskUserQuestionSummary } from '../core/ask-user-question';
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

interface RenderedWorkGroup {
	groupEl: HTMLElement;
	headerEl: HTMLButtonElement;
	contentEl: HTMLElement;
	expanded: boolean;
	headerText: string;
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
	/** Resolved permission items: tracks expansion of the summary row. */
	permExpanded?: boolean;
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
	/**
	 * Assistant items only: holds the collapsible intermediate work group.
	 * Only created when the turn is complete and there is at least one work block.
	 */
	workGroup?: RenderedWorkGroup;
}

/** How long the icon shows "copied" before reverting — long enough to register, not a toast. */
const COPY_FEEDBACK_MS = 1500;

export class MessageList {
	private readonly rendered = new Map<string, RenderedItem>();
	private readonly scrollEl: HTMLElement;
	private readonly jumpEl: HTMLElement;
	/** True when content arrived while the reader was scrolled away from the bottom. */
	private missedContent = false;
	/** When true, sync() does not scroll to bottom even if previously at bottom (used during prepend). */
	private suppressScrollToBottom = false;

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

		// Process non-permission items first so that assistant messages and their blocks
		// exist in this.rendered before attaching permission summaries to tool blocks.
		const regularItems = items.filter((it) => it.kind !== 'permission');
		const permissionItems = items.filter((it) => it.kind === 'permission');

		for (const item of regularItems) {
			seen.add(item.id);
			const existing = this.rendered.get(item.id);
			const entry = existing ?? this.createItem(item);
			if (!existing) {
				this.placeItemInOrder(item, entry.el, items);
			}
			changed = this.updateItem(item, entry) || !existing || changed;
		}

		for (const item of permissionItems) {
			// Permission cards mount in the composer slot while pending.
			// Resolved requests leave a summary row in the transcript.
			if (item.status === 'pending') {
				continue;
			}
			seen.add(item.id);
			const existing = this.rendered.get(item.id);
			const toolBlockEl = this.findToolBlock(items, item.toolUseId);
			const entry = existing ?? this.createItem(item, toolBlockEl ?? this.scrollEl);
			if (!existing && !toolBlockEl) {
				this.placeItemInOrder(item, entry.el, items);
			}
			if (existing && toolBlockEl && entry.el.parentElement !== toolBlockEl) {
				toolBlockEl.appendChild(entry.el);
				changed = true;
			}
			changed = this.updateItem(item, entry) || !existing || changed;
		}

		for (const [id, entry] of this.rendered) {
			if (!seen.has(id)) {
				entry.el.remove();
				this.rendered.delete(id);
				changed = true;
			}
		}

		if (wasAtBottom && !this.suppressScrollToBottom) {
			this.scrollToBottom();
		} else if (changed) {
			this.missedContent = true;
		}
		this.updateJumpButton();
	}

	private findToolBlock(items: readonly ChatItem[], toolUseId: string | undefined): HTMLElement | null {
		if (!toolUseId) {
			return null;
		}
		for (const item of items) {
			if (item.kind !== 'assistant') {
				continue;
			}
			for (const [index, block] of item.blocks) {
				if (block.toolUseId === toolUseId) {
					const asstEntry = this.rendered.get(item.id);
					const blockEntry = asstEntry?.blocks.get(index);
					if (blockEntry) {
						return blockEntry.el;
					}
				}
			}
		}
		return null;
	}

	private createItem(item: ChatItem, parentEl: HTMLElement = this.scrollEl): RenderedItem {
		if (item.kind === 'divider') {
			const el = parentEl.createDiv({ cls: 'guki-message guki-message-divider' });
			el.createSpan({ cls: 'guki-divider-label', text: item.text });
			const entry: RenderedItem = {
				el,
				bodyEl: el,
				metaEl: el,
				renderedText: item.text,
				status: '',
				blocks: new Map(),
			};
			this.rendered.set(item.id, entry);
			return entry;
		}

		const el = parentEl.createDiv({ cls: `guki-message guki-message-${item.kind}` });
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

	private placeItemInOrder(item: ChatItem, el: HTMLElement, items: readonly ChatItem[]): void {
		const idx = items.findIndex((it) => it.id === item.id);
		if (idx === -1) {
			return;
		}
		for (let i = idx + 1; i < items.length; i++) {
			const next = this.rendered.get(items[i]!.id);
			if (next) {
				this.scrollEl.insertBefore(el, next.el);
				return;
			}
		}
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
			case 'divider':
				return false;
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
		changed = this.syncWorkGroup(item, entry) || changed;

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
				const parentEl = other.el.parentElement ?? entry.bodyEl;
				parentEl.insertBefore(el, other.el);
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

	/**
	 * When an assistant turn completes, groups intermediate work blocks into a collapsible container.
	 * Trailing contiguous text blocks form the answer and remain outside the group.
	 */
	private syncWorkGroup(item: AssistantItem, entry: RenderedItem): boolean {
		if (item.status !== 'complete') {
			if (entry.workGroup) {
				for (const block of orderedBlocks(item)) {
					const rendered = entry.blocks.get(block.index);
					if (rendered && rendered.el.parentElement !== entry.bodyEl) {
						entry.bodyEl.insertBefore(rendered.el, entry.workGroup.groupEl);
					}
				}
				entry.workGroup.groupEl.remove();
				entry.workGroup = undefined;
				return true;
			}
			return false;
		}

		// Partition: trailing contiguous run of 'text' blocks is answer; everything before is work.
		const blocks = orderedBlocks(item);
		let answerStartIndex = blocks.length;
		while (answerStartIndex > 0 && blocks[answerStartIndex - 1]?.kind === 'text') {
			answerStartIndex--;
		}
		const workBlocks = blocks.slice(0, answerStartIndex);
		const answerBlocks = blocks.slice(answerStartIndex);

		// Threshold: if zero work blocks, create no group at all.
		if (workBlocks.length === 0) {
			if (entry.workGroup) {
				for (const block of orderedBlocks(item)) {
					const rendered = entry.blocks.get(block.index);
					if (rendered && rendered.el.parentElement !== entry.bodyEl) {
						entry.bodyEl.insertBefore(rendered.el, entry.workGroup.groupEl);
					}
				}
				entry.workGroup.groupEl.remove();
				entry.workGroup = undefined;
				return true;
			}
			return false;
		}

		let changed = false;
		const headerText = formatWorkDuration(item.meta?.durationMs);

		if (!entry.workGroup) {
			const groupEl = entry.bodyEl.createDiv({ cls: 'guki-work-group' });
			const headerEl = groupEl.createEl('button', {
				cls: 'guki-work-header',
				attr: { 'type': 'button', 'aria-expanded': 'false' },
			});
			headerEl.setAttribute('aria-expanded', 'false');
			headerEl.setText(headerText);
			const contentEl = groupEl.createDiv({ cls: 'guki-work-content' });
			contentEl.hide();

			const workGroup: RenderedWorkGroup = {
				groupEl,
				headerEl,
				contentEl,
				expanded: false,
				headerText,
			};
			entry.workGroup = workGroup;

			this.component.registerDomEvent(headerEl, 'click', () => {
				workGroup.expanded = !workGroup.expanded;
				headerEl.setAttribute('aria-expanded', String(workGroup.expanded));
				groupEl.toggleClass('guki-work-open', workGroup.expanded);
				if (workGroup.expanded) {
					contentEl.show();
				} else {
					contentEl.hide();
				}
			});
			changed = true;
		} else {
			if (entry.workGroup.headerText !== headerText) {
				entry.workGroup.headerEl.setText(headerText);
				entry.workGroup.headerText = headerText;
				changed = true;
			}
		}

		const workGroup = entry.workGroup;

		const workEls: HTMLElement[] = [];
		for (const block of workBlocks) {
			const rendered = entry.blocks.get(block.index);
			if (rendered) {
				workEls.push(rendered.el);
			}
		}

		const answerEls: HTMLElement[] = [];
		for (const block of answerBlocks) {
			const rendered = entry.blocks.get(block.index);
			if (rendered) {
				answerEls.push(rendered.el);
			}
		}

		// Move any answer blocks sitting inside contentEl out to entry.bodyEl
		for (const el of answerEls) {
			if (el.parentElement === workGroup.contentEl) {
				entry.bodyEl.appendChild(el);
				changed = true;
			}
		}

		// Reconcile work blocks into contentEl in slot order
		for (let i = workEls.length - 1; i >= 0; i--) {
			const el = workEls[i];
			if (!el) {
				continue;
			}
			const nextEl = workEls[i + 1] ?? null;
			if (el.parentElement !== workGroup.contentEl || el.nextSibling !== nextEl) {
				workGroup.contentEl.insertBefore(el, nextEl);
				changed = true;
			}
		}

		// Reconcile bodyEl: groupEl followed by answer blocks in slot order
		const bodyExpected = [workGroup.groupEl, ...answerEls];
		for (let i = bodyExpected.length - 1; i >= 0; i--) {
			const el = bodyExpected[i];
			if (!el) {
				continue;
			}
			const nextEl = bodyExpected[i + 1] ?? null;
			if (el.parentElement !== entry.bodyEl || el.nextSibling !== nextEl) {
				entry.bodyEl.insertBefore(el, nextEl);
				changed = true;
			}
		}

		return changed;
	}

	// --- permission requests -------------------------------------------------

	/**
	 * Renders a resolved permission summary row in the transcript.
	 * While pending, the card is in the composer slot.
	 * Once resolved (allowed, denied, cancelled), it renders a one-line summary that expands on click.
	 */
	private updatePermission(item: PermissionItem, entry: RenderedItem): boolean {
		if (item.status === 'pending') {
			entry.el.hide();
			return false;
		}

		entry.el.show();
		const key = `${item.status}:${item.toolName}:${JSON.stringify(item.answers ?? '')}:${JSON.stringify(item.askQuestions ?? '')}`;
		if (entry.status === key) {
			return false;
		}
		entry.status = key;
		entry.bodyEl.empty();
		entry.metaEl.empty();

		const containerEl = entry.bodyEl.createDiv({ cls: 'guki-perm-summary-block' });
		containerEl.toggleClass('guki-perm-summary-allowed', item.status === 'allowed');
		containerEl.toggleClass('guki-perm-summary-denied', item.status === 'denied');
		containerEl.toggleClass('guki-perm-summary-cancelled', item.status === 'cancelled');
		containerEl.toggleClass('guki-perm-summary-open', Boolean(entry.permExpanded));

		const headerEl = containerEl.createEl('button', { cls: 'guki-perm-summary-header' });

		// Build one-line collapsed summary text
		let headerText = '';
		if (item.toolName === 'AskUserQuestion') {
			headerText = formatAskUserQuestionSummary(item.askQuestions, item.answers, item.status);
		} else {
			const target = toolSummary(item.toolName, item.input);
			const targetStr = target.length > 0 ? `: ${target}` : '';
			let decisionStr = '';
			if (item.status === 'allowed') {
				decisionStr = 'Allowed';
			} else if (item.status === 'denied') {
				decisionStr = 'Denied';
			} else {
				decisionStr = 'Not answered (turn ended)';
			}
			headerText = `Approval: ${item.toolName}${targetStr} → ${decisionStr}`;
		}

		headerEl.setText(headerText);

		const contentEl = containerEl.createDiv({ cls: 'guki-perm-summary-content' });
		if (!entry.permExpanded) {
			contentEl.hide();
		}

		this.component.registerDomEvent(headerEl, 'click', () => {
			entry.permExpanded = !entry.permExpanded;
			containerEl.toggleClass('guki-perm-summary-open', Boolean(entry.permExpanded));
			if (entry.permExpanded) {
				contentEl.show();
			} else {
				contentEl.hide();
			}
		});

		// Build expanded content
		if (item.toolName === 'AskUserQuestion') {
			if (item.askQuestions && item.askQuestions.length > 0) {
				item.askQuestions.forEach((q, idx) => {
					const qEl = contentEl.createDiv({ cls: 'guki-perm-summary-question' });
					const qTitleEl = qEl.createDiv({ cls: 'guki-perm-summary-qtitle' });
					const qLabel = item.askQuestions!.length > 1 ? `Question ${idx + 1}: ${q.question}` : q.question;
					qTitleEl.setText(q.header ? `${q.header}: ${qLabel}` : qLabel);

					const optionsListEl = qEl.createDiv({ cls: 'guki-perm-summary-qoptions' });
					const answerVal = item.answers
						? item.answers[String(idx)] ?? (q.id ? item.answers[q.id] : undefined) ?? item.answers[q.question]
						: undefined;
					const chosenArr = Array.isArray(answerVal)
						? answerVal
						: typeof answerVal === 'string'
							? [answerVal]
							: [];

					if (q.options && q.options.length > 0) {
						for (const opt of q.options) {
							const optEl = optionsListEl.createDiv({ cls: 'guki-perm-summary-option' });
							const isChosen =
								item.status === 'allowed' &&
								(chosenArr.includes(opt.value) || chosenArr.includes(opt.label));
							optEl.toggleClass('is-selected', isChosen);
							const prefix = isChosen ? '✓ ' : '○ ';
							const desc = opt.description ? ` — ${opt.description}` : '';
							optEl.setText(`${prefix}${opt.label}${desc}`);
						}
					}

					const knownValues = new Set((q.options ?? []).flatMap((o) => [o.value, o.label]));
					const customAnswers = chosenArr.filter((v) => !knownValues.has(v));
					if (q.isOther || customAnswers.length > 0) {
						const otherEl = optionsListEl.createDiv({ cls: 'guki-perm-summary-option' });
						if (customAnswers.length > 0 && item.status === 'allowed') {
							otherEl.addClass('is-selected');
							otherEl.setText(`✓ Other: "${customAnswers.join(', ')}"`);
						} else {
							const bullet = '○ ';
							otherEl.setText(`${bullet}Other`);
						}
					}

					if (item.status !== 'allowed') {
						const outcomeEl = qEl.createDiv({ cls: 'guki-perm-summary-outcome' });
						outcomeEl.setText(statusText(item.status));
					}
				});
			} else {
				const malformedEl = contentEl.createDiv({ cls: 'guki-perm-summary-malformed' });
				malformedEl.setText('Question details unavailable.');
				const outcomeEl = contentEl.createDiv({ cls: 'guki-perm-summary-outcome' });
				outcomeEl.setText(statusText(item.status));
			}
		} else {
			const detailEl = contentEl.createDiv({ cls: 'guki-perm-summary-details' });

			const toolRow = detailEl.createDiv({ cls: 'guki-perm-summary-detail-row' });
			toolRow.createSpan({ cls: 'guki-perm-summary-detail-label', text: 'Tool:' });
			toolRow.createSpan({ cls: 'guki-perm-summary-detail-value', text: item.toolName });

			const target = toolSummary(item.toolName, item.input);
			if (target.length > 0) {
				const targetRow = detailEl.createDiv({ cls: 'guki-perm-summary-detail-row' });
				targetRow.createSpan({ cls: 'guki-perm-summary-detail-label', text: 'Target:' });
				targetRow.createSpan({ cls: 'guki-perm-summary-detail-value', text: target });
			}

			if (typeof item.input === 'object' && item.input !== null) {
				const inputObj = item.input as Record<string, unknown>;
				const fullTarget = inputObj.file_path ?? inputObj.path ?? inputObj.command;
				if (typeof fullTarget === 'string' && fullTarget !== target) {
					const fullRow = detailEl.createDiv({ cls: 'guki-perm-summary-detail-row' });
					fullRow.createSpan({ cls: 'guki-perm-summary-detail-label', text: 'Full target:' });
					fullRow.createSpan({ cls: 'guki-perm-summary-detail-value', text: fullTarget });
				}
			}

			const decisionRow = detailEl.createDiv({ cls: 'guki-perm-summary-detail-row' });
			decisionRow.createSpan({ cls: 'guki-perm-summary-detail-label', text: 'Decision:' });
			decisionRow.createSpan({ cls: 'guki-perm-summary-detail-value', text: statusText(item.status) });
		}

		return true;
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

	getScrollEl(): HTMLElement {
		return this.scrollEl;
	}

	getFirstMessageEl(): HTMLElement | null {
		return this.scrollEl.querySelector('.guki-message');
	}

	setSuppressScrollToBottom(suppress: boolean): void {
		this.suppressScrollToBottom = suppress;
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

/**
 * Header text for the completed turn's intermediate work group:
 * "Worked for MM:SS" derived from item.meta.durationMs (zero-padded seconds, minutes not padded).
 * If durationMs is missing or not a finite number, returns "Worked".
 */
export function formatWorkDuration(durationMs?: number): string {
	if (durationMs === undefined || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
		return 'Worked';
	}
	const totalSeconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `Worked for ${minutes}:${String(seconds).padStart(2, '0')}`;
}

