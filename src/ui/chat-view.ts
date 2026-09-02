import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import {
	CHAT_VIEW_ICON,
	CHAT_VIEW_TITLE,
	NARROW_BREAKPOINT_PX,
	VIEW_TYPE_GUKI_CHAT,
} from '../constants';
import {
	activeVaultFile,
	droppedVaultFiles,
	resolveVaultFile,
} from '../core/attachment-resolver';
import type { Attachment } from '../core/attachments';
import type { SessionManager } from '../core/session-manager';
import { Composer } from './composer';
import { MessageList } from './message-list';

export class ChatView extends ItemView {
	private rootEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private pendingMeasure: number | null = null;
	private messageList: MessageList | null = null;
	private composer: Composer | null = null;
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

		// A positioned wrapper, not the scroller itself: the jump-to-bottom button has to stay put
		// while the content behind it scrolls, so it cannot live inside the scrolling element.
		const messages = root.createDiv({ cls: 'guki-messages-wrap' });
		this.messageList = new MessageList(this.app, messages, this, {
			// The view never decides a permission itself; it hands the request id back to the
			// session, which owns the broker holding the pending JSON-RPC call.
			decide: (requestId, behavior) => {
				this.session.decidePermission(requestId, behavior);
			},
		});

		const footer = root.createDiv({ cls: 'guki-footer' });
		// Kept as a field now: the Send/Stop swap is driven from the session state.
		this.composer = new Composer(footer, this, {
			onSubmit: (text: string, attachments: readonly Attachment[]) => {
				this.session.send(text, attachments);
				return true;
			},
			onStop: () => {
				this.session.interrupt();
			},
			// `dataTransfer` is read here and now — it is only valid during the drop event, so
			// the vault files come out synchronously and only the boundary check is deferred.
			onDropped: (dataTransfer: DataTransfer | null) => {
				const files = droppedVaultFiles(this.app, dataTransfer);
				if (files.length === 0) {
					// Nothing in the drop was a vault file. A file dragged in from Finder lands
					// here too, and that is task 2's — saying so is better than doing nothing,
					// which reads as the panel being broken.
					new Notice('Only files from this vault can be attached.');
					return;
				}
				void this.attachFiles(files);
			},
			onAttachActiveNote: () => {
				const file = activeVaultFile(this.app);
				if (!file) {
					new Notice('No active note to attach.');
					return;
				}
				void this.attachFiles([file]);
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
		this.composer = null;

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

	/**
	 * Verifies each file against the vault boundary and adds the chips that pass.
	 *
	 * **The check is here, on the way in, and it is the only thing that authorises an `@`.** A chip
	 * exists only for a path that resolved inside the vault, so `composeMessage` can never be handed
	 * an out-of-vault path to `@`-reference — which would silently disable all of Phase 5b for that
	 * file (PLAN's Phase 6 syntax table).
	 *
	 * Async because the resolver is built from Node's `fs` on first use. The refusal is a Notice
	 * rather than silence: a note that is a symlink out of the vault looks like any other note in
	 * the file explorer, so a chip that just fails to appear is indistinguishable from a bug.
	 */
	private async attachFiles(files: readonly TFile[]): Promise<void> {
		const paths = await this.session.vaultPaths();
		const refused: string[] = [];

		for (const file of files) {
			const attachment = resolveVaultFile(this.app, paths, file);
			if (!attachment) {
				refused.push(file.name);
				continue;
			}
			// The composer may have gone away while this was resolving — the panel can be closed
			// mid-drop, and `onClose` drops the reference.
			this.composer?.attach(attachment);
		}

		if (refused.length > 0) {
			new Notice(
				`Could not attach ${refused.join(', ')} — it does not resolve inside the vault.`,
			);
		}
	}

	private syncMessages(): void {
		this.messageList?.sync(this.session.state.items);
		this.composer?.setBusy(this.session.busy);
		this.composer?.setBlocked(this.session.blocked);
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
