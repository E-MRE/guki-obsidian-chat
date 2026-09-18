/**
 * The Bash gate (PLAN §2b, "Bash whitelist").
 *
 * Emre's constraint, and the reason this file is not a list of command names: **never whitelist by
 * name or prefix alone.** `git status; rm -rf x` starts with an allowed name. A whitelist without a
 * metacharacter gate is a security hole with a convenience story attached to it.
 *
 * Three ordered steps, and a command must survive all three to be auto-allowed:
 *
 *   1. metacharacter veto — on the **raw string**, before any tokenising;
 *   2. argv exact match   — quote-aware tokens, leading N tokens equal to a whitelist entry;
 *   3. path resolution    — every non-flag token must land inside the vault.
 *
 * Anything else is `ask`. Pure: the only outside knowledge is `VaultPaths`, so every case here is
 * exercisable from a fixture (`docs/offline-checks.ts` §N).
 */
import type { PermissionSettings, PermissionVerdict, VaultPaths } from './permission-policy';

/**
 * Step 1. Presence is enough — no escaping analysis, no "is it really quoted?", because deciding
 * that is precisely the analysis that gets bypassed.
 *
 * PLAN lists `;  &&  ||  |  $(  \`  >  >>  <  &  \n`. Everything from `$` onwards below is an
 * addition, and it is not decoration — PLAN's list has a hole. It vetoes `$(` but not a bare `$`,
 * so `cat $HOME/.ssh/id_rsa` clears step 1; step 3 as PLAN words it only rejects tokens that
 * "resolve to an existing filesystem path", and the literal token `$HOME/.ssh/id_rsa` does not
 * exist, so the command would have been **allowed** and the shell would then have expanded it.
 * `~` and the glob characters open the same hole (`cat ../*`). They are vetoed here, and step 3 is
 * additionally strengthened, so neither alone is load-bearing.
 */
export const BASH_METACHARACTERS: readonly string[] = [
	';',
	'&',
	'|',
	'>',
	'<',
	'`',
	'\n',
	'\r',
	// Expansions the shell performs on a token that looks inert to a path check.
	'$',
	'~',
	// Globs — an unexpanded `*` or `?` resolves to nothing and reaches the shell intact.
	'*',
	'?',
	'[',
	']',
	'{',
	'}',
	// Grouping, escaping and comments: all of them change what the shell finally runs.
	'(',
	')',
	'\\',
	'!',
	'#',
];

/**
 * Step 2. Each entry is a token sequence; an entry of N tokens must equal the command's first N
 * tokens exactly. `ls` therefore covers `ls -la`, and `git status` does **not** cover `git statusx`.
 *
 * The starting list is PLAN §2b's table verbatim. Every entry is read-only — nothing here can
 * modify a file even when it is pointed at one.
 */
export const BASH_WHITELIST: readonly (readonly string[])[] = [
	['git', 'status'],
	['git', 'diff'],
	['git', 'log'],
	['git', 'branch'],
	['which'],
	['ls'],
	['pwd'],
	['cat'],
	['wc'],
	['node', '--version'],
];

/**
 * Whitespace tokenising that honours single and double quotes. Returns `null` on an unbalanced
 * quote, which the caller turns into `ask`: a command we cannot tokenise is a command we cannot
 * reason about.
 *
 * Quote characters are stripped from the token, so `cat 'my notes.md'` yields the real filename for
 * step 3. This runs only after step 1, so no token can contain a metacharacter.
 */
export function tokenizeCommand(raw: string): string[] | null {
	const tokens: string[] = [];
	let current = '';
	let started = false;
	let quote: "'" | '"' | null = null;

	for (const char of raw) {
		if (quote !== null) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === ' ' || char === '\t') {
			if (started) {
				tokens.push(current);
				current = '';
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}

	if (quote !== null) {
		return null;
	}
	if (started) {
		tokens.push(current);
	}
	return tokens;
}

/** Step 2, in one place so the reversion sweep can point at it. */
function matchesWhitelist(tokens: string[]): boolean {
	return BASH_WHITELIST.some(
		(entry) => tokens.length >= entry.length && entry.every((token, i) => tokens[i] === token),
	);
}

/**
 * Step 3, and it is deliberately stronger than PLAN's wording.
 *
 * PLAN: "any remaining token that **resolves to an existing filesystem path** must be inside the
 * vault." The existence qualifier is the hole described on `BASH_METACHARACTERS`, so this checks
 * *every* non-flag token, existing or not. A token that names nothing at all still resolves
 * somewhere, and `..` is what makes that somewhere interesting.
 *
 * A leading `-` marks a flag and is skipped — none of the whitelisted commands take a flag that can
 * reach outside the vault — except that a flag containing `/` is refused outright rather than
 * reasoned about.
 */
function argumentsStayInsideVault(tokens: string[], paths: VaultPaths): boolean {
	for (const token of tokens) {
		if (token.length === 0) {
			continue;
		}
		if (token.startsWith('-')) {
			if (token.includes('/')) {
				return false;
			}
			continue;
		}
		if (!paths.isInside(token)) {
			return false;
		}
	}
	return true;
}

/**
 * Resolves and canonicalises the working directory for a Bash command.
 * Normalised to NFC and stripped of trailing slashes.
 * Returns null if unavailable or unresolvable (fail-closed).
 */
export function resolveBashCwd(rawCwd: unknown, paths: VaultPaths): string | null {
	const raw =
		typeof rawCwd === 'string' && rawCwd.trim().length > 0
			? rawCwd.trim()
			: rawCwd === undefined
				? paths.root
				: null;
	if (raw === null || raw.length === 0) {
		return null;
	}
	const resolved = paths.resolve(raw);
	if (resolved === null) {
		return null;
	}
	const norm = resolved.normalize('NFC');
	return norm.endsWith('/') && norm.length > 1 ? norm.slice(0, -1) : norm;
}

export const PROTECTED_SEGMENTS = new Set(['.git', '.obsidian']);

export function hasProtectedSegment(pathOrToken: string): boolean {
	const norm = pathOrToken.normalize('NFC').toLowerCase();
	const segments = norm.split(/[/\\]/);
	for (const seg of segments) {
		if (PROTECTED_SEGMENTS.has(seg)) {
			return true;
		}
		if (seg.includes('=')) {
			const subSegs = seg.split('=');
			if (subSegs.some((s) => PROTECTED_SEGMENTS.has(s))) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Absolute security floor for Bash commands.
 * Runs on every command BEFORE any allow rule (allowEverything, runCommands auto-allow,
 * or remembered decisions) can be consulted.
 *
 * 1. String and non-empty check
 * 2. Metacharacter veto (on raw string)
 * 3. Quote-aware tokenization
 * 4. Protected segment check (.obsidian, .git in tokens)
 *
 * Returns the parsed tokens if the floor passes, or null if vetoed / malformed (fail-closed).
 *
 * Evasion boundary of the command-string heuristic:
 * Caught:
 *   - cd-then-relative writes inside a protected cwd (via rawCwd protected segment check)
 *   - in-command cd into protected segments
 *   - path assembled from shell variable expansion ($)
 *   - backslash-escaped and quoted spellings of .obsidian or .git
 * Open limits (deliberately not closed — inspecting payloads/runtimes is out of scope):
 *   - paths built at runtime by an invoked binary
 *   - commands extracting or applying payloads whose target paths live inside the payload
 *     rather than in the command string, e.g. `tar -xf archive.tar` or `patch -p0 -i patchfile`
 *   - pre-existing symlinks pointing into a protected directory
 *   - pre-exported environment variables
 */
export function validateBashFloor(
	command: unknown,
	rawCwd?: unknown,
	paths?: VaultPaths,
	skipMetacharacterVeto = false,
): string[] | null {
	if (typeof command !== 'string') {
		return null;
	}
	const raw = command.trim();
	if (raw.length === 0) {
		return null;
	}

	// Cwd floor: if working directory is inside a protected segment (.obsidian or .git),
	// relative writes or commands executed inside that directory are vetoed.
	if (typeof rawCwd === 'string' && rawCwd.trim().length > 0) {
		if (hasProtectedSegment(rawCwd)) {
			return null;
		}
		if (paths) {
			const resolved = paths.resolve(rawCwd);
			if (resolved !== null && hasProtectedSegment(resolved)) {
				return null;
			}
		}
	}

	// Step 1: Metacharacter veto — on the raw string, before anything is interpreted.
	// Skippable only by the explicit 'auto-allow-unsafe' setting (permission-policy.ts); every
	// other caller, including a remembered-decision candidate, still goes through this.
	if (!skipMetacharacterVeto && BASH_METACHARACTERS.some((meta) => raw.includes(meta))) {
		return null;
	}

	// Step 2: Tokenization
	const tokens = tokenizeCommand(raw);
	if (tokens === null || tokens.length === 0) {
		return null;
	}

	// Step 3: Protected segment check — any token naming .obsidian or .git
	if (tokens.some((token) => hasProtectedSegment(token))) {
		return null;
	}

	return tokens;
}

/**
 * Evaluates candidate allow rules for commands.
 * Returns a candidate verdict ('allow' | 'ask').
 * This is an allow candidate ONLY: no branch can return a final 'allow' directly
 * without passing through validateBashFloor in bashVerdict / enforceFloor.
 */
export function evaluateBashCandidate(
	command: unknown,
	paths: VaultPaths,
	settings?: PermissionSettings,
	rawCwd?: unknown,
): PermissionVerdict {
	if (typeof command !== 'string' || command.trim().length === 0) {
		return 'ask';
	}

	const raw = command.trim();
	const tokens = tokenizeCommand(raw);
	if (tokens === null || tokens.length === 0) {
		return 'ask';
	}

	if (settings?.allowEverything || settings?.runCommands === 'auto-allow' || settings?.runCommands === 'auto-allow-unsafe') {
		return 'allow';
	}

	const currentCwd = resolveBashCwd(rawCwd, paths);
	if (
		currentCwd !== null &&
		settings?.rememberedDecisions?.some((d) => {
			if (d.category !== 'command' || typeof d.cwd !== 'string' || d.cwd.length === 0) {
				return false;
			}
			const normCwd = d.cwd.normalize('NFC');
			const cleanCwd = normCwd.endsWith('/') && normCwd.length > 1 ? normCwd.slice(0, -1) : normCwd;
			return (
				cleanCwd === currentCwd &&
				Array.isArray(d.argv) &&
				d.argv.length === tokens.length &&
				d.argv.every((token, i) => token === tokens[i])
			);
		})
	) {
		return 'allow';
	}

	if (!matchesWhitelist(tokens)) {
		return 'ask';
	}

	// Step 3.
	return argumentsStayInsideVault(tokens, paths) ? 'allow' : 'ask';
}

/**
 * The Bash gate.
 * Evaluates allow rules as a candidate verdict, which must pass through validateBashFloor.
 * No branch in evaluateBashCandidate can return 'allow' directly to the caller.
 */
export function bashVerdict(
	command: unknown,
	paths: VaultPaths,
	settings?: PermissionSettings,
	rawCwd?: unknown,
): PermissionVerdict {
	const candidate = evaluateBashCandidate(command, paths, settings, rawCwd);
	if (candidate !== 'allow') {
		return 'ask';
	}

	return validateBashFloor(command, rawCwd, paths) !== null ? 'allow' : 'ask';
}

