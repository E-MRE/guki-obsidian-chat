# PHASE2-STATE — handoff written mid-implementation (2026-08-28)

Phase 2 ("one-way message: send it, see the full response") is implemented but **not verified in
Obsidian**. `npm run build` and `npm run lint` pass; nothing has been run inside the app yet. This
file exists so a fresh session does not have to re-derive the verified facts below.

Nothing in Phase 1 was touched except `src/ui/chat-view.ts` (composer + message list wired into the
existing `onOpen`) and `src/main.ts` (session ownership + cleanup). The width/pin logic is byte-for-byte
what Emre verified.

---

## 1. Files

Modified (were Phase 1):

| Path | What it does | State |
|---|---|---|
| `src/main.ts` | Creates one `SessionManager`, passes it into `registerView`'s factory, disposes it in `onunload` **and** on `workspace.on('quit')`. | Complete |
| `src/constants.ts` | Added `FALLBACK_VAULT_PATH` (`/Users/you/Documents/YourVault`) and `CLAUDE_BINARY_OVERRIDE` (`''`). | Complete |
| `src/ui/chat-view.ts` | `onOpen` now builds `MessageList` into `.guki-messages` and `Composer` into `.guki-footer`, subscribes to `session.state`, re-syncs on change, unsubscribes in `onClose`. Phase 1 width/pin code unchanged. | Complete |

New:

| Path | What it does | State |
|---|---|---|
| `src/cli/node-api.ts` | Guarded lazy accessors for `child_process`/`fs`/`os`/`path` + `nodeEnv()`; exports `SpawnedProcess` type. All async (cached `Promise`). | Complete |
| `src/cli/events.ts` | stream-json event types from RESEARCH B2/B3/B4, `parseStreamJsonLine`, `userMessageLine`, three type guards. | Complete for Phase 2; `stream_event` typed but not consumed (Phase 3), `tool_result` typed but unused (Phase 4). |
| `src/cli/binary-resolver.ts` | RESEARCH C order: override → `~/.local/bin/claude` → newest `~/.local/share/claude/versions/*` → `/opt/homebrew/bin` → `/usr/local/bin` → `zsh -lc 'command -v claude'`. Throws `BinaryNotFoundError` carrying `attempts[]`. | Complete |
| `src/cli/claude-process.ts` | `spawn` with the mandatory flags, sanitised env, stdout line buffer, stderr tail buffer, `error`/`exit` handlers, `write()`, `stop()` (stdin.end → 2 s SIGTERM → 2 s SIGKILL). | Complete for Phase 2. No `control_request`/interrupt (Phase 3). |
| `src/core/chat-state.ts` | `ChatItem = UserItem \| AssistantItem \| NoticeItem`; assistant content is `Map<number, MessageBlock>`; `subscribe`/`emitChange`; `visibleText()` joins ordered `text` blocks. | Complete |
| `src/core/stream-reducer.ts` | Consumes `system/init`, `assistant`, `result`. `beginTurn`, `failActiveTurn`, `hasActiveTurn`. | Complete for Phase 2 |
| `src/core/session-manager.ts` | Owns process + state + reducer, vault path via `instanceof FileSystemAdapter`, one-turn-at-a-time queue, spawn-error/exit reporting, `dispose()`. | Complete for Phase 2. Queue is FIFO but a failed start drops all queued turns on purpose. |
| `src/ui/markdown.ts` | `renderChatMarkdown(app, md, el, component)` → `MarkdownRenderer.render` with `sourcePath = ''`. | Complete |
| `src/ui/message-list.ts` | Incremental sync keyed by item id, markdown re-rendered only when text changes, sticky-bottom scroll, cost/duration line, error class. | Complete for Phase 2 |
| `src/ui/composer.ts` | Textarea + Send button; Enter sends, Shift+Enter newline, `isComposing` ignored. No other shortcut. | Complete |

**Not started — the one real gap:**

| Path | Missing |
|---|---|
| `styles.css` | Still the 49-line Phase 1 skeleton. **No rules exist for `.guki-message`, `.guki-message-user`, `.guki-message-assistant`, `.guki-message-notice`, `.guki-message-error`, `.guki-message-body`, `.guki-message-meta`, `.guki-composer`, `.guki-composer-input`, `.guki-composer-send`.** The panel will function but look unstyled (raw textarea/button, no bubbles). `.guki-placeholder` is now dead and can go. Apple-inspired shell, Obsidian variables only, no hardcoded colours. |

---

## 2. Verified facts (checked in this session, with source)

Obsidian API — `node_modules/obsidian/obsidian.d.ts`:

- `MarkdownRenderer.render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void>` — **line 4013** (PLAN.md says 4014; one line off, signature identical).
- `Workspace.on(name: 'quit', callback: (tasks: Tasks) => any, ctx?: any): EventRef` — **line 7195**.
- `class Tasks { add(callback: () => Promise<any>): void; addPromise(promise: Promise<any>): void }` — **line 6026**.
- `FileSystemAdapter.getBasePath(): string` — **line 2881**; class declared at **2872**.
- `Platform` is a `const` object (not a class) with `isDesktop`, `isMobile`, `isDesktopApp`, `isMobileApp` — **line 4677**.
- `Component.registerDomEvent(el: HTMLElement, type, cb, options?)` is **public** — **line 1899**; `registerEvent` at 1881, `register` at 1875.

`eslint-plugin-obsidianmd@0.4.0` — read from `node_modules/eslint-plugin-obsidianmd/dist/lib/rules/`:

- `no-nodejs-modules` (`noNodejsModules.js`): reports on **every `ImportDeclaration`** whose source `isBuiltin()` — it never inspects `importKind`, so **`import type { X } from 'child_process'` is reported too**. `isDesktopOnly: true` in the manifest is irrelevant; the rule does not read the manifest.
- Same rule: `require()` and dynamic `import()` are accepted **only when guarded**. Accepted guard forms (from `isGuardedByPlatformIsDesktop`): inside `if (Platform.isDesktop) {...}` consequent, `Platform.isDesktop && ...` right side, ternary consequent, or a function whose **first statement** is `if (!Platform.isDesktop) { throw|return }`. **A module-level `const cp = require('child_process')` can never be guarded and always fails.**
- `rule-custom-message` wraps core `no-console` with `{ allow: ['warn', 'error', 'debug'] }` — `console.log` is an error, `console.debug`/`warn`/`error` are fine.
- `hardcoded-config-path` only matches the literal string `.obsidian`; an absolute vault path is not flagged.
- The recommended config includes `typescript-eslint` **recommended-type-checked**: `no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`, `no-unsafe-argument`, `no-explicit-any`, `no-floating-promises`, `no-misused-promises` are all on. `no-unsafe-type-assertion` is **not** on. This is why `JSON.parse` is typed as `unknown` and narrowed by hand in `events.ts`.
- **Rule-vs-rule conflict found:** `obsidianmd/no-nodejs-modules` pushes toward `require()`, `@typescript-eslint/no-require-imports` forbids `require()`. Both are satisfied only by a **guarded dynamic `import()`**. That is why every `node-api.ts` accessor returns a `Promise`, and why `ClaudeProcess.start()` is `async`.

CLI facts taken from `docs/RESEARCH.md` raw output (not from memory):

- Mandatory flags: `-p --input-format stream-json --output-format stream-json --verbose` (B0: without `--verbose`, exit 1).
- stdin payload: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` + `\n` (B1, verified).
- `system/init` arrives at the start of **every** turn (B1).
- `result` fields: `subtype`, `is_error`, `result?`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`, `permission_denials[]`, `stop_reason`, `terminal_reason`, `ttft_ms`. **`result` is absent on a cancelled turn** (B4).
- `terminal_reason === 'aborted_streaming'` → user cancellation, show "stopped" not an error (B4).
- `assistant.message.content[]` blocks: `text` / `thinking` (+`signature`) / `tool_use`; `parent_tool_use_id` marks subagent output (B2).
- Env to strip: `ANTHROPIC_BASE_URL` plus `CLAUDE*` / `ANTHROPIC*` / `AI_AGENT*` / `HEADROOM*` (C, NEXT trap 2).
- Binary layout on this machine (checked with `ls`): `~/.local/bin/claude` is a **symlink** to `~/.local/share/claude/versions/2.1.250`; `versions/` holds executable **files** named `2.1.247`, `2.1.248`, `2.1.250` — not directories. The resolver sorts them numerically, descending.

---

## 3. The four orchestrator conditions

| # | Condition | State |
|---|---|---|
| a | `getBasePath()` behind `instanceof FileSystemAdapter`, constant only as fallback | **Done.** `SessionManager.vaultPath` (`src/core/session-manager.ts`): `if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();` then `return FALLBACK_VAULT_PATH;`. No cast anywhere. |
| b | No top-level `require` | **Done.** No `require` in the source at all. `src/cli/node-api.ts` uses `import('child_process' \| 'fs' \| 'os' \| 'path')` inside functions whose first statement is `if (!Platform.isDesktop) { throw new Error(DESKTOP_ONLY); }`, cached in module-level `Promise` variables. Verified in the bundle: `main.js` contains `N??=import("child_process")` inside the guarded function. |
| c | Reducer state block-indexed, no flat accumulation | **Done.** `AssistantItem.blocks: Map<number, MessageBlock>`; `MessageBlock` carries `index`, `kind`, `text`, `final`, `toolUseId?`, `toolName?`. `applyAssistant` does `item.blocks.set(index, mapped)` using the position in `message.content[]` — replace, never append. No string `+=` anywhere in the reducer. `visibleText()` sorts by `index` at render time. |
| d | stderr / `error` / `exit` surface a dead subprocess | **Done, unverified in the app.** `ClaudeProcess`: stderr is buffered to the last 8000 chars (`STDERR_BUFFER_LIMIT`) and also forwarded per chunk; `child.on('error')` → `onSpawnError`; `child.on('exit')` → `onExit` with `{code, signal, unexpected, stderr}` where `unexpected = !this.stopping`. `SessionManager.handleSpawnError` fails the in-flight turn and adds an error notice; `handleExit` does the same for an unexpected exit and shows the stderr tail. Both clear the queue, so nothing can sit on "Working…" forever. |

---

## 4. Decisions made while implementing (with reasons)

1. **Guarded dynamic `import()` instead of `require()`** — forced by the rule-vs-rule conflict in §2. Consequence: `ClaudeProcess.start()` is `async` and `SessionManager.startProcess()` awaits it. Do not "simplify" this back to `require`; lint will fail either way you turn unless the import is dynamic and guarded.
2. **`sourcePath = ''`** in `markdown.ts` — the chat is not a note, so links resolve against the vault root. PLAN says "vault root"; the empty string is how that is spelled in the API.
3. **The view is the `Component`** passed to `MarkdownRenderer.render`, never the plugin (`obsidianmd/no-plugin-as-component`).
4. **`SessionManager` lives on the plugin, the view only subscribes** — the subprocess and transcript must survive the panel being closed/reopened. `registerView`'s factory receives it, so no view instance is ever stored on the plugin (`obsidianmd/no-view-references-in-plugin` stays satisfied).
5. **`Composer` is not stored as a field on the view** — nothing focuses it from outside, and auto-focusing on open would steal focus from the editor when the panel is restored at startup.
6. **An unexpected process death is not auto-recovered.** The next `send()` spawns a fresh process, which means a new conversation; the notice says so explicitly rather than silently losing context.
7. **A failed start clears the queue** instead of retrying, so a broken binary cannot produce a pile of stuck messages.
8. **`CLAUDE_BINARY_OVERRIDE` constant** (empty by default) is step 1 of the resolver — it exists as the lever for the "deliberately broken binary path" acceptance test, since there is no settings UI until v2. An override that does not resolve is a hard error, not a reason to fall through to the search.
9. **`user` events are not consumed yet.** They carry `tool_result` (Phase 4) and the synthetic `[Request interrupted by user]` text (Phase 3 cancel). Typed, ignored.
10. **`thinking` and `tool_use` blocks are stored in state but not rendered** — Phase 3/4 own their surfaces; storing them now means the reducer does not change shape later.
11. **Turn metadata is rendered** (duration, cost) because `result` hands it over for free (RESEARCH B6). Not an acceptance criterion; remove if unwanted.

---

## 5. Risks that are unverified — read before trusting anything

1. 🔴 **`import('child_process')` survives into the bundle verbatim.** `main.js` contains a literal `import("child_process")` inside a CJS module (esbuild keeps it because the module is external). Node/Electron should resolve it, **but this has not been executed once**. If it throws at runtime, the fallback that satisfies both lint rules is `window.require('child_process')` — a `MemberExpression` callee, which neither `no-require-imports` (checks an `Identifier` named `require`) nor `no-nodejs-modules` (same check) reports — kept behind the same `Platform.isDesktop` guard. **This is the single most likely "compiles but does nothing" failure of this phase.** It is the same class of bug as the three Phase 1 ones.
2. The panel is unstyled until `styles.css` is written (§1).
3. `nodeEnv()` reads the global `process`. Typechecks and lints clean, unverified at runtime in the Obsidian renderer.

---

## 6. Exact next step

**Write the missing `styles.css` rules** for the classes listed in §1 (bubbles/composer, Apple-inspired shell, Obsidian variables only, plus the `.guki-root.guki-narrow` variants), delete the dead `.guki-placeholder` rule, then run `npm run build && npm run lint`.

**Then hand Emre the manual test list**, in this order, since risk #1 can only be settled in the app:

1. Reload the plugin, open the panel, type `merhaba` + Enter → a markdown-rendered reply appears. **If nothing happens, open the developer console first and look for a dynamic-import error — that is risk #1, not a CLI problem.**
2. `42 sayısını hatırla` → then `hangi sayıyı sormuştum?` → the reply is `42`, and the first message is still on screen (same process, `system/init` on turn 2 did not reset the UI).
3. Ask for something with a code block → it renders with Obsidian's own code-block styling.
4. Quit Obsidian → `ps aux | grep claude` shows no leftover process.
5. Set `CLAUDE_BINARY_OVERRIDE` in `src/constants.ts` to `/tmp/nope/claude`, rebuild → the panel shows a "could not find the CLI" error and does not crash. Reset it to `''` afterwards.

Do not mark any acceptance criterion done on the strength of a clean build — Phase 1's lesson is that `build` and `lint` caught none of the three real bugs.

---

## 7. Command output, as run (2026-08-28)

```
$ npm run build
> guki-chat@0.1.0 build
> tsc -noEmit -skipLibCheck && node esbuild.config.mjs production
(no diagnostics; main.js written, 16126 bytes)

$ npm run lint
> guki-chat@0.1.0 lint
> eslint .
(no output, exit 0)
```

Earlier in the session lint reported 5 errors — 4x `@typescript-eslint/no-require-imports` in
`node-api.ts` and 1x `obsidianmd/rule-custom-message` (`no-console`) in `session-manager.ts`. Both
were fixed by changing the code (dynamic import, `console.debug`), not by suppressing a rule.
