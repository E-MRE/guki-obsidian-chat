# PHASE2-STATE — handoff written mid-implementation (2026-08-28)

Phase 2 ("one-way message: send it, see the full response") is implemented. `npm run build` and
`npm run lint` pass. The Node-access bug found on the first run in Obsidian is fixed (§8) and the
whole pipeline was proven end to end in a headless harness; the panel itself still needs Emre's
manual pass (§6). This file exists so a fresh session does not have to re-derive the verified
facts below.

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
| `src/cli/node-api.ts` | Guarded accessors for `child_process`/`fs`/`os`/`path` + `nodeEnv()` via `window.require`; exports `SpawnedProcess` type. Still async (`Promise.resolve`), so no caller changed. | Complete, rewritten — see §8 |
| `src/cli/events.ts` | stream-json event types from RESEARCH B2/B3/B4, `parseStreamJsonLine`, `userMessageLine`, three type guards. | Complete for Phase 2; `stream_event` typed but not consumed (Phase 3), `tool_result` typed but unused (Phase 4). |
| `src/cli/binary-resolver.ts` | RESEARCH C order: override → `~/.local/bin/claude` → newest `~/.local/share/claude/versions/*` → `/opt/homebrew/bin` → `/usr/local/bin` → `zsh -lc 'command -v claude'`. Throws `BinaryNotFoundError` carrying `attempts[]`. | Complete |
| `src/cli/claude-process.ts` | `spawn` with the mandatory flags, sanitised env, stdout line buffer, stderr tail buffer, `error`/`exit` handlers, `write()`, `stop()` (stdin.end → 2 s SIGTERM → 2 s SIGKILL). | Complete for Phase 2. No `control_request`/interrupt (Phase 3). |
| `src/core/chat-state.ts` | `ChatItem = UserItem \| AssistantItem \| NoticeItem`; assistant content is `Map<number, MessageBlock>`; `subscribe`/`emitChange`; `visibleText()` joins ordered `text` blocks. | Complete |
| `src/core/stream-reducer.ts` | Consumes `system/init`, `assistant`, `result`. `beginTurn`, `failActiveTurn`, `hasActiveTurn`. | Complete for Phase 2 |
| `src/core/session-manager.ts` | Owns process + state + reducer, vault path via `instanceof FileSystemAdapter`, one-turn-at-a-time queue, spawn-error/exit reporting, `dispose()`. | Complete for Phase 2. Queue is FIFO but a failed start drops all queued turns on purpose. |
| `src/ui/markdown.ts` | `renderChatMarkdown(app, md, el, component)` → `MarkdownRenderer.render` with `sourcePath = ''`. | Complete |
| `src/ui/message-list.ts` | Incremental sync keyed by item id, markdown re-rendered only when text changes, sticky-bottom scroll, cost/duration line, error class. | Complete for Phase 2 |
| `src/ui/composer.ts` | Textarea + Send button; Enter sends, Shift+Enter newline, `isComposing` ignored. No other shortcut. | Complete |
| `styles.css` | 223 lines. Bubbles (user = accent, right; assistant = card, left; notice = centred), `.guki-message-error` on both, card-shaped composer with `:focus-within` accent border, `.guki-narrow` variants. Dead `.guki-placeholder` removed. Every colour is an Obsidian variable, and each variable used was confirmed to be defined in `obsidian.asar`. | Complete |

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
- **Rule-vs-rule conflict found:** `obsidianmd/no-nodejs-modules` pushes toward `require()`, `@typescript-eslint/no-require-imports` forbids `require()`. **Both check for a bare `require` identifier as the callee**, so `window.require('fs')` — a `MemberExpression` — satisfies both with no suppression (verified: `npm run lint` exit 0). A guarded dynamic `import()` also satisfies both, but does not work at runtime (§8). The accessors still return a `Promise` only so that no caller had to change.

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

1. **`window.require` behind the `Platform.isDesktop` guard** (was: guarded dynamic `import()`, which was broken — §8). The accessors stay async and `ClaudeProcess.start()` stays `async`; `require` is synchronous and the result is wrapped in `Promise.resolve`. Do not unwind the async plumbing, and do not go back to a bare `require` identifier — that is what the two lint rules actually match.
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

1. ✅ **Settled — it did fail, and it is fixed.** See §8. `main.js` now contains no `import(` at all (`grep -c 'import("' main.js` → 0) and one `window.require` shim: `function p(r){return window.require(r)}`.
2. ✅ Styling is written (§1). Unseen in the app — it is CSS, so the risk is cosmetic, not functional.
3. ✅ `nodeEnv()` no longer reads the global `process`; it reads `require('process').env`, which does not depend on Electron exposing the global.
4. 🟡 **The panel has still never rendered a reply in Obsidian.** The pipeline is proven headlessly (§8), which covers binary resolution, env sanitising, spawn, NDJSON buffering, the reducer and `visibleText()` — but not `MarkdownRenderer`, not the view wiring, and not `window.require` inside Chromium. That last one is the standard Obsidian desktop-plugin pattern, but Phase 1's lesson says it counts as unverified until Emre sees it.

---

## 6. Exact next step

Both implementation tasks are done. What is left is **Emre's manual pass in Obsidian**:

1. Reload the plugin, open the panel, type `merhaba` + Enter → a markdown-rendered reply appears in a bubble. **If nothing happens, open the developer console first: an error naming `require` means the Node-access fix (§8) did not take; a CLI error names the binary.**
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

Re-run after the §8 fix and after `styles.css` was written: `npm run build` exit 0, `npm run lint`
exit 0, no output.

Earlier in the session lint reported 5 errors — 4x `@typescript-eslint/no-require-imports` in
`node-api.ts` and 1x `obsidianmd/rule-custom-message` (`no-console`) in `session-manager.ts`. Both
were fixed by changing the code (dynamic import, `console.debug`), not by suppressing a rule.


---

## 8. The Node-access bug and its fix (2026-08-28, after the first run in Obsidian)

**Symptom.** Sending a message produced three stacked errors in the panel: "The Claude Code CLI could
not be started." / "Could not find the Claude Code CLI." / "Failed to resolve module specifier 'os'."

**Cause.** esbuild treats Node built-ins as external, so the guarded `import('child_process')` was
emitted into `main.js` **verbatim** — and `main.js` is CJS. A dynamic `import()` inside a CJS module
is resolved by **Chromium**, not by Node, so every one of the four accessors rejected. Confirmed
independently in the Obsidian console: `await import("child_process")` fails the same way.

**Fix.** `src/cli/node-api.ts` now reaches Node through `window.require`:

```ts
interface NodeRequireWindow { require: (id: string) => unknown; }
function loadNodeModule(id: string): unknown {
	return (window as unknown as NodeRequireWindow).require(id);
}
```

- The `if (!Platform.isDesktop) { throw ... }` first statement of every accessor is unchanged.
- The accessors keep their async signatures (`Promise.resolve(...)`), so `ClaudeProcess.start()`,
  `SessionManager.startProcess()` and `binary-resolver.ts` are untouched.
- The result of `loadNodeModule` is `unknown` and is cast per call site to `typeof import('<mod>')`
  — a type position, which `no-nodejs-modules` does not inspect. Typing it `any` instead would trip
  `no-unsafe-call` / `no-unsafe-assignment` / `no-unsafe-member-access` from
  `recommended-type-checked`. No rule is suppressed anywhere; lint exits 0.
- `nodeEnv()` was changed too, pre-emptively: it now returns `require('process').env` rather than
  reading the global `process`, since the global has the same "only there if Electron exposes it"
  dependency that caused this bug.

**Proof.** A headless harness (`esbuild`-bundled from the real `src/` modules, `obsidian` stubbed to
`Platform.isDesktop = true`, and `globalThis.window = { require, setTimeout, clearTimeout }` as the
*only* Node access) ran a full turn against the real CLI:

```
binary: /Users/you/.local/bin/claude (~/.local/bin)
status: complete meta: {"costUsd":0.115024,"durationMs":4944}
text: "... MERHABA GUKI"
```

So binary resolution, env sanitising, `spawn`, the stdout line buffer, the stream-json parser, the
reducer and `visibleText()` all work through `window.require`. What the harness cannot cover is
Chromium's own `window.require` and `MarkdownRenderer` — that is manual test 1.

---

## 9. Phase 2 closed — Emre's manual pass in Obsidian (2026-08-28)

All seven steps passed. Phase 2 is done: send a message, see the full response.

| Step | Result |
|---|---|
| 1. Reply renders | ✅ Real reply, markdown-rendered, `33.4 s · $0.2503`. The `window.require` fix works inside Chromium; `MarkdownRenderer` and the view wiring work. |
| 2. Second turn / `system/init` | ✅ `42` came back and turn 1 was still on screen — one persistent process, and `system/init` on turn 2 did not reset the UI. |
| 3. Code block | ✅ Obsidian's own code-block styling, **including syntax highlighting and the copy button** — neither is in our CSS, so `MarkdownRenderer.render` really is going through Obsidian's pipeline with the right `Component`. |
| 4. Theme | ✅ Light and dark both readable: user bubble, assistant card, code block and composer. No hardcoded colour (55 `var(--…)`, verified by grep and by eye). |
| 5. Width | ✅ Dragged to the right sidebar → narrow mode, Send not clipped, no horizontal overflow. Dragged back → wide mode **without touching the window**, which is exactly the Phase 1 bug that `onResize()` + `layout-change` + the one-frame delay was added to fix. |
| 6. Scroll | ✅ (as far as this phase allows) Scrolled to the bottom on arrival, and when Emre had scrolled up, a new reply did **not** yank him back down. Live follow-while-streaming is unmeasurable here — there is no incremental stream until Phase 3. |
| 7. Clean shutdown | ✅ After Cmd+Q no `claude -p --input-format stream-json` process was left. The two `stream-json` processes in `ps` output belong to the VSCode extension and to a cmux hook, not to the plugin. |

Step 5 of §6 (`CLAUDE_BINARY_OVERRIDE`) was skipped deliberately: the error path had already been
seen live earlier in the session, when the dynamic-import bug surfaced as
`Failed to resolve module specifier 'os'` rendered as an error bubble without crashing.

### Deferred to Phase 3 — found by this manual pass, not by build or lint

1. **The empty-card gap.** On the first `assistant` event the status goes `pending` → `streaming`
   and the meta line is cleared with `setText('')`, but that first event carries a *thinking* block,
   and `visibleText()` only collects `text` blocks — so the body is still empty. The result is a
   completely blank card for the whole turn: "Working…" disappears and nothing replaces it. Emre
   read it as "no reply is coming". With a 33–50 s turn and no token streaming yet, that meta line is
   the only sign of life the user has. Fix: while `streaming` with no visible text, keep the meta
   line (`Thinking…` / `Working…`) instead of blanking it.
2. **No "jump to bottom" affordance.** Not yanking the reader down is correct, but nothing tells him
   a reply arrived while he was scrolled up. Same code region as `isAtBottom()` / `scrollToBottom()`,
   and it will matter far more once replies stream token by token. Emre raised this himself.

Neither is a Phase 2 acceptance criterion, and neither reopens the phase.

### Observations worth carrying forward

- **Turn cost and latency are dominated by the session, not the CLI.** A bare `merhaba` cost
  `$0.2503` / 33.4 s because every SessionStart hook runs and the GuKi system prompt is large. This
  is an argument for the persistent process (B1), not against it.
- **Second live piece of evidence for Phase 5.** The in-panel GuKi could *write* to mem0
  (`add_memory` succeeded) but not *read* it — `search_memories` asked for permission and, the
  session being non-interactive, the call silently vanished with nothing shown to the user. That is
  exactly the hole `--permission-prompt-tool` plus our own approval UI closes.
- The in-panel session also left a stray memory file (`memory/emre_hatirla_42.md`) it lacked
  permission to delete. Removed by hand. Another symptom of the same missing permission bridge.
