// Minimal stand-in so `docs/phase3-offline-checks.ts` can bundle for node. The production code
// under test only uses these two from `obsidian` as values (the `instanceof` check on the vault
// adapter); everything else it imports is type-only and erased at build time.
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

// Undefined by default, matching old Obsidian releases. i18n checks can install a reader without
// changing the behaviour of any existing section that imports this stub.
export let getLanguage;
export function setGetLanguageForChecks(reader) {
	getLanguage = reader;
}

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
// Global environment shims for Node runtime
if (typeof globalThis.window === 'undefined') {
	globalThis.window = globalThis;
}
if (typeof globalThis.window.requestAnimationFrame === 'undefined') {
	globalThis.window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
if (typeof globalThis.window.cancelAnimationFrame === 'undefined') {
	globalThis.window.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
	globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.ResizeObserver === 'undefined') {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

export class Events {
	constructor() {
		this._events = new Map();
	}
	on(name, callback, ctx) {
		if (!this._events.has(name)) this._events.set(name, new Set());
		const entry = { callback, ctx };
		this._events.get(name).add(entry);
		const ref = {
			name,
			entry,
			events: this,
			unload: () => this.offref(ref),
		};
		return ref;
	}
	off(name, callback) {
		const set = this._events.get(name);
		if (set) {
			for (const entry of set) {
				if (entry.callback === callback) {
					set.delete(entry);
				}
			}
		}
	}
	offref(ref) {
		if (ref && ref.name && ref.entry && this._events.has(ref.name)) {
			this._events.get(ref.name).delete(ref.entry);
		}
	}
	trigger(name, ...data) {
		const set = this._events.get(name);
		if (set) {
			for (const entry of [...set]) {
				entry.callback.apply(entry.ctx, data);
			}
		}
	}
	tryTrigger(ref, args) {
		if (ref && ref.entry) {
			ref.entry.callback.apply(ref.entry.ctx, args);
		}
	}
}

export class Component {
	constructor() {
		this._cleanups = [];
		this._children = [];
		this._loaded = false;
	}
	load() {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const child of this._children) {
			child.load();
		}
	}
	onload() {}
	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		for (const child of this._children) {
			child.unload();
		}
		this.onunload();
		for (const cleanup of this._cleanups) {
			try { cleanup(); } catch {}
		}
		this._cleanups = [];
	}
	onunload() {}
	addChild(component) {
		this._children.push(component);
		if (this._loaded) component.load();
		return component;
	}
	removeChild(component) {
		const idx = this._children.indexOf(component);
		if (idx !== -1) {
			this._children.splice(idx, 1);
			component.unload();
		}
		return component;
	}
	register(cb) {
		if (typeof cb === 'function') {
			this._cleanups.push(cb);
		}
	}
	registerEvent(eventRef) {
		if (typeof eventRef === 'function') {
			this._cleanups.push(eventRef);
		} else if (eventRef && typeof eventRef.unload === 'function') {
			this._cleanups.push(() => eventRef.unload());
		}
	}
	registerDomEvent(el, type, callback, options) {
		if (el?.addEventListener) {
			el.addEventListener(type, callback, options);
		}
		this.register(() => {
			if (el?.removeEventListener) {
				el.removeEventListener(type, callback, options);
			}
		});
	}
	registerInterval(id) {
		this.register(() => clearInterval(id));
		return id;
	}
}

export class Workspace extends Events {
	constructor(app) {
		super();
		this.app = app;
		this.rootSplit = { type: 'root' };
		this.leftSplit = { type: 'sidedock' };
		this.rightSplit = { type: 'sidedock' };
	}
}

export class Vault extends Events {
	constructor(app) {
		super();
		this.app = app;
		this.adapter = new FileSystemAdapter();
	}
	getFiles() { return []; }
	getAbstractFileByPath(_path) { return null; }
}

export class App {
	constructor() {
		this.workspace = new Workspace(this);
		this.vault = new Vault(this);
	}
}

export class View extends Component {
	constructor(leaf) {
		super();
		this.leaf = leaf;
		this.app = leaf?.app;
		this.containerEl = leaf?.containerEl ?? null;
		this._isOpened = false;
	}
	async onOpen() {}
	async onClose() {}
	getViewType() { return ''; }
	getState() { return {}; }
	async setState(_state, _result) {}
	getEphemeralState() { return {}; }
	getIcon() { return ''; }
	getDisplayText() { return ''; }
}

export class ItemView extends View {
	constructor(leaf) {
		super(leaf);
		this.contentEl = leaf?.contentEl ?? (this.containerEl?.createDiv ? this.containerEl.createDiv({ cls: 'view-content' }) : this.containerEl);
	}
	addAction(icon, title, callback) {
		const actionEl = this.containerEl?.createDiv
			? this.containerEl.createDiv({ cls: 'clickable-icon view-action' })
			: null;
		if (actionEl) {
			if (actionEl.setAttribute) {
				actionEl.setAttribute('aria-label', title);
			}
			if (callback) {
				this.registerDomEvent(actionEl, 'click', callback);
			}
		}
		return actionEl;
	}
}

export class WorkspaceLeaf extends Events {
	constructor(app, containerEl, contentEl) {
		super();
		this.app = app;
		if (this.app && !this.app.workspace) {
			this.app.workspace = new Workspace(this.app);
		}
		this.containerEl = containerEl ?? null;
		this.contentEl = contentEl ?? null;
		this.pinned = false;
		this.view = null;
		this._root = this.app?.workspace?.rightSplit ?? null;
		this.title = '';
		this.headerUpdates = 0;
	}
	updateHeader() {
		this.headerUpdates = (this.headerUpdates ?? 0) + 1;
		if (this.view && typeof this.view.getDisplayText === 'function') {
			this.title = this.view.getDisplayText();
		}
	}
	getRoot() {
		return this._root ?? this.app?.workspace?.rightSplit ?? null;
	}
	setRoot(root) {
		this._root = root;
	}
	setPinned(pinned) {
		this.pinned = pinned;
		this.trigger('pinned-change', pinned);
	}
	async open(view) {
		this.view = view;
		if (view) {
			view.leaf = this;
			if (!view.app) view.app = this.app;
			if (!view._isOpened && typeof view.onOpen === 'function') {
				view._isOpened = true;
				await view.onOpen();
			}
		}
		return view;
	}
}

export class Notice {
	constructor(message, duration) {
		this.message = message;
		this.duration = duration;
	}
	hide() {}
}

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
export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest ?? { dir: '' };
	}
	async loadData() { return {}; }
	async saveData(_data) {}
	addSettingTab() {}
	registerView() {}
	addRibbonIcon() {}
	registerEvent(eventRef) { super.registerEvent(eventRef); }
	addCommand() {}
}
