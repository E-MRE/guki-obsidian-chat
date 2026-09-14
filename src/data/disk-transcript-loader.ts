/**
 * Streaming on-disk transcript reader and active DAG branch resolver.
 *
 * WHY THIS EXISTS — the reality of Claude Code CLI transcript files:
 * Measured in `docs/capture-phase8-transcript-schema.md` (§4f, §4g) and verified in
 * `docs/capture-phase8-transcript-schema-verify.md` (2026-09-14):
 * 1. An on-disk transcript (~/.claude/projects/<slug>/<session-id>.jsonl) is NOT a linear
 *    chat log. It is an append-only DAG linked by `parentUuid` -> `uuid`. When a session
 *    is resumed or forked, new records branch off an earlier node, and all abandoned
 *    branches remain in the file permanently. In sample session Sample 4, 259 abandoned
 *    records were found across 18 distinct forks. A naive sequential reader would interleave
 *    these dead turns, rendering a conversation that never actually happened.
 * 2. File order is NOT chronological. Timestamp reversals between successive records were
 *    measured in 7 of 8 sampled files (up to 77 reversals in Sample 4). File order reflects
 *    when disk flushes occurred, not message causality.
 * 3. The authoritative tip of the active branch is identified by the LAST `last-prompt`
 *    record's `leafUuid`. Tracing `parentUuid` from that leaf back to root recovers the
 *    exact linear conversation intended by the operator.
 * 4. Memory constraint: Transcripts reach 15.2 MB (up to 3,449 lines) with single lines
 *    reaching 7.5 MB (embedded base64 images in user/attachment records). Full file string
 *    reading (`readFile` + `split('\n')`) creates severe memory spikes and freezes Obsidian's
 *    single-threaded UI loop during JSON.parse. This loader implements a two-pass streaming
 *    architecture:
 *    - Pass 1 (Branch Resolution): Streams lines with `readline`, extracting only minimal
 *      DAG metadata (`uuid`, `parentUuid`, `type`, `timestamp`, `lineIndex`) and immediately
 *      discarding record payloads.
 *    - Pass 2 (Paged Retrieval): Streams lines from disk and parses JSON ONLY for the
 *      active branch slice requested by the caller, skipping unneeded and abandoned lines.
 *
 * REFERENCE CHECK (Claudian):
 * We inspected Claudian's `src/providers/claude/history/sdkBranchFilter.ts` and
 * `ClaudeHistoryStore.ts` (local checkout). Critical traps identified and avoided:
 * - Claudian reads the entire file into a string with `fs.readFile` and splits by `\n`,
 *   violating our memory constraint.
 * - Claudian ignores `last-prompt.leafUuid`, attempting instead to infer branches via
 *   complex heuristics (`hasConversationContent`, `isRealUserBranchChild`). The measurement
 *   proved `last-prompt.leafUuid` is the authoritative tip emitted by the CLI at turn end.
 * - Claudian returns entries filtered in FILE order via `.filter()`, which fails under
 *   timestamp reversals and writes out-of-order records. Our loader reverses the walked
 *   parent chain, guaranteeing root -> tip chain causality.
 * - Claudian dedupes UUIDs by keeping the first occurrence; we adopt this to protect
 *   against duplicate entries.
 */

import { nodeFs, nodeReadline } from '../cli/node-api';
import type { TranscriptRecord } from './transcript-store';

export type { TranscriptRecord };

/**
 * Minimal metadata extracted in Pass 1 to reconstruct the conversation DAG
 * without holding large record payloads in memory.
 */
export interface ChainRecordMetadata {
	/** Authoritative unique ID of the record. */
	uuid: string;
	/**
	 * Parent UUID pointing to the preceding record in the DAG.
	 * Undefined on the root record of the session.
	 */
	parentUuid?: string;
	/** Top-level record type ('user', 'assistant', 'system', 'attachment', etc.). */
	type: string;
	/**
	 * ISO 8601 timestamp string from the record.
	 * Used for deterministic tie-breaking when choosing a fallback leaf.
	 */
	timestamp?: string;
	/** Zero-based line number in the on-disk .jsonl file where this record lives. */
	lineIndex: number;
}

/**
 * Reason why a fallback leaf selection had to be performed.
 */
export type FallbackReason = 'no-last-prompt' | 'unknown-leaf-uuid';

/**
 * Diagnostics when a `parentUuid` link could not be resolved to an existing record.
 */
export interface ChainBreak {
	/** The earliest record reached on the active branch before the break. */
	atUuid: string;
	/** The parent UUID requested by `atUuid` that was absent from the transcript. */
	missingParentUuid: string;
}

/**
 * Result of Pass 1 branch resolution.
 */
export interface ResolvedBranch {
	/**
	 * The resolved active branch in root -> tip order.
	 * This ordering is strictly the chain's, NOT the file's and NOT the timestamps'.
	 */
	activeBranch: ChainRecordMetadata[];
	/** Authoritative leaf UUID at the tip of the active branch, or null if transcript is empty. */
	tipUuid: string | null;
	/** True if a fallback strategy was used instead of an authoritative last-prompt record. */
	usedFallback: boolean;
	/** Reason for the fallback, if one was used. */
	fallbackReason?: FallbackReason;
	/** Set if the chain broke before reaching a root node. */
	chainBreak?: ChainBreak;
	/** Set if a cycle was encountered in parentUuid links; traversal halted to avoid looping. */
	cycleDetected?: boolean;
	/** Total physical lines scanned in the file. */
	totalLines: number;
	/** Unparsable or torn lines skipped during scan. */
	skippedLines: number;
	/** Total conversation records in the file that belonged to abandoned forks. */
	abandonedRecordCount: number;
}

/**
 * Paged slice of raw transcript records ready for translation.
 */
export interface PagedTranscriptResult {
	/** Parsed transcript records in root -> tip chain order. */
	records: TranscriptRecord[];
	/** Start index (inclusive) of this page in the active branch. */
	startIndex: number;
	/** End index (exclusive) of this page in the active branch. */
	endIndex: number;
	/** Total number of records on the resolved active branch. */
	totalActiveRecords: number;
	/** True if older records exist before this page (startIndex > 0). */
	hasMoreBefore: boolean;
}

/**
 * SEAM FOR LATER LANE:
 * The record -> ChatItem translator (Phase 8 lane 2) attaches here.
 * It will consume the paged TranscriptRecord[] output from DiskTranscriptLoader
 * and map them to ChatItem[] (UserItem, AssistantItem, DividerItem) in src/core/chat-state.ts.
 *
 * Do NOT implement the translator in this lane.
 */
export type TranscriptRecordTranslator<T = unknown> = (records: TranscriptRecord[]) => Promise<T[]> | T[];

interface RawScanAccumulator {
	recordsByUuid: Map<string, ChainRecordMetadata>;
	lastPromptLeafUuid?: string;
	totalLines: number;
	skippedLines: number;
}

function emptyScanAccumulator(): RawScanAccumulator {
	return {
		recordsByUuid: new Map(),
		totalLines: 0,
		skippedLines: 0,
	};
}

/**
 * Pass 1: Streams the file line by line, building a map of UUID -> minimal chain metadata.
 * Does NOT retain full JSON payloads or full lines in memory.
 */
async function streamScanChainMetadata(filePath: string): Promise<RawScanAccumulator> {
	const fs = await nodeFs();
	const readline = await nodeReadline();

	let stream: import('fs').ReadStream;
	try {
		stream = fs.createReadStream(filePath, { encoding: 'utf8' });
	} catch {
		// Missing file / directory is not an error: return empty accumulator
		return emptyScanAccumulator();
	}

	const rl = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});

	const recordsByUuid = new Map<string, ChainRecordMetadata>();
	let lastPromptLeafUuid: string | undefined;
	let totalLines = 0;
	let skippedLines = 0;

	try {
		for await (const line of rl) {
			const lineIndex = totalLines;
			totalLines++;

			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// Torn or corrupted line: skip this line, keep the file (matches session-index.ts)
				skippedLines++;
				continue;
			}

			if (typeof parsed !== 'object' || parsed === null) {
				continue;
			}

			const r = parsed as Record<string, unknown>;
			const type = typeof r.type === 'string' ? r.type : '';

			// The last `last-prompt` record in the file defines the authoritative leaf
			if (type === 'last-prompt' && typeof r.leafUuid === 'string' && r.leafUuid.length > 0) {
				lastPromptLeafUuid = r.leafUuid;
			}

			if (typeof r.uuid === 'string' && r.uuid.length > 0) {
				const uuid = r.uuid;
				// Deduplicate: Claudian keeps the first occurrence; subsequent repeats are ignored
				if (!recordsByUuid.has(uuid)) {
					recordsByUuid.set(uuid, {
						uuid,
						parentUuid: typeof r.parentUuid === 'string' && r.parentUuid.length > 0 ? r.parentUuid : undefined,
						type,
						timestamp: typeof r.timestamp === 'string' ? r.timestamp : undefined,
						lineIndex,
					});
				}
			}
		}
	} catch (err: unknown) {
		const code = (err as { code?: string })?.code;
		// Missing file (ENOENT) or missing parent directory (ENOTDIR / ENOENT) is an empty result, not an exception
		if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
			return emptyScanAccumulator();
		}
		throw err;
	} finally {
		rl.close();
		stream.destroy();
	}

	return {
		recordsByUuid,
		lastPromptLeafUuid,
		totalLines,
		skippedLines,
	};
}

/**
 * Finds the candidate leaf with the newest timestamp when last-prompt is missing or invalid.
 * A leaf is defined as any record whose UUID is not referenced as `parentUuid` by any other record.
 */
function findNewestLeaf(recordsByUuid: Map<string, ChainRecordMetadata>): ChainRecordMetadata | null {
	if (recordsByUuid.size === 0) {
		return null;
	}

	const referencedParents = new Set<string>();
	for (const record of recordsByUuid.values()) {
		if (record.parentUuid) {
			referencedParents.add(record.parentUuid);
		}
	}

	const leaves: ChainRecordMetadata[] = [];
	for (const record of recordsByUuid.values()) {
		if (!referencedParents.has(record.uuid)) {
			leaves.push(record);
		}
	}

	// If no unreferenced leaves exist (e.g. pure cycle), fall back to all records
	const candidates = leaves.length > 0 ? leaves : Array.from(recordsByUuid.values());

	candidates.sort((a, b) => {
		if (a.timestamp && b.timestamp) {
			const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
			if (!Number.isNaN(timeDiff) && timeDiff !== 0) {
				return timeDiff;
			}
		} else if (b.timestamp) {
			return 1;
		} else if (a.timestamp) {
			return -1;
		}
		// Tiebreak by file line index (latest line first)
		return b.lineIndex - a.lineIndex;
	});

	return candidates[0] ?? null;
}

/**
 * Resolves the active branch DAG from an on-disk transcript file.
 *
 * Implements Pass 1:
 * - Scans file streaming line by line.
 * - Extracts minimal DAG metadata.
 * - Locates active leaf (authoritative last-prompt or newest-timestamp leaf fallback).
 * - Walks parentUuid pointers back to root.
 * - Returns active branch in root -> tip order.
 */
export async function resolveTranscriptBranch(filePath: string): Promise<ResolvedBranch> {
	const scan = await streamScanChainMetadata(filePath);
	const { recordsByUuid, lastPromptLeafUuid, totalLines, skippedLines } = scan;

	if (recordsByUuid.size === 0) {
		return {
			activeBranch: [],
			tipUuid: null,
			usedFallback: false,
			totalLines,
			skippedLines,
			abandonedRecordCount: 0,
		};
	}

	let tipUuid: string | null = null;
	let usedFallback = false;
	let fallbackReason: FallbackReason | undefined;

	if (lastPromptLeafUuid && recordsByUuid.has(lastPromptLeafUuid)) {
		tipUuid = lastPromptLeafUuid;
	} else {
		usedFallback = true;
		fallbackReason = lastPromptLeafUuid ? 'unknown-leaf-uuid' : 'no-last-prompt';
		const fallbackLeaf = findNewestLeaf(recordsByUuid);
		tipUuid = fallbackLeaf ? fallbackLeaf.uuid : null;
	}

	if (!tipUuid || !recordsByUuid.has(tipUuid)) {
		return {
			activeBranch: [],
			tipUuid: null,
			usedFallback,
			fallbackReason,
			totalLines,
			skippedLines,
			abandonedRecordCount: recordsByUuid.size,
		};
	}

	// Walk parentUuid chain from tip back to root
	const chainFromTipToRoot: ChainRecordMetadata[] = [];
	const visitedUuids = new Set<string>();
	let currentUuid: string | undefined = tipUuid;
	let chainBreak: ChainBreak | undefined;
	let cycleDetected = false;

	while (currentUuid) {
		// Detect cycle (corrupt file): stop on revisit, never loop forever
		if (visitedUuids.has(currentUuid)) {
			cycleDetected = true;
			break;
		}
		visitedUuids.add(currentUuid);

		const record = recordsByUuid.get(currentUuid);
		if (!record) {
			break;
		}
		chainFromTipToRoot.push(record);

		const parentUuid = record.parentUuid;
		if (!parentUuid) {
			// Reached root node cleanly
			break;
		}

		if (!recordsByUuid.has(parentUuid)) {
			// Broken chain: parent UUID missing from map.
			// Return portion from break to tip and record break point.
			chainBreak = {
				atUuid: currentUuid,
				missingParentUuid: parentUuid,
			};
			break;
		}

		currentUuid = parentUuid;
	}

	// The chain was traversed tip -> root. Reverse to return root -> tip order.
	const activeBranch = chainFromTipToRoot.reverse();
	const activeUuidSet = new Set(activeBranch.map((r) => r.uuid));
	const abandonedRecordCount = recordsByUuid.size - activeUuidSet.size;

	return {
		activeBranch,
		tipUuid,
		usedFallback,
		fallbackReason,
		chainBreak,
		cycleDetected: cycleDetected ? true : undefined,
		totalLines,
		skippedLines,
		abandonedRecordCount,
	};
}

/**
 * Pass 2: Selectively reads full JSON records from disk for specified active branch indices.
 * Streams through the file and calls JSON.parse ONLY on lines belonging to the requested slice.
 * Unrequested lines and multi-megabyte payloads on dead branches are skipped without parsing.
 */
async function streamReadRecordSlice(
	filePath: string,
	targetLineToBranchIndex: Map<number, number>,
): Promise<Map<number, TranscriptRecord>> {
	if (targetLineToBranchIndex.size === 0) {
		return new Map();
	}

	const fs = await nodeFs();
	const readline = await nodeReadline();

	let stream: import('fs').ReadStream;
	try {
		stream = fs.createReadStream(filePath, { encoding: 'utf8' });
	} catch {
		return new Map();
	}

	const rl = readline.createInterface({
		input: stream,
		crlfDelay: Infinity,
	});

	let maxTargetLine = -1;
	for (const lineIdx of targetLineToBranchIndex.keys()) {
		if (lineIdx > maxTargetLine) {
			maxTargetLine = lineIdx;
		}
	}

	const recordsByBranchIndex = new Map<number, TranscriptRecord>();
	let currentLineIndex = -1;

	try {
		for await (const line of rl) {
			currentLineIndex++;

			if (targetLineToBranchIndex.has(currentLineIndex)) {
				const branchIdx = targetLineToBranchIndex.get(currentLineIndex)!;
				try {
					const parsed = JSON.parse(line.trim()) as TranscriptRecord;
					recordsByBranchIndex.set(branchIdx, parsed);
				} catch {
					// Torn line during read: omit rather than throw
				}

				if (recordsByBranchIndex.size === targetLineToBranchIndex.size) {
					// All requested records have been retrieved; exit early
					break;
				}
			}

			if (currentLineIndex >= maxTargetLine) {
				// Past the highest requested line number; stop reading further
				break;
			}
		}
	} catch (err: unknown) {
		const code = (err as { code?: string })?.code;
		if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
			return new Map();
		}
		throw err;
	} finally {
		rl.close();
		stream.destroy();
	}

	return recordsByBranchIndex;
}

/**
 * Primary loader class managing transcript branch resolution and paged on-demand record reads.
 */
export class DiskTranscriptLoader {
	private readonly filePath: string;
	private cachedBranch: ResolvedBranch | null = null;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/**
	 * Resolves the active branch DAG metadata (Pass 1).
	 * Results are cached for subsequent paged reads.
	 */
	async resolveBranch(): Promise<ResolvedBranch> {
		if (!this.cachedBranch) {
			this.cachedBranch = await resolveTranscriptBranch(this.filePath);
		}
		return this.cachedBranch;
	}

	/**
	 * Loads a specific index range [startIndex, endIndex) of active branch records (Pass 2).
	 * Records are returned strictly in root -> tip chain order.
	 */
	async loadRange(startIndex: number, endIndex: number): Promise<TranscriptRecord[]> {
		const branch = await this.resolveBranch();
		const total = branch.activeBranch.length;

		const clampedStart = Math.max(0, Math.min(startIndex, total));
		const clampedEnd = Math.max(clampedStart, Math.min(endIndex, total));

		if (clampedStart >= clampedEnd) {
			return [];
		}

		// Build map from lineIndex -> activeBranch index
		const targetLineToBranchIndex = new Map<number, number>();
		for (let i = clampedStart; i < clampedEnd; i++) {
			const meta = branch.activeBranch[i];
			if (meta) {
				targetLineToBranchIndex.set(meta.lineIndex, i);
			}
		}

		const recordsByBranchIndex = await streamReadRecordSlice(this.filePath, targetLineToBranchIndex);

		// Order records by active branch slot, ensuring chain order even if disk lines were out of order
		const records: TranscriptRecord[] = [];
		for (let i = clampedStart; i < clampedEnd; i++) {
			const rec = recordsByBranchIndex.get(i);
			if (rec) {
				records.push(rec);
			}
		}

		return records;
	}

	/**
	 * Paging seam: loads the LAST `count` records of the resolved active branch.
	 *
	 * N is chosen by the caller; no policy number is hard-coded.
	 */
	async loadNewest(count: number): Promise<PagedTranscriptResult> {
		const branch = await this.resolveBranch();
		const total = branch.activeBranch.length;

		if (total === 0 || count <= 0) {
			return {
				records: [],
				startIndex: 0,
				endIndex: 0,
				totalActiveRecords: total,
				hasMoreBefore: false,
			};
		}

		const clampedCount = Math.min(count, total);
		const startIndex = total - clampedCount;
		const endIndex = total;

		const records = await this.loadRange(startIndex, endIndex);

		return {
			records,
			startIndex,
			endIndex,
			totalActiveRecords: total,
			hasMoreBefore: startIndex > 0,
		};
	}

	/**
	 * Paging seam: loads up to `count` records immediately preceding `beforeIndex`.
	 *
	 * Guarantees no overlap and no gap with the previous page:
	 * If previous page was [startIndex, endIndex), pass `previous.startIndex` as `beforeIndex`.
	 */
	async loadBefore(beforeIndex: number, count: number): Promise<PagedTranscriptResult> {
		const branch = await this.resolveBranch();
		const total = branch.activeBranch.length;

		const validBeforeIndex = Math.max(0, Math.min(beforeIndex, total));

		if (validBeforeIndex === 0 || count <= 0 || total === 0) {
			return {
				records: [],
				startIndex: 0,
				endIndex: 0,
				totalActiveRecords: total,
				hasMoreBefore: false,
			};
		}

		const clampedCount = Math.min(count, validBeforeIndex);
		const startIndex = validBeforeIndex - clampedCount;
		const endIndex = validBeforeIndex;

		const records = await this.loadRange(startIndex, endIndex);

		return {
			records,
			startIndex,
			endIndex,
			totalActiveRecords: total,
			hasMoreBefore: startIndex > 0,
		};
	}
}
