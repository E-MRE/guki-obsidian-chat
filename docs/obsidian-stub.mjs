// Minimal stand-in so `docs/phase3-offline-checks.ts` can bundle for node. The production code
// under test only uses these two from `obsidian` as values (the `instanceof` check on the vault
// adapter); everything else it imports is type-only and erased at build time.
export class App {}
export class FileSystemAdapter {
	getBasePath() { return ''; }
	getFullPath(path) {
		const base = this.getBasePath();
		return base ? `${base}/${path}` : path;
	}
}
// `session-manager` pulls in `binary-resolver` → `node-api`, which imports Platform as a value.
// Nothing in these checks calls it; the stub only has to exist for the bundle to link.
export const Platform = { isDesktop: true };

// Phase 6: `attachment-resolver.ts` checks `instanceof TFile` on whatever Obsidian's drag state
// hands back, and `instanceof FileSystemAdapter` before it trusts a path. Both have to be real
// classes here, not shapes, or the guard under test would answer "no" for every input and §O would
// pass by refusing everything.
export class TFile {}

export function prepareFuzzySearch(query) {
	const lowerQuery = query.toLowerCase();
	return function(text) {
		const lowerText = text.toLowerCase();
		let queryIdx = 0;
		let score = 0;
		const matches = [];
		for (let i = 0; i < lowerText.length; i++) {
			if (queryIdx < lowerQuery.length && lowerText[i] === lowerQuery[queryIdx]) {
				matches.push([i, i + 1]);
				queryIdx++;
				score += 10;
				if (i > 0 && matches.some(m => m[1] === i)) score += 5;
			}
		}
		if (queryIdx === lowerQuery.length) {
			return { score, matches };
		}
		return null;
	};
}

export function sortSearchResults(results) {
	results.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
}

// Phase 5: `permission-broker.ts` imports `normalizePath` as a value. Obsidian's own version
// collapses duplicate slashes and strips a leading one; the broker only ever builds a
// `.obsidian/plugins/...` path, so the identity of a well-formed path is all these checks need —
// and §K asserts on the exact string the broker asks the adapter for.
export function normalizePath(path) {
	return path.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

// §L drives `tool-card.ts`'s two display-string functions directly, which pulls the whole module
// — and its `setIcon` import — into the bundle. Only the two pure functions are called; the icon
// helper exists so the module links, and touching the DOM here would mean the checks were testing
// rendering rather than the decision.
export function setIcon() {}

// Phase 6 task 5 follow-up round: `chat-view.ts`'s `formatQuotaWarning` and `message-list.ts`'s
// `formatTurnMeta` / `withTurnMeta` are pure, exported, and worth driving directly rather than
// leaving as manual-only — but importing either module reaches these four as *values*:
// `chat-view.ts` extends `ItemView` and calls `new Notice(...)` in a non-`type` import that also
// names `WorkspaceLeaf`, and `message-list.ts` pulls in `markdown.ts`, which imports
// `MarkdownRenderer`. None of the checks instantiate any of the four or call a method on them —
// only the module graph has to link — so empty classes are enough.
export class ItemView {}
export class Notice {}
export class WorkspaceLeaf {}
export class MarkdownRenderer {
	static async render(_app, markdown, el) {
		if (el?.setText) el.setText(markdown);
	}
}

// Phase 7 task 3 round C: `settings-tab.ts` defines `GukiSettingTab extends PluginSettingTab`
// and instantiates `new Setting(containerEl)`. Stubs allow offline checks to import pure helpers.
export class PluginSettingTab {}
export class Setting {
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText() { return this; }
	addDropdown() { return this; }
	addToggle() { return this; }
	addButton() { return this; }
}

// Phase 7 task 3 round D: `main.ts` defines `GukiChatPlugin extends Plugin`.
// Section Y instantiates the plugin to test the full save-settings chain.
export class Plugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest ?? { dir: '' };
	}
	async loadData() { return {}; }
	async saveData(_data) {}
	addSettingTab() {}
	registerView() {}
	addRibbonIcon() {}
	registerEvent() {}
	addCommand() {}
}

