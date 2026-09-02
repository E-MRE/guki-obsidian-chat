/**
 * The impure half of the permission policy: turning a path argument into an absolute, symlink-free
 * path, and answering whether it is inside the vault.
 *
 * Split out from `permission-policy.ts` on purpose. The table has to stay free of `obsidian` and
 * Node imports so every row of it is drivable from a fixture; this file is the small piece that
 * genuinely needs a filesystem, and it is small enough to be tested against real symlinks in a real
 * temp directory (`docs/offline-checks.ts` §N).
 *
 * The comparison itself is **not** here — it is `containsPath`, in the policy, because "inside the
 * vault" is a security definition and belongs with the table it serves.
 */
import { nodeFs, nodePath } from '../cli/node-api';
import type { PriorContent } from './chat-state';
import { containsPath, type VaultPaths } from './permission-policy';

/**
 * How far up the ancestor walk will climb before giving up. `dirname` converges on `/` long before
 * this on any real path; the cap exists so a malformed argument cannot spin.
 */
const MAX_ANCESTOR_DEPTH = 64;

/**
 * Builds the `VaultPaths` the policy is handed.
 *
 * `vaultRoot` is resolved once, here: if any ancestor of the vault is itself a symlink, an
 * unresolved root would never prefix-match the resolved paths coming out of `resolve`, and every
 * single call would read as "outside the vault".
 */
export async function createVaultPaths(vaultRoot: string): Promise<VaultPaths> {
	const fs = await nodeFs();
	const path = await nodePath();

	/**
	 * **`realpathSync.native`, not `realpathSync`.** They disagree, and the difference is a hole.
	 *
	 * Node's JavaScript `realpathSync` begins by calling `path.resolve`, which collapses `..`
	 * *lexically* — before any symlink has been followed. So for `<vault>/escape/../outside/x`,
	 * where `escape` is a symlink pointing out of the vault, it computes `<vault>/outside/x` and
	 * reports a path **inside** the vault. `realpathSync.native` calls the OS `realpath(3)`, which
	 * resolves `..` against what the symlink actually pointed at, and answers `<outside>/x`.
	 *
	 * Measured on this machine, Node v23.9.0, and it is what §N's "`..` is applied after the
	 * symlink" check exists to hold: with the JS version that check reads `allow`.
	 */
	const realpath = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;

	function realpathOrNull(target: string): string | null {
		try {
			return realpath(target);
		} catch {
			// ENOENT for a path being created, ELOOP for a symlink cycle, EACCES for a directory we
			// cannot traverse. All three mean "not resolvable here", and the caller climbs.
			return null;
		}
	}

	const absoluteRoot = path.resolve(vaultRoot);
	const root = realpathOrNull(absoluteRoot) ?? absoluteRoot;

	/**
	 * `fs.realpathSync` on the closest **existing** ancestor, with the remainder appended
	 * (PLAN §2b).
	 *
	 * The order matters and it is the whole reason this is a walk rather than a call to
	 * `path.resolve`. Collapsing `..` lexically first would turn `<vault>/link/../secret`, where
	 * `link` points out of the vault, into `<vault>/secret` — inside, and wrong. `realpath` resolves
	 * `..` *after* the symlink, which is what the kernel does.
	 *
	 * **Both exits that mean "could not resolve" return null**, and null is never inside the vault
	 * (`containsPath`), so the verdict is `ask`. An earlier version fell back to `path.resolve` when
	 * the depth ran out, which reopened at the back door exactly the hole the walk closes at the
	 * front: the fallback resolves the *whole* path, existing prefix included, and a symlink lives
	 * in that prefix. `<vault>/escape/../<70 components>/x` came back as `<vault>/d0/…/x` — inside,
	 * and wrong. It takes an absurd path to reach, and it answered `allow`, which is the direction
	 * that has no witness.
	 */
	function resolveClosest(absolute: string): string | null {
		let current = absolute;
		const tail: string[] = [];
		for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
			const real = realpathOrNull(current);
			if (real !== null) {
				return tail.length === 0 ? real : path.join(real, ...[...tail].reverse());
			}
			const parent = path.dirname(current);
			if (parent === current) {
				// Walked to `/` and even that did not resolve. Nothing left to climb.
				return null;
			}
			tail.push(path.basename(current));
			current = parent;
		}
		return null;
	}

	function resolve(raw: string): string | null {
		if (raw.length === 0) {
			return null;
		}
		// `~` is expanded by a shell, not by `realpath`, which would treat it as an ordinary
		// directory name and place `~/.ssh/id_rsa` *inside* the vault. Nothing here runs a shell, so
		// the honest answer is that this argument cannot be resolved.
		if (raw.startsWith('~')) {
			return null;
		}
		// String concatenation rather than `path.join`, which normalises `..` away before `realpath`
		// ever sees it — the same ordering trap as above. A relative argument is relative to the
		// CLI's cwd, and that is the vault root (`SessionManager` spawns it there).
		const absolute = path.isAbsolute(raw) ? raw : `${root}/${raw}`;
		try {
			return resolveClosest(absolute);
		} catch {
			return null;
		}
	}

	return {
		root,
		resolve,
		/**
		 * Note what this is *not*: on a case-insensitive volume (the default on macOS) `realpath`
		 * does not canonicalise case, so `/users/...` and `/Users/...` resolve to different strings
		 * and the second would read as outside the vault. That errs towards a card, never towards a
		 * silent allow, which is the direction this whole file is biased in.
		 */
		isInside: (raw: string) => containsPath(root, resolve(raw)),
	};
}

/**
 * How much of a file the approval card will read to show a Before pane. A vault note is a few KB;
 * anything past this is not something a reader is going to scan in a card, and pulling it into the
 * renderer to throw it away is worse than saying we did not look.
 */
const MAX_PRIOR_CONTENT_BYTES = 512 * 1024;

/**
 * Reads the current contents of a file a `Write` is about to replace, for the approval card.
 *
 * **Synchronous, and through `fs` rather than Obsidian's vault adapter.** Both are deliberate:
 *
 * - The adapter is async and only reaches inside the vault — and the paths that produce a card are
 *   very often the ones *outside* it, which is exactly where the reader most needs to see what is
 *   about to be overwritten.
 * - Async would mean the card appears first and its Before pane fills in afterwards. The reader can
 *   press Allow in that window, on a pane that has not resolved yet. A card is only worth having if
 *   what it shows is true at the moment it is actionable, so this is read *before* the item exists.
 *
 * It is a display value and never a decision: nothing in `permission-policy.ts` reads a file, which
 * is what keeps the check-to-write window closed. Every failure answers `unknown`.
 */
export async function createPriorContentReader(): Promise<(absolutePath: string) => PriorContent> {
	const fs = await nodeFs();

	return (absolutePath: string): PriorContent => {
		let stats;
		try {
			stats = fs.statSync(absolutePath);
		} catch {
			// ENOENT is the ordinary case and it is real information: there is no file, so the card
			// is about a *create*, and `(empty)` is the honest Before. Any other stat failure is
			// indistinguishable from it here, so both answer `absent` only when the path is truly
			// missing — checked below.
			return fs.existsSync(absolutePath) ? { kind: 'unknown' } : { kind: 'absent' };
		}
		if (!stats.isFile() || stats.size > MAX_PRIOR_CONTENT_BYTES) {
			// A directory, a device, or something too big to show. We did not look.
			return { kind: 'unknown' };
		}
		try {
			return { kind: 'content', text: fs.readFileSync(absolutePath, 'utf8') };
		} catch {
			return { kind: 'unknown' };
		}
	};
}
