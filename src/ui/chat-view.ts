import { ItemView, WorkspaceLeaf } from 'obsidian';
import {
	CHAT_VIEW_ICON,
	CHAT_VIEW_TITLE,
	NARROW_BREAKPOINT_PX,
	VIEW_TYPE_GUKI_CHAT,
} from '../constants';
import type { SessionManager } from '../core/session-manager';
import { Composer } from './composer';
import { MessageList } from './message-list';

export class ChatView extends ItemView {
	private rootEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private pendingMeasure: number | null = null;
	private messageList: MessageList | null = null;
	private unsubscribe: (() => void) | null = null;

	/**
	 * The session lives on the plugin, not here: the subprocess and the transcript must survive
	 * the panel being closed and reopened.
	 */
	constructor(leaf: WorkspaceLeaf, private readonly session: SessionManager) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_GUKI_CHAT;
	}

	getDisplayText(): string {
		return CHAT_VIEW_TITLE;
	}

	getIcon(): string {
		return CHAT_VIEW_ICON;
	}

	protected async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('guki-chat-content');

		const root = this.contentEl.createDiv({ cls: 'guki-root' });
		this.rootEl = root;

		const messages = root.createDiv({ cls: 'guki-messages' });
		this.messageList = new MessageList(this.app, messages, this);

		const footer = root.createDiv({ cls: 'guki-footer' });
		// Not kept as a field: nothing focuses or clears it from outside, and auto-focusing on
		// open would steal focus from the editor when the panel is restored at startup.
		new Composer(footer, this, {
			onSubmit: (text: string) => {
				this.session.send(text);
				return true;
			},
		});

		// The state is the single source of truth, so a reopened panel re-renders the whole
		// conversation from it rather than starting empty.
		this.unsubscribe = this.session.state.subscribe(() => this.syncMessages());
		this.syncMessages();
		this.messageList.scrollToBottom();

		this.observeWidth(root);

		// `pinned-change` is a WorkspaceLeaf event, not a Workspace one (obsidian.d.ts:7369).
		// Registering it on the view means it is released when the leaf goes away.
		this.registerEvent(
			this.leaf.on('pinned-change', (pinned: boolean) => {
				// Only react to losing the pin; calling setPinned(true) unconditionally
				// would re-fire this event and loop.
				if (!pinned) {
					this.leaf.setPinned(true);
				}
			}),
		);
	}

	protected async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.messageList = null;

		// A ResizeObserver is not covered by Component.register*, so disconnect it by hand.
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.pendingMeasure !== null) {
			window.cancelAnimationFrame(this.pendingMeasure);
			this.pendingMeasure = null;
		}
		this.rootEl = null;
		this.contentEl.empty();
	}

	private syncMessages(): void {
		this.messageList?.sync(this.session.state.items);
	}

	/**
	 * Called by Obsidian when the view's size changes, including when the leaf is moved
	 * between the main area and a sidebar (obsidian.d.ts:6715).
	 */
	onResize(): void {
		this.refreshWidthClass();
	}

	/**
	 * Toggles `.guki-narrow` from the panel's own width. There is no event for a panel
	 * being dragged between the main area and a sidebar; width is the signal (RESEARCH A).
	 *
	 * The ResizeObserver alone misses that move — dragging a leaf detaches and re-inserts
	 * the element, and the observer reports nothing until the next real resize (measured by
	 * hand 2026-08-28: the panel stayed `.guki-narrow` back in the main area until the
	 * window was nudged). So `onResize()` and `layout-change` re-measure as well.
	 * `applyWidthClass` is idempotent, so the three sources overlapping is harmless.
	 */
	private observeWidth(target: HTMLElement): void {
		this.applyWidthClass(target.clientWidth);
		this.resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				this.applyWidthClass(entry.contentRect.width);
			}
		});
		this.resizeObserver.observe(target);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.refreshWidthClass()),
		);
	}

	/**
	 * Re-measures the panel and re-applies the width class. Deferred by one frame: right
	 * after a move the element is re-attached but not laid out yet, so an immediate
	 * `clientWidth` still reports the old pane's width.
	 */
	private refreshWidthClass(): void {
		if (this.pendingMeasure !== null) {
			return;
		}
		this.pendingMeasure = window.requestAnimationFrame(() => {
			this.pendingMeasure = null;
			if (this.rootEl) {
				this.applyWidthClass(this.rootEl.clientWidth);
			}
		});
	}

	private applyWidthClass(width: number): void {
		if (!this.rootEl || width === 0) {
			return;
		}
		this.rootEl.toggleClass('guki-narrow', width < NARROW_BREAKPOINT_PX);
		this.rootEl.toggleClass('guki-wide', width >= NARROW_BREAKPOINT_PX);
	}
}
