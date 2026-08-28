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
}

export class Composer {
	private readonly inputEl: HTMLTextAreaElement;

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
				placeholder: 'Message GuKi… (Enter to send, Shift+Enter for a new line)',
			},
		});

		const sendEl = form.createEl('button', {
			cls: 'guki-composer-send',
			text: 'Send',
		});

		component.registerDomEvent(this.inputEl, 'keydown', (event: KeyboardEvent) => {
			// isComposing: mid-IME-composition Enter belongs to the input method, not to us.
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}
			event.preventDefault();
			this.submit();
		});

		component.registerDomEvent(sendEl, 'click', () => {
			this.submit();
		});
	}

	private submit(): void {
		const text = this.inputEl.value.trim();
		if (text.length === 0) {
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
