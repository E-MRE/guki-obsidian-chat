/**
 * PLAN §2b's table: the single place a tool call is decided (`allow` silently, or `ask` the reader).
 *
 * Emre's rule, which the table encodes: *note create/edit passes automatically (git makes it
 * reversible); the approval card appears only for command execution, deletion, and access outside
 * the vault. Web search is free.*
 *
 * This cannot be expressed with `--permission-mode` — `acceptEdits` auto-approves `Bash` and still
 * prompts for `Read` (RESEARCH B5b) — so the CLI runs in default mode, every gated call reaches the
 * bridge, and the decision is made here.
 *
 * **Pure, and deliberately so.** No `obsidian` import, no Node import: the only outside knowledge is
 * `VaultPaths`, injected. That is what lets `docs/offline-checks.ts` §N drive every row of the table
 * with no process, no socket and no DOM — which matters more here than anywhere else in the
 * codebase, because *an auto-allow produces no card*. A rule that is wrong in the permissive
 * direction looks exactly like a rule that is right, so every `allow` branch below has a named
 * assertion behind it and the reversion sweep proves each one goes red on its own.
 *
 * Two standing rules from PLAN, restated because they are what make the table unambiguous:
 * - unknown ⇒ `ask`; a new tool must be added deliberately and can never inherit `allow`;
 * - this is a **safety net, not the only defence** — the CLI resolves some low-risk calls itself and
 *   they never reach the bridge at all (RESEARCH B5).
 */
import { evaluateBashCandidate, PROTECTED_SEGMENTS, resolveBashCwd, validateBashFloor } from './bash-whitelist';
export { bashVerdict } from './bash-whitelist';

export type PermissionVerdict = 'allow' | 'ask';

export type CategorySetting = 'always ask' | 'auto-allow';

export type PermissionCategory = 'read' | 'write' | 'command';

export interface RememberedDecision {
	id: string;
	category: PermissionCategory;
	path?: string;
	existedOnGrant?: boolean;
	argv?: string[];
	cwd?: string;
	description?: string;
	createdAt?: number;
}

export interface PermissionSettings {
	readOutsideVault: CategorySetting;
	writeOutsideVault: CategorySetting;
	runCommands: CategorySetting;
	allowEverything: boolean;
	rememberedDecisions: RememberedDecision[];
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
	readOutsideVault: 'always ask',
	writeOutsideVault: 'always ask',
	runCommands: 'always ask',
	allowEverything: false,
	rememberedDecisions: [],
};

/**
 * Normalises settings loaded from disk. Missing, partial or malformed values fall back
 * to the safe default ('always ask', allowEverything false, empty rememberedDecisions).
 */
export function normalizePermissionSettings(raw: unknown): PermissionSettings {
	if (typeof raw !== 'object' || raw === null) {
		return { ...DEFAULT_PERMISSION_SETTINGS, rememberedDecisions: [] };
	}
	const r = raw as Record<string, unknown>;

	const readOutsideVault: CategorySetting =
		r.readOutsideVault === 'auto-allow' ? 'auto-allow' : 'always ask';
	const writeOutsideVault: CategorySetting =
		r.writeOutsideVault === 'auto-allow' ? 'auto-allow' : 'always ask';
	const runCommands: CategorySetting =
		r.runCommands === 'auto-allow' ? 'auto-allow' : 'always ask';
	const allowEverything = r.allowEverything === true;

	const rememberedDecisions: RememberedDecision[] = [];
	if (Array.isArray(r.rememberedDecisions)) {
		for (const item of r.rememberedDecisions) {
			if (typeof item !== 'object' || item === null) {
				continue;
			}
			const entry = item as Record<string, unknown>;
			if (typeof entry.id !== 'string' || entry.id.length === 0) {
				continue;
			}

			if (entry.category === 'read') {
				if (typeof entry.path === 'string' && entry.path.length > 0) {
					rememberedDecisions.push({
						id: entry.id,
						category: 'read',
						path: entry.path.normalize('NFC'),
						description: typeof entry.description === 'string' ? entry.description : undefined,
						createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : undefined,
					});
				}
			} else if (entry.category === 'write') {
				if (typeof entry.path === 'string' && entry.path.length > 0 && typeof entry.existedOnGrant === 'boolean') {
					rememberedDecisions.push({
						id: entry.id,
						category: 'write',
						path: entry.path.normalize('NFC'),
						existedOnGrant: entry.existedOnGrant,
						description: typeof entry.description === 'string' ? entry.description : undefined,
						createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : undefined,
					});
				}
			} else if (entry.category === 'command') {
				if (
					Array.isArray(entry.argv) &&
					entry.argv.length > 0 &&
					entry.argv.every((t) => typeof t === 'string') &&
					typeof entry.cwd === 'string' &&
					entry.cwd.trim().length > 0
				) {
					const normCwd = entry.cwd.normalize('NFC');
					const cleanCwd = normCwd.endsWith('/') && normCwd.length > 1 ? normCwd.slice(0, -1) : normCwd;
					rememberedDecisions.push({
						id: entry.id,
						category: 'command',
						argv: entry.argv,
						cwd: cleanCwd,
						description: typeof entry.description === 'string' ? entry.description : undefined,
						createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : undefined,
					});
				}
			}
		}
	}

	return {
		readOutsideVault,
		writeOutsideVault,
		runCommands,
		allowEverything,
		rememberedDecisions,
	};
}

/**
 * The filesystem, as much of it as the policy is allowed to know.
 *
 * `resolve` returns an **absolute, symlink-free** path — `fs.realpathSync` on the closest existing
 * ancestor, with the non-existent remainder appended — or `null` when the argument cannot safely be
 * resolved at all. String prefix matching on the raw argument is not sufficient: `vault/../etc/hosts`
 * passes it (PLAN §2b), and so does a symlink inside the vault pointing out of it.
 *
 * `isInside` is the composed question the table actually asks. Its comparison is `containsPath`,
 * kept here rather than in the resolver so the boundary check itself is pure and testable.
 */
export interface VaultPaths {
	/** The vault root, already resolved. */
	readonly root: string;
	resolve(raw: string): string | null;
	isInside(raw: string): boolean;
	exists?(rawOrResolved: string): boolean;
}

/**
 * The boundary comparison. Exported because it is the one line where "inside the vault" is defined,
 * and it has two failure modes worth pinning down in tests: a sibling directory sharing the root's
 * name (`/vault-backup` must not match `/vault`), and a root of `/`, which would make everything
 * "inside". An unresolvable path is never inside.
 */
export function containsPath(root: string, resolved: string | null): boolean {
	if (resolved === null || root.length === 0 || root === '/') {
		return false;
	}
	const normRoot = root.normalize('NFC');
	const normResolved = resolved.normalize('NFC');
	const normalizedRoot = normRoot.endsWith('/') ? normRoot.slice(0, -1) : normRoot;
	if (normResolved === normalizedRoot) {
		return true;
	}
	return normResolved.startsWith(`${normalizedRoot}/`);
}

/** Where each tool keeps its path argument, and whether the tool is usable without one. */
interface PathRule {
	field: string;
	/**
	 * `false` only where the CLI's own default is the working directory — which is the vault root,
	 * because that is what `SessionManager` spawns the process with. `Grep` and `Glob` are routinely
	 * called with no `path` at all, and asking for every one of them is exactly the per-turn card
	 * storm RESEARCH B5b warns about.
	 */
	required: boolean;
}

/** Read-only, no side effect. Allowed when their target is inside the vault. */
const READ_ONLY_TOOLS = new Map<string, PathRule>([
	['Read', { field: 'file_path', required: true }],
	['NotebookRead', { field: 'notebook_path', required: true }],
	['LS', { field: 'path', required: true }],
	['Grep', { field: 'path', required: false }],
	['Glob', { field: 'path', required: false }],
]);

/**
 * File-editing tools. Allowed inside the vault because git makes them reversible — which is also
 * why `.git` itself is excluded below, and why the destructive shapes are pulled out.
 */
const EDIT_TOOLS = new Map<string, string>([
	['Edit', 'file_path'],
	['Write', 'file_path'],
	['MultiEdit', 'file_path'],
	['NotebookEdit', 'notebook_path'],
]);

/**
 * Non-filesystem built-ins with no side effect outside the session.
 *
 * `Task`/`Agent` is here because it was **measured**, in Emre's acceptance run on 2026-09-02, not
 * because PLAN's table says so: PLAN's rationale ("no side effect outside the session") is wrong on
 * its face, since a subagent runs its own tools. What settles it is that **a subagent's inner calls
 * are gated individually**. An `Agent` was allowed, its own `Write /tmp/agent-test.md` produced its
 * own approval card with Allow/Deny, and its follow-up `Bash ls -la /tmp/…` produced a second one.
 * So allowing the parent grants nothing: every inner call still arrives at this table on its own.
 * The tool is named `Agent` at this CLI version; `Task` is listed too, because the name has changed
 * before and an unrecognised name would fail closed anyway.
 *
 * The trap that came with the measurement: **a subagent reporting "no permission prompt appeared"
 * is not evidence of anything.** The prompt is intercepted at the broker and shown to the reader —
 * from inside the subagent, an approved call and an ungated one are identical. Only the
 * transcript's own cards can answer this question.
 */
const NO_SIDE_EFFECT_TOOLS = new Set(['WebSearch', 'TodoWrite', 'Task', 'Agent']);

/** Schemes `WebFetch` may be auto-allowed for. `file://` is a local file read wearing a URL. */
const FETCHABLE_SCHEMES = ['http://', 'https://'];

function field(input: unknown, name: string): unknown {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	return (input as Record<string, unknown>)[name];
}

/** A required string field. Anything else — missing, empty, a number — is malformed, so `ask`. */
function stringField(input: unknown, name: string): string | null {
	const value = field(input, name);
	if (typeof value !== 'string' || value.length === 0) {
		return null;
	}
	return value;
}

/**
 * A path argument, checked against the vault. `required: false` means an absent argument is the
 * CLI's own cwd, which is the vault root — present but malformed is still `ask`.
 */
function pathVerdict(input: unknown, rule: PathRule): boolean {
	const raw = field(input, rule.field);
	if (raw === undefined || raw === null) {
		return !rule.required;
	}
	return typeof raw === 'string' && raw.length > 0;
}

/**
 * A glob-shaped argument. `Glob.pattern` and `Grep.glob` are matched against the filesystem, so
 * `../**` reaches outside the vault while the tool's own `path` argument still looks innocent.
 * `Grep.pattern` is deliberately **not** checked: it is a regular expression, where `..` means "any
 * two characters" and is entirely ordinary.
 */
function globEscapes(input: unknown, name: string): boolean {
	const pattern = field(input, name);
	if (typeof pattern !== 'string') {
		return false;
	}
	return pattern.startsWith('/') || pattern.includes('..');
}

function readOnlyVerdict(
	toolName: string,
	input: unknown,
	rule: PathRule,
	paths: VaultPaths,
	settings: PermissionSettings,
): PermissionVerdict {
	if (!pathVerdict(input, rule)) {
		return 'ask';
	}
	if (toolName === 'Glob' && globEscapes(input, 'pattern')) {
		return 'ask';
	}
	if (toolName === 'Grep' && globEscapes(input, 'glob')) {
		return 'ask';
	}
	const raw = field(input, rule.field);
	if (typeof raw !== 'string') {
		// The optional case: no path argument, so the target is the CLI's cwd — the vault root.
		return 'allow';
	}
	if (paths.isInside(raw)) {
		return 'allow';
	}
	const resolved = paths.resolve(raw);
	if (resolved === null) {
		return 'ask';
	}
	const canonicalPath = resolved.normalize('NFC');
	if (settings.rememberedDecisions.some((d) => d.category === 'read' && d.path === canonicalPath)) {
		return 'allow';
	}
	if (settings.allowEverything || settings.readOutsideVault === 'auto-allow') {
		return 'allow';
	}
	return 'ask';
}

/**
 * The destructive shapes PLAN's "deletion, or an existing file being emptied" row is about.
 *
 * Nothing here reads a file, and that is deliberate. Deciding whether the target is "an existing
 * file being emptied" would need a filesystem read *inside the decision*, which opens a window
 * between the check and the write — so instead the **shape** of the input is treated as destructive
 * and the reader is asked. It costs one needless card at worst and never loses a file.
 *
 * That applies to `Edit` and `MultiEdit` too, and their absence here was a real hole: an `Edit`
 * whose `new_string` is empty and whose `old_string` is the whole file empties it just as
 * completely as a `Write` of `''`, and it was silently allowed. An empty `new_string` also
 * describes deleting a fragment from a larger file — the two are not distinguishable from the input
 * alone, so the same trade is made in the same direction. In practice a model deleting a line
 * anchors on context (`"a\nb\nc"` → `"a\nc"`); a bare empty `new_string` is the uncommon shape.
 */
function isDestructiveEdit(toolName: string, input: unknown): boolean {
	if (toolName === 'Write') {
		const content = field(input, 'content');
		return typeof content !== 'string' || content.trim().length === 0;
	}
	if (toolName === 'NotebookEdit') {
		return field(input, 'edit_mode') === 'delete';
	}
	if (toolName === 'Edit') {
		const oldString = field(input, 'old_string');
		const newString = field(input, 'new_string');
		// Malformed is destructive-by-default, the same fail-closed rule the rest of the table uses.
		if (typeof oldString !== 'string' || typeof newString !== 'string') {
			return true;
		}
		return newString.length === 0;
	}
	if (toolName === 'MultiEdit') {
		const edits = field(input, 'edits');
		if (!Array.isArray(edits)) {
			return true;
		}
		// **Any** entry emptying its target is enough — the hunks all land in the same file.
		return edits.some((edit) => {
			const newString = field(edit, 'new_string');
			return typeof newString !== 'string' || newString.length === 0;
		});
	}
	return false;
}

export function validateEditFloor(
	input: unknown,
	pathField: string,
	paths: VaultPaths,
): boolean {
	const raw = stringField(input, pathField);
	if (raw === null) {
		return false;
	}
	const resolved = paths.resolve(raw);
	if (resolved === null) {
		return false;
	}
	const canonicalPath = resolved.normalize('NFC');
	return (
		!raw.normalize('NFC').split(/[/\\]/).some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase())) &&
		!canonicalPath.split('/').some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))
	);
}

export function evaluateEditCandidate(
	toolName: string,
	input: unknown,
	pathField: string,
	paths: VaultPaths,
	settings: PermissionSettings,
): CandidateVerdict {
	const raw = stringField(input, pathField);
	if (raw === null) {
		return 'ask';
	}
	const resolved = paths.resolve(raw);
	if (resolved === null) {
		return 'ask';
	}
	const canonicalPath = resolved.normalize('NFC');
	if (paths.isInside(raw)) {
		if (isDestructiveEdit(toolName, input)) {
			return settings.allowEverything ? 'allow' : 'ask';
		}
		return 'allow';
	}
	const currentlyExists = paths.exists ? paths.exists(resolved) : false;
	if (
		settings.rememberedDecisions.some(
			(d) => d.category === 'write' && d.path === canonicalPath && d.existedOnGrant === currentlyExists,
		)
	) {
		return 'allow';
	}
	if (settings.allowEverything || settings.writeOutsideVault === 'auto-allow') {
		return 'allow';
	}
	return 'ask';
}

export function editVerdict(
	toolName: string,
	input: unknown,
	pathField: string,
	paths: VaultPaths,
	settings: PermissionSettings,
): PermissionVerdict {
	const candidate = evaluateEditCandidate(toolName, input, pathField, paths, settings);
	if (candidate !== 'allow') {
		return 'ask';
	}
	return validateEditFloor(input, pathField, paths) ? 'allow' : 'ask';
}

function webFetchVerdict(input: unknown): PermissionVerdict {
	const url = stringField(input, 'url');
	if (url === null) {
		return 'ask';
	}
	const lower = url.toLowerCase();
	return FETCHABLE_SCHEMES.some((scheme) => lower.startsWith(scheme)) ? 'allow' : 'ask';
}

/**
 * Builds a remembered decision from a tool request, enforcing all security invariants:
 * - Read: exact canonical absolute path.
 * - Write: exact canonical absolute path plus whether target existed on grant. Writes to .obsidian/ or .git are rejected.
 * - Bash: exact normalised argv token sequence. Metacharacters are vetoed.
 * Any malformed input, unresolvable path, or unrecognised tool returns null (fail-closed).
 */
export function buildRememberedDecision(
	toolName: string,
	input: unknown,
	paths: VaultPaths,
): Omit<RememberedDecision, 'id' | 'createdAt'> | null {
	if (READ_ONLY_TOOLS.has(toolName)) {
		const rule = READ_ONLY_TOOLS.get(toolName)!;
		if (!pathVerdict(input, rule)) {
			return null;
		}
		if (toolName === 'Glob' && globEscapes(input, 'pattern')) {
			return null;
		}
		if (toolName === 'Grep' && globEscapes(input, 'glob')) {
			return null;
		}
		const raw = field(input, rule.field);
		const targetRaw = typeof raw === 'string' ? raw : paths.root;
		const resolved = paths.resolve(targetRaw);
		if (resolved === null) {
			return null;
		}
		const canonicalPath = resolved.normalize('NFC');
		return {
			category: 'read',
			path: canonicalPath,
			description: `Read ${canonicalPath}`,
		};
	}

	if (EDIT_TOOLS.has(toolName)) {
		const pathField = EDIT_TOOLS.get(toolName)!;
		const raw = stringField(input, pathField);
		if (raw === null) {
			return null;
		}
		const resolved = paths.resolve(raw);
		if (resolved === null) {
			return null;
		}
		const canonicalPath = resolved.normalize('NFC');
		if (canonicalPath.split('/').some((segment) => PROTECTED_SEGMENTS.has(segment.toLowerCase()))) {
			return null;
		}
		const existedOnGrant = paths.exists ? paths.exists(resolved) : false;
		return {
			category: 'write',
			path: canonicalPath,
			existedOnGrant,
			description: `Write ${canonicalPath} (${existedOnGrant ? 'existing' : 'new'})`,
		};
	}

	if (toolName === 'Bash') {
		const tokens = validateBashFloor(field(input, 'command'), field(input, 'cwd'), paths);
		if (tokens === null) {
			return null;
		}
		const canonicalCwd = resolveBashCwd(field(input, 'cwd'), paths);
		if (canonicalCwd === null) {
			return null;
		}
		return {
			category: 'command',
			argv: tokens,
			cwd: canonicalCwd,
			description: `Bash: ${tokens.join(' ')}`,
		};
	}

	return null;
}

export type CandidateVerdict = 'allow' | 'ask';

/**
 * Evaluates whether a tool request qualifies for an allow decision.
 * Returns only a CandidateVerdict ('allow' | 'ask').
 * This is an allow candidate ONLY: no branch can return a final 'allow' directly
 * without passing through enforceFloor in permissionVerdict.
 */
export function evaluateCandidateVerdict(
	toolName: unknown,
	input: unknown,
	paths: VaultPaths,
	settings: PermissionSettings = DEFAULT_PERMISSION_SETTINGS,
): CandidateVerdict {
	if (typeof toolName !== 'string' || toolName.length === 0) {
		return 'ask';
	}

	if (toolName === 'Bash') {
		return evaluateBashCandidate(field(input, 'command'), paths, settings, field(input, 'cwd'));
	}

	if (NO_SIDE_EFFECT_TOOLS.has(toolName)) {
		return 'allow';
	}

	if (toolName === 'WebFetch') {
		return webFetchVerdict(input);
	}

	const readRule = READ_ONLY_TOOLS.get(toolName);
	if (readRule !== undefined) {
		return readOnlyVerdict(toolName, input, readRule, paths, settings);
	}

	const editField = EDIT_TOOLS.get(toolName);
	if (editField !== undefined) {
		return evaluateEditCandidate(toolName, input, editField, paths, settings);
	}

	return 'ask';
}

/**
 * Structural security floor: the single exit point that produces a final 'allow' verdict.
 * Every tool's evaluation returns only a CandidateVerdict. No allow evaluation can return
 * an allow verdict directly; all candidate allows must pass through this floor enforcer.
 */
export function enforceFloor(
	candidate: CandidateVerdict,
	toolName: unknown,
	input: unknown,
	paths: VaultPaths,
): PermissionVerdict {
	if (candidate !== 'allow') {
		return 'ask';
	}

	if (toolName === 'Bash') {
		return validateBashFloor(field(input, 'command'), field(input, 'cwd'), paths) !== null
			? 'allow'
			: 'ask';
	}

	if (typeof toolName === 'string' && EDIT_TOOLS.has(toolName)) {
		const editField = EDIT_TOOLS.get(toolName)!;
		return validateEditFloor(input, editField, paths) ? 'allow' : 'ask';
	}

	if (
		typeof toolName === 'string' &&
		(READ_ONLY_TOOLS.has(toolName) || NO_SIDE_EFFECT_TOOLS.has(toolName) || toolName === 'WebFetch')
	) {
		return 'allow';
	}

	return 'ask';
}

/**
 * The table. `toolName` and `input` are both `unknown` because they arrive straight off the socket
 * (`RequestMessage`), and every read of them is guarded — a malformed request is `ask`, like an
 * unrecognised one.
 *
 * Structural floor: evaluateCandidateVerdict determines if the request would be allowed by policy,
 * and enforceFloor gates every candidate allow through the absolute floor before returning.
 */
export function permissionVerdict(
	toolName: unknown,
	input: unknown,
	paths: VaultPaths,
	settings: PermissionSettings = DEFAULT_PERMISSION_SETTINGS,
): PermissionVerdict {
	const candidate = evaluateCandidateVerdict(toolName, input, paths, settings);
	return enforceFloor(candidate, toolName, input, paths);
}
