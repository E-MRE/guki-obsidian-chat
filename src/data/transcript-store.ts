/**
 * PLAN §1's session data layer abstraction. `listSessions` is the only real implementation in v1
 * (RESEARCH §D, this task's own measurement) — `readSession` and any UI over it are v2.
 */
import { nodeFs, nodeOs, nodePath } from '../cli/node-api';
import { projectSlug, scanSessionsDir, type SessionSummary } from './session-index';
import { DiskTranscriptLoader, type PagedTranscriptResult } from './disk-transcript-loader';
import { translateTranscriptRecords, type TranslateOptions } from './transcript-translator';
import type { ChatItem } from '../core/chat-state';

export type { SessionSummary };

/** Left abstract — v2 parses the record shapes found in transcripts;
 *  nothing in v1 needs the fields typed yet. */
export interface TranscriptRecord {
	type: string;
	[key: string]: unknown;
}

export interface ReadSessionOptions extends TranslateOptions {
	/** Number of active branch records to load (caller's choice; no policy baked into data layer). */
	count?: number;
	/** Cursor: load records immediately preceding this active branch index. */
	beforeIndex?: number;
}

/**
 * A paged slice of conversation items returned by `readSession`.
 *
 * Implements Array<ChatItem> so it behaves as an array for direct consumers,
 * while exposing paging metadata (startIndex, endIndex, hasMoreBefore, totalActiveRecords)
 * and `loadBefore(count)` to page backwards towards conversation root.
 */
export class SessionPage extends Array<ChatItem> {
	startIndex: number = 0;
	endIndex: number = 0;
	totalActiveRecords: number = 0;
	hasMoreBefore: boolean = false;
	private _loadBeforeHandler?: (count?: number) => Promise<SessionPage>;

	get items(): ChatItem[] {
		return this;
	}

	async loadBefore(count?: number): Promise<SessionPage> {
		if (!this._loadBeforeHandler) {
			throw new Error('No loadBefore handler attached to SessionPage');
		}
		return this._loadBeforeHandler(count);
	}

	static fromPage(
		items: ChatItem[],
		paged: PagedTranscriptResult,
		loadBeforeHandler: (count?: number) => Promise<SessionPage>,
	): SessionPage {
		const page = new SessionPage(...items);
		page.startIndex = paged.startIndex;
		page.endIndex = paged.endIndex;
		page.totalActiveRecords = paged.totalActiveRecords;
		page.hasMoreBefore = paged.hasMoreBefore;
		page._loadBeforeHandler = loadBeforeHandler;
		return page;
	}

	static empty(loadBeforeHandler?: (count?: number) => Promise<SessionPage>): SessionPage {
		const page = new SessionPage();
		page.startIndex = 0;
		page.endIndex = 0;
		page.totalActiveRecords = 0;
		page.hasMoreBefore = false;
		page._loadBeforeHandler = loadBeforeHandler ?? (async () => page);
		return page;
	}
}

export interface TranscriptStore {
	listSessions(vaultPath: string): Promise<SessionSummary[]>;
	readSession(sessionId: string, vaultPath?: string, options?: ReadSessionOptions): Promise<SessionPage>;
	readSession(sessionId: string, options?: ReadSessionOptions): Promise<SessionPage>;
	resumeArgs(sessionId: string): string[];
}

export class NodeTranscriptStore implements TranscriptStore {
	constructor(private readonly basePath?: string) {}

	async listSessions(vaultPath: string): Promise<SessionSummary[]> {
		const os = await nodeOs();
		const path = await nodePath();
		const projectsDir = this.basePath ?? path.join(os.homedir(), '.claude', 'projects', projectSlug(vaultPath));
		return scanSessionsDir(projectsDir);
	}

	async resolveSessionFilePath(sessionId: string, vaultPath?: string): Promise<string | null> {
		const fs = await nodeFs();
		const os = await nodeOs();
		const path = await nodePath();

		const fileExists = async (p: string): Promise<boolean> => {
			try {
				const stat = await fs.promises.stat(p);
				return stat.isFile();
			} catch {
				return false;
			}
		};

		// 1. Direct absolute path or filename that exists
		if (path.isAbsolute(sessionId) || sessionId.endsWith('.jsonl')) {
			if (await fileExists(sessionId)) {
				return sessionId;
			}
		}

		// 2. Custom basePath (for synthetic test fixtures)
		if (this.basePath) {
			const candidateWithExt = path.join(this.basePath, `${sessionId}.jsonl`);
			if (await fileExists(candidateWithExt)) {
				return candidateWithExt;
			}
			const candidateDirect = path.join(this.basePath, sessionId);
			if (await fileExists(candidateDirect)) {
				return candidateDirect;
			}
		}

		// 3. Vault-specific project directory
		if (vaultPath) {
			const projectsDir = path.join(os.homedir(), '.claude', 'projects', projectSlug(vaultPath));
			const candidate = path.join(projectsDir, `${sessionId}.jsonl`);
			if (await fileExists(candidate)) {
				return candidate;
			}
		}

		// 4. Search across all projects in ~/.claude/projects/
		const baseDir = path.join(os.homedir(), '.claude', 'projects');
		try {
			const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const candidate = path.join(baseDir, entry.name, `${sessionId}.jsonl`);
					if (await fileExists(candidate)) {
						return candidate;
					}
				}
			}
		} catch {
			// Directory unreadable / missing
		}

		return null;
	}

	async readSession(
		sessionId: string,
		vaultPathOrOptions?: string | ReadSessionOptions,
		options?: ReadSessionOptions,
	): Promise<SessionPage> {
		let vaultPath: string | undefined;
		let opts: ReadSessionOptions | undefined;

		if (typeof vaultPathOrOptions === 'string') {
			vaultPath = vaultPathOrOptions;
			opts = options;
		} else if (typeof vaultPathOrOptions === 'object' && vaultPathOrOptions !== null) {
			vaultPath = undefined;
			opts = vaultPathOrOptions;
		} else {
			opts = options;
		}

		const targetFile = await this.resolveSessionFilePath(sessionId, vaultPath);
		if (!targetFile) {
			throw new Error(`Transcript file not found for session: ${sessionId} (v2)`);
		}

		const fs = await nodeFs();
		try {
			const stat = await fs.promises.stat(targetFile);
			if (stat.size === 0) {
				return SessionPage.empty();
			}
		} catch {
			return SessionPage.empty();
		}

		const loader = new DiskTranscriptLoader(targetFile);
		const branch = await loader.resolveBranch();
		const total = branch.activeBranch.length;

		if (total === 0) {
			return SessionPage.empty();
		}

		const count = opts?.count ?? 50;
		const beforeIndex = opts?.beforeIndex;

		const pagedResult = beforeIndex !== undefined
			? await loader.loadBefore(beforeIndex, count)
			: await loader.loadNewest(count);

		if (pagedResult.records.length === 0) {
			const emptyPage = SessionPage.empty(async (c?: number) =>
				this.readSession(sessionId, vaultPath, { ...opts, count: c ?? count, beforeIndex: pagedResult.startIndex }),
			);
			emptyPage.startIndex = pagedResult.startIndex;
			emptyPage.endIndex = pagedResult.endIndex;
			emptyPage.totalActiveRecords = pagedResult.totalActiveRecords;
			emptyPage.hasMoreBefore = pagedResult.hasMoreBefore;
			return emptyPage;
		}

		// Translate ONLY the records belonging to this page slice.
		// Content for unrequested records is never read, ensuring zero sidecar reads
		// and bounded memory usage.
		const items = await translateTranscriptRecords(pagedResult.records, { filePath: targetFile, ...opts });

		const loadBeforeHandler = async (c?: number): Promise<SessionPage> => {
			return this.readSession(sessionId, vaultPath, {
				...opts,
				count: c ?? count,
				beforeIndex: pagedResult.startIndex,
			});
		};

		return SessionPage.fromPage(items, pagedResult, loadBeforeHandler);
	}

	resumeArgs(sessionId: string): string[] {
		return ['--resume', sessionId];
	}
}
