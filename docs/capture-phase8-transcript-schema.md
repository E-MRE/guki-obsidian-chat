# Phase 8: On-Disk Transcript Schema Measurement & Redraw Cost Analysis

**Target Document**: `docs/capture-phase8-transcript-schema.md`  
**Base Commit**: `568e082` (`feat/gorev-8-conversation-history`)  
**Mode**: Explore (measurement only; read-only against `src/`)  
**Purpose**: Size the schema differences, information loss, and implementation cost of redrawing a past conversation from its on-disk transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`) to target `ChatItem` models in `src/core/chat-state.ts`.

---

## 1. Record Type Inventory

### 1.1 Dataset and Sampling
Transcripts were sampled across 4 distinct project directories under `~/.claude/projects/` (including a primary vault directory and 3 other projects). 8 specific files were selected to span the full lifecycle: short/aborted sessions (3.9KB – 39KB), medium/typical sessions (328KB – 365KB), and large multi-turn sessions (2.8MB – 5.3MB).

1. `Sample 1`: `<project-a-slug>/e5288036-1a6d-43e2-b1b5-d531e939e2d2.jsonl` (365,640 bytes, 202 lines)
2. `Sample 2`: `<project-a-slug>/883cd2e1-5339-46b4-98fb-9cdc7bbfe3a2.jsonl` (39,781 bytes, 9 lines)
3. `Sample 3`: `<project-b-slug>/49c6c6be-3dd3-40b1-84be-6adfc90754f8.jsonl` (3,948 bytes, 6 lines)
4. `Sample 4`: `<project-b-slug>/17f8909f-301b-4b7d-b7d5-289f7c6ce158.jsonl` (5,342,537 bytes, 1,853 lines)
5. `Sample 5`: `<project-c-slug>/2185b5ee-559e-4433-aa02-5539e9a11a30.jsonl` (328,675 bytes, 109 lines)
6. `Sample 6`: `<project-c-slug>/73d4e6b1-a69c-49f9-bc4d-1f92a40364a3.jsonl` (17,324 bytes, 12 lines)
7. `Sample 7`: `<project-d-slug>/dc27ed63-b281-44f7-be0c-92e1cfa743ce.jsonl` (2,877,308 bytes, 1,241 lines)
8. `Sample 8`: `<project-d-slug>/42db4550-93a9-49df-add6-926ed76c1d16.jsonl` (25,865 bytes, 13 lines)

In addition, a corpus-wide scan was conducted across all 1,187 `.jsonl` files in `~/.claude/projects/` (119,742 total records) to ensure no record types were missed.

### 1.2 Occurrence Counts Across Sampled Files
16 distinct record types were observed across the 8 sampled files (total 3,445 records):

| Record Type | Sample 1 | Sample 2 | Sample 3 | Sample 4 | Sample 5 | Sample 6 | Sample 7 | Sample 8 | Sample Total | Corpus Total (1,187 files) |
|---|---|---|---|---|---|---|---|---|---|---|
| `assistant` | 43 | 0 | 0 | 612 | 42 | 0 | 415 | 0 | **1,112** | 34,287 |
| `attachment` | 52 | 3 | 1 | 378 | 12 | 4 | 261 | 5 | **716** | 30,269 |
| `user` | 26 | 2 | 2 | 378 | 26 | 2 | 212 | 0 | **648** | 20,947 |
| `last-prompt` | 10 | 1 | 1 | 99 | 8 | 1 | 69 | 2 | **191** | 7,434 |
| `atis-latch` | 8 | 0 | 0 | 97 | 7 | 0 | 68 | 0 | **180** | 6,892 |
| `ai-title` | 8 | 0 | 0 | 97 | 8 | 2 | 5 | 0 | **120** | 4,069 |
| `mode` | 9 | 0 | 1 | 29 | 0 | 0 | 68 | 1 | **108** | 2,892 |
| `file-history-delta` | 4 | 0 | 0 | 68 | 0 | 0 | 30 | 0 | **102** | 1,246 |
| `permission-mode` | 9 | 0 | 0 | 0 | 0 | 0 | 68 | 1 | **78** | 2,373 |
| `system` | 20 | 1 | 1 | 15 | 1 | 1 | 10 | 1 | **50** | 3,950 |
| `queue-operation` | 0 | 2 | 0 | 34 | 4 | 2 | 6 | 0 | **48** | 4,288 |
| `file-history-snapshot` | 11 | 0 | 0 | 12 | 1 | 0 | 6 | 1 | **31** | 1,879 |
| `frame-link` | 0 | 0 | 0 | 31 | 0 | 0 | 0 | 0 | **31** | 72 |
| `pr-link` | 0 | 0 | 0 | 0 | 0 | 0 | 21 | 0 | **21** | 281 |
| `cost-state` | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | **6** | 179 |
| `artifact-comment-monitor` | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | **3** | 5 |
| *`agent-setting`\** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | 124 |

*\*Note: `agent-setting` was discovered during the full 1,187-file sweep (`type`, `agentSetting`, `sessionId`). It did not appear in the 8-file sample.*  
*\*Note on corpus drift: Corpus-wide totals drift as the operator keeps using the CLI (the verification lane measured a ~1.3% increase between the two runs), so the corpus numbers are a snapshot, not a constant.*

### 1.3 Top-Level Field Distribution per Record Type

Measured from the 3,445 records across the sample:

1. **`assistant`** (total 1,112):
   - *Always present (12)*: `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`
   - *Sometimes present (13)*: `requestId` (99.9%), `effort` (99.8%), `slug` (53.1%), `session_id` (41.2%), `apiBlockIndex` (37.3%), `attributionSkill` (1.8%), `attributionMcpServer` (0.2%), `attributionMcpTool` (0.2%), `isApiErrorMessage` (0.2%), `apiErrorStatus` (0.1%), `attributionPlugin` (0.1%), `error` (0.1%), `quotaLimits` (0.1%)

2. **`user`** (total 648):
   - *Always present (12)*: `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `message`, `parentUuid`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`
   - *Sometimes present (17)*: `promptId` (99.7%), `sourceToolAssistantUUID` (92.3%), `toolUseResult` (92.3%), `slug` (56.2%), `session_id` (33.8%), `origin` (4.9%), `promptSource` (4.8%), `permissionMode` (4.8%), `isMeta` (1.4%), `classifierMetaLines` (0.8%), `toolDenialKind` (0.5%), `mcpMeta` (0.5%), `isCompactSummary` (0.2%), `isVisibleInTranscriptOnly` (0.2%), `queueSkipAttachments` (0.2%), `sourceToolUseID` (0.2%), `turnCompanion` (0.2%)

3. **`system`** (total 50):
   - *Always present (12)*: `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `parentUuid`, `sessionId`, `subtype`, `timestamp`, `type`, `userType`, `uuid`, `version`
   - *Sometimes present (19)*: `level` (70.0%), `hasOutput` (58.0%), `hookAdditionalContext` (58.0%), `hookCount` (58.0%), `hookErrors` (58.0%), `hookInfos` (58.0%), `preventedContinuation` (58.0%), `stopReason` (58.0%), `toolUseID` (58.0%), `isMeta` (42.0%), `durationMs` (30.0%), `messageCount` (30.0%), `session_id` (30.0%), `slug` (30.0%), `content` (12.0%), `compactMetadata` (2.0%), `logicalParentUuid` (2.0%), `pendingBackgroundAgentCount` (2.0%), `preventContinuation` (2.0%)

4. **`attachment`** (total 716):
   - *Always present (12)*: `attachment`, `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `parentUuid`, `sessionId`, `timestamp`, `type`, `userType`, `uuid`, `version`
   - *Sometimes present (3)*: `slug` (50.0%), `session_id` (37.0%), `rendered` (33.7%)

5. **`last-prompt`** (total 191):
   - *Always present (3)*: `leafUuid`, `sessionId`, `type`
   - *Sometimes present (1)*: `lastPrompt` (96.3%)

6. **`atis-latch`** (total 180):
   - *Always present (3)*: `atis`, `sessionId`, `type`

7. **`ai-title`** (total 120):
   - *Always present (3)*: `aiTitle`, `sessionId`, `type`

8. **`mode`** (total 108):
   - *Always present (3)*: `mode`, `sessionId`, `type`

9. **`file-history-delta`** (total 102):
   - *Always present (6)*: `backup`, `messageId`, `snapshotMessageId`, `timestamp`, `trackingPath`, `type`

10. **`permission-mode`** (total 78):
    - *Always present (3)*: `permissionMode`, `sessionId`, `type`

11. **`queue-operation`** (total 48):
    - *Always present (4)*: `operation`, `sessionId`, `timestamp`, `type`
    - *Sometimes present (2)*: `content` (18.8%), `reason` (4.2%)

12. **`file-history-snapshot`** (total 31):
    - *Always present (4)*: `isSnapshotUpdate`, `messageId`, `snapshot`, `type`

13. **`frame-link`** (total 31):
    - *Always present (4)*: `artifactCount`, `sessionId`, `timestamp`, `type`
    - *Sometimes present (3)*: `frameUrl` (6.5%), `path` (6.5%), `title` (6.5%)

14. **`pr-link`** (total 21):
    - *Always present (6)*: `prNumber`, `prRepository`, `prUrl`, `sessionId`, `timestamp`, `type`

15. **`cost-state`** (total 6):
    - *Always present (12)*: `hasUnknownModelCost`, `modelUsage`, `sessionId`, `startTime`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalCostUSD`, `totalDuration`, `totalLinesAdded`, `totalLinesRemoved`, `totalToolDuration`, `type`

16. **`artifact-comment-monitor`** (total 3):
    - *Always present (4)*: `artifacts`, `sessionId`, `type`, `v`

---

## 2. Field-Shape Diff: Live Event Stream vs On-Disk Transcripts

The existing parser (`src/core/stream-reducer.ts`) consumes `--output-format stream-json` events defined in `src/cli/events.ts`. Below is the side-by-side comparison for every construct rendered in the UI.

### 2.1 User Message
| Dimension | Live Stream Event (`UserEvent`) | On-Disk Record (`user`) |
|---|---|---|
| **Top-Level Type** | `type: "user"` | `type: "user"` |
| **Identity** | Optional `uuid` | Authoritative `uuid`, `parentUuid` |
| **Session Field** | `session_id` (snake_case) | `sessionId` (camelCase) (sometimes also `session_id`) |
| **Message Payload** | `message: { role?: "user", content?: string \| ContentBlock[] }` | `message: { role: "user", content: string \| ContentBlock[] }` |
| **Human vs Tool Result** | Differentiated by context / event subtype | Differentiated by top-level flags: human has `origin: {kind: "human"}`, `promptSource: "typed"`; tool results have `toolUseResult: true`, `sourceToolAssistantUUID` |
| **Attachments / Images** | Transmitted over stdin as API image blocks; not reflected in stream user events | Stored in `message.content[]` as Anthropic `type: "image"` with `source: { type: "base64", media_type: string, data: string }` |
| **Synthetic / Cancellation** | `message.content = "[Request interrupted by user]"` | `message.content = [{"type": "text", "text": "[Request interrupted by user]"}]` |

### 2.2 Assistant Message
| Dimension | Live Stream Event (`AssistantEvent`) | On-Disk Record (`assistant`) |
|---|---|---|
| **Delivery Model** | Incremental: One event per block as it completes, always sitting at array index `message.content[0]` | Single snapshot: Contains the complete `message.content[]` array with all blocks in slot order |
| **Identity** | `message.id` | Top-level `uuid`, `parentUuid`, `requestId` |
| **Session Field** | `session_id` | `sessionId` (camelCase) |
| **Subagent Signal** | `parent_tool_use_id` (snake_case) | Subagents stored in separate sidecar files (`subagents/workflows/...`), or `isSidechain: true` |
| **Error Marker** | Absent (errors arrive on `result` event) | Top-level `isApiErrorMessage: true`, `apiErrorStatus: number`, `error: string` |

### 2.3 Thinking / Reasoning
| Dimension | Live Stream Events (`stream_event`, `system/thinking_tokens`, `assistant`) | On-Disk Representation (`assistant.message.content[]`) |
|---|---|---|
| **Live Streaming Deltas** | `stream_event` carrying SSE `content_block_start`, `thinking_delta`, `content_block_stop` | **Completely absent.** Deltas are never persisted to disk. |
| **Token Counter** | `system` with `subtype: "thinking_tokens"` (`estimated_tokens`) | **Completely absent.** |
| **Thinking Text Content** | Carried live in `thinking_delta.thinking` and final `assistant.message.content[0].thinking` | **Stripped to empty string `""` in 99.65% of blocks** on disk in CLI $\ge$ 2.1.250 (20 non-empty instances observed out of 5,759; effectively always, but not guaranteed), retaining `signature`. The loader must handle non-empty thinking blocks rather than assume they cannot occur. |
| **Cryptographic Signature** | `signature_delta` and `assistant.message.content[0].signature` | `signature: string` stored inline on the thinking block |
| **Durations** | Measured by local wall-clock between `startedAt` and `endedAt` | **Completely absent.** No block-level start/end timestamps exist on disk. |

### 2.4 Tool Use
| Dimension | Live Stream Event (`AssistantEvent`) | On-Disk Record (`assistant.message.content[]`) |
|---|---|---|
| **Block Structure** | `{ type: "tool_use", id: string, name: string, input: object }` | `{ type: "tool_use", id: string, name: string, input: object }` |
| **Name / Key Casing** | Matches Anthropic API spec (`id`, `name`, `input`) | Matches Anthropic API spec (`id`, `name`, `input`) |
| **Streaming State** | Opens with `{}` in `content_block_start`, input streams via `input_json_delta` | Authoritative complete input object stored directly |

### 2.5 Tool Result
| Dimension | Live Stream Event (`UserEvent`) | On-Disk Record (`user`) |
|---|---|---|
| **Envelope** | `type: "user"`, `message.content: [ToolResultBlock]` | `type: "user"`, `toolUseResult: true`, `sourceToolAssistantUUID: string` |
| **Matching Key** | `block.tool_use_id` | `block.tool_use_id` |
| **Error Flag** | `block.is_error === true` | `block.is_error === true` |
| **Result Content** | String or array of content blocks | Inline string / array, **OR** offloaded pointer if > ~50KB (`<persisted-output>` pointing to `tool-results/<tool_use_id>.txt`) |
| **Denial Marker** | Absent on wire; inferred live by reducer tracking broker calls or `result.permission_denials[]` | Authoritative top-level field `toolDenialKind: "user-rejected"` (or `"permission-rule"`) |

### 2.6 Permission Request & Decision
| Dimension | Live Stream Bridge (MCP stdio bridge) | On-Disk Representation |
|---|---|---|
| **Request Event** | Out-of-band JSON-RPC tool call (`permission_prompt`) from CLI to plugin MCP server | **Completely absent.** No permission prompt event is ever written to disk. |
| **Card Data / Diff** | Plugin reads file from disk prior to execution (`PriorContent` "Before" pane) | **Completely absent.** |
| **Allow Decision** | Plugin MCP server returns `{ behavior: "allow" }` | **No trace on disk.** Tool executes normally; indistinguishable from auto-allowed tool calls. |
| **Deny Decision** | Plugin MCP server returns `{ behavior: "deny", message: "..." }` | Captured as `user` record with `toolDenialKind: "user-rejected"`, `tool_result.is_error: true`, and denial explanation in content |
| **Cancellation** | Turn aborted via interrupt request | Preceding assistant has no matching `tool_result`; followed by `[Request interrupted by user]` |

### 2.7 Compaction Boundary
| Dimension | Live Stream Event (`SystemCompactBoundaryEvent`) | On-Disk Record (`system`) |
|---|---|---|
| **Type & Subtype** | `type: "system"`, `subtype: "compact_boundary"` | `type: "system"`, `subtype: "compact_boundary"` |
| **Casing Differences** | `session_id` (snake_case) | `sessionId` (camelCase) |
| **Metadata Casing** | `compact_metadata` (snake_case): `pre_tokens`, `post_tokens`, `cumulative_dropped_tokens`, `duration_ms` | `compactMetadata` (camelCase): `preTokens`, `postTokens`, `cumulativeDroppedTokens`, `durationMs` |
| **Pruning Metadata** | Minimal | Rich: includes `preservedSegment` (`headUuid`, `anchorUuid`, `tailUuid`) and `preservedMessages` (`uuids[]`) |
| **Summary Content** | Followed by synthetic `assistant` event or stream delta | Followed by dedicated `user` record with `isCompactSummary: true`, `isVisibleInTranscriptOnly: true` |

### 2.8 Cost and Duration
| Dimension | Live Stream Event (`ResultEvent`) | On-Disk Transcripts (`cost-state`, `turn_duration`) |
|---|---|---|
| **Event Existence** | **`result` event arrives at the end of every turn** | **`result` event DOES NOT EXIST on disk.** |
| **Per-Turn Cost** | `total_cost_usd` per turn; reducer computes delta `costUsd = current - baseline` | **Completely absent per turn.** Only session-wide cumulative `totalCostUSD` in `cost-state` (which is absent in >50% of files). |
| **Per-Turn Duration** | `duration_ms` on every `result` event | Present only when `system` with `subtype: "turn_duration"` is recorded (~30% of turns); otherwise must be inferred from timestamp deltas. |
| **Model Context Usage** | Live `usage` and `modelUsage` on `result` event | Raw token counts in `assistant.message.usage`; no per-turn context percent badge |

---

## 3. Mappability Table

Target `ChatItem` model defined in `src/core/chat-state.ts`:

| `ChatItem` Model / Field | Target Field Type | Mappability Status | Missing Fields & Fallback Strategy | Real Record Anchor |
|---|---|---|---|---|
| **`UserItem`** | `UserItem` | **FULLY RECONSTRUCTIBLE** | None for text. For images, `displayName` is missing from the on-disk image block; fallback to synthetic name `image-<index>.png`. | `Sample 1:10` (`type: "user"`, `uuid: "b211f32a-..."`, `origin: {"kind": "human"}`) |
| `UserItem.id` | `string` | Fully | Maps directly from `record.uuid`. | `Sample 1:10` |
| `UserItem.text` | `string` | Fully | Maps directly from `record.message.content` (string or `text` block). | `Sample 1:10` |
| `UserItem.images` | `ImageAttachment[]` | Partially | Base64 data and mime-type are present in `content` blocks; `displayName` must be synthesized. | `<project-slug>/8dc32f4e...:1846` (`content` block `type: "image"`) |
| **`AssistantItem`** | `AssistantItem` | **PARTIALLY RECONSTRUCTIBLE** | Per-turn cost is lost. Per-turn duration is partially missing. Thinking text is effectively always stripped (99.65% empty in CLI $\ge$ 2.1.250; loader must handle non-empty blocks when present). | `Sample 1:22` (`type: "assistant"`, `uuid: "c8413a9d-..."`) |
| `AssistantItem.id` | `string` | Fully | Maps directly from `record.uuid`. | `Sample 1:22` |
| `AssistantItem.status` | `TurnStatus` | Partially | Historical turns are never `'pending'` or `'streaming'`. Mapped to `'stopped'` if followed by `[Request interrupted by user]`, `'error'` if `isApiErrorMessage: true`, else `'complete'`. | `<project-slug>/47fcedc8...:196` (`stopped`), `<project-slug>/c74e3c6f...:441` (`error`) |
| `AssistantItem.errorText` | `string` | Partially | Recoverable from `record.error` or `record.message.content` when `isApiErrorMessage: true`. | `<project-slug>/c74e3c6f...:441` |
| `AssistantItem.blocks` | `Map<number, MessageBlock>` | Partially | See MessageBlock breakdown below. | `Sample 1:22` |
| `AssistantItem.meta.costUsd` | `number` | **NOT RECONSTRUCTIBLE** | Per-turn cost delta is not stored anywhere on disk. Must be left `undefined`. | *Absent from all records* |
| `AssistantItem.meta.sessionCostUsd` | `number` | Partially / Not | Session-wide total available from `cost-state` when present, but running per-turn total is lost. | `Sample 1:198` (`cost-state.totalCostUSD`) |
| `AssistantItem.meta.durationMs` | `number` | Partially | Recoverable if matching `system/turn_duration` exists (`parentUuid === assistant.uuid`); otherwise must infer from `Date(assistant.timestamp) - Date(user.timestamp)`. | `<project-slug>/2661ce2d...:24` (`subtype: "turn_duration"`) |
| **`MessageBlock (text)`** | `MessageBlock` | **FULLY RECONSTRUCTIBLE** | None. `text` is preserved verbatim. | `Sample 1:22` (`content[0]` `type: "text"`) |
| **`MessageBlock (thinking)`**| `MessageBlock` | **PARTIALLY RECONSTRUCTIBLE** | `thinking` text is stripped (`""`) in 99.65% of blocks in CLI $\ge$ 2.1.250 (96.3% corpus-wide; effectively always, but not guaranteed). `startedAt`, `endedAt`, `thinkingTokens` are absent. UI renders a collapsed block with signature when empty, but the loader must handle a non-empty thinking block rather than assume it cannot occur. | `Sample 4:19` (`content[0]` `type: "thinking"`) |
| **`MessageBlock (tool_use)`**| `MessageBlock` | **FULLY RECONSTRUCTIBLE** | `toolUseId`, `toolName`, `toolInput` are fully intact. `toolPending` set to `false`. | `Sample 1:22` (`content[1]` `type: "tool_use"`) |
| `MessageBlock.toolResultText`| `string` | Partially | Present inline for outputs < ~50KB. For offloaded outputs, points to `<session-dir>/tool-results/<id>.txt`; reader must read file or fallback to preview. | Inline: `Sample 1:77`. Offloaded: `<project-slug>/47fcedc8...:77` |
| `MessageBlock.toolIsError` | `boolean` | Fully | Maps directly from child `tool_result.is_error === true`. | `<project-slug>/2661ce2d...:662` |
| `MessageBlock.toolDenied` | `boolean` | Partially | Inferred if child user record has `toolDenialKind: "user-rejected"` (or `"permission-rule"`). | `<project-slug>/2661ce2d...:662` |
| `MessageBlock.toolPermissionRequested` | `boolean` | **NOT RECONSTRUCTIBLE** | MCP bridge requests leave no trace. Defaults to `false`. | *Absent from all records* |
| `MessageBlock.subagentActive / Label / ToolUses` | `boolean / string / number` | **NOT RECONSTRUCTIBLE** | Live task progress events are not preserved in the main transcript. | *Absent from all records* |
| **`DividerItem`** | `DividerItem` | **FULLY RECONSTRUCTIBLE** | Maps directly from `type: "system", subtype: "compact_boundary"`. `id` = `record.uuid`, `text` = `'Conversation compacted'`. | `<project-slug>/2661ce2d...:393` |
| **`PermissionItem`** | `PermissionItem` | **NOT RECONSTRUCTIBLE** (ordinary) / **PARTIAL** (`AskUserQuestion`) | Ordinary tool approval cards (`Write`, `Bash`) and `priorContent` diffs are not saved on disk. `AskUserQuestion` can be partially reconstructed from `tool_use` input and `tool_result` content. | `<project-slug>/c3d240aa...:58, 59` (`AskUserQuestion`) |
| **`NoticeItem`** | `NoticeItem` | **NOT RECONSTRUCTIBLE** | Out-of-band ephemeral notices (process failure, binary missing) are client-only and not part of transcript history. | *Client runtime only* |

---

## 4. Specific Questions

### a) Permission Request & Decision Recovery
* **Recoverable from disk?**: **NO for ordinary tool approval cards.** The interactive permission flow runs over an MCP stdio bridge (`--permission-prompt-tool`) directly between the Claude Code CLI and the plugin. The CLI does NOT persist MCP bridge calls or pending permission cards to `.jsonl`.
* **Chosen answer on disk?**: 
  - If **Allowed**: The tool executes, leaving an ordinary `tool_use` in the assistant record and `tool_result` in the user record. There is no flag indicating whether it was explicitly approved by a user or auto-approved by a policy/bypass rule.
  - If **Denied**: The denial is recorded in the child `user` record with `toolDenialKind: "user-rejected"` (or `"permission-rule"`), `is_error: true`, and the user's rejection reason in `message.content[0].content`.
* **Can cancelled be distinguished?**: **YES.** If a turn was stopped while waiting for permission, the preceding assistant's `tool_use` block has no corresponding `tool_result`, and is followed by `type: "user", message.content: [{"type": "text", "text": "[Request interrupted by user]"}]`.

### b) Tool Results: Inline vs Offloaded
* **Storage model**: Tool results are stored **inline** if their payload is small (< ~50KB). If the payload exceeds the size threshold, it is **offloaded** into a sidecar directory next to the transcript: `~/.claude/projects/<slug>/<session-id>/tool-results/<tool_use_id>.txt`.
* **Inline record shape**: When offloaded, the inline `tool_result.content` is replaced by an XML block:
  ```xml
  <persisted-output>
  Output too large (49.5KB). Full output saved to: ~/.claude/projects/<slug>/<session-id>/tool-results/toolu_01LZ8U9cs4XfKLvA6MKAsvSN.txt

  Preview (first 2KB):
  {"total":256,"results":[{"name":"...
  ...
  </persisted-output>
  ```
* **Following the pointer**: A historical redraw reader must check if `content` begins with `<persisted-output>`. If so, it can either regex-extract the path (`Full output saved to: (.*)`) or construct the path from `path.join(sessionDir, 'tool-results', `${toolUseId}.txt`)`. If the file exists on disk, it reads the full text; if missing, it falls back to the embedded 2KB preview.

### c) Thinking / Reasoning Content
* **Present on disk?**: The block structure is present: `{ "type": "thinking", "thinking": "", "signature": "..." }`.
* **Redacted / Stripped**: **EFFECTIVELY ALWAYS, BUT NOT GUARANTEED.** In modern CLI versions (2.1.250+), the `thinking` string is **stripped to empty string `""` in 99.65% of blocks** (20 non-empty instances observed out of 5,759 in CLI $\ge$ 2.1.250; 100% empty across the 8-file sample, and 96.3% empty across the wider 119,742-record corpus). Stripping is effectively always present, but not guaranteed: the loader must handle a non-empty thinking block rather than assume it cannot occur. For the ~99.7% of modern turns where thinking text is stripped, redrawing history cannot show the thought monologue.

### d) Compaction Boundary & Per-Segment Durations
* **Boundary record**: **YES.** Recorded as `type: "system", subtype: "compact_boundary"`, followed by a `user` record with `isCompactSummary: true` and `isVisibleInTranscriptOnly: true`.
* **Per-segment durations recoverable?**: **NO.** In the live stream, `StreamReducer` measures local wall-clock elapsed time between the start of the turn, the arrival of `compact_boundary`, and the arrival of `result`. On disk:
  - `result` event does not exist.
  - `compactMetadata.durationMs` records the time taken to execute the compaction algorithm itself (e.g. 153,112 ms), NOT the elapsed duration of the pre-compaction conversation segment.
  - Per-segment duration badges cannot be faithfully reproduced from disk.

### e) Per-Turn Duration and Cost Recovery
* **Per-turn cost**: **COMPLETELY LOST.** The live `result.total_cost_usd` is not recorded on disk. The only cost record is `type: "cost-state"`, which is emitted periodically or at session close (and is absent in >50% of sessions). It only carries a single session total (`totalCostUSD`). Individual message bubbles cannot display their turn cost badge.
* **Per-turn duration**: **PARTIALLY RECOVERABLE.** 
  - When `type: "system", subtype: "turn_duration"` is present (observed in ~30% of turns), it carries `durationMs` linked via `parentUuid` to the assistant message `uuid`.
  - In all other turns, duration must be approximated by subtracting `user.timestamp` from `assistant.timestamp`.

### f) Disk Ordering Guarantees
* **Is file order strictly chronological?**: **NO.** Across multi-turn sessions, timestamp reversals of a few milliseconds to several minutes were observed in 7 out of 8 sampled files (e.g. 77 out-of-order pairs in `Sample 4`, 27 in `Sample 7`). `queue-operation` and `file-history-delta` records frequently carry timestamps that deviate from surrounding records.
* **Rewritten vs Append-Only**: The `.jsonl` file is strictly **append-only**. Records like `atis-latch`, `last-prompt`, and `cost-state` repeat periodically at the end of turns (e.g. `last-prompt` occurs 99 times in `Sample 4`).
* **Tree / DAG structure**: Transcripts form a tree connected by `parentUuid` -> `uuid`. When a session is resumed or forked, new records branch from an earlier `parentUuid`. Linear line reading without branch filtering can interleave abandoned branches. The authoritative tip of the active branch is identified by `last-prompt.leafUuid`.

### g) Practical File Sizes & Paging Decision
Across the full corpus of 1,187 transcript files:

| Metric | Sampled Files (N=8) | Full Corpus (N=1,187) |
|---|---|---|
| **Min Bytes** | 3,948 bytes (~3.9 KB) | 3,948 bytes (~3.9 KB) |
| **Median Bytes** | 184,228 bytes (~180 KB) | 231,732 bytes (~226 KB) |
| **Mean Bytes** | 1,123,733 bytes (~1.1 MB) | 390,685 bytes (~381 KB) |
| **Max Bytes** | 5,342,537 bytes (5.34 MB) | 15,204,823 bytes (15.2 MB) |
| **Min Lines** | 6 lines | 6 lines |
| **Median Lines** | 61 lines | 33 lines |
| **Mean Lines** | 435 lines | 102 lines |
| **Max Lines** | 1,853 lines | 3,449 lines |

**Paging Implication**: Because median file size is modest (~230KB, 33 lines), 80%+ of sessions can be parsed into memory in <15ms. However, the 95th+ percentile reaches 5MB–15MB (up to 3,449 lines with multi-megabyte tool outputs). Therefore, full-file string parsing (`readFile` + `split('\n')`) will cause memory spikes on large sessions; line-by-line stream parsing (`readline` interface) or pagination is mandatory for large transcripts.

---

## 5. Size Estimate (Disk → `ChatItem` Translator)

> [!NOTE]
> **ESTIMATE**: The following sizing and line counts are estimates derived from the measurements above, not measured code.

### 5.1 Required Translator Modules
To redraw a past conversation accurately, a standalone parser (`disk-transcript-loader.ts`) must implement:

1. **DAG / Branch Filter** (~80–120 LOC):
   - Index records by `uuid`.
   - Locate the active leaf from the last `last-prompt` record (`leafUuid`) or newest terminal record.
   - Trace `parentUuid` back to the root to isolate the active branch, discarding dead forks.
2. **Record Discriminator & Normalizer** (~100–140 LOC):
   - Separate human user messages (`origin.kind === 'human'`) from tool results (`toolUseResult: true`).
   - Extract base64 image blocks and synthesize `displayName`.
   - Resolve `system/compact_boundary` into divider items.
   - Match `system/turn_duration` records to assistant items by `parentUuid`.
3. **Turn Reducer / Builder** (~120–180 LOC):
   - Assemble `AssistantItem` blocks (`text`, `thinking`, `tool_use`).
   - Handle empty `thinking: ""` gracefully (render header with signature or placeholder); the loader must handle a non-empty thinking block rather than assume it cannot occur.
   - Match `tool_result` blocks in following user records to earlier `tool_use` by `tool_use_id`.
   - Detect `toolDenialKind: "user-rejected"` and map to `toolDenied: true`.
   - Detect `[Request interrupted by user]` and set `status: 'stopped'`.
4. **Offloaded Tool-Result Resolver** (~40–60 LOC):
   - Check `tool_result.content` for `<persisted-output>`.
   - Read external `tool-results/<id>.txt` asynchronously if present; fall back to embedded preview.

**Total Estimated TypeScript Implementation**: **~350 – 500 lines of code**.  
*(For comparison, `src/core/stream-reducer.ts` is 1,080 lines; the disk parser is simpler because it does not manage live SSE chunk streaming, typewriter deltas, slot reservation, or interactive MCP server loops).*

### 5.2 Expensive Mappability Gaps
1. **Loss of Thinking Text**: Monologue text is stripped in 99.65% of blocks for CLI $\ge$ 2.1.250 (effectively always, but not guaranteed). While the UI renders a collapsed "Thought" container without expandable text when empty, the loader must handle a non-empty thinking block rather than assume it cannot occur.
2. **Loss of Turn-Level Cost**: Cost badges on assistant bubbles (`$0.02`) cannot be shown. Only an aggregate session cost pill can be rendered at the session header/footer if `cost-state` exists.
3. **Offloaded File Dependencies**: Reading transcripts requires reading external files in `tool-results/`. If a session directory was pruned or moved, full tool outputs are lost.
4. **Interactive Cards Cannot Be Restored**: Approval cards (`PermissionItem`) with "Before/After" file diffs cannot be reconstructed. They will appear as standard executed or rejected tool cards.

---

## 6. Reference Check (Claudian)

* **Local Repository Verified**: **YES.** Verified against a local clone of the public repository `claudian`.
* **Does Claudian read Claude Code CLI's native transcripts or persist its own?**: **BOTH.**
  1. **Its own store**: Claudian implements an internal conversation store in `src/app/conversations/ConversationRepository.ts:197-246` and `src/core/bootstrap/storagePaths.ts:9` (`.claudian/sessions/` and legacy `.claude/sessions/`). It persists its own JSON files (`${id}.json`, `${id}.inputs.json`).
  2. **Native CLI reader**: In `src/providers/claude/history/sdkSessionPaths.ts` and `src/providers/claude/history/ClaudeHistoryStore.ts:127-200`, Claudian **also implements a native transcript reader** (`loadSDKSessionMessages`, `readSDKSession`, `parseSDKMessageToChat`). It reads native Claude Code transcripts directly from `{CLAUDE_CONFIG_DIR:-~/.claude}/projects/{encodedVault}/{sessionId}.jsonl`, filters the active branch using `filterActiveBranch`, parses tool calls, and handles `system/turn_duration` and `system/compact_boundary` separators.

---

## 7. Structural Privacy Verification

* **Operator Content Redaction**: Confirmed structurally. No user prompt text, assistant conversational responses, unredacted local workspace paths, or private credentials are included in this document. All absolute filesystem paths, user directory slugs, and private project identifiers have been replaced with generic placeholders (e.g. `~/.claude/projects/<slug>/`, `<project-slug>`) and neutral sample labels. All JSON snippets display types, keys, and synthetic placeholders only.
* **Casing and Naming Fidelity**: All field names (`sessionId` vs `session_id`, `compactMetadata` vs `compact_metadata`, `toolDenialKind`, `totalCostUSD`) reflect exact casing observed in disk records.
