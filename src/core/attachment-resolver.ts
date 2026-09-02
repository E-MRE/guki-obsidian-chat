/**
 * The impure half of attachments: turning something the user indicated — the active note, or a
 * file dragged out of Obsidian's own UI — into an `Attachment` whose path has been *verified*
 * inside the vault.
 *
 * Split from `attachments.ts` for the reason `vault-path-resolver.ts` is split from
 * `permission-policy.ts`: the rule stays fixture-drivable, and the part that needs `App`, a vault
 * adapter and a real filesystem is kept small.
 *
 * **Nothing here may return an `Attachment` it has not resolved through `VaultPaths`.** The `@`
 * form skips the permission system entirely (PLAN's Phase 6 syntax table), so "we got this from
 * Obsidian's file explorer, it must be in the vault" is not good enough — a vault file can be a
 * symlink pointing out, and that is exactly the case a name-based check misses.
 */
import { FileSystemAdapter, TFile, type App } from 'obsidian';
import type { Attachment } from './attachments';
import { containsPath, type VaultPaths } from './permission-policy';

/**
 * Obsidian's internal drag state. **Not in `obsidian.d.ts`** — there is no public drag API at all
 * (checked in 1.13.7: the only drag surface the types expose is the `editor-drop` workspace
 * event). So this is declared narrowly and every field is re-checked at the point of use.
 *
 * What it holds was read off the app's own bundle rather than guessed
 * (`Obsidian.app/Contents/Resources/obsidian.asar` → `app.js`, 1.13.7):
 *
 *   dragFile(evt, file, source)  → { source, type: 'file',  icon, title, file: TFile }
 *   dragFiles(evt, files, source) → { source, type: 'files', icon, title, files: TFile[] }
 *
 * A real `TFile` is on there, which is why this is the preferred source: it is lossless, where the
 * `dataTransfer` payload is not (see `vaultPathFromObsidianUrl`).
 */
interface ObsidianDraggable {
	type?: unknown;
	file?: unknown;
	files?: unknown;
}

interface DragManagerHost {
	dragManager?: {
		draggable?: ObsidianDraggable | null;
	};
}

/**
 * Verifies one vault file and builds its chip, or returns `null`.
 *
 * `null` means "do not attach this", and every route to it is deliberate:
 * - the adapter is not a `FileSystemAdapter`, so there is no filesystem path to hand over;
 * - the path did not resolve (deleted between the drag and the drop);
 * - **it resolved outside the vault** — a symlinked note. Out-of-vault attachments are task 2,
 *   and until that exists the honest answer is to refuse rather than to `@` it.
 */
export function resolveVaultFile(app: App, paths: VaultPaths, file: TFile): Attachment | null {
	const adapter = app.vault.adapter;
	// `instanceof`, not a cast: the same rule `SessionManager.vaultPath` follows. A cast that
	// succeeds on a non-file adapter would produce a path string that means nothing.
	if (!(adapter instanceof FileSystemAdapter)) {
		return null;
	}

	// `getFullPath` takes the vault-relative path and returns an absolute one (obsidian.d.ts:2971).
	const fullPath = adapter.getFullPath(file.path);

	// Resolved once and kept, rather than calling `isInside` and then re-deriving: the path that
	// goes in the message must be the *same* string that was checked. Resolving twice leaves a
	// window where the two disagree, which is the check-to-use gap `permission-policy.ts` is
	// careful about everywhere else.
	const resolved = paths.resolve(fullPath);
	if (!containsPath(paths.root, resolved)) {
		return null;
	}

	return {
		// Non-null by `containsPath`, which answers false for null.
		absolutePath: resolved ?? fullPath,
		displayName: file.name,
		location: 'in-vault',
	};
}

/** The active note, or `null` when the active leaf is not a file — settings, graph, our own panel. */
export function activeVaultFile(app: App): TFile | null {
	return app.workspace.getActiveFile();
}

/**
 * The vault files behind a drop, in the order Obsidian was dragging them.
 *
 * Two sources, in this order, and the order is the point:
 *
 * 1. `app.dragManager.draggable` — carries the real `TFile`. Lossless.
 * 2. The `dataTransfer` payload — lossy, so only a fallback.
 *
 * Reading `dataTransfer` at all needs care. Obsidian's `dragFile` sets `text/plain` **and**
 * `text/uri-list` to `app.getObsidianUrl(file)` (measured in `app.js`), and that URL is built with
 * `Hl(path)`, which **strips the `.md` extension**:
 *
 *   obsidian://open?vault=<name>&file=<vault-relative path, no .md for markdown>
 *
 * So the URL alone cannot tell `Note` (a markdown file) from `Note` (an extensionless attachment)
 * or from a folder called `Note`. That ambiguity is resolved the only way it safely can be — by
 * asking the vault which of the candidates is a real file — and never by assuming `.md`.
 */
export function droppedVaultFiles(app: App, dataTransfer: DataTransfer | null): TFile[] {
	const fromDragManager = draggedVaultFiles(app);
	if (fromDragManager.length > 0) {
		return fromDragManager;
	}
	return vaultFilesFromDataTransfer(app, dataTransfer);
}

function draggedVaultFiles(app: App): TFile[] {
	const draggable = (app as unknown as DragManagerHost).dragManager?.draggable;
	if (!draggable) {
		return [];
	}
	// `type` is checked but not trusted to be the *only* signal: what matters is that a real TFile
	// is present, so both shapes are read and each entry is `instanceof`-checked.
	const files: TFile[] = [];
	if (draggable.file instanceof TFile) {
		files.push(draggable.file);
	}
	if (Array.isArray(draggable.files)) {
		for (const entry of draggable.files) {
			if (entry instanceof TFile) {
				files.push(entry);
			}
		}
	}
	return files;
}

function vaultFilesFromDataTransfer(app: App, dataTransfer: DataTransfer | null): TFile[] {
	if (!dataTransfer) {
		return [];
	}
	// `text/uri-list` first: it is the typed field for this, and `text/plain` carries the same
	// string only because Obsidian sets both.
	const raw = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain');
	if (raw.length === 0) {
		return [];
	}

	const files: TFile[] = [];
	// A uri-list is newline-separated and `#`-prefixed lines are comments, per RFC 2483.
	for (const line of raw.split('\n')) {
		const candidate = line.trim();
		if (candidate.length === 0 || candidate.startsWith('#')) {
			continue;
		}
		const file = vaultFileFromObsidianUrl(app, candidate);
		if (file && !files.includes(file)) {
			files.push(file);
		}
	}
	return files;
}

/**
 * `obsidian://open?vault=…&file=…` to a `TFile`, or `null`.
 *
 * The vault name is checked: a URL for a *different* open vault would otherwise resolve against
 * this one's paths and attach whatever happened to sit at the same relative path.
 */
function vaultFileFromObsidianUrl(app: App, candidate: string): TFile | null {
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (url.protocol !== 'obsidian:') {
		return null;
	}
	const vaultName = url.searchParams.get('vault');
	if (vaultName !== null && vaultName !== app.vault.getName()) {
		return null;
	}
	const relative = url.searchParams.get('file');
	if (relative === null || relative.length === 0) {
		return null;
	}
	// The extension the URL dropped, put back only if the vault agrees a file is there. `.md` is
	// the only extension `Hl` strips, so it is the only one guessed — and it is guessed second, so
	// a real extensionless file still wins.
	return app.vault.getFileByPath(relative) ?? app.vault.getFileByPath(`${relative}.md`);
}
