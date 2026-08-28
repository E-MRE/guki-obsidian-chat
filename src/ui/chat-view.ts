import { ItemView, WorkspaceLeaf } from 'obsidian';
import {
	CHAT_VIEW_ICON,
	CHAT_VIEW_TITLE,
	NARROW_BREAKPOINT_PX,
	VIEW_TYPE_GUKI_CHAT,
} from '../constants';

export class ChatView extends ItemView {
	private rootEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf) {
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
		messages.createDiv({
			cls: 'guki-placeholder',
			text: 'GuKi Chat is not connected yet.',
		});

		root.createDiv({
			cls: 'guki-footer',
			text: 'Composer arrives in a later phase.',
		});

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
		// A ResizeObserver is not covered by Component.register*, so disconnect it by hand.
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.rootEl = null;
		this.contentEl.empty();
	}

	/**
	 * Toggles `.guki-narrow` from the panel's own width. There is no event for a panel
	 * being dragged between the main area and a sidebar; width is the signal (RESEARCH A).
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
	}

	private applyWidthClass(width: number): void {
		if (!this.rootEl || width === 0) {
			return;
		}
		this.rootEl.toggleClass('guki-narrow', width < NARROW_BREAKPOINT_PX);
		this.rootEl.toggleClass('guki-wide', width >= NARROW_BREAKPOINT_PX);
	}
}
