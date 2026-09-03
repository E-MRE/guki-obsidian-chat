/**
 * PLAN §1's session data layer abstraction. `listSessions` is the only real implementation in v1
 * (RESEARCH §D, this task's own measurement) — `readSession` and any UI over it are v2.
 */
import { nodeOs, nodePath } from '../cli/node-api';
import { projectSlug, scanSessionsDir, type SessionSummary } from './session-index';

export type { SessionSummary };

/** Left abstract — v2 will parse the record shapes RESEARCH §D found (`ai-title`, `cost-state`,
 *  `user`, `attachment`, …); nothing in v1 needs the fields typed yet. */
export interface TranscriptRecord {
	type: string;
	[key: string]: unknown;
}

export interface TranscriptStore {
	listSessions(vaultPath: string): Promise<SessionSummary[]>;
	readSession(sessionId: string): Promise<TranscriptRecord[]>;
	resumeArgs(sessionId: string): string[];
}

export class NodeTranscriptStore implements TranscriptStore {
	async listSessions(vaultPath: string): Promise<SessionSummary[]> {
		const os = await nodeOs();
		const path = await nodePath();
		const projectsDir = path.join(os.homedir(), '.claude', 'projects', projectSlug(vaultPath));
		return scanSessionsDir(projectsDir);
	}

	/** v2: needs `--resume` + `--input-format stream-json` behaviour verified first (RESEARCH §D's
	 *  open question, NEXT.md). A silent `[]` here would let a caller mistake "not built yet" for
	 *  "no transcript records". */
	async readSession(sessionId: string): Promise<TranscriptRecord[]> {
		throw new Error(`TranscriptStore.readSession is not implemented — v2 (sessionId: ${sessionId})`);
	}

	resumeArgs(sessionId: string): string[] {
		return ['--resume', sessionId];
	}
}
