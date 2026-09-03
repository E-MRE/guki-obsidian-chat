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

export interface SessionSummary {
	/** Taken from the filename, not parsed — RESEARCH §D and this task's own measurement agree the
	 *  two never disagree, and the filename is free. */
	sessionId: string;
	/** From `ai-title`. Absent on ~40% of real sessions (short or aborted ones) — not a defect to
	 *  paper over with a placeholder. */
	title?: string;
	/** ISO timestamp of the first `type: "user"` record in the file. Every sampled file has one; a
	 *  file that somehow doesn't is left out of the result rather than given a fabricated time. */
	startedAt: string;
	/** `cost-state`'s `totalCostUSD`, already summed across models — do not recompute from
	 *  `modelUsage`. Absent on ~52% of real sessions (more missing than present). */
	costUsd?: number;
}

/** In the absolute vault path, every `/` becomes `-` (verified against the real directory name). */
export function projectSlug(vaultPath: string): string {
	return vaultPath.replace(/\//g, '-');
}

/**
 * One `.jsonl` file → a summary, or `null` if it never turns up a `user` record to date it by.
 *
 * Per-line `JSON.parse` in its own `try`/`catch`: a session file still being written to can end in
 * a torn line, and one bad line must not cost the rest of the file's `ai-title` or `cost-state`.
 */
async function buildSessionSummary(filePath: string, sessionId: string): Promise<SessionSummary | null> {
	const fs = await nodeFs();
	const content = await fs.promises.readFile(filePath, 'utf8');

	let startedAt: string | undefined;
	let title: string | undefined;
	let costUsd: number | undefined;

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
	}

	if (startedAt === undefined) {
		return null;
	}
	return { sessionId, title, startedAt, costUsd };
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
