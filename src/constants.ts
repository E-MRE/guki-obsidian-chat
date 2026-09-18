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
 * The MCP server name in the generated `mcp.json`, and the tool id built from it.
 *
 * The id format is `mcp__<server>__<tool>`; hyphens in the server name survive it (RESEARCH B5
 * shows `mcp__codebase-memory-mcp__index_repository`). The same name is what the startup
 * self-check looks for in `system/init.mcp_servers` — a mismatch between these two would mean the
 * CLI runs with no approval gate and the check still passes, so they are derived from one string.
 */
export const MCP_SERVER_NAME = 'guki-perm';

export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_NAME}__permission_prompt`;

/** The server script, bundled into `main.js` at build time and written into a temp dir by the broker. */
export const PERMISSION_SERVER_FILE = 'mcp-permission-server.mjs';
