/**
 * The input row: attachment chips, a textarea and a send button.
 *
 * Enter sends, Shift+Enter inserts a newline, and that is the only key behaviour there is — no
 * other shortcut, by closed decision #3. The chat is not a terminal.
 *
 * The composer stays presentational about attachments: it holds the chips and renders them, but it
 * never resolves a path or decides whether a file may be attached. It hands the drop and the
 * attach control to the view, which owns the vault-boundary check, and the view calls `attach`.
 * That keeps the security decision in `core/` and out of a DOM file.
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
	/** The attach control was pressed. The view resolves the active note and calls `attach`. */
	onAttachActiveNote(): void;
}

const DEFAULT_PLACEHOLDER = 'Message GuKi… (Enter to send, Shift+Enter for a new line)';

export class Composer {
	private readonly chipsEl: HTMLElement;
	private readonly inputEl: HTMLTextAreaElement;
	private readonly actionEl: HTMLButtonElement;
	private readonly attachEl: HTMLButtonElement;
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

		const row = form.createDiv({ cls: 'guki-composer-row' });

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
		// Attaching is disabled with the rest of it. A chip is a path the CLI will read, so it is
		// input like any other — collecting them while the gate is down would be the same mistake
		// as letting text be typed.
		this.attachEl.disabled = isBlocked;
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
