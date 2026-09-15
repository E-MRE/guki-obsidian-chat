/**
 * History dropdown component for past conversation sessions.
 *
 * Modeled after `ComposerDropdown` (`src/ui/composer-dropdown.ts`):
 * - Renders a scrollable popover container anchored to the panel chrome / header.
 * - Keyboard navigation: ArrowDown / ArrowUp to change highlight, Enter / Tab to select, Escape to close.
 * - Mouse navigation: Click to select, click outside or Escape to close.
 * - Row content: Title (real `ai-title` or derived prompt fallback), session date, and optional
 *   subdued session cost badge.
 * - Empty state: Renders a clean "No past conversations found in this vault." notice without erroring.
 * - Performance: Styled with `content-visibility: auto` so large directories with hundreds of
 *   session files render without layout stalls.
 */
import { setIcon } from 'obsidian';
import { resolveSessionTitle, type SessionSummary } from '../data/session-index';
import type { ConversationTitleStore } from '../data/conversation-titles';
import { t } from '../i18n';

export interface HistoryRowItem {
	sessionId: string;
	title: string;
	isDerivedTitle: boolean;
	dateText: string;
	costText: string | null;
}

export interface HistoryDropdownOptions {
	containerEl: HTMLElement;
	triggerEl?: HTMLElement | null;
	getSessions: () => Promise<SessionSummary[]>;
	onSelectSession: (sessionId: string) => void;
	onClose?: () => void;
	titleStore?: ConversationTitleStore;
	onSaveTitle?: (sessionId: string, title: string) => Promise<void>;
}

/** Formats ISO timestamp to human-readable date `YYYY-MM-DD HH:mm`. */
export function formatSessionDate(isoString: string): string {
	try {
		const date = new Date(isoString);
		if (isNaN(date.getTime())) {
			return isoString.slice(0, 10);
		}
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	} catch {
		return isoString.slice(0, 10);
	}
}

/**
 * Shapes a SessionSummary into display-ready row data.
 *
 * Delegates title resolution to `resolveSessionTitle` (Contract §4):
 * - `customTitle` > `title` > `derivedTitle` > 'Untitled session'
 * - `isDerivedTitle` is true only when source is 'derived'
 * Formats `costUsd` as `$X.XX` if present, or `null` if absent.
 */
export function shapeSessionRow(summary: SessionSummary): HistoryRowItem {
	const resolved = resolveSessionTitle(summary);
	const title = resolved.text;
	const isDerivedTitle = resolved.source === 'derived';
	const dateText = formatSessionDate(summary.startedAt);
	const costText = summary.costUsd !== undefined ? `$${summary.costUsd.toFixed(2)}` : null;

	return {
		sessionId: summary.sessionId,
		title,
		isDerivedTitle,
		dateText,
		costText,
	};
}

export class HistoryDropdown {
	private readonly dropdownEl: HTMLElement;
	private triggerEl: HTMLElement | null = null;
	private open = false;
	private items: HistoryRowItem[] = [];
	private summaries: SessionSummary[] = [];
	private itemEls: HTMLElement[] = [];
	private selectedIndex = 0;
	private editingSessionId: string | null = null;
	private isCanceling = false;
	private isRefreshing = false;
	private savePromise: Promise<void> | null = null;
	/** Set when an edit is committed; swallows exactly the one Enter that did the committing. */
	private suppressNextEnter = false;
	private boundOnKeyDown: ((event: KeyboardEvent) => void) | null = null;
	private boundOnDocClick: ((event: MouseEvent) => void) | null = null;

	constructor(private readonly options: HistoryDropdownOptions) {
		this.triggerEl = options.triggerEl ?? null;
		this.dropdownEl = options.containerEl.createDiv({
			cls: 'guki-history-dropdown guki-hidden',
		});
	}

	setTriggerEl(el: HTMLElement | null): void {
		this.triggerEl = el;
	}

	getTriggerEl(): HTMLElement | null {
		return this.triggerEl;
	}

	getDropdownEl(): HTMLElement {
		return this.dropdownEl;
	}

	isOpen(): boolean {
		return this.open;
	}

	getItems(): readonly HistoryRowItem[] {
		return this.items;
	}

	getItemEls(): readonly HTMLElement[] {
		return this.itemEls;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	isEditing(): boolean {
		return this.editingSessionId !== null;
	}

	getEditingSessionId(): string | null {
		return this.editingSessionId;
	}

	getSummaries(): readonly SessionSummary[] {
		return this.summaries;
	}

	getSummary(sessionId: string): SessionSummary | undefined {
		return this.summaries.find((s) => s.sessionId === sessionId);
	}

	async refresh(): Promise<void> {
		if (!this.open) {
			return;
		}

		// 1. Remember currently selected session ID and index
		const prevSelectedSessionId = this.items[this.selectedIndex]?.sessionId ?? null;
		const prevSelectedIndex = this.selectedIndex;

		// 2. Remember open rename editor state and typed text
		const editingSessionId = this.editingSessionId;
		let editingText: string | null = null;
		let selectionStart: number | null = null;
		let selectionEnd: number | null = null;
		if (editingSessionId !== null) {
			const inputEl = this.dropdownEl.querySelector('input');
			if (inputEl) {
				editingText = inputEl.value;
				selectionStart = inputEl.selectionStart;
				selectionEnd = inputEl.selectionEnd;
			}
		}

		// 3. Rescan sessions
		const rawSummaries = await this.options.getSessions();
		this.summaries = rawSummaries;
		this.items = rawSummaries.map(shapeSessionRow);

		// 4. Update selection: follow by sessionId, or nearest row if disappeared
		if (this.items.length === 0) {
			this.selectedIndex = 0;
		} else if (prevSelectedSessionId !== null) {
			const matchIdx = this.items.findIndex((item) => item.sessionId === prevSelectedSessionId);
			if (matchIdx !== -1) {
				this.selectedIndex = matchIdx;
			} else {
				this.selectedIndex = Math.min(prevSelectedIndex, this.items.length - 1);
			}
		} else {
			this.selectedIndex = Math.min(prevSelectedIndex, this.items.length - 1);
		}

		// 5. Preserve rename editor if session still exists
		if (editingSessionId !== null) {
			const stillExists = this.items.some((item) => item.sessionId === editingSessionId);
			this.editingSessionId = stillExists ? editingSessionId : null;
		}

		// 6. Render with isRefreshing flag to suppress blur-commit during DOM clear
		this.isRefreshing = true;
		try {
			this.render();
		} finally {
			this.isRefreshing = false;
		}

		// 7. Restore typed text and cursor selection in rename input
		if (this.editingSessionId !== null && editingText !== null) {
			const inputEl = this.dropdownEl.querySelector('input');
			if (inputEl) {
				inputEl.value = editingText;
				inputEl.focus?.();
				if (selectionStart !== null && selectionEnd !== null) {
					inputEl.setSelectionRange?.(selectionStart, selectionEnd);
				}
			}
		}
	}

	async toggle(): Promise<void> {
		if (this.open) {
			this.close();
		} else {
			await this.openDropdown();
		}
	}

	async openDropdown(): Promise<void> {
		const rawSummaries = await this.options.getSessions();
		// Order newest first: `session-index.ts` already sorts that way; do not re-sort!
		this.summaries = rawSummaries;
		this.items = rawSummaries.map(shapeSessionRow);
		this.open = true;
		this.selectedIndex = 0;
		this.editingSessionId = null;
		this.render();
		this.attachListeners();
	}

	startEditing(sessionId: string): void {
		if (this.editingSessionId === sessionId) {
			return;
		}
		if (this.editingSessionId !== null) {
			void this.commitEdit();
		}
		this.editingSessionId = sessionId;
		this.render();
		const inputEl = this.dropdownEl.querySelector('input');
		if (inputEl) {
			inputEl.focus?.();
			inputEl.select?.();
			inputEl.setSelectionRange?.(0, inputEl.value.length);
		}
	}

	cancelEdit(): void {
		if (this.editingSessionId === null) {
			return;
		}
		this.isCanceling = true;
		this.editingSessionId = null;
		this.render();
		this.isCanceling = false;
	}

	async commitEdit(): Promise<void> {
		if (this.editingSessionId === null || this.isCanceling || this.isRefreshing) {
			// Nothing of our own to commit — but a save started by an earlier commit (a blur, say)
			// may still be writing, and callers await this method to know it finished.
			await this.savePromise;
			return;
		}
		const sessionId = this.editingSessionId;
		const inputEl = this.dropdownEl.querySelector('input');
		const newTitle = inputEl ? inputEl.value : '';
		this.editingSessionId = null;

		const trimmed = newTitle.trim();
		const summary = this.summaries.find(s => s.sessionId === sessionId);
		if (summary) {
			summary.customTitle = trimmed.length > 0 ? trimmed : undefined;
		}
		const itemIndex = this.items.findIndex(item => item.sessionId === sessionId);
		if (itemIndex !== -1) {
			if (summary) {
				this.items[itemIndex] = shapeSessionRow(summary);
			} else {
				this.items[itemIndex] = {
					...this.items[itemIndex]!,
					title: trimmed.length > 0 ? trimmed : (this.items[itemIndex]?.title ?? t('chat.history.untitled-session')),
					isDerivedTitle: false,
				};
			}
		}
		this.render();

		// Saves are serialised, never dropped: a rename committed while an earlier one is still
		// writing used to return the in-flight promise and silently lose the second name
		// (found by the V2 verification round; checks AT1.3/AT1.4 cover it).
		// No save in flight: call straight through, so the common path keeps its original timing.
		const chained = this.savePromise === null
			? this.saveTitle(sessionId, trimmed)
			: this.savePromise.catch(() => undefined).then(() => this.saveTitle(sessionId, trimmed));
		this.savePromise = chained.finally(() => {
			if (this.savePromise === chained) {
				this.savePromise = null;
			}
		});

		// Committing with Enter must not let the same keypress fall through to the list and open
		// whatever row happens to be highlighted (checks AT2.2/AT2.3).
		this.suppressNextEnter = true;

		return chained;
	}

	private async saveTitle(sessionId: string, title: string): Promise<void> {
		if (this.options.titleStore) {
			await this.options.titleStore.set(sessionId, title);
		}
		if (this.options.onSaveTitle) {
			await this.options.onSaveTitle(sessionId, title);
		}
	}

	selectNext(): void {
		if (this.items.length <= 1) return;
		this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
		this.updateHighlight();
	}

	selectPrev(): void {
		if (this.items.length <= 1) return;
		this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
		this.updateHighlight();
	}

	selectIndex(index: number): boolean {
		if (this.editingSessionId !== null) {
			return false;
		}
		const item = this.items[index];
		if (!item) {
			return false;
		}
		this.close();
		this.options.onSelectSession(item.sessionId);
		return true;
	}

	selectCurrent(): boolean {
		return this.selectIndex(this.selectedIndex);
	}

	close(): void {
		if (!this.open) return;
		this.detachListeners();
		this.open = false;
		this.items = [];
		this.summaries = [];
		this.itemEls = [];
		this.selectedIndex = 0;
		this.editingSessionId = null;
		this.dropdownEl.empty();
		this.dropdownEl.addClass('guki-hidden');
		this.options.onClose?.();
	}

	destroy(): void {
		this.detachListeners();
		this.dropdownEl.remove();
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		if (!this.open) {
			return false;
		}
		if (this.editingSessionId !== null) {
			if (event.key === 'Enter') {
				event.preventDefault?.();
				void this.commitEdit();
				return true;
			}
			if (event.key === 'Escape') {
				event.preventDefault?.();
				this.cancelEdit();
				return true;
			}
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault?.();
				return true;
			}
			return false;
		}
		this.suppressNextEnter = event.key === 'Enter' ? this.suppressNextEnter : false;
		if (event.key === 'ArrowDown') {
			event.preventDefault?.();
			this.selectNext();
			return true;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault?.();
			this.selectPrev();
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault?.();
			if (this.suppressNextEnter) {
				this.suppressNextEnter = false;
				return true;
			}
			return this.selectCurrent();
		}
		if (event.key === 'Escape') {
			event.preventDefault?.();
			this.close();
			return true;
		}
		return false;
	}

	private render(): void {
		this.dropdownEl.empty();
		this.dropdownEl.removeClass('guki-hidden');
		this.itemEls = [];

		if (this.items.length === 0) {
			this.dropdownEl.createDiv({
				cls: 'guki-history-empty',
				text: t('chat.history.empty'),
			});
			return;
		}

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const isEditingThis = this.editingSessionId === item.sessionId;
			const itemEl = this.dropdownEl.createDiv({
				cls: 'guki-history-item' + (i === this.selectedIndex ? ' is-selected' : '') + (isEditingThis ? ' is-editing' : ''),
			});

			if (isEditingThis) {
				const inputEl = itemEl.createEl('input', {
					cls: 'guki-history-rename-input',
					attr: {
						type: 'text',
						'aria-label': t('chat.history.rename-session'),
					},
				});
				inputEl.value = item.title;

				inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter') {
						e.preventDefault?.();
						e.stopPropagation?.();
						void this.commitEdit();
					} else if (e.key === 'Escape') {
						e.preventDefault?.();
						e.stopPropagation?.();
						this.cancelEdit();
					} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
						e.stopPropagation?.();
					}
				});

				inputEl.addEventListener('blur', () => {
					void this.commitEdit();
				});

				inputEl.addEventListener('click', (e: MouseEvent) => {
					e.stopPropagation?.();
				});
			} else {
				const titleEl = itemEl.createSpan({
					cls: 'guki-history-title' + (item.isDerivedTitle ? ' is-derived' : ''),
					text: item.title,
				});
				if (item.isDerivedTitle) {
					titleEl.setAttribute('title', t('chat.history.derived', { title: item.title }));
				}

				itemEl.createSpan({
					cls: 'guki-history-date',
					text: item.dateText,
				});

				if (item.costText !== null) {
					itemEl.createSpan({
						cls: 'guki-history-cost',
						text: item.costText,
					});
				}

				const renameBtn = itemEl.createEl('button', {
					cls: 'clickable-icon guki-history-rename-btn',
					attr: {
						type: 'button',
						'aria-label': t('chat.history.rename-conversation'),
					},
				});
				setIcon(renameBtn, 'pencil');

				renameBtn.addEventListener('click', (evt: MouseEvent) => {
					evt.preventDefault?.();
					evt.stopPropagation?.();
					this.startEditing(item.sessionId);
				});

				itemEl.addEventListener('click', (evt: MouseEvent) => {
					if (this.editingSessionId !== null) return;
					const target = evt.target as HTMLElement | null;
					if (target === renameBtn || renameBtn.contains(target) || target?.tagName === 'INPUT') {
						return;
					}
					evt.preventDefault?.();
					this.selectIndex(i);
				});
			}

			this.itemEls.push(itemEl);
		}

		this.scrollSelectedIntoView();
	}

	private updateHighlight(): void {
		for (let i = 0; i < this.itemEls.length; i++) {
			const el = this.itemEls[i];
			if (!el) continue;
			if (i === this.selectedIndex) {
				el.addClass('is-selected');
			} else {
				el.removeClass('is-selected');
			}
		}
		this.scrollSelectedIntoView();
	}

	private scrollSelectedIntoView(): void {
		const selected = this.itemEls[this.selectedIndex];
		if (selected && typeof selected.scrollIntoView === 'function') {
			selected.scrollIntoView({ block: 'nearest' });
		}
	}

	private attachListeners(): void {
		if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

		this.boundOnKeyDown = (event: KeyboardEvent) => {
			this.handleKeyDown(event);
		};
		window.addEventListener('keydown', this.boundOnKeyDown, true);

		this.boundOnDocClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && !this.dropdownEl.contains(target) && (!this.triggerEl || !this.triggerEl.contains(target))) {
				this.close();
			}
		};
		// Attach on next frame/tick so the opening click does not immediately trigger closing
		if (typeof window.setTimeout === 'function') {
			window.setTimeout(() => {
				if (this.open && this.boundOnDocClick && typeof window?.addEventListener === 'function') {
					window.addEventListener('click', this.boundOnDocClick, true);
				}
			}, 0);
		}
	}

	private detachListeners(): void {
		if (typeof window === 'undefined') return;

		if (this.boundOnKeyDown && typeof window.removeEventListener === 'function') {
			window.removeEventListener('keydown', this.boundOnKeyDown, true);
			this.boundOnKeyDown = null;
		}
		if (this.boundOnDocClick && typeof window.removeEventListener === 'function') {
			window.removeEventListener('click', this.boundOnDocClick, true);
			this.boundOnDocClick = null;
		}
	}
}
