/**
 * Finds the binaries the plugin spawns: `claude`, and since Phase 5 a `node` for the MCP
 * permission server.
 *
 * Two traps, both measured on this machine (RESEARCH C):
 * 1. Obsidian launched from the GUI does not read the shell profile, so `~/.local/bin` is not on
 *    PATH — `spawn('claude')` simply fails.
 * 2. `claude` is *also* a zsh function here (a Headroom wrapper defined in `~/.zshrc`). Going
 *    through an interactive shell would hit the wrapper, change `ANTHROPIC_BASE_URL`, and add its
 *    own permission prompt. `zsh -lc` is safe — a login, non-interactive shell does not read
 *    `.zshrc`, so it returns the file path — but it stays a last resort.
 */
import { nodeChildProcess, nodeFs, nodeOs, nodePath } from './node-api';

export interface BinaryResolution {
	path: string;
	/** Which step of the order below produced it — surfaced in the panel for diagnosis. */
	source: string;
}

export class BinaryNotFoundError extends Error {
	constructor(
		readonly attempts: string[],
		/** Which binary was being looked for. Phase 5 added a second one. */
		readonly binary = 'claude',
	) {
		super(`Could not find the ${binary} binary.`);
		this.name = 'BinaryNotFoundError';
	}
}

const ZSH_LOOKUP_TIMEOUT_MS = 4000;

async function isExecutableFile(candidate: string): Promise<boolean> {
	const fs = await nodeFs();
	try {
		await fs.promises.access(candidate, fs.constants.X_OK);
	} catch {
		return false;
	}
	try {
		// Follows symlinks on purpose: ~/.local/bin/claude is a link into versions/.
		const stat = await fs.promises.stat(candidate);
		return stat.isFile();
	} catch {
		return false;
	}
}

/** Descending version sort for the `versions/` directory ("2.1.250" beats "2.1.99"). */
function compareVersionsDesc(a: string, b: string): number {
	const left = a.split('.').map((part) => Number.parseInt(part, 10));
	const right = b.split('.').map((part) => Number.parseInt(part, 10));
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (Number.isNaN(l) || Number.isNaN(r)) {
			return b.localeCompare(a);
		}
		if (l !== r) {
			return r - l;
		}
	}
	return 0;
}

async function newestVersionedBinary(versionsDir: string): Promise<string | null> {
	const fs = await nodeFs();
	const path = await nodePath();
	let entries: string[];
	try {
		entries = await fs.promises.readdir(versionsDir);
	} catch {
		return null;
	}
	for (const name of entries.sort(compareVersionsDesc)) {
		const candidate = path.join(versionsDir, name);
		if (await isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Last resort: ask a **login** shell (`-l`), never an interactive one (`-i`), so the zsh function
 * definition in `.zshrc` stays out of the picture.
 */
async function lookupViaLoginShell(command: string): Promise<string | null> {
	let childProcess;
	try {
		childProcess = await nodeChildProcess();
	} catch {
		return null;
	}
	return new Promise((resolve) => {
		let child;
		try {
			child = childProcess.execFile(
				'/bin/zsh',
				['-lc', `command -v ${command}`],
				{ timeout: ZSH_LOOKUP_TIMEOUT_MS, encoding: 'utf8' },
				(error, stdout) => {
					if (error) {
						resolve(null);
						return;
					}
					const found = stdout.trim().split('\n')[0]?.trim();
					resolve(found && found.startsWith('/') ? found : null);
				},
			);
		} catch {
			resolve(null);
			return;
		}
		child.on('error', () => resolve(null));
	});
}

/**
 * Resolution order from RESEARCH C. `override` is step 1 — the settings value, which has no UI
 * until v2 but is already threaded through so the "broken path" acceptance test has a lever.
 */
export async function resolveClaudeBinary(override?: string): Promise<BinaryResolution> {
	const os = await nodeOs();
	const path = await nodePath();
	const home = os.homedir();
	const attempts: string[] = [];

	const trimmedOverride = override?.trim();
	if (trimmedOverride) {
		attempts.push(`setting: ${trimmedOverride}`);
		if (await isExecutableFile(trimmedOverride)) {
			return { path: trimmedOverride, source: 'setting' };
		}
		// An explicitly configured path that does not work is an error, not a reason to guess.
		throw new BinaryNotFoundError(attempts);
	}

	const localBin = path.join(home, '.local', 'bin', 'claude');
	attempts.push(localBin);
	if (await isExecutableFile(localBin)) {
		return { path: localBin, source: '~/.local/bin' };
	}

	const versionsDir = path.join(home, '.local', 'share', 'claude', 'versions');
	attempts.push(`${versionsDir}/*`);
	const versioned = await newestVersionedBinary(versionsDir);
	if (versioned) {
		return { path: versioned, source: 'newest installed version' };
	}

	for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
		const candidate = path.join(dir, 'claude');
		attempts.push(candidate);
		if (await isExecutableFile(candidate)) {
			return { path: candidate, source: dir };
		}
	}

	attempts.push("zsh -lc 'command -v claude'");
	const fromShell = await lookupViaLoginShell('claude');
	if (fromShell && (await isExecutableFile(fromShell))) {
		return { path: fromShell, source: 'login shell lookup' };
	}

	throw new BinaryNotFoundError(attempts);
}

/** Where a `node` is likely to be, in the order it is worth trying. Homebrew first on this Mac. */
const NODE_CANDIDATE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/**
 * Finds a **real** `node` for the MCP permission server (PLAN Phase 5 task 3: an absolute
 * interpreter path, because a bare `node` fails silently — the server simply never appears).
 *
 * `process.execPath` is deliberately not used. Inside Obsidian's renderer that is the Electron
 * binary, not node. `ELECTRON_RUN_AS_NODE=1` would make it behave as one, but Electron's
 * `runAsNode` fuse can be disabled by the packager, and when it is, spawning the binary opens a
 * second Obsidian window instead of failing — a worse failure than not starting at all.
 *
 * Throws `BinaryNotFoundError` when there is none. The caller turns that into a visible panel
 * error and refuses input, exactly as it does for a missing permission server: running the CLI
 * without an approval gate is the one outcome that is never acceptable (PLAN Phase 5 task 9).
 */
export async function resolveNodeBinary(): Promise<BinaryResolution> {
	const path = await nodePath();
	const attempts: string[] = [];

	for (const dir of NODE_CANDIDATE_DIRS) {
		const candidate = path.join(dir, 'node');
		attempts.push(candidate);
		if (await isExecutableFile(candidate)) {
			return { path: candidate, source: dir };
		}
	}

	attempts.push("zsh -lc 'command -v node'");
	const fromShell = await lookupViaLoginShell('node');
	if (fromShell && (await isExecutableFile(fromShell))) {
		return { path: fromShell, source: 'login shell lookup' };
	}

	throw new BinaryNotFoundError(attempts, 'node');
}
