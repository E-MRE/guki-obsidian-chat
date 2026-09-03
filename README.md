# GuKi Chat

Chat with Claude Code inside your Obsidian vault — no terminal switch needed.

Opens a pinned chat panel next to your notes. It spawns the real `claude` CLI in your
vault's root, so everything you already have set up for it (`CLAUDE.md`, hooks, skills,
MCP servers, memory) keeps working exactly as it does in a terminal — this plugin is a
different window onto the same CLI, not a separate assistant.

## Requirements

- Desktop Obsidian (this plugin spawns a subprocess — no mobile support, and never will).
- [Claude Code](https://claude.com/claude-code) installed and already logged in on the
  same machine.

## Install

Not on the Community Plugins list yet — install manually:

1. Download the latest release zip (or copy `main.js`, `manifest.json`, `styles.css` and
   `mcp-permission-server.mjs` from this repo after building — see below).
2. Put those files in `<your-vault>/.obsidian/plugins/guki-chat/`.
3. In Obsidian: Settings → Community plugins → turn off Restricted mode if this is your
   first community plugin → enable **GuKi Chat**.

The chat panel opens automatically on startup, pinned in the main area. You can also
open it from the command palette: **GuKi Chat: Open chat**.

## Settings

**Claude Code binary path** — leave empty to auto-detect (checks the usual install
locations, then falls back to a login-shell lookup). Only set this if auto-detect fails;
find the settings page from Settings → Community plugins → the gear icon next to
**GuKi Chat**. A change only takes effect on the next chat session — a CLI that's
already running keeps using the binary it started with.

## What it does

- Sends your messages to `claude --print --input-format stream-json`, one persistent
  process per Obsidian session (not one per message — hooks that run at session start
  fire once, not on every turn).
- Renders the stream as chat bubbles: markdown, code blocks, collapsible tool calls,
  diffs for edits, and permission cards you approve or deny inline.
- Drag-and-drop, clipboard paste, and a file picker for attaching images and files.
- A status line with live cost, duration, and context-window usage.

## Known limits (v1)

- No browsing of past sessions from the panel yet (the CLI's own `--resume` still works
  from a terminal).
- Paths and settings are per-vault; nothing is shared between vaults or synced.

## Building from source

```sh
npm install
npm run build   # tsc + esbuild, produces main.js and mcp-permission-server.mjs
npm run lint
```

`npm run dev` runs an unminified, watching build for local development — point Obsidian
at this repo's folder (or symlink it into `.obsidian/plugins/guki-chat/`) to iterate.

## License

[BSD Zero Clause License](./LICENSE).
