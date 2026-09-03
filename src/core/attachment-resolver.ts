/**
 * The impure half of attachments: turning something the user indicated — the active note, a file
 * dragged out of Obsidian's own UI, or a file that arrived from outside Obsidian entirely — into an
 * `Attachment` whose path has been *resolved*, and whose side of the vault boundary was decided by
 * that resolution.
 *
 * …and one thing that is not a file at all. `triageImageFiles` / `readImageAttachment` at the
 * bottom handle the **pasted clipboard image**: a bitmap with no path, which therefore has no vault
 * boundary to be on and gets no `@` and no card, because it involves no tool call. Everything above
 * them is about paths; those two are the single byte exception (PLAN Phase 6 task 3).
 *
 * Split from `attachments.ts` for the reason `vault-path-resolver.ts` is split from
 * `permission-policy.ts`: the rule stays fixture-drivable, and the part that needs `App`, a vault
 * adapter and a real filesystem is kept small.
 *
 * **Nothing here may return an `Attachment` it has not resolved through `VaultPaths`.** The `@`
 * form skips the permission system entirely (PLAN's Phase 6 syntax table), so "we got this from
 * Obsidian's file explorer, it must be in the vault" is not good enough — a vault file can be a
 * symlink pointing out, and that is exactly the case a name-based check misses. The mirror of it is
 * just as important: **a file dragged in from Finder that happens to live inside the vault is
 * in-vault and gets an `@`.** The question is always where the file *is*, never where it came from.
 */
import { FileSystemAdapter, TFile, type App } from 'obsidian';
import { absolutePathForFile, nodeFs } from '../cli/node-api';
import {
	encodeBase64,
	isImageMediaType,
	type ImageAttachment,
	type PathAttachment,
} from './attachments';
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
export function resolveVaultFile(app: App, paths: VaultPaths, file: TFile): PathAttachment | null {
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
		kind: 'path',
		// Non-null by `containsPath`, which answers false for null.
		absolutePath: resolved ?? fullPath,
		displayName: file.name,
		location: 'in-vault',
	};
}

/**
 * A file that arrived from outside Obsidian — a Finder drag, a paste, or the picker — after the
 * `File` has been turned into a path and before anything has been decided about it.
 */
export interface ExternalFile {
	/** Straight off the `File`, so the chip and any refusal name what the OS calls the file. */
	displayName: string;
	/** As `absolutePathForFile` gave it: absolute, but **not** yet resolved or checked. */
	absolutePath: string;
}

/**
 * What became of one external file. A refusal carries its reason because the two read differently
 * to the person who just dropped something, and a Notice that cannot say which is which is a
 * Notice that reads as "the panel is broken".
 */
export type ExternalResolution =
	| { kind: 'attached'; attachment: PathAttachment }
	| { kind: 'refused'; reason: 'directory' | 'unresolvable'; displayName: string };

/**
 * The paths behind a drop's, a paste's or a picker's `File`s, with the ones that have no path
 * dropped.
 *
 * `ArrayLike<File>` rather than `FileList` so this is drivable from a fixture — a `FileList` cannot
 * be constructed outside a browser, and the null-dropping is the part worth asserting.
 *
 * **A `File` with no path is passed over in silence, and is now picked up by `triageImageFiles`.**
 * That is the pasted clipboard image, the one case that has to send bytes. It is skipped here
 * rather than reported because the two doors are consulted in turn over the same `File` list, and a
 * refusal from this one would fire on every pasted screenshot.
 */
export function externalFilePaths(files: ArrayLike<File> | null | undefined): ExternalFile[] {
	if (!files) {
		return [];
	}
	const resolved: ExternalFile[] = [];
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		if (!file) {
			continue;
		}
		const absolutePath = absolutePathForFile(file);
		if (absolutePath === null) {
			continue;
		}
		resolved.push({ displayName: file.name, absolutePath });
	}
	return resolved;
}

/**
 * The clipboard's generic name for every screenshot, measured in task 2's acceptance run: a
 * Cmd+Shift+4 grab arrives as `{name: 'image.png', type: 'image/png', size: 27878}`. Two of them
 * would produce two chips reading `image.png`, which tells the reader nothing, so this one value is
 * replaced by a label that at least says where it came from. The thumbnail carries the identity.
 */
const CLIPBOARD_GENERIC_NAME = 'image.png';
const PASTED_IMAGE_LABEL = 'Pasted image';

/** Ids for image chips. A counter, not a hash of the bytes: two pastes of one screenshot are two. */
let imageSequence = 0;

/**
 * A path-less image that arrived in a format the model cannot read, so it never becomes a chip.
 *
 * `mediaType` is carried so the notice can name it. A refusal the reader cannot act on is a refusal
 * that reads as a bug, and "that is a `.svg`" is exactly the actionable part.
 */
export interface UnsupportedImage {
	displayName: string;
	mediaType: string;
}

/**
 * What a drop's or a paste's `File`s hold once the ones with paths have been taken by task 2.
 *
 * **Synchronous, and it has to be**: `onPasted`'s return value decides `preventDefault()`, so the
 * question "is any of this ours" must be answerable before a single byte has been read. Only the
 * reading that follows is awaited.
 */
export interface ImageTriage {
	/** Path-less, and in one of the formats an `image` block may carry. Ready to be read. */
	images: File[];
	/** Path-less images we will not send, with the reason the notice needs. */
	unsupported: UnsupportedImage[];
}

/**
 * Splits the path-less `File`s out of a drop or a paste — the clipboard-image case, and the only
 * attachment in the whole design that sends bytes.
 *
 * **One rule branches everything, and it is the same rule task 2 uses: does the `File` have a
 * path?** With a path it is task 2's chip and this function ignores it entirely; without one there
 * is nothing to `Read`, so it is an image or it is nothing.
 *
 * Three outcomes, and the third is deliberate:
 *
 * - a path-less `File` whose `type` the model can read → `images`, and it becomes bytes;
 * - a path-less `File` whose `type` is some *other* `image/*` → `unsupported`, refused **at paste
 *   time with a named reason**. Without this the turn would be sent, cost money and come back
 *   `subtype: "success"` with the model saying it could not see the picture — measured (§M3), and
 *   an ordinary-looking bubble is a worse answer than a notice;
 * - a path-less `File` that is not an image at all → **ignored in silence**, exactly as task 2
 *   ignored every path-less `File`. We have never seen one and have no idea what it would be, and
 *   inventing a notice for it would train the reader to ignore notices.
 *
 * `ArrayLike<File>` rather than `FileList` so this is drivable from a fixture — a `FileList` cannot
 * be constructed outside a browser.
 */
export function triageImageFiles(files: ArrayLike<File> | null | undefined): ImageTriage {
	const triage: ImageTriage = { images: [], unsupported: [] };
	if (!files) {
		return triage;
	}
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		if (!file) {
			continue;
		}
		// A file with a path is task 2's, whatever its type. A screenshot dragged from macOS's
		// bottom-right thumbnail is a real file in `/private/var/…` and goes through that door.
		if (absolutePathForFile(file) !== null) {
			continue;
		}
		const mediaType = file.type;
		if (isImageMediaType(mediaType)) {
			triage.images.push(file);
		} else if (mediaType.startsWith('image/')) {
			triage.unsupported.push({ displayName: imageDisplayName(file), mediaType });
		}
	}
	return triage;
}

/**
 * Reads one path-less image into the block the CLI is handed. `null` when the bytes cannot be read.
 *
 * The media type is re-checked rather than trusted from `triageImageFiles`, because this is the
 * function that stamps it onto the outgoing block and the check belongs where the claim is made.
 *
 * `file.arrayBuffer()` rather than `FileReader`: it is the same platform read without the event
 * dance, and it hands over a buffer `encodeBase64` can chunk. Neither route touches Node, so
 * `src/cli/node-api.ts` gained no `Buffer` accessor for this — that file exists so nothing else
 * reaches for `window.require`, and there was no reason to widen it.
 */
export async function readImageAttachment(file: File): Promise<ImageAttachment | null> {
	const mediaType = file.type;
	if (!isImageMediaType(mediaType)) {
		return null;
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch {
		return null;
	}
	// An empty bitmap is not something to send: it would decode to nothing at the far end and come
	// back as a successful turn in which the model says it saw no image (§M3).
	if (bytes.length === 0) {
		return null;
	}
	imageSequence += 1;
	return {
		kind: 'image',
		id: `image-${String(imageSequence)}`,
		displayName: imageDisplayName(file),
		mediaType,
		data: encodeBase64(bytes),
		byteLength: bytes.length,
	};
}

function imageDisplayName(file: File): string {
	const name = file.name;
	if (name.length === 0 || name === CLIPBOARD_GENERIC_NAME) {
		return PASTED_IMAGE_LABEL;
	}
	return name;
}

/**
 * The sibling of `resolveVaultFile`, for a path that came from outside Obsidian. **Both locations
 * are legal outcomes here, and that is the whole point.**
 *
 * `location` is set from the *answer* `containsPath` gives about the resolved path, never from the
 * fact that the file arrived through an external door. A file dragged in from Finder that lives in
 * the vault becomes an `@` reference, exactly as if it had been dragged from the file explorer; a
 * vault path that resolves through a symlink out of the vault becomes a plain path, and the model's
 * `Read` of it raises a card. "It came from outside Obsidian, so treat it as outside the vault" is
 * the wrong half of the rule, and it is the plausible-sounding one.
 *
 * Two refusals, and neither is about the vault boundary:
 *
 * - **`directory`** — `Read` on a directory errors, so a dropped folder must never become a chip.
 *   The check is `statSync(...).isDirectory()` on the *resolved* path rather than an inspection of
 *   the `File`, whose `type` and `size` for a directory are platform trivia. Resolving first also
 *   means a symlink to a directory is caught.
 * - **`unresolvable`** — the path did not resolve at all, or it resolved and then failed to stat.
 *   An external `File` names something that existed a moment ago, so this is the file having gone
 *   away underneath us. Nothing to attach, and it is *not* the same case as a missing in-vault file
 *   (see §O3): there, the chip's source is a `TFile` Obsidian is still holding, and the boundary,
 *   not existence, is the security question.
 *
 * There is deliberately **no extension filter**. Whatever `Read` opens works, and what it cannot
 * open produces its own error — which is the honest place for it (PLAN Phase 6).
 */
export async function resolveExternalFile(
	paths: VaultPaths,
	file: ExternalFile,
): Promise<ExternalResolution> {
	const { absolutePath, displayName } = file;

	// Resolved once and kept, for the reason `resolveVaultFile` resolves once and keeps: the string
	// that goes in the message must be the one that was checked, or there is a check-to-use gap.
	const resolved = paths.resolve(absolutePath);
	// **This is the narrowing, not a second safety net, and the sweep says so.** Removing it does
	// not turn the checks red (task 2's reversion row 5): `statSync(null)` throws, the `catch`
	// below answers `unresolvable`, and the outcome is identical. It is kept because it is what
	// lets the rest of the function be typed without a `!` — scattering one at each site would
	// silence the compiler without saying why the value is there. Do not read it as a guard.
	if (resolved === null) {
		return { kind: 'refused', reason: 'unresolvable', displayName };
	}

	const fs = await nodeFs();
	let stats;
	try {
		stats = fs.statSync(resolved);
	} catch {
		return { kind: 'refused', reason: 'unresolvable', displayName };
	}
	if (stats.isDirectory()) {
		return { kind: 'refused', reason: 'directory', displayName };
	}

	return {
		kind: 'attached',
		attachment: {
			kind: 'path',
			absolutePath: resolved,
			displayName,
			// The one line this function exists for. `containsPath` answers about the resolved
			// path, and its answer — not the door the file came through — picks the syntax.
			location: containsPath(paths.root, resolved) ? 'in-vault' : 'outside-vault',
		},
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
