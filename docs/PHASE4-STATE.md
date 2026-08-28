# PHASE4-STATE — Tool rendering

Working state document. Written as the work happens, not at the end (Phase 2 nearly lost its
verified d.ts line numbers to auto-compaction).

Start: 2026-08-28. Base commit `c71e3ad`, tree clean.

---

## F0. What the fixture already covers — no live capture needed for most of Phase 4

`docs/capture-phase3-thinking-redacted.jsonl`, 77 lines, one real turn, session
`5c424a38-beb2-41af-aedd-4cf1982faf7b`, model `claude-opus-5`.

The handoff said it holds three `tool_use` blocks. It holds **more than that** — it also holds
three `user`/`tool_result` events, two of them with `is_error: true`, and two
`system/permission_denied` events. Verified by `jq`, raw output quoted in F1–F4 below.

What it covers:

| Phase 4 surface | Covered? |
|---|---|
| `tool_use` block open + `input_json_delta` stream + authoritative `assistant` | ✅ |
| `tool_result` matched by `tool_use_id` | ✅ (3 results) |
| `is_error === true` result | ✅ (2 results) |
| result `content` as an **array of objects** | ✅ (the `ToolSearch` result) |
| result `content` as a **plain string** | ✅ (the two error results) |
| results arriving **out of block order** | ✅ — see F4, this is the id-matching proof |
| `system/permission_denied` live event | ✅ (Phase 5's, but the shape is recorded here) |
| `parent_tool_use_id` populated (subagent) | ❌ — **the only gap** |
| `Edit`/`Write` tool input for the diff surface | ❌ |

So a live CLI capture is needed for **subagent** and for an **Edit** turn only. Decision below in D5.

---

## F1. `content_block_start` for `tool_use` — raw

```json
{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_01FthQe4aLGRaW6wywBuDhSU","name":"ToolSearch","input":{},"caller":{"type":"direct"}}},"session_id":"5c424a38-...","parent_tool_use_id":null,"uuid":"24c97179-..."}
```

Fields confirmed present on the opening shell: `type`, `id`, `name`, `input` (always `{}` at
open), and an undocumented **`caller: {"type":"direct"}`**. `caller.type` is `"direct"` on all
three tool_use opens in this capture. Not modelled — we have no second observed value for it, and
guessing an enum from one sample is how bad schemas get written.

## F2. `input_json_delta` — raw, all 11 in the capture

```
{"i":2,"p":""}
{"i":2,"p":"{\"query\": \"select:WebSearch,WebFetch"}
{"i":2,"p":"\", \"max_results\": 2"}
{"i":2,"p":"}"}
{"i":0,"p":""}
{"i":0,"p":"{\"query\": \"Trabz"}
{"i":0,"p":"onspor Avrupa Ligi play-off maç sonucu Ağustos 2026"}
{"i":0,"p":"\"}"}
{"i":1,"p":""}
{"i":1,"p":"{\"query\": \"Trabzonspor Europa League playoff result August 2026"}
{"i":1,"p":"\"}"}
```

The field is `delta.partial_json`, on `stream_event.event.delta`, alongside `event.index`.
**The first delta of every block is the empty string**, and the fragments split mid-token
(`"Trabz"` + `"onspor ..."`). So partial JSON is *not* parseable until `content_block_stop`.

**Decision D1 (below):** do not attempt incremental JSON parsing of `partial_json`.

## F3. Authoritative `assistant` event for a `tool_use` block — raw (input inlined)

```json
{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_01FthQe4aLGRaW6wywBuDhSU","name":"ToolSearch","input":{"query":"select:WebSearch,WebFetch","max_results":2}}]}}
```

The **complete, parsed `input` object arrives here**, on the authoritative event — exactly the same
place the final text of a text block arrives. This is what makes D1 safe: we never need to parse
`partial_json` ourselves, we just wait one event.

`src/cli/events.ts:28-33` already types `ToolUseBlock.input?: unknown`. Present and correct.
`mapBlock()` in `src/core/stream-reducer.ts:376-384` **drops it** — it copies `id` and `name` but
not `input`. That is the first thing Phase 4 has to fix.

## F4. `user` / `tool_result` events — raw, all three

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01FthQe4aLGRaW6wywBuDhSU","content":[{"type":"tool_reference","tool_name":"WebSearch"},{"type":"tool_reference","tool_name":"WebFetch"}]}]},"parent_tool_use_id":null,"tool_use_result":{"matches":["WebSearch","WebFetch"],"query":"select:WebSearch,WebFetch","total_deferred_tools":47}}

{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Claude requested permissions to use WebSearch, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_01QXoTaiyJE3fXqoKiPT5zER"}]},"parent_tool_use_id":null,"tool_use_result":"Error: Claude requested permissions to use WebSearch, but you haven't granted it yet.","tool_result_meta":[{"id":"toolu_01QXoTaiyJE3fXqoKiPT5zER","non_execution_kind":"user-rejected"}]}

{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Claude requested permissions to use WebSearch, but you haven't granted it yet.","is_error":true,"tool_use_id":"toolu_01KHHp18vP4iB9rgBp4Q1vJZ"}]},"parent_tool_use_id":null,"tool_use_result":"Error: ...","tool_result_meta":[{"id":"toolu_01KHHp18vP4iB9rgBp4Q1vJZ","non_execution_kind":"user-rejected"}]}
```

Field facts, all from the raw above:

- The block sits at `message.content[]`, `type: "tool_result"`, with `tool_use_id`.
- **`content` has two different runtime shapes.** A plain `string` on the error results; an
  **array of blocks** on the success result. Any renderer must handle both, plus absent.
  `ToolResultBlock.content?: unknown` (`events.ts:38`) is already correctly loose.
- `is_error` is **only present when true**. The successful result has no `is_error` key at all —
  so the test is `=== true`, never `!== false`.
- **Note the field-order trap:** in the error results `tool_use_id` is the *last* key, in the
  success result it is the *first*. Nothing may depend on key order.
- There is a **second, richer copy of the result** on the envelope: `tool_use_result` (parsed
  object on success, string on error) and `tool_result_meta[]` carrying
  `non_execution_kind: "user-rejected"`. Undocumented in RESEARCH. Not consumed in v1 — the
  in-message `content` is enough and is the shape the API itself defines. Recorded here so
  Phase 5 does not have to re-derive it.

### The ordering proof — why id-matching is not theoretical here

Full event order of the turn (`jq` over the capture):

```
MESSAGE_START
  cb_start idx=0 thinking
  ASSISTANT thinking
  cb_start idx=1 text
  ASSISTANT text
  cb_start idx=2 tool_use toolu_01FthQe4aLGRaW6wywBuDhSU
  ASSISTANT  tool_use toolu_01FthQe4aLGRaW6wywBuDhSU
  TOOL_RESULT for toolu_01FthQe4aLGRaW6wywBuDhSU
MESSAGE_START
  cb_start idx=0 tool_use toolu_01QXoTaiyJE3fXqoKiPT5zER
  ASSISTANT  tool_use toolu_01QXoTaiyJE3fXqoKiPT5zER
  TOOL_RESULT for toolu_01QXoTaiyJE3fXqoKiPT5zER      <-- before block idx=1 even opens
  cb_start idx=1 tool_use toolu_01KHHp18vP4iB9rgBp4Q1vJZ
  ASSISTANT  tool_use toolu_01KHHp18vP4iB9rgBp4Q1vJZ
  TOOL_RESULT for toolu_01KHHp18vP4iB9rgBp4Q1vJZ
MESSAGE_START
  cb_start idx=0 text
  ASSISTANT text
```

A result arrives **interleaved into the middle of the second message**, before the next tool_use
block has opened. "The Nth result belongs to the Nth tool_use" happens to hold on *this* capture,
but a queue of pending tool_use blocks with results applied in arrival order would be one
reordering away from filling the wrong card. Match by `tool_use_id`.

## F5. `system/permission_denied` and the `result` event — raw

```json
{"type":"system","subtype":"permission_denied","tool_name":"WebSearch","tool_use_id":"toolu_01QXoTaiyJE3fXqoKiPT5zER","message":"Claude requested permissions to use WebSearch, but you haven't granted it yet.","uuid":"b76d859f-...","session_id":"5c424a38-..."}
```

```json
{"subtype":"success","is_error":false,"terminal_reason":"completed","stop_reason":"end_turn","total_cost_usd":0.1832235,
 "permission_denials":[{"tool_name":"WebSearch","tool_use_id":"toolu_01QXoTaiyJE3fXqoKiPT5zER","tool_input":{"query":"..."}},
                       {"tool_name":"WebSearch","tool_use_id":"toolu_01KHHp18vP4iB9rgBp4Q1vJZ","tool_input":{"query":"..."}}]}
```

Confirms RESEARCH trap 6 on live data: **two tools were denied and the turn is still
`subtype: "success"`, `is_error: false`.** The turn must not render as an error. But the
individual tool cards must, because their `tool_result.is_error === true`. Phase 4's `is_error`
override is exactly what makes this legible.

## F6. The second capture — `docs/capture-phase4-tools.jsonl`, 91 lines

Taken by `docs/capture-phase4.mjs` for the two things F0 marked missing: a populated
`parent_tool_use_id` and a real `Edit` input. Session `32fd66df-10d3-4db6-808d-5b62927361d1`,
model `claude-opus-5`, in a throwaway temp directory (the turn edits a file and it must not be a
vault note).

Event census, by `jq`: 4 `message_start`, 5 `content_block_start`, 21 `content_block_delta`,
10 `assistant`, 9 `user`, 1 `system/task_started`, 5 `system/task_progress`, 1 `system/task_updated`,
1 `system/task_notification`, 1 `system/permission_denied`, 3 `rate_limit_event`, 1 `result`.
**11 events carry `parent_tool_use_id`.**

The main agent's blocks are `text`, `Agent`, `Read`, `Edit`, `text`. The subagent's own five calls
(`Bash`, `Glob`, `Read`, `Bash`, `Bash`) arrive under the parent's id and must never become cards.

**The `Edit` input, raw:**

```json
{"type":"tool_use","id":"toolu_01XCZZqyyrfskL7FkM12YyCU","name":"Edit","input":{"replace_all":false,"file_path":"…/sample.txt","old_string":"bravo","new_string":"BRAVO-EDITED"},"caller":{"type":"direct"}}
```

`replace_all` is present and is **not** one of the three fields the diff reads, so
`diffFromToolInput` must ignore unknown keys rather than validate the object.

**The subagent-spawning tool is called `Agent`, not `Task`:**

```json
{"type":"tool_use","id":"toolu_011eTaSq5vzh5mYS9t1nT3s2","name":"Agent","input":{"subagent_type":"Explore","description":"Count lines in sample.txt","run_in_background":false,"prompt":"…"}}
```

PLAN Phase 4.5 says `Task`. At CLI 2.1.250 the wire name is `Agent`. `tool-policy.ts` carries both;
nothing about the subagent *line* depends on the name, because the parent is identified by id.

**One caveat about this capture, which matters for the manual test.** `capture-phase4.mjs` adds
`--allowedTools Edit,Read,Task,Glob`, which the plugin does **not** pass. So this capture proves
what the panel renders *when the tools are allowed to run*. Which tools the CLI resolves by itself
in the panel's own flag set is Phase 5's subject, and the one live denial here
(`system/permission_denied` for a multi-operation `Bash` **inside the subagent**) shows the shape:

```json
{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_013JRouA1AmtyqLmQhj4BsSg","agent_id":"a71bae7b02f73f1f5","decision_reason_type":"subcommandResults","message":"This Bash command contains multiple operations. …"}
```

`agent_id` is new here and ties the denial to the subagent, not to the main flow. The turn is still
`is_error: false` and the denial appears in `permission_denials[]` — RESEARCH trap 6, confirmed a
second time — and no main-flow card may turn red because of it.

## F7. `system/task_*` — the subagent lifecycle, raw

This is what makes the "subagent running…" line *live* instead of a fixed string. All of these
carry `tool_use_id` — the parent `Agent` call's id — which is what ties them to a card.

```json
{"type":"system","subtype":"task_started","task_id":"a71bae7b02f73f1f5","tool_use_id":"toolu_011eTaSq5vzh5mYS9t1nT3s2","description":"Count lines in sample.txt","subagent_type":"Explore","is_backgrounded":false,"spawn_depth":1,"task_type":"local_agent","prompt":"…"}

{"type":"system","subtype":"task_progress","task_id":"a71bae7b02f73f1f5","tool_use_id":"toolu_011eTaSq5vzh5mYS9t1nT3s2","description":"Running List dir and find sample.txt","subagent_type":"Explore","usage":{"total_tokens":12621,"tool_uses":1,"duration_ms":5000},"last_tool_name":"Bash"}

{"type":"system","subtype":"task_updated","task_id":"a71bae7b02f73f1f5","patch":{"status":"completed","end_time":1787919785478}}

{"type":"system","subtype":"task_notification","task_id":"a71bae7b02f73f1f5","tool_use_id":"toolu_011eTaSq5vzh5mYS9t1nT3s2","status":"completed","output_file":"…/tasks/a71bae7b02f73f1f5.output","summary":"**File:** `…`"}
```

The five `task_progress` descriptions in order: "Running List dir and find sample.txt",
"Finding **/sample.txt", "Reading sample.txt", "Running Count lines check trailing newline",
"Running Count lines and dump bytes". `usage.tool_uses` runs 1 → 5 and `duration_ms` 5000 → 12446.
That is the movement the line shows.

**`task_updated` is deliberately not modelled:** it carries `task_id` and a `patch`, with **no
`tool_use_id`**, so tying it to a card would need a second index, and `task_notification` already
reports completion with the id.

---

---

## Verified Obsidian API (checked in `node_modules/obsidian/obsidian.d.ts`, not from memory)

| Symbol | Line | Signature |
|---|---|---|
| `setIcon` | 5517 | `export function setIcon(parent: HTMLElement, iconId: IconName): void;` |
| `createEl` | 187 | `createEl<K extends keyof HTMLElementTagNameMap>(tag, o?: DomElementInfo \| string, cb?): HTMLElementTagNameMap[K]` |
| `createDiv` | 188 | `createDiv(o?: DomElementInfo \| string, cb?): HTMLDivElement` |

(Existing verified numbers carried over from earlier phases: `View.onResize()` d.ts:6715,
`Workspace.on('layout-change')` d.ts:7119, `WorkspaceLeaf` `pinned-change` d.ts:7369.)

---

## Decisions

**D1. No incremental parsing of `partial_json`.** F2 shows fragments split mid-token and the first
one is always `""`. The complete parsed `input` arrives on the authoritative `assistant` event
(F3) a few milliseconds later. While the arguments are still streaming the card shows the tool
name and a "running" state; the argument summary appears when `input` lands. This keeps
architectural rule #4's shape — stream a placeholder, render on the authoritative event.

**D2. Tool state lives on `MessageBlock`, not in a second map.** `toolUseId`/`toolName` are already
there (`chat-state.ts:30-32`). Phase 4 adds `toolInput`, `toolResult`, `toolIsError`,
`toolPending`. Reason: the block map is already keyed by slot and already survives a panel
reopen; a parallel structure would have to be kept in sync with it and would be the obvious place
for a Phase 5 bug.

**D3. `tool_use_id → slot` index on the reducer, rebuilt per turn.** `applyUser` looks the id up
there. O(1), and an unmatched id is dropped rather than guessed at.

**D4. `is_error` is `=== true`, never truthiness or `!== false`.** F4: the key is absent on
success.

**D5. Live capture scope.** Only two things the fixture lacks: a subagent turn
(`parent_tool_use_id` populated) and an `Edit`/`Write` input for the diff surface. Both captured
in one CLI run and saved to `docs/`, never to a scratchpad.

---

## Next step

(kept current as the work moves)

- [x] Read the docs and the source of every file to be changed.
- [x] Text selection fix in `styles.css` (item 7, one line, do it first).
- [x] `src/core/tool-policy.ts`.
- [x] Reducer: carry `input`, handle `user`/`tool_result`, id index.
- [x] `src/ui/tool-card.ts` + `MessageList.syncBlocks` stops skipping `tool_use`.
- [x] `src/ui/diff-view.ts`, vertical under `.guki-narrow`.
- [x] Subagent line — `parent_tool_use_id` on three event paths, plus the live `system/task_*`
      description and tool-use count (F7).
- [x] Extend `docs/phase3-offline-checks.ts` (renamed to `docs/offline-checks.ts`), prove each new
      assertion goes red — see *Reversion proofs* below. 151 assertions, 106 of them in D–I;
      165 after the acceptance-run fixes (§J).
- [x] Live capture for subagent + Edit — `docs/capture-phase4-tools.jsonl` (F6, F7).
- [x] `npm run build` and `npm run lint` clean. Nothing surfaced; that is the floor, not the proof.
- [x] Numbered manual test list, each step saying *where* it is performed — below.
- [x] **Emre runs the manual list — first pass, 2026-08-28.** Steps 1–8 passed. Steps 9 and 10
      failed; four findings recorded below, all four fixed.
- [x] Fixes for the four acceptance findings, with assertions (§J, 151 → 165) and reversion proofs
      (P1–P6 below).
- [x] **Emre re-runs manual steps 9 and 10** on the rebuilt `main.js` (Cmd+Q first). Both passed.
      The re-run of step 9 surfaced A5–A8, each fixed and re-verified by Emre in turn.
- [x] **All ten manual steps passed. Phase 4 is closed.**
- [ ] The commit comes after that, not before.

---

## Reversion proofs (task 2 — "a check that has never gone red proves nothing")

Every assertion in sections D–I was attacked by reverting the production line it guards, rebuilding
the bundle and re-running. The mutations are one-line reversions to the pre-Phase-4 behaviour or to
the obvious wrong implementation; the source tree was restored after each one (`git diff --stat` is
byte-identical to before the run).

**Always `rm -f /tmp/guki-checks.mjs` first.** A stale bundle kept reporting green through a broken
source tree once already this phase.

| # | Reverted | Assertions that went red |
|---|---|---|
| M1 | `mapBlock` drops `toolInput` again | 10 (D inputs + summary, E, I `Edit` fields and diff) |
| M2 | `toolResultText` loses the array branch | 2 — and note the **exact** D assertion is what caught it; the `includes` one stayed green |
| M3 | `is_error` tested `!== false` | 4 (D slot 2, E slot 1, I `Agent`, I no-card-in-error) |
| M4 | results matched by arrival order | 6 (both E outputs swapped, both error flags, H3) |
| M5 | authoritative event stops preserving a landed result | 1 (E "survives the replacement") |
| M6 | `closeOpenBlocks` stops clearing `toolPending` | 2 (H2 cancel + subprocess death) |
| M7 | `beginTurn` stops clearing the id→slot map | 2 (H3) |
| M8 | `assistant` stops flagging subagent activity | 2 (H1, H1b) |
| M8b | `assistant` stops hiding subagent content | 8 (H1 leak, I block list, I `Read`) |
| M9 | `system/task_*` ignored | 1 (I progress count) |
| M10 | `hasRenderableContent` stops counting `tool_use` | 1 (D) |
| M11 | unknown tools default to `expanded` | 4 (F unknown-tool rule) |
| M12 | the `is_error` expansion override removed | 2 (D, F) |
| M13 | `asRecord` accepts arrays | 1 (F) |
| M14 | paths abbreviated from the head | 1 (F) |
| M15 | `TodoWrite` count summary removed | 1 (F) |
| M16 | MCP first-string-field fallback removed | 2 (D summary, F) |
| M17 | diff suffix scan allowed to overlap the prefix | 1 (G repeated line) |
| M18 / M19 / N13 | `Write` / `MultiEdit` / `Edit` stop producing a diff | 3 / 1 / 11 |
| M20 | `Edit` input types unguarded | 2 (G) |
| M21 | an unmatched `tool_use_id` falls back to slot 0 | 5 (E stranger, H3) |
| M22, M22b | `applyUser` stops skipping subagent results | 1 (H1b `user` path) |
| M23 | a tool block no longer starts pending | 3 (H1, H2) |
| M24 | `stream_event` stops flagging subagent activity | 1 (H1b stream path) |
| M24b | `stream_event` stops hiding subagent content | 1 (H1b delta leak) |
| M25 | `user` events not consumed at all (pre-Phase-4) | 20 |
| M26 | no registration from the authoritative `assistant` event | 2 (H1c) |
| M27 | `content_block_start` stops registering the id→slot map | 8 |
| N1–N6 | each category-table row removed or miscategorised | 1–2 each (F, I, D) |
| N7 | `toolSummary` stringifies a non-object input | 4 (F guards) |
| N8–N11 | each `toolResultText` shape branch removed | 6 / 2 / 3 / 1 |
| N12 | the diff drops the file path | 1 (G) |
| N14 | a `Write` given an empty before-text | 2 (G) |
| N15 | a non-diff tool falls through to an empty diff | 1 (G `Read`) |
| N16 | `diffFromToolInput` loses its object guard | G's `undefined` case — **red as an aborted run**, `TypeError: Cannot read properties of undefined (reading 'file_path')` |
| N17 | `MultiEdit` with no usable edits returns a diff | 1 (G) |
| N18 | the diff loses its common-prefix scan | 2 (G) |
| N19 | `mapBlock` drops the tool name | 18 |
| N20 | a card flagged as a subagent the moment it opens | 1 (H1) |
| N21 | `aborted_streaming` no longer reads as stopped | 1 (H2) |
| N22 / N23 | `applyToolResult` / and `closeOpenBlocks` stop clearing `toolPending` | 1 / 6 |
| N24 | nothing clears `subagentActive` (result, notification, turn close) | 2 (H1, I) |
| N25 | a denied tool fails the whole turn | 2 (B, D) |

### What the proofs found

Three guards were **covered by nothing** — reverting them left all 142 assertions green:

1. **The `stream_event` subagent guard.** H1's `a subagent stream_event does not add a block either`
   only counts blocks, and a leaked subagent delta lands *on the existing slot 0* rather than adding
   a block — so the count stayed at 1 while the tool card silently took the subagent's text.
2. **The `applyUser` subagent guard.** Nothing exercised the `user`-event path into
   `noteSubagentActivity`; H1 lit the same card through the `assistant` path first.
3. **Registration from the authoritative `assistant` event.** Every section feeds a
   `content_block_start` first, so the second registration — the only one there is when
   `--include-partial-messages` is absent — was never reached.

Three new sub-sections close them, and each was then proven red (M24b, M22, M26 above):
**H1b** lights one card per event path and checks each for leaked content, **H1c** replays a turn
with no partial-message stream at all. 142 → 151 assertions.

Five assertions **cannot be made to fail by reverting one line**, and are reported as such rather
than claimed as proven:

- `F: Bash summarises its command` — `{command: 'ls -la'}` also comes out of the unknown-tool
  fallback, so the `Bash` table row is unobservable here. It only goes red when *both* the
  primary-field lookup and the fallback are removed.
- `G: undefined / null / an array input is not a diff` — every later guard already returns null, so
  the object guard's only observable effect is not throwing. It is red as a crash (N16), not as a
  FAIL line.
- `H: the subagent content did NOT leak into the main flow` — under M8b the leaked block overwrites
  slot 0 instead of adding one, so the block *count* stays right. Its sibling
  (`no block holds the subagent text`) is what goes red. The count assertion is redundant, not wrong.
- `H: the closed turn was not rewritten either` — `this.active` is replaced by `beginTurn`, so no
  small reversion can reach the previous turn's item.
- `I: the turn completed despite a denial inside the subagent` — the denial is inside the subagent,
  so no main-flow card carries `toolIsError`; the wrong implementation that fails a turn on a denied
  tool (N25) reddens the section-D sibling instead. It documents the fixture, not a branch.

---

## Acceptance run — Emre, 2026-08-28/29: eight findings, all fixed, all ten steps passed

Run 1: steps 1–8 passed, 9 and 10 failed (A1–A4). Run 2, after those fixes: steps 9 and 10 passed,
and re-testing the narrow layout surfaced four more (A5–A8), each fixed and re-verified in turn.
Final state: **all ten steps passed**. Two findings carry state and are asserted (§J); the other six
are CSS or presentational.

**A1–A3 were fixed by the implementing agent; A4–A8 by the orchestrator.** A4–A8 share one cause
worth carrying into Phase 5: *every one of them was invisible in the wide layout, and every one came
from an Obsidian element default this stylesheet never overrode* — `.guki-tool-header` is a
`<button>` (its `justify-content` and its fixed `height`), and the message surfaces inherit
Obsidian's accent-tinted `::selection` and its `user-select: none`. **A container that inherits
Obsidian's own element defaults must be tested in the sidebar, not in the main area.**

### A1 — a Stop during a pending tool call rendered as an error (step 10)

The card correctly stopped saying `Running…`, but the transcript showed a red *"The turn ended with
error_during_execution."* — breaking the closed Phase 3 decision that a cancellation is **stopped**,
not a failure.

Cause: the reducer's only cancellation marker was `terminal_reason === 'aborted_streaming'`. When
Stop lands while a tool call is **waiting for permission**, the CLI ends the turn with
`subtype: "error_during_execution"` and **no `terminal_reason` at all**.

The subtype cannot simply be mapped to *stopped*: `error_during_execution` also arrives with no Stop
involved, and that one is a real failure the reader has to see. What separates them is knowing
whether *we* asked for it — and only `SessionManager` knows that. So the fix spans both classes:

- `StreamReducer.noteInterruptSent()` sets a per-turn `interruptSent` flag (`beginTurn` clears it),
  and `applyResult` tests `this.interruptSent || terminal_reason === ABORTED_STREAMING` **before**
  the `is_error` branch.
- `SessionManager.interrupt()` calls it when the control request was actually written; when the
  write fails there is no process to interrupt, so it falls back to `failActiveTurn` rather than
  leaving a Stop button that does nothing.

A turn that had already finished when the request went out is marked stopped too. Deliberate: the
alternative is deciding after the fact which of a completed reply and a pressed Stop was "really"
the outcome, and the one thing that must never happen is a cancellation surfacing as a failure.

### A2 — `+4 −0` for a three-line file (step 2)

`split('\n')` on text ending in a newline — nearly every file — yields a trailing empty element that
is not a line. It was both **counted** in the `+n −n` summary and **drawn** as an empty green row in
the *After* pane. `diff-view.ts` now splits through `splitLines()`, which drops exactly **one**
trailing empty element: `"a\n\n"` really does end with a blank line and that one must survive.
`""` yields zero lines, not one.

### A3 — the file path was printed twice (presentational, no assertion)

Once in the card header summary (`toolSummary`) and again in the body's `guki-tool-path` div.
**Kept: the header. Dropped: the body copy** — the header line is the format PLAN §2 specifies for a
tool card, and it is the *only* line a collapsed card shows, so it cannot be the one that goes. The
body copy was redundant in the wide layout and cost a second full-width row directly under an
identical row in the narrow one. The now-dead `.guki-tool-path` rule was removed from `styles.css`.
`DiffInput.path` is still **parsed** — Phase 5's permission card needs the same target path out of
the same parser, and §G asserts on it — it is simply not rendered by the card.

This is a layout decision with no state behind it, so it gets no assertion: an assertion here would
pin the DOM shape of a surface that is meant to change, which is exactly what NEXT.md's "assert on
block content, not on slot placement" rule warns against.

### A4 — the narrow diff collapsed to a hairline (step 9) — fixed by Emre

`.guki-diff-pane { flex: 1 1 0 }` sizes along the **main** axis, which `flex-direction: column`
had turned vertical, and `overflow: auto` on `.guki-diff-lines` zeroed the `min-height: auto` that
would otherwise have held the panes open. `styles.css` now carries
`.guki-root.guki-narrow .guki-diff-pane { flex: 0 0 auto; }` with the reasoning in place.
Not touched by this session beyond reading it.

### A5 — the tool card header centred itself in the narrow layout (step 9)

`.guki-tool-header` is a `<button>`, and Obsidian's own button rule centres its content; our rule
never set `justify-content`. It only showed once the layout went narrow: while the summary sits on
the same row it is `flex: 1 1 auto` and absorbs every spare pixel, so there is nothing to centre,
but `flex-wrap: wrap` moves it to its own line and the icon and tool name then drifted to the middle
of an otherwise empty row. Fixed with an explicit `justify-content: flex-start`.

### A6 — the wrapped path was sliced in half (step 9)

Same root as A5, one property further. Obsidian gives buttons a fixed height; that is fine for a
one-row header, but when the summary wraps to a second row the button does not grow and
`.guki-tool-card { overflow: hidden }` cut the path through the middle of its glyphs. Fixed with
`height: auto; min-height: 0` on the header.

### A7 — a selection inside the user's own bubble was invisible

The user bubble's background is `--interactive-accent` and Obsidian's selection highlight is
accent-tinted, so selected text in a sent message looked identical to unselected text — only the
cursor shape gave away that the region was selectable. The reply bubbles sit on a neutral background
and never had the problem, which is why Phase 3's `user-select` fix looked complete. Fixed with a
`::selection` rule on the user body that inverts the two colours the bubble already uses, so it
stays inside the theme.

### A8 — a selection would not clear on a click beside it

Phase 3 re-enabled selection on `.guki-message` only; the scroller around the bubbles still
inherited Obsidian's `user-select: none`. **Chromium does not collapse an existing selection on a
`mousedown` that lands in a `user-select: none` region**, so clicking in the gap between two bubbles
left the highlight stuck — and clicking the selected text itself cleared it, which is what made the
behaviour look arbitrary. Fixed by enabling selection on `.guki-messages` too. The composer and the
buttons are outside it and stay unselectable.

### Reversion proofs for the fixes (§J, six mutations, all red)

| # | Mutation | FAILs |
|---|---|---|
| P1 | `applyResult` ignores `interruptSent` again (pre-fix line) | 2 (J1) |
| P2 | `interrupt()` stops telling the reducer (`noteInterruptSent` removed) | 2 (J1) |
| P3 | the subtype is blanket-mapped to *stopped* instead of using the flag | 3 (J2) |
| P4 | `beginTurn` stops clearing the flag | 1 (J2 — one Stop would silence every later failure) |
| P5 | `splitLines` reverts to a plain `split('\n')` | 2 (J3) |
| P6 | `splitLines` strips **every** trailing blank line instead of one | 1 (J3) |

P4 needed the assertion rewritten before it went red: the first version began the second turn
without ever setting the flag, so it passed against the broken code. It now stops a turn for real
and lets the *next* one fail on its own. Assertion count 151 → 165; all green after the fixes.

The empty rendered row of A2 is asserted through the **counts**, not the DOM: both come from the
same `splitLines` array, so the phantom row *is* the phantom line, and the checks run under a stub
`obsidian` with no real DOM.

---

## Manual test list (Emre runs this; the commit waits for it)

**Where everything happens.** Steps run in **Obsidian**, in the GuKi Chat panel, unless a step says
otherwise. Two layouts are used: **wide** = the panel as a tab in the main editor area, **narrow** =
the panel dragged into the right sidebar (< 480 px, `.guki-narrow`). Type the prompt into the panel
composer and press Enter.

**Step 0 — load the new build.** In a terminal at the repo root: `npm run build`. Then **quit
Obsidian completely with Cmd+Q** and reopen it — a reload is not enough, a new `main.js` only loads
on a full quit. Open the panel from the command palette: *GuKi Chat: Open chat*. Leave it in the
main area (wide).

Scratch file used below: `📥 000-Inbox/Dump/guki-tool-test.md`. It is created by step 2 and can be
deleted afterwards.

| # | Where | Type this | Pass = |
|---|---|---|---|
| 1 | wide | `read .obsidian/plugins/guki-chat/manifest.json` | A `Read` card appears **while the turn is still running**, as **one collapsed line**: icon, `Read`, and the path. Clicking the header opens it and shows the file contents; clicking again closes it. The reply text follows below it. |
| 2 | wide | `create a note at 📥 000-Inbox/Dump/guki-tool-test.md containing exactly three lines: alpha, bravo, charlie` | A `Write` card appears **already expanded**, with the file path, a `+3 −0` line, and a two-pane diff — the *After* pane holds the three lines, the *Before* pane says `(empty)`. |
| 3 | wide | `in 📥 000-Inbox/Dump/guki-tool-test.md change bravo to BRAVO` | An `Edit` card, **already expanded**, `+1 −1`, *Before* showing `bravo` and *After* showing `BRAVO`, each with a line of context around it. |
| 4 | wide | `read 📥 000-Inbox/Dump/this-file-does-not-exist.md` | The `Read` card is **expanded even though `Read` is a collapsed tool**, has a red border, says `Error`, and the body shows the failure text. The turn itself must **not** render as a failed turn — no red error bubble under the reply. |
| 5 | wide | `search your own tool list for the WebSearch tool` (any call to an unknown/MCP tool works — `ToolSearch`, a `mcp__…` tool) | A card appears with a generic wrench icon, the tool's real name, **collapsed** — and nothing in the panel breaks. Expanding it shows the raw arguments and the result. |
| 6 | wide | (no prompt) With a reply on screen, drag-select a sentence of it with the mouse, Cmd+C, then paste into any note. | The text highlights while dragging and the paste produces that text. This is the Phase-3 regression: before the fix, nothing could be selected. |
| 7 | wide | `list the markdown files directly under 📥 000-Inbox/Dump, then read the two smallest ones, then tell me which is shorter` | Several tool cards appear **one after another**, each showing `Running…` and then a result — the panel is never silent for a long stretch, and the `Working…` meta line disappears as soon as the first card is drawn. This is the "looks frozen" case Phase 4 exists for. |
| 8 | wide | `use the Explore subagent to find which notes under 🏰 300-Projects mention "GuKi Chat"` | An `Agent` (or `Task`) card appears with a **live line on the right of its header** that changes as the subagent works (e.g. "Finding \*\*/…", "Reading …") and carries a rising count. **No subagent content appears in the transcript.** When the call returns, the line disappears and the card holds the subagent's summary. |
| 9 | **narrow** | Drag the panel tab into the **right sidebar**, then repeat step 3's prompt with a different word (`change charlie to CHARLIE`). | The diff is now **stacked vertically** — *Before* above *After*, each full width — instead of side by side, each pane tall enough to read (the panes are `flex: 0 0 auto` here — finding A4). The path appears **once**, in the card header, and nowhere else (finding A3). Dragging the panel back to the main area returns it to side-by-side **without re-sending anything**. |
| 10 | wide | `read .obsidian/plugins/guki-chat/manifest.json` and press **Stop** while a tool card still says `Running…` | The card stops saying `Running…` immediately; the turn is marked *stopped*, not *error* — **no red bubble, and no "The turn ended with error_during_execution."** (finding A1); nothing is left pulsing. |

**One thing to expect that is not a failure.** The permission bridge is Phase 5, so a tool the CLI
does not resolve by itself may come back as a permission error rather than a result. When that
happens the card is red and expanded (which is step 4's behaviour, correct), the turn still reads as
complete (RESEARCH trap 6), and the *card* is still the thing being tested — for step 2 and 3 the
diff is rendered from the tool's **arguments**, so it is on screen whether or not the edit was
allowed to run. If steps 1–3 come back denied, note it: the surfaces still pass, but they must be
re-run after Phase 5 to see a real result body.
