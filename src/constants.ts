/** View type id registered with `registerView`. Also used by `getLeavesOfType` / `detachLeavesOfType`. */
export const VIEW_TYPE_GUKI_CHAT = 'guki-chat-view';

export const CHAT_VIEW_TITLE = 'GuKi Chat';

/** Lucide icon id shown on the tab header. */
export const CHAT_VIEW_ICON = 'message-square';

/**
 * Below this width the panel switches to its narrow layout (`.guki-narrow`).
 * The right sidebar sits well under this; a main-area tab sits well above it.
 */
export const NARROW_BREAKPOINT_PX = 480;

/**
 * The CLI runs with the vault root as its `cwd` (RESEARCH B6). The real path comes from
 * `FileSystemAdapter.getBasePath()`; this is only the fallback for when the adapter is not a
 * FileSystemAdapter, and it is never reached on desktop with a local vault.
 */
export const FALLBACK_VAULT_PATH = '/Users/you/Documents/YourVault';

/**
 * The MCP server name in the generated `mcp.json`, and the tool id built from it.
 *
 * The id format is `mcp__<server>__<tool>`; hyphens in the server name survive it (RESEARCH B5
 * shows `mcp__codebase-memory-mcp__index_repository`). The same name is what the startup
 * self-check looks for in `system/init.mcp_servers` — a mismatch between these two would mean the
 * CLI runs with no approval gate and the check still passes, so they are derived from one string.
 */
export const MCP_SERVER_NAME = 'guki-perm';

export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_NAME}__permission_prompt`;

/** The server script, copied next to `main.js` by esbuild and into a temp dir by the broker. */
export const PERMISSION_SERVER_FILE = 'mcp-permission-server.mjs';

/**
 * Must match `manifest.json`'s `id`. Only a fallback: the authoritative answer is
 * `PluginManifest.dir` (obsidian.d.ts:4946), which the plugin hands to the session at startup.
 * That field is optional, and the config directory is not always `.obsidian`, so both halves of
 * the fallback path are guesses — which is exactly why the real value is preferred.
 */
export const PLUGIN_ID = 'guki-chat';

/**
 * Step 1 of the binary resolution order (RESEARCH C) — the setting, which gains its UI in v2.
 * Empty means "resolve normally". Point it at a nonexistent path to exercise the panel's
 * "binary not found" state by hand.
 */
export const CLAUDE_BINARY_OVERRIDE = '';
