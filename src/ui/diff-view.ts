/**
 * The diff surface for `Edit` / `Write` / `MultiEdit` (PLAN Phase 4.3).
 *
 * Layout is **not decided here**: the element carries `guki-diff` and both panes are always
 * emitted, and `styles.css` puts them side by side under `.guki-wide` and stacked under
 * `.guki-narrow`. Deciding it in TypeScript would mean re-rendering the diff every time the panel
 * is dragged between the main area and a sidebar, and the width class already exists and is
 * already kept correct (`ChatView.applyWidthClass`).
 *
 * The diff itself is line-based and deliberately simple: a common prefix and a common suffix are
 * held back, and everything between them is shown as removed-then-added. That is enough to make an
 * edit legible without pulling in a diff library for a panel that shows one hunk at a time.
 */

import type { PriorContent } from '../core/chat-state';

export interface DiffInput {
	/** Absent for `Write` unless prior content was supplied — see `PriorContent`. */
	oldText?: string;
	/**
	 * Set when the Before side is genuinely unknown rather than empty. Kept separate from
	 * `oldText === ''` because those two must not render alike.
	 */
	oldUnknown?: boolean;
	newText: string;
	/**
	 * The edited file, when the tool input carried one.
	 *
	 * Parsed but **not rendered by the card**: the header summary already prints it, and printing
	 * it twice was one of Emre's Phase 4 acceptance findings. Kept because it is part of what an
	 * edit input means — Phase 5's permission card needs the same target path out of the same
	 * parser — and because `diffFromToolInput` is checked on it (`docs/offline-checks.ts` §G).
	 */
	path?: string;
}

/**
 * Reads a tool `input` of unknown shape into a diff, or returns null when it is not one.
 *
 * Every field access is guarded: this object comes off the wire, and an `Edit` whose arguments do
 * not look the way we expect must fall back to the plain summary rather than throw inside the
 * renderer and take the whole card down with it.
 */
export function diffFromToolInput(
	toolName: string | undefined,
	input: unknown,
	/**
	 * Only `Write` uses it — `Edit` and `MultiEdit` carry their own `old_string`, which is real
	 * content and needs no lookup. Omitted means `unknown`, which is what keeps the tool card
	 * unchanged: it renders a call that has already happened and never looks at the file.
	 */
	prior: PriorContent = { kind: 'unknown' },
): DiffInput | null {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		return null;
	}
	const record = input as Record<string, unknown>;
	const path = typeof record.file_path === 'string' ? record.file_path : undefined;

	if (toolName === 'Write') {
		if (typeof record.content !== 'string') {
			return null;
		}
		if (prior.kind === 'content') {
			return { oldText: prior.text, newText: record.content, path };
		}
		if (prior.kind === 'absent') {
			// Verifiably nothing there. `(empty)` is the honest Before for a file being created.
			return { oldText: '', newText: record.content, path };
		}
		return { newText: record.content, oldUnknown: true, path };
	}

	if (toolName === 'Edit') {
		const oldText = record.old_string;
		const newText = record.new_string;
		if (typeof oldText !== 'string' || typeof newText !== 'string') {
			return null;
		}
		return { oldText, newText, path };
	}

	if (toolName === 'MultiEdit') {
		// One card, several hunks. They are joined rather than rendered as separate diffs: the
		// card is a summary surface, and the file path is the same for all of them.
		const edits = record.edits;
		if (!Array.isArray(edits)) {
			return null;
		}
		const olds: string[] = [];
		const news: string[] = [];
		for (const edit of edits) {
			if (typeof edit !== 'object' || edit === null) {
				continue;
			}
			const e = edit as Record<string, unknown>;
			if (typeof e.old_string === 'string' && typeof e.new_string === 'string') {
				olds.push(e.old_string);
				news.push(e.new_string);
			}
		}
		if (news.length === 0) {
			return null;
		}
		return { oldText: olds.join('\n…\n'), newText: news.join('\n…\n'), path };
	}

	return null;
}

/** Line counts for the card's one-line summary: `+12 −3`. */
export interface DiffStats {
	added: number;
	removed: number;
}

interface DiffHunk {
	context: string[];
	removed: string[];
	added: string[];
	trailing: string[];
}

/**
 * Splits text into display lines.
 *
 * A file that ends in a newline — which is nearly every file — makes `split('\n')` produce a
 * trailing empty element that is not a line. It was both counted and drawn: a three-line `Write`
 * reported `+4 −0` and rendered a fourth, empty, green row (Emre's Phase 4 acceptance run, step 2).
 * Only **one** trailing empty element is dropped, because `"a\n\n"` really does end with a blank
 * line and that one must survive.
 */
function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function computeHunk(diff: DiffInput): DiffHunk {
	const oldLines = diff.oldText === undefined ? [] : splitLines(diff.oldText);
	const newLines = splitLines(diff.newText);

	// Common prefix, then common suffix out of what is left. The two scans must not overlap, or a
	// repeated line would be counted as both context and trailing and the hunk would go negative.
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}

	return {
		context: oldLines.slice(0, prefix),
		removed: oldLines.slice(prefix, oldLines.length - suffix),
		added: newLines.slice(prefix, newLines.length - suffix),
		trailing: suffix === 0 ? [] : oldLines.slice(oldLines.length - suffix),
	};
}

export function diffStats(diff: DiffInput): DiffStats {
	const hunk = computeHunk(diff);
	return { added: hunk.added.length, removed: hunk.removed.length };
}

/** How many unchanged lines are kept on either side of the change, for orientation. */
const CONTEXT_LINES = 2;

/**
 * Renders the diff into `parent`, replacing whatever was there.
 *
 * Both panes are always created even when one of them is empty — a `Write` has no "before" — so
 * the narrow layout has something to stack and the panes do not jump around between renders.
 */
export function renderDiff(parent: HTMLElement, diff: DiffInput): void {
	parent.empty();
	parent.addClass('guki-diff');

	const hunk = computeHunk(diff);
	const leadIn = hunk.context.slice(Math.max(0, hunk.context.length - CONTEXT_LINES));
	const leadOut = hunk.trailing.slice(0, CONTEXT_LINES);

	renderPane(parent, 'before', leadIn, hunk.removed, leadOut, '−', emptyPaneText(diff, 'before'));
	renderPane(parent, 'after', leadIn, hunk.added, leadOut, '+', emptyPaneText(diff, 'after'));
}

/**
 * What a pane with no lines says. Exported so the three states can be asserted with no DOM in the
 * loop — `renderDiff` needs Obsidian's element helpers, and this is the decision inside it.
 *
 * `(empty)` is a claim about the file. It is only ever made about a Before pane when someone
 * actually looked.
 */
export function emptyPaneText(diff: DiffInput, side: 'before' | 'after'): string {
	if (side === 'before' && diff.oldUnknown === true) {
		return '(not read)';
	}
	return '(empty)';
}

function renderPane(
	parent: HTMLElement,
	side: 'before' | 'after',
	leadIn: string[],
	changed: string[],
	leadOut: string[],
	marker: string,
	emptyText: string,
): void {
	const pane = parent.createDiv({ cls: `guki-diff-pane guki-diff-${side}` });
	pane.createDiv({ cls: 'guki-diff-pane-title', text: side === 'before' ? 'Before' : 'After' });
	const body = pane.createDiv({ cls: 'guki-diff-lines' });

	if (leadIn.length === 0 && changed.length === 0 && leadOut.length === 0) {
		body.createDiv({ cls: 'guki-diff-line guki-diff-empty', text: emptyText });
		return;
	}

	for (const line of leadIn) {
		addLine(body, 'context', ' ', line);
	}
	for (const line of changed) {
		addLine(body, side === 'before' ? 'removed' : 'added', marker, line);
	}
	for (const line of leadOut) {
		addLine(body, 'context', ' ', line);
	}
}

function addLine(body: HTMLElement, kind: string, marker: string, text: string): void {
	const line = body.createDiv({ cls: `guki-diff-line guki-diff-${kind}` });
	line.createSpan({ cls: 'guki-diff-marker', text: marker });
	// `setText`, never markdown: this is source, and it must survive verbatim.
	line.createSpan({ cls: 'guki-diff-text', text });
}
