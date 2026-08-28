# PHASE3-STATE — Live streaming (working file)

Working file for Phase 3 only. Filled as the work happens, not at the end. When Phase 3 closes,
lift the still-relevant lessons into `docs/NEXT.md` and move this file to `docs/archive/`.

## Scope (from PLAN.md "Phase 3 — Live streaming" + NEXT.md)

| # | Task | Status |
|---|---|---|
| 1 | `--include-partial-messages` | ✅ code done, awaiting manual test — `claude-process.ts` buildArgs |
| 2 | `stream_event` branch in the reducer, block-indexed | ✅ code done, awaiting manual test — `stream-reducer.ts`, slots not array positions (F2) |
| 3 | Plain text while streaming, markdown on the authoritative `assistant` event | ✅ code done, awaiting manual test — `message-list.ts` updateTextBlock |
| 4 | `thinking-block.ts` — collapsed but never hidden | ✅ code done, awaiting manual test — built into `message-list.ts`, not a separate file |
| 5 | Sticky-bottom auto-scroll | ✅ code done, awaiting manual test — unchanged from Phase 2, now covers streaming |
| 6 | Stop button via `control_request` / `interrupt` | ✅ code done, awaiting manual test — `composer.ts` + `SessionManager.interrupt` |
| 7 | Cancellation renders as "stopped", not an error | ✅ code done, awaiting manual test — `applyResult`, verified by replay |
| D1 | Deferred from Phase 2: the empty-card gap | ✅ code done, awaiting manual test — thinking header + meta never blanks without content |
| D2 | Deferred from Phase 2: "jump to bottom" affordance | ✅ code done, awaiting manual test — `.guki-jump` in `message-list.ts` |

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

Captured by `scratchpad/spike/partial.mjs`; full capture in `raw.jsonl`. Quoted verbatim.

### F1. `stream_event.event` shapes

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

## Lint / build notes

_(filled as they come up)_
