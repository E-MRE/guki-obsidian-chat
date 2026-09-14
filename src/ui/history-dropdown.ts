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
import type { SessionSummary } from '../data/session-index';

export interface HistoryRowItem {
	sessionId: string;
	title: string;
	isDerivedTitle: boolean;
	dateText: string;
	costText: string | null;
}

export interface HistoryDropdownOptions {
	containerEl: HTMLElement;
	triggerEl?: HTMLElement;
	getSessions: () => Promise<SessionSummary[]>;
	onSelectSession: (sessionId: string) => void;
	onClose?: () => void;
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
 * Real `ai-title` wins when present; otherwise `derivedTitle` is used.
 * If neither is present, falls back to "Untitled session".
 * Preserves the distinction with `isDerivedTitle`.
 * Formats `costUsd` as `$X.XX` if present, or `null` if absent.
 */
export function shapeSessionRow(summary: SessionSummary): HistoryRowItem {
	const hasRealTitle = summary.title !== undefined && summary.title.length > 0;
	const isDerivedTitle = !hasRealTitle && summary.derivedTitle !== undefined && summary.derivedTitle.length > 0;
	const title = hasRealTitle
		? summary.title!
		: (isDerivedTitle ? summary.derivedTitle! : 'Untitled session');
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
	private itemEls: HTMLElement[] = [];
	private selectedIndex = 0;
	private boundOnKeyDown: ((event: KeyboardEvent) => void) | null = null;
	private boundOnDocClick: ((event: MouseEvent) => void) | null = null;

	constructor(private readonly options: HistoryDropdownOptions) {
		this.triggerEl = options.triggerEl ?? null;
		this.dropdownEl = options.containerEl.createDiv({
			cls: 'guki-history-dropdown guki-hidden',
		});
	}

	setTriggerEl(el: HTMLElement): void {
		this.triggerEl = el;
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
		this.items = rawSummaries.map(shapeSessionRow);
		this.open = true;
		this.selectedIndex = 0;
		this.render();
		this.attachListeners();
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
		this.itemEls = [];
		this.selectedIndex = 0;
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
				text: 'No past conversations found in this vault.',
			});
			return;
		}

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const itemEl = this.dropdownEl.createDiv({
				cls: 'guki-history-item' + (i === this.selectedIndex ? ' is-selected' : ''),
			});

			const titleEl = itemEl.createSpan({
				cls: 'guki-history-title' + (item.isDerivedTitle ? ' is-derived' : ''),
				text: item.title,
			});
			if (item.isDerivedTitle) {
				titleEl.setAttribute('title', `Derived: ${item.title}`);
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

			itemEl.addEventListener('click', (evt: MouseEvent) => {
				evt.preventDefault?.();
				this.selectIndex(i);
			});

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
