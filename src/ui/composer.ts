/**
 * The composer: attachment chips, a row of two attach controls, then the textarea and Send.
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
import {
	addAttachment,
	attachmentKey,
	hasSendableContent,
	imageDataUrl,
	imageSummary,
	type Attachment,
} from '../core/attachments';

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

/**
 * Whether a `paste` dispatched anywhere in the document belongs to this composer.
 *
 * A pure function of its five inputs, and exported, for two reasons: it is the only part of the
 * paste path a headless harness can assert (`docs/offline-checks.ts` §O11), and the version that
 * lived inline shipped a defect that reached Emre's hands — the one branch 1 below exists to fix.
 *
 * **Two branches, and what separates them is how much the target tells you.**
 *
 * 1. **The target is anywhere inside the panel** — the textarea, an attach button, a chip, a card,
 *    or a reply bubble's own `<li>`. Unambiguous: whatever Chromium dispatched this event to,
 *    selection or focus, is *in our panel*, so nothing else can have wanted it. Claimed with **no**
 *    further guard, deliberately: `pointerInPanel` and `panelShown` exist to disambiguate a target
 *    that says nothing about where the reader is, and this target says everything.
 *
 *    This branch is the correction, and the measurement behind it is in
 *    `docs/archive/PHASE6-TASK4-STATE.md` §M7. `paste` is **not** dispatched to the focused
 *    element when a selection exists — it goes to the node holding the selection anchor. Our
 *    transcript re-enables `user-select` (styles.css:76, `.guki-message`, because Obsidian's shell
 *    turns selection off outside editor surfaces and a reply must be copyable), so clicking a
 *    bubble *does* place a selection and the target is the `<li>` that was clicked. That node is
 *    inside the panel but is neither inside the composer nor an ancestor of it, so branch 2 alone
 *    missed the exact gesture it was written for: click a bubble, Cmd+V, nothing happened at all.
 *
 * 2. **The target is an ancestor of the composer** — `.guki-root`, `.view-content`,
 *    `.workspace-leaf-content`, `body`. This is "nothing is focused and there is no selection
 *    either", which is the case outside the transcript, where `user-select` is still off. Here the
 *    target tells you nothing about the reader, so both guards apply, and §M5 is why they must:
 *    Obsidian routes an unfocused paste to the active leaf (`activeLeaf.view.handlePaste`), so
 *    claiming every unfocused paste while this panel is merely visible would take a note's paste
 *    away from the note. `pointerInPanel` demands the reader's last click was in the panel;
 *    `panelShown` closes the stale path where the panel was clicked and then hidden by a keyboard
 *    tab switch rather than by another click.
 *
 * **The guard's semantics do not widen: a target outside the panel is never ours.** Branch 1 is a
 * subtree test on `panelEl` and is false for every node outside it, guards or no guards. Branch 2
 * cannot reach one either — a node that contains the composer is by definition on the composer's
 * own ancestor chain, and every one of those either *is* the panel or contains it; a sibling
 * subtree (another leaf's editor, a search field, a modal input) contains neither. So a paste aimed
 * at another note's tab header or at its body still satisfies neither branch and is left entirely
 * to Obsidian, which is the behaviour Emre confirmed by hand.
 *
 * One consequence, made deliberate rather than accidental: **selecting text in a reply bubble and
 * then pasting is now ours**, and the pasted text lands in the textarea. In a read-only transcript
 * there is nothing else it could sensibly do, and the alternative is the silent nothing above.
 */
export function pasteBelongsToComposer(
	target: Node,
	formEl: Node,
	panelEl: Node,
	pointerInPanel: boolean,
	panelShown: boolean,
): boolean {
	// `contains` is true of a node itself, which is what makes the textarea and the panel's own
	// root land in branch 1 rather than falling to branch 2.
	if (panelEl.contains(target)) {
		return true;
	}
	return target.contains(formEl) && pointerInPanel && panelShown;
}

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
	/**
	 * Whether the reader's last click landed inside the panel. It is what says an unfocused paste
	 * was aimed here — see `registerPasteTarget`.
	 */
	private pointerInPanel = false;

	constructor(
		containerEl: HTMLElement,
		/**
		 * The whole panel, which is wider than `containerEl` — the composer lives in the footer,
		 * but a click anywhere in the panel is what makes an unfocused paste this composer's.
		 */
		private readonly panelEl: HTMLElement,
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

		/*
		 * The attach controls, on their own row *above* the textarea rather than beside it.
		 *
		 * Emre's preference from task 2's acceptance run, and it pays for itself in the sidebar:
		 * the two buttons and Send used to share the input row with the textarea, and each button
		 * is `--input-height` tall (30px) by Obsidian's own button rule and ~34px wide, so a 300px
		 * panel left the textarea barely half its width. On their own row the textarea gets that
		 * width back and the buttons cost one 30px row.
		 */
		const tools = form.createDiv({ cls: 'guki-composer-tools' });

		/*
		 * Two attach controls, not one button behind a menu. They are two different actions —
		 * "attach the note I am looking at" and "attach a file from disk" — and this panel's
		 * product boundary is "better conversation" (PLAN §5 decision 12), so the common path does
		 * not get to cost an extra click.
		 *
		 * The paperclip is Obsidian's own icon for attaching a file (`editor:attach-file` uses
		 * `lucide-paperclip`), so the meaning is borrowed rather than invented.
		 */
		this.pickEl = tools.createEl('button', {
			cls: 'guki-composer-attach',
			attr: { 'aria-label': 'Attach files from disk' },
		});
		setIcon(this.pickEl, 'paperclip');

		this.attachEl = tools.createEl('button', {
			cls: 'guki-composer-attach',
			attr: { 'aria-label': 'Attach the active note' },
		});
		setIcon(this.attachEl, 'file-plus');

		const row = form.createDiv({ cls: 'guki-composer-row' });

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

		this.registerPasteTarget(component, form);
		this.registerDropTarget(component, form);
		this.renderChips();
	}

	/**
	 * Paste handling for the whole panel, not just the textarea.
	 *
	 * **Why the document and not an element.** With the listener on the textarea, clicking anywhere
	 * else in the panel and pressing Cmd+V did nothing at all, with no feedback (Emre, task 3
	 * acceptance run, step 6). It bites hardest for a screenshot, because pasting a picture is a
	 * "click the panel, then paste" gesture in a way that pasting a file path never was.
	 *
	 * **Where such a paste actually lands is not obvious, and getting it wrong is what §M7 caught.**
	 * The ownership test and the whole of that reasoning live in `pasteBelongsToComposer` above,
	 * because the harness asserts it there; this method is only the wiring — a `pointerdown`
	 * listener that records the last click, and the paste listener that asks the predicate.
	 *
	 * (`View.handlePaste` is Obsidian's own hook for this and would be the tidier route, but it is
	 * **not** in `obsidian.d.ts` — an internal API, so not one to build on. Our own listener sits on
	 * the document, which bubbles before `window`, so a paste we take is `defaultPrevented` by the
	 * time Obsidian's handler looks at it and the two can never both act.)
	 *
	 * **The decision itself is untouched.** `onPasted` still answers synchronously and still answers
	 * `false` for an ordinary text paste, because that answer is what calls `preventDefault()` — the
	 * regression Emre tested by hand in task 2 (step 7, pasting the word "fenerbahçe") and again in
	 * task 3. What is new is only where an ordinary text paste *goes* when the textarea never had
	 * focus: into the textarea, at its caret. Dropping it because the caret was elsewhere would be a
	 * worse bug than the one this listener exists to fix.
	 */
	private registerPasteTarget(component: Component, form: HTMLElement): void {
		// Capture, so a handler that stops propagation on the way up cannot hide the click from
		// this. It only reads the event.
		component.registerDomEvent(
			form.ownerDocument,
			'pointerdown',
			(event: PointerEvent) => {
				const target = event.target;
				this.pointerInPanel = target instanceof Node && this.panelEl.contains(target);
			},
			{ capture: true },
		);

		component.registerDomEvent(form.ownerDocument, 'paste', (event: ClipboardEvent) => {
			if (this.blocked !== null) {
				return;
			}
			const target = event.target;
			if (!(target instanceof Node)) {
				return;
			}
			// `isShown()` (obsidian.d.ts:104) is only read by the ancestor branch; passing it in
			// eagerly is what keeps the predicate pure, and it is a cheap class check on the element.
			const ours = pasteBelongsToComposer(
				target,
				form,
				this.panelEl,
				this.pointerInPanel,
				this.panelEl.isShown(),
			);
			if (!ours) {
				return;
			}

			// A file copied in Finder arrives as `clipboardData.files` (PLAN Phase 6 task 2), which
			// is the same payload a drop carries, so it takes the same route; a clipboard bitmap is
			// task 3's byte path. Either way the view says whether it took anything.
			if (this.options.onPasted(event.clipboardData)) {
				event.preventDefault();
				// The chips are in the composer now, and the next thing the reader does is type the
				// question about them.
				if (!this.inputEl.contains(target)) {
					this.inputEl.focus();
				}
				return;
			}

			if (this.inputEl.contains(target)) {
				// Ordinary text aimed at the caret. The textarea's own default handling is the right
				// one — native undo, native caret — so nothing is suppressed here.
				return;
			}

			const text = event.clipboardData?.getData('text/plain') ?? '';
			if (text.length === 0) {
				// Nothing either door claimed and no text either: an image the browser exposes only
				// as HTML, say. Left to whatever else may be listening.
				return;
			}
			event.preventDefault();
			this.insertAtCaret(text);
		});
	}

	/**
	 * Inserts text at the textarea's caret and focuses it.
	 *
	 * Only reached for a paste that did not originate in the textarea, so there is no native
	 * insertion to defer to — but the insertion still has to *behave* like one.
	 *
	 * **`execCommand('insertText')` is deprecated, and used anyway — Emre's call.** His task 4 run
	 * hit the reason within a minute: assigning `value` does not enter the textarea's native undo
	 * stack, so Cmd+Z would not remove the pasted word. `execCommand` is the only API that
	 * registers an undo entry, it is universally implemented in Chromium, and Obsidian is Electron,
	 * so the deprecation cannot strand us. It also replaces the current selection the way a native
	 * paste would, which is why the range maths below is now a fallback rather than the main path.
	 * Recorded here so the next reader does not "clean it up".
	 *
	 * Focus comes **first**: `execCommand` acts on the focused editable element, so an unfocused
	 * textarea would silently get nothing.
	 *
	 * The fallback costs exactly one thing — no undo entry, i.e. the behaviour this replaces — so a
	 * runtime that has dropped the command degrades to a paste that cannot be undone rather than to
	 * a paste that vanishes.
	 */
	private insertAtCaret(text: string): void {
		this.inputEl.focus();
		if (this.inputEl.ownerDocument.execCommand('insertText', false, text)) {
			return;
		}
		const { value, selectionStart, selectionEnd } = this.inputEl;
		this.inputEl.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
		const caret = selectionStart + text.length;
		this.inputEl.setSelectionRange(caret, caret);
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

	private detach(key: string): void {
		this.attachments = this.attachments.filter((held) => attachmentKey(held) !== key);
		this.renderChips();
	}

	private renderChips(): void {
		this.chipsEl.empty();
		// The row is hidden rather than left empty so it takes no vertical space when there is
		// nothing attached — the composer keeps its current height until a chip exists.
		this.chipsEl.toggleClass('guki-composer-chips-empty', this.attachments.length === 0);

		for (const attachment of this.attachments) {
			const chip = this.chipsEl.createDiv({ cls: 'guki-composer-chip' });

			if (attachment.kind === 'image') {
				/*
				 * A thumbnail, not an icon, and this is the minimum rather than a flourish. The
				 * clipboard names every screenshot `image.png` (measured, task 2 §R3), so two
				 * pasted images would otherwise be two identical chips and the reader could not
				 * tell which one they were about to remove. The picture is the only thing that
				 * distinguishes them, and it is already in memory — no decode, no canvas, no work.
				 */
				const thumbEl = chip.createEl('img', { cls: 'guki-composer-chip-thumb' });
				thumbEl.src = imageDataUrl(attachment);
				thumbEl.alt = '';
				chip.createSpan({ cls: 'guki-composer-chip-name', text: attachment.displayName });
				// Standing in for the absolute path a file chip shows: format and size, which is
				// what actually differs between two screenshots.
				chip.setAttr('aria-label', imageSummary(attachment));
			} else {
				const iconEl = chip.createSpan({ cls: 'guki-composer-chip-icon' });
				setIcon(iconEl, 'file-text');
				chip.createSpan({ cls: 'guki-composer-chip-name', text: attachment.displayName });
				// The full path in the tooltip, not on the chip: the chip is narrow, but which of
				// two same-named notes this is can only be answered by the path.
				chip.setAttr('aria-label', attachment.absolutePath);
			}

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
				this.detach(attachmentKey(attachment));
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
