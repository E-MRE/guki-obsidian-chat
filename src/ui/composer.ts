/**
 * The input row: a textarea plus a send button.
 *
 * Enter sends, Shift+Enter inserts a newline, and that is the only key behaviour there is — no
 * other shortcut, by closed decision #3. The chat is not a terminal.
 */
import type { Component } from 'obsidian';

export interface ComposerOptions {
	/** Called with the trimmed text. The composer clears itself only if this returns true. */
	onSubmit(text: string): boolean;
	/** Called when the button is in its Stop state (RESEARCH B4's `interrupt` control request). */
	onStop(): void;
}

const DEFAULT_PLACEHOLDER = 'Message GuKi… (Enter to send, Shift+Enter for a new line)';

export class Composer {
	private readonly inputEl: HTMLTextAreaElement;
	private readonly actionEl: HTMLButtonElement;
	private busy = false;
	/** Non-null when the panel is refusing input; the text is shown in place of the placeholder. */
	private blocked: string | null = null;

	constructor(
		containerEl: HTMLElement,
		/** The view, so the key handler is detached with it. */
		component: Component,
		private readonly options: ComposerOptions,
	) {
		const form = containerEl.createDiv({ cls: 'guki-composer' });

		this.inputEl = form.createEl('textarea', {
			cls: 'guki-composer-input',
			attr: {
				rows: '3',
				placeholder: DEFAULT_PLACEHOLDER,
			},
		});

		this.actionEl = form.createEl('button', {
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
		this.inputEl.placeholder = reason ?? DEFAULT_PLACEHOLDER;
		this.actionEl.toggleClass('guki-composer-blocked', isBlocked);
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (text.length === 0 || this.blocked !== null) {
			return;
		}
		if (this.options.onSubmit(text)) {
			this.inputEl.value = '';
		}
	}

	focus(): void {
		this.inputEl.focus();
	}
}
