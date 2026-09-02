/**
 * The input row: attachment chips, two attach controls, a textarea and a send button.
 *
 * Enter sends, Shift+Enter inserts a newline, and that is the only key behaviour there is — no
 * other shortcut, by closed decision #3. The chat is not a terminal.
 *
 * The composer stays presentational about attachments: it holds the chips and renders them, but it
 * never resolves a path or decides whether a file may be attached. It hands the drop, the paste,
 * the picked files and the attach control to the view, which owns the vault-boundary check, and the
 * view calls `attach`. That keeps the security decision in `core/` and out of a DOM file — and it
 * is why all four affordances arrive here as raw payloads and leave as one `Attachment`.
 */
import { setIcon, type Component } from 'obsidian';
import { addAttachment, hasSendableContent, type Attachment } from '../core/attachments';

export interface ComposerOptions {
	/**
	 * Called with the trimmed text and the chips. The composer clears itself — text *and* chips —
	 * only if this returns true.
	 */
	onSubmit(text: string, attachments: readonly Attachment[]): boolean;
	/** Called when the button is in its Stop state (RESEARCH B4's `interrupt` control request). */
	onStop(): void;
	/**
	 * Something was dropped on the composer. The view resolves it against the vault and calls
	 * `attach` for whatever survived the check; the composer does not inspect the payload.
	 */
	onDropped(dataTransfer: DataTransfer | null): void;
	/**
	 * Something was pasted. **Returns whether it was taken as an attachment**, and the composer
	 * calls `preventDefault()` only then — so an ordinary text paste still reaches the textarea,
	 * and a pasted clipboard *image* (a `File` with no path, PLAN Phase 6 task 3) is left entirely
	 * alone rather than being swallowed by a handler that does nothing with it.
	 *
	 * The decision has to be synchronous, because `preventDefault()` is: the view answers from
	 * whether any path came out of `clipboardData.files`, and resolves those paths afterwards.
	 */
	onPasted(clipboardData: DataTransfer | null): boolean;
	/** The attach control was pressed. The view resolves the active note and calls `attach`. */
	onAttachActiveNote(): void;
	/**
	 * Files were chosen in the picker. Same payload shape as a drop, and the view treats them
	 * identically — the picker is a third affordance over one code path, not a third code path.
	 */
	onPickedFiles(files: FileList | null): void;
}

const DEFAULT_PLACEHOLDER = 'Message GuKi… (Enter to send, Shift+Enter for a new line)';

export class Composer {
	private readonly chipsEl: HTMLElement;
	private readonly inputEl: HTMLTextAreaElement;
	private readonly actionEl: HTMLButtonElement;
	private readonly attachEl: HTMLButtonElement;
	private readonly pickEl: HTMLButtonElement;
	private readonly fileInputEl: HTMLInputElement;
	private busy = false;
	/** Non-null when the panel is refusing input; the text is shown in place of the placeholder. */
	private blocked: string | null = null;
	private attachments: Attachment[] = [];
	/**
	 * Nested `dragenter`/`dragleave` pairs fire as the pointer crosses child elements, so a plain
	 * add-on-enter/remove-on-leave would flicker the highlight off while the file is still over the
	 * composer. Counting them is the standard fix.
	 */
	private dragDepth = 0;

	constructor(
		containerEl: HTMLElement,
		/** The view, so the key handler is detached with it. */
		component: Component,
		private readonly options: ComposerOptions,
	) {
		const form = containerEl.createDiv({ cls: 'guki-composer' });

		// Above the textarea, so the chips read as belonging to the message being written rather
		// than to the conversation above it.
		this.chipsEl = form.createDiv({ cls: 'guki-composer-chips' });

		/*
		 * The picker's input, created once and reused.
		 *
		 * Obsidian's own `editor:attach-file` command builds a throwaway input on
		 * `activeDocument.body` and then has to detach it again — including on a *cancelled* pick,
		 * which fires no `change` event, so it watches the document for focus/click and removes the
		 * element five seconds later (measured in `app.js`, 1.13.7, byte 3,854,690). None of that
		 * is needed for one input that lives in the composer's own form and dies with the view:
		 * `value` is cleared before each `click()` so re-picking the same file still fires `change`,
		 * and a cancelled pick leaves nothing behind.
		 */
		this.fileInputEl = form.createEl('input', {
			cls: 'guki-composer-file-input',
			attr: { type: 'file', multiple: 'multiple', tabindex: '-1', 'aria-hidden': 'true' },
		});

		const row = form.createDiv({ cls: 'guki-composer-row' });

		/*
		 * Two attach controls, not one button behind a menu. They are two different actions —
		 * "attach the note I am looking at" and "attach a file from disk" — and this panel's
		 * product boundary is "better conversation" (PLAN §5 decision 12), so the common path does
		 * not get to cost an extra click.
		 *
		 * The paperclip is Obsidian's own icon for attaching a file (`editor:attach-file` uses
		 * `lucide-paperclip`), so the meaning is borrowed rather than invented.
		 */
		this.pickEl = row.createEl('button', {
			cls: 'guki-composer-attach',
			attr: { 'aria-label': 'Attach files from disk' },
		});
		setIcon(this.pickEl, 'paperclip');

		this.attachEl = row.createEl('button', {
			cls: 'guki-composer-attach',
			attr: { 'aria-label': 'Attach the active note' },
		});
		setIcon(this.attachEl, 'file-plus');

		this.inputEl = row.createEl('textarea', {
			cls: 'guki-composer-input',
			attr: {
				rows: '3',
				placeholder: DEFAULT_PLACEHOLDER,
			},
		});

		this.actionEl = row.createEl('button', {
			cls: 'guki-composer-send',
			text: 'Send',
		});

		component.registerDomEvent(this.inputEl, 'keydown', (event: KeyboardEvent) => {
			// isComposing: mid-IME-composition Enter belongs to the input method, not to us.
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}
			event.preventDefault();
			// Enter always sends, even mid-turn: the message queues behind the running one. Only
			// the button stops, so a stray Enter can never throw away a reply in progress.
			this.submit();
		});

		component.registerDomEvent(this.actionEl, 'click', () => {
			if (this.busy) {
				this.options.onStop();
				return;
			}
			this.submit();
		});

		component.registerDomEvent(this.attachEl, 'click', () => {
			if (this.blocked !== null) {
				return;
			}
			this.options.onAttachActiveNote();
		});

		component.registerDomEvent(this.pickEl, 'click', () => {
			if (this.blocked !== null) {
				return;
			}
			// Cleared first: picking the same file twice in a row is not a `change` otherwise, and
			// the second pick would silently do nothing.
			this.fileInputEl.value = '';
			this.fileInputEl.click();
		});

		component.registerDomEvent(this.fileInputEl, 'change', () => {
			if (this.blocked !== null) {
				return;
			}
			this.options.onPickedFiles(this.fileInputEl.files);
		});

		/*
		 * Paste, on the textarea rather than the composer: this has to fire for a paste the reader
		 * aimed at the text they are writing, and that is where the caret is.
		 *
		 * A file copied in Finder arrives as `clipboardData.files` (PLAN Phase 6 task 2), which is
		 * the same payload a drop carries, so it takes the same route. The default is only
		 * suppressed when the view says it took something — see `onPasted`.
		 */
		component.registerDomEvent(this.inputEl, 'paste', (event: ClipboardEvent) => {
			if (this.blocked !== null) {
				return;
			}
			if (this.options.onPasted(event.clipboardData)) {
				event.preventDefault();
			}
		});

		this.registerDropTarget(component, form);
		this.renderChips();
	}

	/**
	 * Drop handling on the whole composer, not just the textarea.
	 *
	 * `dragover` must call `preventDefault()` on **every** event, not once: the browser reads the
	 * absence of a `preventDefault` on the latest `dragover` as "this is not a drop target" and
	 * refuses the drop. The same call is also what stops the textarea's default handling, which
	 * would otherwise paste Obsidian's `obsidian://open?…` URL in as text — the drag payload is a
	 * URL, so a missed `preventDefault` produces a plausible-looking wrong result rather than
	 * nothing (measured in `app.js`: `dragFile` sets both `text/plain` and `text/uri-list`).
	 */
	private registerDropTarget(component: Component, form: HTMLElement): void {
		component.registerDomEvent(form, 'dragover', (event: DragEvent) => {
			if (this.blocked !== null) {
				return;
			}
			event.preventDefault();
			if (event.dataTransfer) {
				// `copy`, not `move`: attaching a note must never read as taking it out of the
				// vault. Obsidian's own drag sets `effectAllowed = 'all'`.
				event.dataTransfer.dropEffect = 'copy';
			}
		});

		component.registerDomEvent(form, 'dragenter', (event: DragEvent) => {
			if (this.blocked !== null) {
				return;
			}
			event.preventDefault();
			this.dragDepth += 1;
			form.toggleClass('guki-composer-dragover', true);
		});

		component.registerDomEvent(form, 'dragleave', () => {
			this.dragDepth = Math.max(0, this.dragDepth - 1);
			if (this.dragDepth === 0) {
				form.toggleClass('guki-composer-dragover', false);
			}
		});

		component.registerDomEvent(form, 'drop', (event: DragEvent) => {
			this.dragDepth = 0;
			form.toggleClass('guki-composer-dragover', false);
			if (this.blocked !== null) {
				return;
			}
			event.preventDefault();
			// Read synchronously by the view: `dataTransfer` is only valid during this event.
			this.options.onDropped(event.dataTransfer);
		});
	}

	/**
	 * Adds a chip. Idempotent per path — dragging the same note twice is one attachment, which is
	 * also what stops the `dragManager` source and the `dataTransfer` fallback from double-adding.
	 */
	attach(attachment: Attachment): void {
		const next = addAttachment(this.attachments, attachment);
		if (next.length === this.attachments.length) {
			return;
		}
		this.attachments = next;
		this.renderChips();
	}

	private detach(absolutePath: string): void {
		this.attachments = this.attachments.filter((held) => held.absolutePath !== absolutePath);
		this.renderChips();
	}

	private renderChips(): void {
		this.chipsEl.empty();
		// The row is hidden rather than left empty so it takes no vertical space when there is
		// nothing attached — the composer keeps its current height until a chip exists.
		this.chipsEl.toggleClass('guki-composer-chips-empty', this.attachments.length === 0);

		for (const attachment of this.attachments) {
			const chip = this.chipsEl.createDiv({ cls: 'guki-composer-chip' });
			const iconEl = chip.createSpan({ cls: 'guki-composer-chip-icon' });
			setIcon(iconEl, 'file-text');
			chip.createSpan({ cls: 'guki-composer-chip-name', text: attachment.displayName });
			// The full path in the tooltip, not on the chip: the chip is narrow, but which of two
			// same-named notes this is can only be answered by the path.
			chip.setAttr('aria-label', attachment.absolutePath);

			const removeEl = chip.createEl('button', {
				cls: 'guki-composer-chip-remove',
				attr: { 'aria-label': `Remove ${attachment.displayName}` },
			});
			setIcon(removeEl, 'x');
			// Plain `addEventListener`, where the rest of the UI uses `component.registerDomEvent`
			// — deliberately, and this is the one place the difference matters. The other dynamic
			// controls (the permission card's buttons, a tool header) are built once per item,
			// whereas this row is rebuilt on every attach and detach. Registering through the
			// component would leave one dead registration per rebuild on the *view's* Component,
			// which lives as long as the panel does. These listeners belong to an element that is
			// dropped by the next `empty()`, so they go with it.
			removeEl.addEventListener('click', () => {
				this.detach(attachment.absolutePath);
			});
		}
	}

	/** Swaps the button between Send and Stop. Idempotent — called on every state change. */
	setBusy(busy: boolean): void {
		if (busy === this.busy) {
			return;
		}
		this.busy = busy;
		this.actionEl.setText(busy ? 'Stop' : 'Send');
		this.actionEl.toggleClass('guki-composer-stop', busy);
		this.actionEl.setAttr('aria-label', busy ? 'Stop the current reply' : 'Send the message');
	}

	/**
	 * Refuses input, with the reason in place of the placeholder (PLAN Phase 5 task 9).
	 *
	 * Only one thing sets this: the approval gate is not running. Leaving the composer usable would
	 * mean typing into a CLI with no permission bridge, which is the state that must never be
	 * reachable quietly — so the control is genuinely disabled, not merely styled as such.
	 * Idempotent; called on every state change.
	 */
	setBlocked(reason: string | null): void {
		if (reason === this.blocked) {
			return;
		}
		this.blocked = reason;
		const isBlocked = reason !== null;
		this.inputEl.disabled = isBlocked;
		this.actionEl.disabled = isBlocked;
		// Attaching is disabled with the rest of it, both controls. A chip is a path the CLI will
		// read, so it is input like any other — collecting them while the gate is down would be the
		// same mistake as letting text be typed.
		this.attachEl.disabled = isBlocked;
		this.pickEl.disabled = isBlocked;
		this.inputEl.placeholder = reason ?? DEFAULT_PLACEHOLDER;
		this.actionEl.toggleClass('guki-composer-blocked', isBlocked);
	}

	private submit(): void {
		const text = this.inputEl.value;
		// Not `text.length === 0`: an attachment with no typed text is a real message.
		if (!hasSendableContent(text, this.attachments) || this.blocked !== null) {
			return;
		}
		if (this.options.onSubmit(text.trim(), this.attachments)) {
			this.inputEl.value = '';
			this.attachments = [];
			this.renderChips();
		}
	}

	focus(): void {
		this.inputEl.focus();
	}
}
