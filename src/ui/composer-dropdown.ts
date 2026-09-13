import { App, FileSystemAdapter, prepareFuzzySearch, sortSearchResults, type SearchResultContainer, type TFile } from 'obsidian';
import { attachmentReference, type PathAttachment } from '../core/attachments';
import { containsPath, type VaultPaths } from '../core/permission-policy';

export interface DropdownItem {
	id: string;
	label: string;
	insertText: string;
	needsPrecedingSpace?: boolean;
}

export type TriggerKind = 'slash' | 'mention';

export interface TriggerMatch {
	kind: TriggerKind;
	start: number;
	end: number;
	query: string;
	needsPrecedingSpace?: boolean;
}

export interface ComposerDropdownOptions {
	containerEl: HTMLElement;
	inputEl: HTMLTextAreaElement;
	app?: App;
	getSlashCommands?: () => readonly string[];
	getVaultPaths?: () => Promise<VaultPaths> | VaultPaths | null;
	onInsert?: () => void;
}

export function matchTrigger(value: string, cursor: number): TriggerMatch | null {
	if (cursor <= 0 || cursor > value.length) {
		return null;
	}
	const before = value.slice(0, cursor);

	// 1. Slash commands: must be at the very start of the textarea (SPEC 1)
	if (value.startsWith('/')) {
		const query = before.slice(1);
		if (!/\s/.test(query)) {
			return {
				kind: 'slash',
				start: 0,
				end: cursor,
				query,
			};
		}
	}

	// 2. Mentions: '@' preceded by whitespace or at input start (SPEC 3 & 6)
	const atIndex = before.lastIndexOf('@');
	if (atIndex !== -1) {
		const query = before.slice(atIndex + 1);
		// Stop if query contains newlines, carriage returns, or quotes
		if (!/[\n\r"]/.test(query)) {
			const needsPrecedingSpace = atIndex > 0 && !/\s/.test(before.charAt(atIndex - 1));
			return {
				kind: 'mention',
				start: atIndex,
				end: cursor,
				query,
				needsPrecedingSpace,
			};
		}
	}

	return null;
}

export function filterSlashCommands(commands: readonly string[], query: string): DropdownItem[] {
	if (commands.length === 0) {
		return [];
	}
	const q = query.toLowerCase();
	const matches = q.length === 0
		? commands.slice()
		: commands.filter((cmd) => {
			const stripped = cmd.startsWith('/') ? cmd.slice(1) : cmd;
			return stripped.toLowerCase().includes(q);
		});

	return matches.map((cmd) => ({
		id: `slash:${cmd}`,
		label: cmd.startsWith('/') ? cmd : `/${cmd}`,
		insertText: cmd.startsWith('/') ? `${cmd} ` : `/${cmd} `,
	}));
}

export function filterVaultFiles(
	app: App | undefined,
	paths: VaultPaths | null,
	query: string,
	needsPrecedingSpace: boolean,
): DropdownItem[] {
	if (!app || !app.vault || !paths) {
		return [];
	}
	const files = app.vault.getFiles();
	if (!Array.isArray(files) || files.length === 0) {
		return [];
	}

	const adapter = app.vault.adapter;
	const getFullPath = (p: string): string => {
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getFullPath(p);
		}
		const duck = adapter as unknown as { getFullPath?: (path: string) => string; getBasePath?: () => string };
		if (typeof duck.getFullPath === 'function') {
			return duck.getFullPath(p);
		}
		const base = typeof duck.getBasePath === 'function' ? duck.getBasePath() : '';
		return base ? `${base}/${p}` : p;
	};

	interface MatchedFile extends SearchResultContainer {
		file: TFile;
	}

	let matchedFiles: MatchedFile[] = [];

	if (query.trim().length === 0) {
		matchedFiles = files.map((file) => ({ file, match: { score: 0, matches: [] } }));
		matchedFiles.sort((a, b) => a.file.path.localeCompare(b.file.path));
	} else {
		const fuzzy = prepareFuzzySearch(query);
		const candidates: MatchedFile[] = [];
		for (const file of files) {
			const match = fuzzy(file.path);
			if (match !== null) {
				candidates.push({ file, match });
			}
		}
		sortSearchResults(candidates);
		matchedFiles = candidates;
	}

	const items: DropdownItem[] = [];
	for (const { file } of matchedFiles) {
		const fullPath = getFullPath(file.path);
		if (!fullPath) {
			continue;
		}
		if (!containsPath(paths.root, paths.resolve(fullPath))) {
			continue;
		}
		const attachment: PathAttachment = {
			kind: 'path',
			absolutePath: fullPath,
			displayName: file.name,
			location: 'in-vault',
		};
		const ref = attachmentReference(attachment);
		if (ref === null) {
			continue;
		}
		items.push({
			id: `file:${file.path}`,
			label: file.path,
			insertText: ref,
			needsPrecedingSpace,
		});
		if (items.length >= 50) {
			break;
		}
	}

	return items;
}

export function insertItem(inputEl: HTMLTextAreaElement, item: DropdownItem, match: TriggerMatch): void {
	const before = inputEl.value.slice(0, match.start);
	const after = inputEl.value.slice(match.end);
	let insertText = item.insertText;
	if (insertText.startsWith('@')) {
		const charBefore = before.slice(-1);
		if (charBefore.length > 0 && !/\s/.test(charBefore)) {
			insertText = ' ' + insertText;
		}
	} else if (item.needsPrecedingSpace) {
		insertText = ' ' + insertText;
	}
	inputEl.value = before + insertText + after;
	const cursor = before.length + insertText.length;
	inputEl.selectionStart = cursor;
	inputEl.selectionEnd = cursor;
}

export class ComposerDropdown {
	private readonly dropdownEl: HTMLElement;
	private readonly inputEl: HTMLTextAreaElement;
	private open = false;
	private items: DropdownItem[] = [];
	private itemEls: HTMLElement[] = [];
	private selectedIndex = 0;
	private activeMatch: TriggerMatch | null = null;
	private debounceTimer: number | null = null;
	private cachedVaultPaths: VaultPaths | null = null;

	constructor(private readonly options: ComposerDropdownOptions) {
		this.inputEl = options.inputEl;
		this.dropdownEl = options.containerEl.createDiv({
			cls: 'guki-composer-dropdown guki-hidden',
		});
		this.loadVaultPaths();
	}

	private loadVaultPaths(): void {
		if (this.cachedVaultPaths || !this.options.getVaultPaths) {
			return;
		}
		const vp = this.options.getVaultPaths();
		if (vp && typeof (vp as Promise<VaultPaths>).then === 'function') {
			void (vp as Promise<VaultPaths>).then((resolved) => {
				this.cachedVaultPaths = resolved;
				if (this.activeMatch?.kind === 'mention') {
					this.updateNow();
				}
			});
		} else if (vp) {
			this.cachedVaultPaths = vp as VaultPaths;
		}
	}

	isOpen(): boolean {
		return this.open && this.items.length > 0;
	}

	getActiveMatch(): TriggerMatch | null {
		return this.activeMatch;
	}

	getItems(): readonly DropdownItem[] {
		return this.items;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	selectNext(): void {
		this.flushDebounce();
		if (this.items.length <= 1) return;
		this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
		this.updateHighlight();
	}

	selectPrev(): void {
		this.flushDebounce();
		if (this.items.length <= 1) return;
		this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
		this.updateHighlight();
	}

	insertSelected(): boolean {
		this.flushDebounce();
		const item = this.items[this.selectedIndex];
		if (!item || !this.activeMatch) {
			return false;
		}
		if (this.activeMatch.kind === 'mention' && !this.cachedVaultPaths) {
			return false;
		}
		insertItem(this.inputEl, item, this.activeMatch);
		this.close();
		this.options.onInsert?.();
		return true;
	}

	close(): void {
		this.clearDebounce();
		this.open = false;
		this.items = [];
		this.itemEls = [];
		this.selectedIndex = 0;
		this.activeMatch = null;
		this.dropdownEl.empty();
		this.dropdownEl.addClass('guki-hidden');
	}

	destroy(): void {
		this.clearDebounce();
		this.dropdownEl.remove();
	}

	onInput(): void {
		const cursor = this.inputEl.selectionStart ?? this.inputEl.value.length;
		const match = matchTrigger(this.inputEl.value, cursor);
		if (!match) {
			this.close();
			return;
		}
		this.activeMatch = match;
		this.scheduleUpdate();
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private scheduleUpdate(): void {
		this.clearDebounce();
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.updateNow();
		}, 60);
	}

	flushDebounce(): void {
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
			this.updateNow();
		}
	}

	updateNow(): void {
		const match = this.activeMatch;
		if (!match) {
			this.close();
			return;
		}

		if (match.kind === 'slash') {
			const commands = this.options.getSlashCommands?.() ?? [];
			if (commands.length === 0) {
				this.close();
				return;
			}
			this.items = filterSlashCommands(commands, match.query);
		} else if (match.kind === 'mention') {
			if (!this.cachedVaultPaths) {
				this.loadVaultPaths();
			}
			this.items = filterVaultFiles(
				this.options.app,
				this.cachedVaultPaths,
				match.query,
				!!match.needsPrecedingSpace,
			);
		}

		if (this.items.length === 0) {
			this.open = false;
			this.dropdownEl.empty();
			this.dropdownEl.addClass('guki-hidden');
			return;
		}

		this.open = true;
		this.selectedIndex = 0;
		this.render();
	}

	private render(): void {
		this.dropdownEl.empty();
		this.dropdownEl.removeClass('guki-hidden');
		this.itemEls = [];
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const itemEl = this.dropdownEl.createDiv({
				cls: 'guki-composer-dropdown-item' + (i === this.selectedIndex ? ' is-selected guki-selected' : ''),
				text: item.label,
			});
			itemEl.addEventListener('click', (event: MouseEvent) => {
				event.preventDefault();
				if (this.activeMatch) {
					if (this.activeMatch.kind === 'mention' && !this.cachedVaultPaths) {
						return;
					}
					insertItem(this.inputEl, item, this.activeMatch);
					this.close();
					this.options.onInsert?.();
					this.inputEl.focus();
				}
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
				el.addClass('guki-selected');
			} else {
				el.removeClass('is-selected');
				el.removeClass('guki-selected');
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
}
