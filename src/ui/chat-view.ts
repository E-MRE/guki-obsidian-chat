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
	externalFilePaths,
	readImageAttachment,
	resolveExternalFile,
	resolveVaultFile,
	triageImageFiles,
	type ExternalFile,
	type ImageTriage,
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
			// both payloads come out synchronously and only the resolution is deferred.
			onDropped: (dataTransfer: DataTransfer | null) => {
				const vaultFiles = droppedVaultFiles(this.app, dataTransfer);
				if (vaultFiles.length > 0) {
					void this.attachFiles(vaultFiles);
					return;
				}
				// Obsidian's own drag carries no `File`, and a Finder drag carries no
				// `dragManager.draggable` and no `obsidian://` URL, so these two never overlap.
				const external = externalFilePaths(dataTransfer?.files);
				if (external.length > 0) {
					void this.attachExternalFiles(external);
					return;
				}
				// Files with no path: an image dragged out of a web page, which has no file behind
				// it. Rarer than it looks — a screenshot dragged from macOS's bottom-right
				// thumbnail is a real file in `/private/var/…` and went through the branch above.
				const triage = triageImageFiles(dataTransfer?.files);
				if (triage.images.length > 0 || triage.unsupported.length > 0) {
					void this.attachImages(triage);
					return;
				}
				if ((dataTransfer?.files.length ?? 0) > 0) {
					// There were files, but no path and not an image either — so neither door
					// claims them. Left silent, which is what task 2 did with every path-less
					// `File`: the notice below would say "no file" and there plainly was one.
					return;
				}
				// Dragging a tab header lands here, and so does dragged text or a link — there is
				// no file in any of them. Saying so beats doing nothing, which reads as a bug.
				new Notice('Nothing to attach — that drop contained no file.');
			},
			// Returns whether the paste was taken, which is what suppresses the textarea's own
			// handling. A file copied in Finder arrives exactly as a dropped one does.
			/*
			 * **The return value is the whole subtlety here.** It is what calls
			 * `preventDefault()`, so it has to be synchronous, and it has to be `false` for an
			 * ordinary text paste or the textarea stops receiving typed-in text — a regression
			 * Emre tested by hand in task 2 (step 7, pasting the word "fenerbahçe").
			 *
			 * Both doors are consulted, and both payloads can arrive in one paste, so neither
			 * `return`s early: a file copied in Finder is a path chip, a clipboard bitmap is bytes.
			 * Plain text produces no `files` at all and falls through to `false`.
			 */
			onPasted: (clipboardData: DataTransfer | null): boolean => {
				const external = externalFilePaths(clipboardData?.files);
				const triage = triageImageFiles(clipboardData?.files);
				const takingImages = triage.images.length > 0 || triage.unsupported.length > 0;
				if (external.length === 0 && !takingImages) {
					// Ordinary text. This paste is not ours and the textarea must still get it.
					return false;
				}
				if (external.length > 0) {
					void this.attachExternalFiles(external);
				}
				if (takingImages) {
					void this.attachImages(triage);
				}
				return true;
			},
			onAttachActiveNote: () => {
				const file = activeVaultFile(this.app);
				if (!file) {
					new Notice('No active note to attach.');
					return;
				}
				void this.attachFiles([file]);
			},
			onPickedFiles: (files: FileList | null) => {
				const external = externalFilePaths(files);
				if (external.length === 0) {
					// Unlike the drop and the paste, silence here would be wrong. A file chosen
					// from a file dialog is on disk by definition, so "no path" cannot be a
					// clipboard image — it can only be the path resolution failing, and a button
					// that does nothing is the failure mode this project keeps finding by hand.
					if (files && files.length > 0) {
						new Notice('Could not read a filesystem path for the chosen file.');
					}
					return;
				}
				void this.attachExternalFiles(external);
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

	/**
	 * The same thing for files that arrived from outside Obsidian — a Finder drag, a paste, or the
	 * picker. One method for all three, because they differ only in how the `File` was obtained.
	 *
	 * **The vault boundary is not a filter here, it is a question**: `resolveExternalFile` answers
	 * `in-vault` or `outside-vault` from the resolved path, and both are chips. A file that happens
	 * to live in the vault gets an `@` reference; anything else gets a plain path, which makes the
	 * model call `Read` and puts it through §2b — a card per file, and cards are allowed to queue
	 * (PLAN §5 decision 11).
	 *
	 * The two refusals are reported separately. A folder is a mistake the reader can correct by
	 * dropping its contents instead, so the notice says which one it was; anything else went away
	 * underneath us.
	 */
	private async attachExternalFiles(files: readonly ExternalFile[]): Promise<void> {
		const paths = await this.session.vaultPaths();
		const folders: string[] = [];
		const lost: string[] = [];

		for (const file of files) {
			const resolution = await resolveExternalFile(paths, file);
			if (resolution.kind === 'attached') {
				// The composer may have gone away while this was resolving — the panel can be
				// closed mid-drop, and `onClose` drops the reference.
				this.composer?.attach(resolution.attachment);
				continue;
			}
			(resolution.reason === 'directory' ? folders : lost).push(resolution.displayName);
		}

		if (folders.length > 0) {
			new Notice(
				`Cannot attach the folder ${folders.join(', ')} — attach the files inside it.`,
			);
		}
		if (lost.length > 0) {
			new Notice(`Could not attach ${lost.join(', ')} — that path no longer resolves.`);
		}
	}

	/**
	 * The third door: `File`s that have no path, which is a bitmap living only in the clipboard.
	 *
	 * **Nothing here goes near the permission policy, and that is not an omission.** A path chip
	 * makes the model call `Read`, which is what PLAN §2b gates; bytes are handed straight to the
	 * model with no tool call at all, so there is nothing for a card to authorise. This is also why
	 * it must stay scoped to images — a general "send any file as bytes" route would be a fifth
	 * silent bypass of the whole of Phase 5b.
	 *
	 * Refusals are reported, unlike task 2's silent pass-over of a path-less `File`: by the time we
	 * are here the reader has deliberately pasted a picture, and the alternative to a notice is a
	 * turn that costs money and comes back with the model saying it could not see it (§M3).
	 */
	private async attachImages(triage: ImageTriage): Promise<void> {
		const unreadable: string[] = [];

		for (const file of triage.images) {
			const attachment = await readImageAttachment(file);
			if (!attachment) {
				unreadable.push(file.name);
				continue;
			}
			// The composer may have gone away while the bytes were being read — the panel can be
			// closed mid-paste, and `onClose` drops the reference.
			this.composer?.attach(attachment);
		}

		if (triage.unsupported.length > 0) {
			const named = triage.unsupported
				.map((image) => `${image.displayName} (${image.mediaType})`)
				.join(', ');
			new Notice(
				`Cannot attach ${named} — only PNG, JPEG, GIF and WebP images can be sent.`,
			);
		}
		if (unreadable.length > 0) {
			new Notice(`Could not read ${unreadable.join(', ')} — the image data was unavailable.`);
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
