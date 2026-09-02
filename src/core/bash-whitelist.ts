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
import type { PermissionVerdict, VaultPaths } from './permission-policy';

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
 * The gate. `command` is `unknown` because it arrives off the wire inside the tool's `input`; a
 * non-string is malformed and malformed is `ask`.
 */
export function bashVerdict(command: unknown, paths: VaultPaths): PermissionVerdict {
	if (typeof command !== 'string') {
		return 'ask';
	}
	const raw = command.trim();
	if (raw.length === 0) {
		return 'ask';
	}

	// Step 1, on the raw string, before anything is interpreted.
	if (BASH_METACHARACTERS.some((meta) => raw.includes(meta))) {
		return 'ask';
	}

	// Step 2.
	const tokens = tokenizeCommand(raw);
	if (tokens === null || tokens.length === 0 || !matchesWhitelist(tokens)) {
		return 'ask';
	}

	// Step 3.
	return argumentsStayInsideVault(tokens, paths) ? 'allow' : 'ask';
}
