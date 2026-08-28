# PHASE3-STATE — Live streaming (working file)

Working file for Phase 3 only. Filled as the work happens, not at the end. When Phase 3 closes,
lift the still-relevant lessons into `docs/NEXT.md` and move this file to `docs/archive/`.

## Scope (from PLAN.md "Phase 3 — Live streaming" + NEXT.md)

| # | Task | Status |
|---|---|---|
| 1 | `--include-partial-messages` | ✅ verified by Emre in Obsidian — `claude-process.ts` buildArgs |
| 2 | `stream_event` branch in the reducer, block-indexed | ✅ verified by Emre in Obsidian — `stream-reducer.ts`, slots not array positions (F2) |
| 3 | Plain text while streaming, markdown on the authoritative `assistant` event | ✅ verified by Emre in Obsidian — `message-list.ts` updateTextBlock |
| 4 | `thinking-block.ts` — collapsed but never hidden | ⚠️ **failed step 3, fixed, awaiting re-test** — see F8 and D-7 |
| 5 | Sticky-bottom auto-scroll | ✅ verified by Emre in Obsidian — unchanged from Phase 2, now covers streaming |
| 6 | Stop button via `control_request` / `interrupt` | ✅ verified by Emre in Obsidian — `composer.ts` + `SessionManager.interrupt` |
| 7 | Cancellation renders as "stopped", not an error | ✅ verified by Emre in Obsidian — `applyResult`, verified by replay |
| D1 | Deferred from Phase 2: the empty-card gap | ✅ verified by Emre in Obsidian — thinking header + meta never blanks without content |
| D2 | Deferred from Phase 2: "jump to bottom" affordance | ✅ verified by Emre in Obsidian |

Manual test, round 1: **steps 1, 2, 4–10 passed**, step 3 failed. Everything above except task 4 is
verified in Obsidian and closed; do not re-litigate it. Three further defects were found by review
rather than by the test, none of which it covered:

| # | Defect | Status |
|---|---|---|
| B | `StreamReducer.failActiveTurn` never fired `onTurnEnd`, stranding a queued message | ✅ fixed — D-8, check C2 |
| C | The Stop button was inert on the first message, for the whole binary-resolution window | ✅ fixed — D-9, check C1 |
| D | `tsconfig.json` `moduleResolution: "node"` is deprecated | ✅ fixed — D-10 |

## Verified API signatures (from node_modules/obsidian/obsidian.d.ts)

Re-verified for Phase 3 on 2026-08-28:

| Symbol | Line | Signature |
|---|---|---|
| `View.onResize` | 6715 | `onResize(): void;` |
| `Workspace.on('layout-change')` | 7119 | `on(name: 'layout-change', callback: () => any, ctx?: any): EventRef;` |
| `WorkspaceLeaf.setPinned` | 7337 | `setPinned(pinned: boolean): void;` |
| `WorkspaceLeaf.on('pinned-change')` | 7369 | `on(name: 'pinned-change', callback: (pinned: boolean) => any, ctx?: any): EventRef;` |

New for Phase 3. All are the Obsidian `HTMLElement` extensions declared in the `declare global`
block at the top of the file, verified before use — `show`/`hide` in particular are Obsidian's, not
DOM standard:

| Symbol | Line | Signature |
|---|---|---|
| `HTMLElement.show` | 94 | `show(): void;` |
| `HTMLElement.hide` | 95 | `hide(): void;` |
| `Element.setText` | 77 | `setText(val: string \| DocumentFragment): void;` |
| `Element.toggleClass` | 82 | `toggleClass(classes: string \| string[], value: boolean): void;` |
| `Element.setAttr` | 84 | `setAttr(qualifiedName: string, value: string \| number \| boolean \| null): void;` |
| `Element.createEl` | 187 | `createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomElementInfo \| string, callback?): HTMLElementTagNameMap[K];` |

No new `obsidian` module imports were needed; `MarkdownRenderer.render` (d.ts:4013) is unchanged
from Phase 2.

## Open questions being resolved by spike

`scratchpad/spike/partial.mjs` — one persistent process, `--include-partial-messages`, two turns:
turn 1 a normal thinking+text+code answer, turn 2 interrupted on the first `text_delta`.

1. Exact `stream_event.event` field names: `type`, `index`, `delta.type`, `delta.text`,
   `delta.thinking`, `content_block.type`. RESEARCH B3 records the delta *types* but not the
   surrounding field names verbatim.
2. **Does one `assistant` event carry the whole message, or one block?** RESEARCH B3 counted
   2 `assistant` events against 2 `content_block_start`s in the same message. If each `assistant`
   event carries only the block that just closed, the existing reducer is wrong: it keys blocks by
   the *array position* inside `message.content[]`, so a second event's text block at array index 0
   would overwrite the thinking block already stored at map key 0. This is the mechanism behind
   Phase 2's deferred item D1 (the empty card).
3. `system/thinking_tokens` body shape — whether it can drive a live counter in the header.
4. `control_response` shape and the interrupted `result` shape at this CLI version (2.1.250).

## Findings — raw output, CLI 2.1.250, `claude-haiku-4-5-20251001`

Captured by `scratchpad/spike/partial.mjs`; full capture was in `raw.jsonl`. Quoted verbatim.

> **That scratchpad is gone.** It went with the session that made it, and closing Phase 3 needed a
> re-capture from the live CLI. The replacement lives in `docs/`, where it survives:
> `docs/capture-phase3-thinking-redacted.jsonl` — same CLI, same vault, but **`claude-opus-5`**,
> the model the panel actually runs. See F8–F10. Raw captures go in `docs/` from now on.

### F1. `stream_event.event` shapes

> ⚠️ **Model-specific in one respect: the thinking text.** Everything below about *field names* and
> *ordering* holds. But the plaintext `"thinking":"The user is asking"` in the `thinking_delta`
> here is a `claude-haiku-4-5-20251001` property. On `claude-opus-5` the same field is `""` for the
> whole turn — see F8. The finding is not wrong, it is narrower than it looks.

```json
{"type":"stream_event","event":{"type":"message_start","message":{"model":"...","id":"msg_011CeUyjPnQKsS44xH85bL9J","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{...}}},"session_id":"...","parent_tool_use_id":null,"uuid":"...","ttft_ms":955}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},"parent_tool_use_id":null,...}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},...}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is asking","estimated_tokens":null}},...}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"..."}},...}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"```\nMem0 Active |"}},...}
{"type":"stream_event","event":{"type":"content_block_stop","index":0},...}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null},"usage":{...}},...}
{"type":"stream_event","event":{"type":"message_stop"},...}
```

So: the index lives on `event.index`, the text on `event.delta.text`, the thinking on
`event.delta.thinking`, the opening block's kind on `event.content_block.type`. `parent_tool_use_id`
sits on the **outer** `stream_event`, not inside `event` — subagent stream events are filtered the
same way assistant events are.

### F2. 🔴 An `assistant` event carries **one block**, and its array index is always 0

This is the important one, and it invalidates how the Phase 2 reducer keys blocks.

```
msg_011CeUyjPnQKsS44xH85bL9J ['thinking'] stop=None ptu=None
msg_011CeUyjPnQKsS44xH85bL9J ['text']     stop=None ptu=None
```

Two `assistant` events, **the same `message.id`**, one content block each, each at
`message.content[0]`. The stream indices for those same two blocks were 0 (thinking) and 1 (text).

`stream-reducer.ts` did `content.forEach((block, index) => item.blocks.set(index, mapped))` — the
*array position*. So the text block landed on map key 0 and overwrote the thinking block. Every
Phase 2 turn silently lost its thinking block, and any turn with two text blocks would lose the
first. This is the mechanism behind deferred item D1.

**Fix:** an `assistant` event's blocks are assigned to a running per-turn slot counter, not to their
array position. The counter agrees with the stream index because assistant events arrive one per
closed block, in block order. Verified against the capture: slots 0, 1 = stream indices 0, 1.

Multiple API messages inside one turn (a tool-use round trip) restart `event.index` at 0, so the
reducer keeps a `blockBase` that advances at each `message_start` to one past the highest slot used
so far. The running assistant counter then stays in step without needing the index at all.

### F3. `system/thinking_tokens`

```json
{"type":"system","subtype":"thinking_tokens","estimated_tokens":299,"estimated_tokens_delta":68,"uuid":"...","session_id":"..."}
```

`estimated_tokens` is cumulative within the message and restarts at 5 on the next turn. It arrives
interleaved with the `thinking_delta`s, so it can drive a live counter in the collapsed header.

### F4. Interrupt round trip

```
[13314] content_block_delta idx=1 text_delta   -> sending interrupt
[13316] control_response {"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}
[13317] assistant msgid=msg_011CeUyjx6rCq12oHdPPXjDn blocks=["text"]
[13318] user  [{"type":"text","text":"[Request interrupted by user]"}]
[13319] RESULT subtype=error_during_execution is_error=true terminal_reason=aborted_streaming hasResult=false
```

2 ms round trip. Note the payload nests twice: `control_response.response.subtype`, not
`control_response.subtype` — the Phase 2 `ControlResponseEvent` type had it flat. Corrected.

A **partial** `assistant` event still lands after the interrupt, so the text streamed so far becomes
final; nothing has to be salvaged from the delta buffer.

### F5. `result` keys, both outcomes

```
success               duration_ms=7109  ttft_ms=4996  'result' in ev = True   terminal_reason=completed
error_during_execution duration_ms=2637 ttft_ms=None  'result' in ev = False  terminal_reason=aborted_streaming
```

RESEARCH B4 confirmed at this version: the cancelled result has **no `result` key at all**, but it
does still carry `duration_ms` and `total_cost_usd`, so the meta line is still worth writing.

### F6. A tool-use turn contains two messages, and `index` restarts at 0 in the second

`scratchpad/spike/tooluse.mjs`, one turn, `--allowedTools Read`. Capture in `tooluse.jsonl`:

```
MESSAGE_START id=msg_011CeUzWwhHkcUMSevrq2wck
  block_start idx=0 type=thinking     ASSISTANT content=["thinking"]   block_stop idx=0
  block_start idx=1 type=text         ASSISTANT content=["text"]       block_stop idx=1
  block_start idx=2 type=tool_use     ASSISTANT content=["tool_use"]   block_stop idx=2
USER content=["tool_result"] ptu=null
MESSAGE_START id=msg_011CeUzXLWEchcocz1otexFa
  block_start idx=0 type=thinking     ASSISTANT content=["thinking"]   block_stop idx=0
  block_start idx=1 type=text         ASSISTANT content=["text"]       block_stop idx=1
RESULT success is_error=false
```

The second message's indices **do** restart at 0, so `blockBase` is load-bearing, not defensive.
Five `assistant` events, one block each, in block order — the running counter and `blockBase` agree.
The `tool_result` arrives on a `user` event with `parent_tool_use_id: null` (Phase 4's problem).

### F7. `white-space: pre-wrap` cannot be a permanent rule on a text block

The streaming block is written with `setText`, so it needs `pre-wrap` to keep its newlines. Leaving
that rule on after the markdown render inherits into Obsidian's `<p>` elements and turns a
paragraph's soft wraps into hard line breaks. It is toggled with the block's `final` flag instead.

## Findings — raw output, CLI 2.1.250, `claude-opus-5`

`docs/capture-phase3-thinking-redacted.jsonl`, 77 lines, one turn, captured from the live CLI under
the same vault context the panel uses. This is the model Emre's panel runs.

### F8. 🔴 Thinking content is **encrypted** on this model — the deltas carry `""`

The whole reason step 3 of the manual test failed. Verbatim, the entire thinking block:

```json
{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50}
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}
{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":null}}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":158,"estimated_tokens_delta":108}
{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"CAIS7QQKpgEIERgCKkA+eM6e2HZMnQoQxZQL6sGi…"}}
```

and the authoritative event that closes it:

```
ASSISTANT [('thinking', 0 chars, ['signature','thinking','type'])]
```

Only the signature (840 chars) and the token counts are real. The reducer and the renderer were both
correct — they faithfully rendered an empty string. The **product** was wrong: it offered a
clickable expander for a block that can never hold content, so Emre clicked it and got an empty box.
Reproduced in both themes, on a thinking stretch as long as 23.5 s.

Do not "fix" the reducer for this. The fix is in `message-list.ts` — see D-7.

### F9. An `assistant` event arrives **before** that block's `content_block_stop`

Consistent across all six blocks of the capture, three API messages:

```
17 START 0 thinking      23 ASSISTANT ['thinking']   24 STOP 0
25 START 1 text          28 ASSISTANT ['text']       29 STOP 1
30 START 2 tool_use      35 ASSISTANT ['tool_use']   36 STOP 2
43 START 0 tool_use      48 ASSISTANT ['tool_use']   50 STOP 0   ← second message, index restarts
52 START 1 tool_use      56 ASSISTANT ['tool_use']   58 STOP 1
65 START 0 text          73 ASSISTANT ['text']       74 STOP 0   ← third message
```

The code already tolerates it: `applyAssistant` sets `endedAt = streamed?.endedAt ?? Date.now()`
and `closeBlock` uses `endedAt ??=`, so the later `content_block_stop` cannot overwrite the
timestamp. The ordering itself was undocumented — nothing said which of the two lands first.

Also visible here: **one `assistant` event per block, in block order, always** — six blocks, six
events. This is the evidence the slot design rests on (see the alignment note in NEXT.md).

### F10. Three consecutive `tool_use` blocks — the panel is silent for all of them

Slots 2, 3 and 4 are `tool_use`. `MessageList.syncBlocks` skips `tool_use` (Phase 4), so between
slot 1's text and slot 5's text the panel shows nothing new at all. Ordinary tool calls, no
subagent. Phase 4's problem, recorded in NEXT.md.

Two more shapes, both new since F1–F7 and both currently ignored by the reducer:

```json
{"type":"system","subtype":"permission_denied","tool_name":"WebSearch","tool_use_id":"toolu_…","message":"…"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1788051600,"rateLimitType":"seven_day","utilization":0.8}}
```

`permission_denied` is a live `system` subtype, not only a `result.permission_denials[]` entry
(RESEARCH B5 saw the latter). It is Phase 5's, but it exists on the wire today.

### F11. `result.total_cost_usd` looks **cumulative per session**, not per turn

This turn: `duration_ms=15238 total_cost_usd=0.1832235 num_turns=4`. The orchestrator's observation
during the manual test: two spike turns reported the *same* `total_cost_usd`, while the panel's own
displayed numbers rose monotonically across a session. Not re-measured here — one capture cannot
show it — so it is a lead, not a finding. Out of Phase 3's scope: the meta line prints what the CLI
reports. Recorded so nobody optimises against it.

## Verification performed (before Emre's manual test)

Build and lint pass, which proves nothing on its own. What was actually measured:

1. `scratchpad/spike/partial.mjs` — captured a real two-turn stream, the second turn interrupted on
   its first `text_delta`. Produced F1, F2, F3, F4, F5.
2. `scratchpad/spike/replay/replay.ts` — the **real `StreamReducer`** replayed against that capture.
   Turn 1 ends `complete` with `slot=0 thinking(908 chars, 299 tokens)` and `slot=1 text(228)` both
   intact — the two blocks that Phase 2's array-position keying collapsed into one. Turn 2 ends
   `stopped`, not `error`, and keeps its partial 2-character text.
3. `scratchpad/spike/replay/midstream.ts` — snapshots inside the stream. After each `text_delta`:
   `blocks=[0:thinking/FINAL(908) 1:text/live(17 → 73 → 216 → 228)]`. The text block is genuinely
   non-final and growing while the thinking block is already final, which is the precondition for
   architectural rule #4 doing anything at all.
4. `scratchpad/spike/tooluse.mjs` + replay — a tool-use turn lands as five blocks in slots 0–4 in
   the right order, nothing overwritten. This is what verifies `blockBase`.

Not verified outside Obsidian, and therefore on Emre's list: rendering, the collapse toggle, the
Stop button, sticky-bottom scrolling and the jump affordance.

### Second round, after Emre's manual test (9 of 10 passed, step 3 failed)

**The gap in round 1: nothing asserted on block *content*.** The replay proved slots 0–4 were filled
in the right order and never overwritten, which is a real property — and it would have passed just
as happily with every one of those blocks holding an empty string. That is exactly the defect that
reached Emre. Slot placement is not content.

`docs/phase3-offline-checks.ts` replaces it and is kept in `docs/`, not in a scratchpad. Run from
the repo root:

```
npx esbuild docs/phase3-offline-checks.ts --bundle --platform=node --format=esm \
  --alias:obsidian=./docs/obsidian-stub.mjs --outfile=/tmp/guki-checks.mjs && node /tmp/guki-checks.mjs
```

`docs/obsidian-stub.mjs` supplies the three symbols the production modules import as *values*
(`App`, `FileSystemAdapter`, `Platform`); everything else they take from `obsidian` is type-only and
erased. No production logic is re-implemented — the checks drive the real `StreamReducer` and the
real `SessionManager`.

Section A — the reducer over `docs/capture-phase3-thinking-redacted.jsonl`, 77 events → 6 blocks
`0:thinking(0) 1:text(75) 2:tool_use(ToolSearch) 3:tool_use(WebSearch) 4:tool_use(WebSearch) 5:text(303)`.
Asserted: the slot sequence 0–5 with no gap across three API messages; the kind of each; **the exact
final text of both text blocks**; the thinking block's text being `''` with a real duration and
`thinkingTokens === 158` still attached; three distinct `tool_use_id`s; every block `final`; the turn
ending `complete` with `duration_ms` and `total_cost_usd` on the meta.

Sections B and C — the two paths a manual test cannot reach:

- B1: `failActiveTurn` fires `onTurnEnd`, both with and without an active turn.
- C1: Stop pressed while the first message is still in binary resolution marks the queued turn
  `stopped`, drops `busy`, and the message is **never** written to the CLI even after the resolution
  finally completes.
- C2: a turn failed from outside the stream with a message queued behind it — the queued message is
  sent, not stranded.

Each check was confirmed to *fail* against the pre-fix code before being kept: reverting the
`onTurnEnd` calls broke 4 assertions, reverting the `interrupt` guard broke 3. A green check that
never goes red proves nothing, which is the round-1 lesson restated.

Still not verifiable outside Obsidian, and therefore on Emre's short re-test list: how the
non-interactive thinking header actually looks and behaves, and the first-message Stop button in the
real timing window.

## Decisions taken

- **D-1. Block slots, not array positions.** See F2. The reducer keeps `blockBase` /
  `nextFreeSlot` / `assistantSlot` per turn, all reset in `beginTurn`.
- **D-2. Blocks render individually, in index order.** `.guki-message-body` stops being the bubble
  and becomes a plain column; the bubble moves onto `.guki-block-text`. Needed so the thinking block
  can have its own surface without losing its position in the block order. `visibleText()` is
  dropped — no caller is left.
- **D-3. The thinking content is rendered as plain text, never markdown.** It is prose, it changes on
  every delta, and it is collapsed by default; running the markdown renderer on it would be the
  expensive half of architectural rule #4 for no gain.
- **D-4. Stop does not clear our own queue.** The interrupt ends the turn in flight; a message the
  user queued behind it is still a message they asked for. Acceptance ("a new message can be sent
  after stopping") is satisfied either way.
- **D-5 (bug found while wiring D-4).** Nothing pumped the queue when a turn *ended* — `pump()` was
  only ever called from `send()`. Sending a second message while the first was still streaming left
  it queued forever. Pre-existing since Phase 2, invisible while turns were slow enough to never
  overlap. `StreamReducer` gained an `onTurnEnd` hook that the SessionManager uses to pump.
- **D-6. Jump-to-bottom (D2) is a plain affordance, not a toast.** Visible whenever the scroller is
  away from the bottom; it gains an accent state when content arrived while the reader was away.
  Needs a positioned wrapper around the scroller, so `MessageList` now creates the scroller itself
  from a wrapper element instead of being handed one.

- **D-7. A thinking block with no text gets a label, not an expander.** F8: on `claude-opus-5` the
  thinking is encrypted and the block is empty for the whole turn. The header still renders — the
  duration and the live token counter are the only signal during a 23-second silence, which is the
  entire reason the header exists (PLAN 3.4, Emre's rule). What is conditional is whether it is a
  *control*: with no text there is no content element at all and the `<button>` carries `disabled`,
  so it cannot be clicked, focused, or hovered into looking clickable.
  **If text arrives after the header was drawn as a label**, the expander is added in place and the
  block stays **collapsed**. It does not open itself: the reader is mid-answer, thinking is
  secondary content by decision, and content appearing under the cursor would move the answer down.
  The reverse transition (streamed text replaced by an empty authoritative block) collapses and
  disables it again rather than leaving an empty box behind.
- **D-8. `failActiveTurn` fires `onTurnEnd`; it does not clear the queue.** Its doc comment already
  promised "whenever the active turn ends, for any reason", and this path broke that promise.
  Clearing the queue there instead would contradict D-4 — a message queued behind an interrupted
  turn is still a message the user asked for — and it would only paper over the missing callback for
  one of the three callers. Firing the callback makes the contract true everywhere, and the two
  callers that must *not* restart the process (`handleSpawnError`, `handleExit`) now clear the queue
  **before** the call rather than after, so the pump it triggers finds nothing to do. Ordering is
  load-bearing there: `pump` reads `queue[0]` synchronously.
- **D-9. Stop before the turn begins cancels the queue.** `busy` is true from the moment anything is
  queued, so the composer shows Stop, but on the first message the six-step binary resolution runs
  before the turn starts — `interrupt()` returned early and the button did nothing for that whole
  window. It now marks the queued turns `stopped` and empties the queue. The `cancelled` flag on
  `QueuedTurn` is what makes it stick: a `pump` already suspended on `ensureProcess` holds its own
  reference to the head of the queue and would otherwise send the message anyway. `pump` re-checks
  `cancelled` **and** `queue[0] !== next` after the await.
- **D-10. `moduleResolution: "bundler"`, not `ignoreDeprecations`.** `node10` is deprecated and stops
  working in TypeScript 7.0. This project bundles with esbuild, so `bundler` describes what actually
  happens; silencing the warning would leave a wrong value in place. Nothing broke — see the note
  below.

## Lint / build notes

- `npm run build` and `npm run lint` pass clean after every change in this round. Proves nothing on
  its own (see the working method in NEXT.md); recorded because it must stay true.
- **`moduleResolution: "node"` → `"bundler"` resolved nothing differently.** `tsc -noEmit` is clean
  with both values and all 11 source files still resolve. Worth knowing: **`tsc` 5.9.3 does not
  print the deprecation on the CLI at all** — with `node10` it exits 0 and silent. The warning Emre
  saw comes from the editor's language service, so "the build is clean" was never evidence either
  way here.
- `docs/` is in the eslint ignore list and outside `tsconfig.json`'s `include`, so
  `docs/phase3-offline-checks.ts` and `docs/obsidian-stub.mjs` are not type-checked or linted by the
  project scripts. Deliberate — they are harnesses, and esbuild plus a run is what proves them — but
  it means a type error in them surfaces only when you run them.
- The thinking header is a `<button>` that switches between `disabled` and enabled rather than
  swapping element types. A disabled button fires no `click` in any browser, so the handler
  registered at creation cannot run; it also carries an explicit `rendered.expandable` guard. CSS
  moved the hover rule to `:enabled:hover` and pins `opacity: 1` on `:disabled`, because a theme
  dimming it would suggest a broken control instead of a label.
