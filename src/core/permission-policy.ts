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
import { bashVerdict } from './bash-whitelist';

export type PermissionVerdict = 'allow' | 'ask';

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
	const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
	if (resolved === normalizedRoot) {
		return true;
	}
	return resolved.startsWith(`${normalizedRoot}/`);
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

/** A path segment that revokes the "git makes it reversible" argument the edit allow rests on. */
const PROTECTED_SEGMENT = '.git';

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

function readOnlyVerdict(toolName: string, input: unknown, rule: PathRule, paths: VaultPaths): PermissionVerdict {
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
	return paths.isInside(raw) ? 'allow' : 'ask';
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

function editVerdict(toolName: string, input: unknown, pathField: string, paths: VaultPaths): PermissionVerdict {
	const raw = stringField(input, pathField);
	if (raw === null) {
		return 'ask';
	}
	if (!paths.isInside(raw)) {
		return 'ask';
	}
	if (isDestructiveEdit(toolName, input)) {
		return 'ask';
	}
	const resolved = paths.resolve(raw);
	if (resolved === null || resolved.split('/').includes(PROTECTED_SEGMENT)) {
		return 'ask';
	}
	return 'allow';
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
 * The table. `toolName` and `input` are both `unknown` because they arrive straight off the socket
 * (`RequestMessage`), and every read of them is guarded — a malformed request is `ask`, like an
 * unrecognised one.
 */
export function permissionVerdict(toolName: unknown, input: unknown, paths: VaultPaths): PermissionVerdict {
	if (typeof toolName !== 'string' || toolName.length === 0) {
		return 'ask';
	}

	if (toolName === 'Bash') {
		return bashVerdict(field(input, 'command'), paths);
	}

	if (NO_SIDE_EFFECT_TOOLS.has(toolName)) {
		return 'allow';
	}

	if (toolName === 'WebFetch') {
		return webFetchVerdict(input);
	}

	const readRule = READ_ONLY_TOOLS.get(toolName);
	if (readRule !== undefined) {
		return readOnlyVerdict(toolName, input, readRule, paths);
	}

	const editField = EDIT_TOOLS.get(toolName);
	if (editField !== undefined) {
		return editVerdict(toolName, input, editField, paths);
	}

	// Unknown, including every `mcp__*` tool. Fail closed.
	return 'ask';
}
