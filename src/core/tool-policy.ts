/**
 * Tool → display category (PLAN §2).
 *
 * The table is explicit and closed; **anything not on it becomes `collapsed`**, which covers every
 * MCP tool and every built-in the CLI grows after this was written. That is the whole point of
 * having a table rather than a heuristic: an unknown tool has one defined outcome, not a guess.
 *
 * Nothing here touches the DOM or the event schema. It takes a tool name and an already-parsed
 * `input` of type `unknown` — the input comes off the wire, so every read of it is guarded.
 */
import type { IconName } from 'obsidian';

/**
 * `error` is deliberately **not** a member. PLAN §2 lists it as an overriding rule, not a
 * category: an errored `Read` is still a `Read`, it is just forced open. Modelling it as a fourth
 * category would mean a card could lose its identity by failing.
 */
export type ToolCategory = 'expanded' | 'collapsed' | 'compact';

const EXPANDED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
const COLLAPSED_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'];
const COMPACT_TOOLS = ['Bash'];

const CATEGORY_BY_TOOL = new Map<string, ToolCategory>([
	...EXPANDED_TOOLS.map((name) => [name, 'expanded'] as const),
	...COLLAPSED_TOOLS.map((name) => [name, 'collapsed'] as const),
	...COMPACT_TOOLS.map((name) => [name, 'compact'] as const),
]);

/** The unknown-tool rule from PLAN §2, in one place so it cannot be re-decided elsewhere. */
export const DEFAULT_CATEGORY: ToolCategory = 'collapsed';

export function toolCategory(toolName: string | undefined): ToolCategory {
	if (toolName === undefined) {
		return DEFAULT_CATEGORY;
	}
	return CATEGORY_BY_TOOL.get(toolName) ?? DEFAULT_CATEGORY;
}

/**
 * Whether the card opens by itself.
 *
 * The overriding rule: an error always wins. A `collapsed` `Read` that failed is shown expanded,
 * because a one-line summary of a failure tells the reader nothing about why it failed.
 */
export function startsExpanded(toolName: string | undefined, isError: boolean): boolean {
	return isError || toolCategory(toolName) === 'expanded';
}

/**
 * Subagent-spawning tools. Their cards carry the "subagent running…" line (PLAN Phase 4.5).
 *
 * **PLAN Phase 4.5 calls this tool `Task`. On the wire at CLI 2.1.250 it is `Agent`** — verified
 * in `docs/capture-phase4-tools.jsonl`, where the block is
 * `{"type":"tool_use","name":"Agent","input":{"subagent_type":"Explore",…}}`. Both names are kept:
 * `Task` is the documented name and the one the CLI used historically, and this list only drives
 * the icon and the summary field, so carrying a name that never arrives costs nothing.
 *
 * Nothing about the subagent *line* depends on this list. That is driven by `parent_tool_use_id`
 * and by the `system/task_*` events, both of which identify the parent by id — so a third name
 * would still light the right card up.
 */
export const SUBAGENT_TOOLS = ['Agent', 'Task'];

/**
 * `IconName` is `string` (obsidian.d.ts:7517), so a wrong name is not a compile error — `setIcon`
 * simply adds nothing. The icon holder is hidden when empty in `styles.css`, so a name that ever
 * stops existing costs a glyph, never a broken row.
 */
const ICON_BY_TOOL = new Map<string, IconName>([
	['Read', 'file-text'],
	['Edit', 'pencil'],
	['MultiEdit', 'pencil'],
	['Write', 'file-plus'],
	['NotebookEdit', 'pencil'],
	['Bash', 'terminal'],
	['Grep', 'search'],
	['Glob', 'search'],
	['LS', 'folder'],
	['WebSearch', 'globe'],
	['WebFetch', 'globe'],
	['TodoWrite', 'list'],
	...SUBAGENT_TOOLS.map((name) => [name, 'bot'] as const),
]);

export function toolIcon(toolName: string | undefined): IconName {
	// `wrench` for everything unnamed on the table — including MCP tools, which are the majority
	// of what will land here.
	return (toolName === undefined ? undefined : ICON_BY_TOOL.get(toolName)) ?? 'wrench';
}

/**
 * The primary argument for each tool's one-line summary, per PLAN §2's format
 * `<icon> <ToolName> <primary-argument abbreviated>`.
 *
 * For a tool not on the list — every MCP tool — there is no known primary field, so the first
 * string-valued property of the input is used. That is a summary, not a contract: it may pick an
 * unhelpful field, but it cannot throw, and a wrong-but-present summary beats a blank row.
 */
const PRIMARY_FIELD_BY_TOOL = new Map<string, string>([
	['Read', 'file_path'],
	['Edit', 'file_path'],
	['MultiEdit', 'file_path'],
	['Write', 'file_path'],
	['NotebookEdit', 'notebook_path'],
	['Bash', 'command'],
	['Grep', 'pattern'],
	['Glob', 'pattern'],
	['LS', 'path'],
	['WebSearch', 'query'],
	['WebFetch', 'url'],
	...SUBAGENT_TOOLS.map((name) => [name, 'description'] as const),
]);

/** Fields that hold a filesystem path, and so are abbreviated from the tail, not the head. */
const PATH_FIELDS = new Set(['file_path', 'notebook_path', 'path']);

const MAX_SUMMARY_CHARS = 72;

export function toolSummary(toolName: string | undefined, input: unknown): string {
	const record = asRecord(input);
	if (!record) {
		return '';
	}

	const field = toolName === undefined ? undefined : PRIMARY_FIELD_BY_TOOL.get(toolName);
	if (field !== undefined) {
		const value = record[field];
		if (typeof value === 'string' && value.length > 0) {
			return PATH_FIELDS.has(field) ? abbreviatePath(value) : abbreviate(value);
		}
	}

	// TodoWrite's primary argument is a list, and a count is the only useful one-liner for it.
	if (Array.isArray(record.todos)) {
		return `${String(record.todos.length)} items`;
	}

	// Unknown / MCP fallback.
	for (const value of Object.values(record)) {
		if (typeof value === 'string' && value.length > 0) {
			return abbreviate(value);
		}
	}
	return '';
}

/**
 * `unknown` → a plain object, or null. `typeof null === 'object'`, and an array is an object too;
 * both would pass a naive check and then read as `undefined` properties forever.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

/** Keeps the tail of a path: the file name is what identifies it, the vault prefix is noise. */
function abbreviatePath(value: string): string {
	const collapsed = value.replace(/\n/g, ' ');
	if (collapsed.length <= MAX_SUMMARY_CHARS) {
		return collapsed;
	}
	return `…${collapsed.slice(collapsed.length - MAX_SUMMARY_CHARS + 1)}`;
}

/** Keeps the head of free text: a query or a command is identified by how it starts. */
function abbreviate(value: string): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= MAX_SUMMARY_CHARS) {
		return collapsed;
	}
	return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/**
 * A `tool_result`'s `content` flattened to text for display.
 *
 * Two runtime shapes were observed in one captured turn (PHASE4-STATE F4): a plain string on the
 * error results, and an **array of blocks** on the success result. A third — absent — is possible.
 * Handling only the string shape would have rendered the successful `ToolSearch` result blank.
 */
export function toolResultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const record = asRecord(part);
				if (!record) {
					return typeof part === 'string' ? part : '';
				}
				// A text block carries `text`. Other block types — the captured `ToolSearch` result
				// is an array of `tool_reference` blocks with no `text` at all — are shown as
				// their JSON, because "[tool_reference]" twice tells the reader nothing.
				if (typeof record.text === 'string') {
					return record.text;
				}
				try {
					return JSON.stringify(record);
				} catch {
					return '';
				}
			})
			.filter((part) => part.length > 0)
			.join('\n');
	}
	if (content === undefined || content === null) {
		return '';
	}
	// An object result (some MCP tools return one). Never throw on it.
	try {
		return JSON.stringify(content, null, 2);
	} catch {
		return '';
	}
}
