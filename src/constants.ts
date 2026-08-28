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
 * Step 1 of the binary resolution order (RESEARCH C) — the setting, which gains its UI in v2.
 * Empty means "resolve normally". Point it at a nonexistent path to exercise the panel's
 * "binary not found" state by hand.
 */
export const CLAUDE_BINARY_OVERRIDE = '';
