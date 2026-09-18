/**
 * Turns a `~/.claude/projects/<slug>` directory into `SessionSummary[]`.
 *
 * Measured against the real directory (PHASE6-TASK6-STATE §M, 2026-09-03), not against
 * `docs/RESEARCH.md` §D's single-file sample: `readdir` returns two kinds of entries and only one
 * is a session (`.jsonl` files; same-named directories hold offloaded tool output), `ai-title` and
 * `cost-state` are each missing from a large minority of real sessions and never sit at a fixed
 * offset, and a file being actively appended to can hand back a torn trailing line. So this scans
 * every line of every `.jsonl` file, treats `ai-title` and `cost-state` as optional, and drops a
 * single unparsable line rather than the file it came from.
 */
import { nodeFs, nodePath } from '../cli/node-api';
import { t } from '../i18n';

export interface SessionSummary {
	/** Taken from the filename, not parsed — RESEARCH §D and this task's own measurement agree the
	 *  two never disagree, and the filename is free. */
	sessionId: string;
	/** From `ai-title`. Absent on ~40% of real sessions (short or aborted ones) — not a defect to
	 *  paper over with a placeholder. */
	title?: string;
	/** Heuristic title derived from the first user prompt when `ai-title` is absent.
	 *  Preserved in a distinct field to maintain semantic honesty: callers can distinguish
	 *  a genuine `ai-title` from a derived one without silent conflation (Phase 8 Görev 8). */
	derivedTitle?: string;
	customTitle?: string;
	/** ISO timestamp of the first `type: "user"` record in the file. Every sampled file has one; a
	 *  file that somehow doesn't is left out of the result rather than given a fabricated time. */
	startedAt: string;
	/** `cost-state`'s `totalCostUSD`, already summed across models — do not recompute from
	 *  `modelUsage`. Absent on ~52% of real sessions (more missing than present). */
	costUsd?: number;
}

/**
 * Sensible maximum display length for a derived session title.
 *
 * 60 characters is chosen because:
 * 1. Measured against Obsidian's narrow sidebar layout (< 480px, typically ~280-320px
 *    measured in PHASE6-TASK1), a history row must fit the title, the session date (~10 chars),
 *    and an optional cost badge (~6 chars) on one line without wrapping or visual truncation.
 * 2. 60 characters captures the core intent or opening question of typical user prompts
 *    (e.g. "Fix the bug in session-index scanner where torn lines...") while omitting
 *    superfluous boilerplate.
 * 3. Keeps memory footprint small across directories containing hundreds of session files.
 */
export const MAX_DERIVED_TITLE_LENGTH = 60;

/**
 * Extracts prompt text from a `type: "user"` record.
 *
 * Handles both plain string messages and content-block arrays (`message.content` or `content`).
 * Non-text blocks (such as `image` or `tool_result`) are ignored.
 * Tool use results (`toolUseResult` present: measured on 17,151 of 21,059 real user records under
 * `~/.claude/projects/` as an object, string, or list, and NEVER boolean `true`), compaction
 * summaries (`isCompactSummary: true`), and metadata records (`isMeta: true`) are excluded because
 * they represent tool responses or system bookkeeping, not human prompts.
 */
export function extractUserPromptText(r: Record<string, unknown>): string | undefined {
	if (r.toolUseResult !== undefined || r.isCompactSummary === true || r.isMeta === true) {
		return undefined;
	}
	const msg = typeof r.message === 'object' && r.message !== null
		? (r.message as Record<string, unknown>)
		: null;
	const rawContent = msg !== null && 'content' in msg
		? msg.content
		: ('content' in r ? r.content : r.message);

	if (typeof rawContent === 'string') {
		const trimmed = rawContent.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}

	if (Array.isArray(rawContent)) {
		const textParts: string[] = [];
		for (const block of rawContent) {
			if (
				typeof block === 'object' &&
				block !== null &&
				(block as Record<string, unknown>).type === 'text' &&
				typeof (block as Record<string, unknown>).text === 'string'
			) {
				const t = ((block as Record<string, unknown>).text as string).trim();
				if (t.length > 0) {
					textParts.push(t);
				}
			}
		}
		if (textParts.length > 0) {
			return textParts.join(' ');
		}
	}

	return undefined;
}

/**
 * Tests whether a user record is explicitly marked as human-origin.
 *
 * In transcript schema measurements (capture-phase8-transcript-schema.md §1.3), `origin: {kind: "human"}`
 * and `promptSource: "typed"` appear on ~4.9% of user records in modern CLI sessions.
 * Synthetic/system-injected prompts (e.g. `origin: {kind: "synthetic"}` or tool-injected) make terrible
 * titles and must not displace genuine human prompts.
 */
export function isExplicitHumanUser(r: Record<string, unknown>): boolean {
	if (r.toolUseResult !== undefined || r.isCompactSummary === true || r.isMeta === true) {
		return false;
	}
	const origin = typeof r.origin === 'object' && r.origin !== null
		? (r.origin as Record<string, unknown>)
		: null;
	if (origin !== null && origin.kind === 'human') {
		return true;
	}
	if (r.promptSource === 'typed') {
		return true;
	}
	return false;
}

/**
 * Tests whether a user record is explicitly synthetic, a tool result, or metadata.
 *
 * Measured across 21,059 real user records under `~/.claude/projects/`:
 * - `toolUseResult` is present on 17,151 records (15,496 objects/dicts, 1,617 strings, 38 lists; 0 boolean `true`).
 *   Testing presence rather than `=== true` guards real on-disk records (Defect 1).
 * - `isMeta: true` is present on 317 records and represents system skill/metadata prompts, not user queries (Defect 3).
 * - `isCompactSummary: true` is present on 27 records and represents conversation compaction summaries.
 */
export function isSyntheticUser(r: Record<string, unknown>): boolean {
	if (r.toolUseResult !== undefined || r.isCompactSummary === true || r.isMeta === true) {
		return true;
	}
	const origin = typeof r.origin === 'object' && r.origin !== null
		? (r.origin as Record<string, unknown>)
		: null;
	if (origin !== null && origin.kind !== 'human') {
		return true;
	}
	return false;
}

/**
 * Normalises derived prompt text into a single-line title:
 * - Collapses consecutive whitespace and newlines to a single space.
 * - Trims leading and trailing whitespace.
 * - Truncates to MAX_DERIVED_TITLE_LENGTH (60 chars).
 * - Returns `undefined` if no usable text remains (never an empty string or placeholder).
 */
export function sanitizeDerivedTitle(text: string): string | undefined {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length === 0) {
		return undefined;
	}
	if (collapsed.length <= MAX_DERIVED_TITLE_LENGTH) {
		return collapsed;
	}
	return collapsed.slice(0, MAX_DERIVED_TITLE_LENGTH);
}

export type TitleSource = 'custom' | 'ai' | 'derived' | 'none';

/**
 * Resolves the effective session title and its provenance following the single precedence rule:
 * customTitle > title (ai-title) > derivedTitle (prompt fallback) > 'Untitled session' (none).
 */
export function resolveSessionTitle(s: SessionSummary): { text: string; source: TitleSource } {
	if (typeof s.customTitle === 'string' && s.customTitle.trim().length > 0) {
		return { text: s.customTitle.trim(), source: 'custom' };
	}
	if (typeof s.title === 'string' && s.title.trim().length > 0) {
		return { text: s.title, source: 'ai' };
	}
	if (typeof s.derivedTitle === 'string' && s.derivedTitle.trim().length > 0) {
		return { text: s.derivedTitle, source: 'derived' };
	}
	return { text: t('core.sessionIndex.untitledSession'), source: 'none' };
}

/**
 * Returns the conversation name for the panel header, or null if the session has no proper name.
 * Returns text when source is 'custom' or 'ai'. Returns null for 'derived' (a heuristic trim is
 * not a name and must never appear in the header) or 'none'.
 */
export function panelTitleFor(s: SessionSummary | null | undefined): string | null {
	if (!s) {
		return null;
	}
	const resolved = resolveSessionTitle(s);
	if (resolved.source === 'custom' || resolved.source === 'ai') {
		return resolved.text;
	}
	return null;
}

/**
 * Returns the effective display title and whether it was derived.
 * Preserves semantic honesty: delegates to `resolveSessionTitle`.
 * Returns `null` if the session has neither title nor usable prompt text (source 'none').
 */
export function sessionDisplayTitle(summary: SessionSummary): { text: string; isDerived: boolean } | null {
	const resolved = resolveSessionTitle(summary);
	if (resolved.source === 'none') {
		return null;
	}
	return { text: resolved.text, isDerived: resolved.source === 'derived' };
}

/**
 * Mirrors the Claude Code CLI's own project-directory naming: every character that
 * isn't a letter or digit becomes `-`, not just `/`. A vault path containing `.` or `_`
 * (e.g. a username like `enes.ileri`) previously produced a slug that never matched the
 * CLI's real directory name, so history silently showed empty for those users.
 */
export function projectSlug(vaultPath: string): string {
	return vaultPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * One `.jsonl` file → a summary, or `null` if it never turns up a `user` record to date it by.
 *
 * Per-line `JSON.parse` in its own `try`/`catch`: a session file still being written to can end in
 * a torn line, and one bad line must not cost the rest of the file's `ai-title` or `cost-state`.
 * Reads prompt text from user records during the same pass to derive a fallback title if `ai-title`
 * is absent. The title is derived from the first usable user message (not a tool result, not a
 * compaction summary, not synthetic, and not metadata). Once an acceptable first message is found,
 * later messages cannot replace it.
 */
export async function buildSessionSummary(filePath: string, sessionId: string): Promise<SessionSummary | null> {
	const fs = await nodeFs();
	const content = await fs.promises.readFile(filePath, 'utf8');

	let startedAt: string | undefined;
	let title: string | undefined;
	let costUsd: number | undefined;
	let firstUsableText: string | undefined;

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		let record: unknown;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof record !== 'object' || record === null) {
			continue;
		}
		const r = record as Record<string, unknown>;
		const type = r.type;

		if (startedAt === undefined && type === 'user' && typeof r.timestamp === 'string') {
			startedAt = r.timestamp;
		}
		if (type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.length > 0) {
			title = r.aiTitle;
		}
		if (type === 'cost-state' && typeof r.totalCostUSD === 'number') {
			costUsd = r.totalCostUSD;
		}
		if (type === 'user') {
			const text = extractUserPromptText(r);
			if (text !== undefined && !isSyntheticUser(r)) {
				// Once an acceptable first message is found, later messages cannot replace it.
				// The preference for human-origin records skips non-human / synthetic records,
				// but must not reach backwards past an earlier usable message lacking origin metadata.
				firstUsableText ??= text;
			}
		}
	}

	if (startedAt === undefined) {
		return null;
	}

	let derivedTitle: string | undefined;
	if (title === undefined && firstUsableText !== undefined) {
		derivedTitle = sanitizeDerivedTitle(firstUsableText);
	}

	return { sessionId, title, derivedTitle, startedAt, costUsd };
}

/**
 * Scans a `~/.claude/projects/<slug>` directory directly — split out from `listSessions` so a
 * synthetic fixture can be scanned without also faking `os.homedir()`.
 *
 * A missing directory (no CLI session has ever run against this vault) is not an error: `[]`.
 * Sorted newest-first by `startedAt`; ISO 8601 sorts lexicographically the same as chronologically,
 * so no `Date` parsing is needed. Newest-first is the obvious order for a future "recent sessions"
 * list — nothing today picks it, but nothing should have to re-decide it either.
 */
export async function scanSessionsDir(projectsDir: string): Promise<SessionSummary[]> {
	const fs = await nodeFs();
	const path = await nodePath();

	let entries: string[];
	try {
		entries = await fs.promises.readdir(projectsDir);
	} catch {
		return [];
	}

	const summaries: SessionSummary[] = [];
	for (const entry of entries) {
		// Trap 1: `tool-results` offload directories share a session's name with no extension.
		if (!entry.endsWith('.jsonl')) {
			continue;
		}
		const sessionId = entry.slice(0, -'.jsonl'.length);
		const filePath = path.join(projectsDir, entry);
		let summary: SessionSummary | null;
		try {
			summary = await buildSessionSummary(filePath, sessionId);
		} catch {
			// Unreadable (permissions, deleted mid-scan) — drop this one file, not the whole list.
			continue;
		}
		if (summary !== null) {
			summaries.push(summary);
		}
	}

	summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	return summaries;
}
