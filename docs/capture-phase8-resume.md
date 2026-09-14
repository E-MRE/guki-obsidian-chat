# Measurement Findings: Claude CLI `--resume` in Persistent Process Mode

**Date:** 2026-09-14  
**Base commit:** `568e0826927674c5ac6bd37ecd33be33e7b5600c` (`feat/gorev-8-conversation-history`)  
**Environment:** macOS 24.6.0 (arm64), Node v23.9.0, Claude Code CLI 2.1.270 (resolved at `~/.local/bin/claude`)  
**Goal:** Measure, with runtime evidence, whether and how `--resume <sessionId>` works in the persistent-process setup (`claude-process.ts`: `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`), closing the OPEN QUESTION in `docs/RESEARCH.md` §D.

---

## Executive Summary

1. **`--resume <sessionId>` is fully supported and functional** in the single persistent-process setup with `--input-format stream-json` and `--output-format stream-json`.
2. **Context memory is genuinely restored:** The model accurately remembered state established in prior sessions across multiple follow-up turns without any external context reinjection.
3. **No history replay over the wire:** Resuming does *not* replay past user/assistant turns on stdout. The client only receives events for new turns sent to stdin.
4. **Immediate hook execution on spawn:** SessionStart hooks fire immediately upon process spawn before any stdin message is received in both fresh and resumed modes. Only the hook event name differs (`SessionStart:startup` for fresh processes vs. `SessionStart:resume` for resumed processes). In both modes, `system/init` is deferred until after the first stdin message arrives.
5. **Transcript appending:** The CLI appends new turns directly to the existing `~/.claude/projects/<slug>/<session-id>.jsonl` transcript file.
6. **Multi-turn capability:** The resumed persistent process handles multiple subsequent turns seamlessly.
7. **`--fork-session` creates a branch:** When `--fork-session` is combined with `--resume <sessionId>`, the CLI generates a new session UUID, creates a new transcript file pre-populated with the cloned history, and leaves the parent session transcript file untouched.

---

## Test Protocol & Setup

All measurements were performed in throwaway scratch directories (`/private/tmp/g8-clean` and `/private/tmp/g8-resume`) using synthetic prompts. No vault notes or user sessions were touched.

The spawned process used the exact flag combination and environment sanitization from `src/cli/claude-process.ts`:
- **Binary:** `~/.local/bin/claude` (Mach-O arm64 binary, resolved directly without interactive shell)
- **Spawn Arguments:** `['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']` + extra flags (`--resume <sessionId>`, `--fork-session`)
- **Environment:** Cleaned of `CLAUDE*`, `ANTHROPIC*`, `AI_AGENT*`, `HEADROOM*` variables; `PATH` prioritized.
- **IO:** `stdio: ['pipe', 'pipe', 'pipe']`, `shell: false`.

---

## Detailed Findings (Questions a – g)

### a) Process Startup & Flag Acceptance
*Does the process start at all, or does it reject the flag combination?*

- **Answer:** The process starts immediately without error and accepts the flag combination cleanly.
- **Exit code:** `0` (clean exit on `stdin.end()`).
- **Stderr:** Completely empty (0 bytes received across stderr).
- **Evidence:**
  - Command:
    ```bash
    ~/.local/bin/claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --resume 943d0cdb-ee45-4625-9553-5a4adb187c4f
    ```
  - Exit line from test harness:
    ```
    [+14067ms] Process exit code=0, signal=null
    ```

---

### b) Session ID in `system/init`
*What does the FIRST `system/init` report as `session_id` — the resumed id, or a brand-new one?*

- **Answer:** It reports the **resumed ID** verbatim (`943d0cdb-ee45-4625-9553-5a4adb187c4f`). It does NOT generate a new session ID.
- **Evidence Record:**
  - **Anchor Query:** `jq -c 'select(.type=="system" and .subtype=="init")' docs/capture-phase8-resume.jsonl | head -n 1`
  - **Distinctive UUID / Line:** `uuid: "b803e912-fc4f-43b7-82c4-b199ec2f9515"` (Line 12 in frozen capture)
  - **Verbatim Wire Payload:**
    ```json
    {"type":"system","subtype":"init","cwd":"/private/tmp/g8-clean","session_id":"943d0cdb-ee45-4625-9553-5a4adb187c4f","tools":["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","ListAgents","ListMcpResourcesTool","LSP","Monitor","NotebookEdit","PushNotification","Read","ReadMcpResourceDirTool","ReadMcpResourceTool","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","ShareOnboardingGuide","Skill","TaskOutput","TaskStop","ToolSearch","WebFetch","WebSearch","Workflow","Write","mcp__codebase-memory-mcp__delete_project","mcp__codebase-memory-mcp__detect_changes","mcp__codebase-memory-mcp__get_architecture","mcp__codebase-memory-mcp__get_code_snippet","mcp__codebase-memory-mcp__get_graph_schema","mcp__codebase-memory-mcp__index_repository","mcp__codebase-memory-mcp__index_status","mcp__codebase-memory-mcp__ingest_traces","mcp__codebase-memory-mcp__list_projects","mcp__codebase-memory-mcp__manage_adr","mcp__codebase-memory-mcp__query_graph","mcp__codebase-memory-mcp__search_code","mcp__codebase-memory-mcp__search_graph","mcp__codebase-memory-mcp__trace_path","mcp__plugin_mem0_mem0__add_memory","mcp__plugin_mem0_mem0__delete_all_memories","mcp__plugin_mem0_mem0__delete_entities","mcp__plugin_mem0_mem0__delete_memory","mcp__plugin_mem0_mem0__get_event_status","mcp__plugin_mem0_mem0__get_memories","mcp__plugin_mem0_mem0__get_memory","mcp__plugin_mem0_mem0__list_entities","mcp__plugin_mem0_mem0__list_events","mcp__plugin_mem0_mem0__search_memories","mcp__plugin_mem0_mem0__update_memory"],"mcp_servers":[{"name":"plugin:mem0:mem0","status":"connected"},{"name":"codebase-memory-mcp","status":"connected"},{"name":"claude.ai draw.io","status":"needs-auth"},{"name":"claude.ai Notion","status":"needs-auth"},{"name":"claude.ai Figma","status":"needs-auth"},{"name":"claude.ai Gmail","status":"needs-auth"},{"name":"claude.ai Miro","status":"needs-auth"},{"name":"claude.ai Postman","status":"needs-auth"},{"name":"claude.ai Excalidraw","status":"needs-auth"},{"name":"claude.ai MongoDB Atlas","status":"needs-auth"},{"name":"claude.ai Atlassian Rovo","status":"needs-auth"},{"name":"claude.ai Microsoft 365","status":"needs-auth"},{"name":"claude.ai Focus MCP","status":"needs-auth"}],"model":"claude-opus-5","permissionMode":"default","slash_commands":["example-command"],"terminal_slash_commands":["doctor","color","reload-plugins"],"apiKeySource":"none","claude_code_version":"2.1.270","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["example-skill"],"plugins":[],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"b803e912-fc4f-43b7-82c4-b199ec2f9515","memory_paths":{"auto":"/redacted/memory/"},"messaging_socket_path":"/tmp/cc-socks/45114.sock","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
    ```

---

### c) History Replay vs Pre-Message Silence
*Does the stream replay the prior conversation history before the first new turn, or does it emit nothing until you send a message? Quote what actually comes over the wire.*

- **Answer:** 
  1. **No conversation replay:** Prior conversation history (`user`, `assistant`, `result`) is **never replayed** over stdout.
  2. **Pre-message hook emission in both modes:** stdout is **not** silent before the first message if hooks are configured. SessionStart hooks fire on spawn in both fresh and resumed modes before any bytes are sent to stdin (`SessionStart:startup` for fresh sessions vs. `SessionStart:resume` for resumed sessions). In this run, 11 hook events were emitted over stdout during the pre-message observation window.
  3. **`system/init` deferred in both modes:** Neither mode emits `system/init` or assistant events pre-message; `system/init` is deferred until after the first user message is written to stdin.
- **Evidence:** The test harness waited 4,000 ms after process spawn before writing the first message to stdin. During those 4 seconds, hook events arrived (`SessionStart:resume`):
  - `system/hook_started` (5 hooks started; Lines 1–5)
  - `system/hook_response` (4 hooks responded; Lines 6–9)
  - `system/hook_progress` (1 hook progress event; Line 10, UUID: `"ab55bb90-bf57-49a2-b746-f9f8398d1faf"`)
  - `system/hook_response` (1 hook responded; Line 11, UUID: `"471fcdec-8db4-4246-b1b0-973cc377814b"`)
  *(Note on event count: The 11 hook events observed here are an artifact of this test machine's local configuration, which has 5 active hooks: 1 user hook in `~/.claude/settings.json` plus 3 plugins registering SessionStart hooks. This count is not a CLI protocol constant; an installation with no custom hooks or plugins emits zero hook events before the first message.)*
  - **First Hook Event Anchor:** `jq -c 'select(.subtype=="hook_started")' docs/capture-phase8-resume.jsonl | head -n 1`
  - **Distinctive UUID / Line:** `uuid: "37cbdafe-0ffb-42e3-9783-6264f9d14d7d"` (Line 1 in frozen capture)
  - **Verbatim Wire Payload:**
    ```json
    {"type":"system","subtype":"hook_started","hook_id":"e60e4aef-812e-40a9-8f31-bf427db3d525","hook_name":"SessionStart:resume","hook_event":"SessionStart","uuid":"37cbdafe-0ffb-42e3-9783-6264f9d14d7d","session_id":"943d0cdb-ee45-4625-9553-5a4adb187c4f"}
    ```

---

### d) Memory Restoration Verification
*Send a second turn that tests memory ("what is the magic word?"). Does it answer ORCHID? This is the only proof that context was actually restored — a successful process start is NOT proof.*

- **Answer:** **YES.** The model replied with `"ORCHID"`. Context from the baseline session was completely and accurately restored.
- **Evidence Records (`docs/capture-phase8-resume.jsonl`):**
  - **Turn 1 Assistant Event:**
    - **Anchor Query:** `jq -c 'select(.type=="assistant" and .message.content[0].text=="ORCHID")' docs/capture-phase8-resume.jsonl`
    - **Distinctive UUID / Line:** `uuid: "ded84a36-e7f7-4c16-bff1-6cbc92befbcb"` (Line 25 in frozen capture)
    - **Verbatim Wire Payload:**
      ```json
      {"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011Cf3BgcRcGtVAmJhLLSfCB","type":"message","role":"assistant","content":[{"type":"text","text":"ORCHID"}],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":421,"cache_read_input_tokens":26383,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":421},"output_tokens":8,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"943d0cdb-ee45-4625-9553-5a4adb187c4f","uuid":"ded84a36-e7f7-4c16-bff1-6cbc92befbcb","timestamp":"2026-09-14T10:36:43.277Z","request_id":"req_011Cf3BgbyZf5sqSYQLq8hnY"}
      ```
  - **Turn 1 Result Event:**
    - **Anchor Query:** `jq -c 'select(.type=="result" and .result_index==0)' docs/capture-phase8-resume.jsonl`
    - **Distinctive UUID / Line:** `uuid: "1546c173-1b28-445e-9c40-b916e7e670db"` (Line 30 in frozen capture; previously miscited as Line 27)
    - **Verbatim Wire Payload:**
      ```json
      {"duration_api_ms":1382,"stop_reason":"end_turn","session_id":"943d0cdb-ee45-4625-9553-5a4adb187c4f","total_cost_usd":0.0188365,"usage":{"input_tokens":2,"cache_creation_input_tokens":421,"cache_read_input_tokens":26383,"output_tokens":57,"output_tokens_details":{"thinking_tokens":50},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":421,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":57,"cache_read_input_tokens":26383,"cache_creation_input_tokens":421,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":421},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-5":{"inputTokens":2,"outputTokens":57,"cacheReadInputTokens":26383,"cacheCreationInputTokens":421,"webSearchRequests":0,"costUSD":0.0188365,"contextWindow":1000000,"maxOutputTokens":64000,"thinkingTokens":50,"canonicalModel":"claude-opus-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"ORCHID","ttft_ms":2401,"type":"result","duration_ms":2689,"uuid":"1546c173-1b28-445e-9c40-b916e7e670db","ttft_stream_ms":1675,"time_to_request_ms":1053,"first_content_frame_ms":1873,"queued_turn_count":0,"result_index":0}
      ```

---

### e) Transcript File Mutability
*After the resumed turn, does the CLI append to the SAME `.jsonl` file, or create a new one? Compare file paths, sizes and line counts before/after.*

- **Answer:** The CLI appends to the **EXACT SAME** `.jsonl` file under `~/.claude/projects/<slug>/<session-id>.jsonl`. No new file is created.
- **Target Transcript Path:**  
  `~/.claude/projects/-private-tmp-g8-clean/943d0cdb-ee45-4625-9553-5a4adb187c4f.jsonl`
- **File Measurements:**

| Stage | Size (bytes) | Line Count | Notes |
|---|---|---|---|
| Baseline (Step 1 end) | 157,964 | 30 | Original session (single turn) |
| Before Resume Spawn | 157,964 | 30 | Unchanged |
| After Resumed Turn 1 | 172,065 | 39 | +14,101 bytes, +9 lines appended |
| After Resumed Turn 2 | 175,645 | 45 | +3,580 bytes, +6 lines appended |
| After Resumed Turn 3 | 179,028 | 51 | +3,383 bytes, +6 lines appended |
| After Clean Exit | 179,970 | 54 | +942 bytes (final session cost/state lines) |

- **Integrity Verification:** A `diff -u` between the baseline transcript backup and `head -n 30` of the post-resume file showed 0 diffs. The existing 30 lines were completely unaltered; all new turns were appended sequentially.

---

### f) Multi-Turn Support in Resumed Persistent Process
*Can you send MORE THAN ONE turn through the resumed persistent process, or does it handle only a single turn? Send at least three.*

- **Answer:** **YES.** The resumed persistent process handles multiple turns without restarting. Three sequential turns were sent to the single persistent process:
  1. **Turn 1 (memory test):** *"What is the magic word? Do not use any tools. Answer with just the magic word."*  
     -> Reply: `"ORCHID"` (`is_error: false`, `subtype: "success"`)
  2. **Turn 2 (prior turn recall):** *"What was the very first prompt instruction I gave you when you learned the magic word? Answer briefly in one sentence without tools."*  
     -> Reply: `"You told me to remember that the magic word is ORCHID, to use no tools, and to reply with exactly \"Understood, the magic word is ORCHID.\""` (`is_error: false`, `subtype: "success"`)
  3. **Turn 3 (conversational continuation):** *"What color is a ripe banana? Do not use any tools. Answer in one word."*  
     -> Reply: `"Yellow"` (`is_error: false`, `subtype: "success"`)
- **Evidence Anchors (`docs/capture-phase8-resume.jsonl`):**
  - **Turn 1 `system/init`:** Anchor: `jq -c 'select(.type=="system" and .subtype=="init")' docs/capture-phase8-resume.jsonl | sed -n '1p'` | UUID: `"b803e912-fc4f-43b7-82c4-b199ec2f9515"` (Line 12)
  - **Turn 1 `result/success` (`"ORCHID"`):** Anchor: `jq -c 'select(.type=="result" and .result_index==0)' docs/capture-phase8-resume.jsonl` | UUID: `"1546c173-1b28-445e-9c40-b916e7e670db"` (Line 30; previously miscited as Line 27)
  - **Turn 2 `system/init`:** Anchor: `jq -c 'select(.type=="system" and .subtype=="init")' docs/capture-phase8-resume.jsonl | sed -n '2p'` | UUID: `"b4483c7f-4135-4e21-a152-01d44ce15c36"` (Line 31; previously miscited as Line 28)
  - **Turn 2 `result/success` (`"You told me..."`):** Anchor: `jq -c 'select(.type=="result" and .result_index==1)' docs/capture-phase8-resume.jsonl` | UUID: `"bcf3051a-b5d3-42da-8610-346d6afb8d6e"` (Line 50; previously miscited as Line 44)
  - **Turn 3 `system/init`:** Anchor: `jq -c 'select(.type=="system" and .subtype=="init")' docs/capture-phase8-resume.jsonl | sed -n '3p'` | UUID: `"44fb7b40-f2f8-4c91-afdb-849e476f6636"` (Line 51; previously miscited as Line 45)
  - **Turn 3 `result/success` (`"Yellow"`):** Anchor: `jq -c 'select(.type=="result" and .result_index==2)' docs/capture-phase8-resume.jsonl` | UUID: `"95d74f30-23ca-4a0f-a360-727e1e263e1b"` (Line 61)
- After Turn 3, `child.stdin.end()` was called, and the process exited cleanly with `code=0`.

---

### g) Event Stream Shape Differences
*Does anything differ from a non-resumed process in the event stream shape (extra events, missing events, different ordering)?*

- **Differences Observed:**
  1. **Startup Hook Name (Timing is Identical):** Startup hook timing does *not* differ between fresh and resumed sessions. In both modes, `SessionStart` hooks fire immediately upon process launch before any stdin message arrives, and `system/init` is deferred until after the first stdin message in both. The only difference is the hook name emitted: fresh sessions emit `SessionStart:startup`, whereas resumed sessions emit `SessionStart:resume`. (Note that on a system without custom hooks or plugins, zero hook events are emitted at startup in either mode.)
  2. **No Transcript Replay:** The stream emits no past `assistant` or `user` events. Clients managing chat history must reconstruct past messages from their own storage or from the `.jsonl` transcript file.
  3. **Identical Intra-Turn Shape:** Once a user message is sent to stdin, the event stream shape is completely identical to a fresh process:
     - `system/init` arrives first (repeats on every turn, as documented in RESEARCH B1).
     - `system/status` and `system/thinking_tokens` follow.
     - `stream_event` SSE deltas stream partial tokens.
     - `assistant` delivers the final block.
     - `rate_limit_event` delivers quota snapshots.
     - `result/success` concludes the turn.
  4. **Cost Accumulation:** `result.total_cost_usd` tracks the cumulative cost of the *current process* invocation, resetting on process restart (consistent with RESEARCH §B and `stream-reducer.ts` §150-165).

---

## Step 4: `--fork-session` with `--resume`

Command executed:
```bash
~/.local/bin/claude \
  -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --resume 943d0cdb-ee45-4625-9553-5a4adb187c4f \
  --fork-session
```

### Observations & Evidence:
1. **New Session ID Assigned:**
   The very first `system/init` event reported a freshly minted UUID:
   `session_id = 49d6bf2d-09a6-4440-aac8-760b123116ba` (and `5afa4b4b-3691-44c0-9143-fd842b4a70c1` in secondary run).
2. **New Transcript File Created:**
   A new file was created in `~/.claude/projects/-private-tmp-g8-clean/`:
   `49d6bf2d-09a6-4440-aac8-760b123116ba.jsonl` (initial size 183,284 bytes, 50 lines).
3. **Cloned History:**
   The entire transcript history from the parent session was cloned into the new file, with all `sessionId` fields updated to the forked ID.
4. **Parent Transcript Left Pristine:**
   The parent session transcript (`943d0cdb-ee45-4625-9553-5a4adb187c4f.jsonl`) remained at exactly 179,970 bytes and 54 lines before and after the fork.
5. **Memory Preserved in Fork:**
   Asking the forked session about prior turns confirmed full context retention:
   - Query: *"What fruit was discussed in the last question before this? Answer with just the fruit name."*
   - Reply: `"Banana"` (exit code 0, `subtype: "success"`).

---

## Deliverables & Artifacts

1. `docs/capture-phase8-resume.jsonl`: Clean, scrubbed NDJSON capture containing startup hook events (11 events in this capture due to local hooks/plugins) and the 3 complete turns of the resumed persistent process (validated with `docs/scrub-capture.py --check`).
2. `docs/capture-phase8-resume.md`: This findings document.

---

## Conclusion & Architectural Implications for Görev 8

1. **Persistent Process Architecture Holds:** We do NOT need a process-per-turn model to resume sessions. Spawning one persistent process with `--resume <sessionId>` allows ongoing multi-turn conversations while retaining the ~4x speed advantage established in RESEARCH B1.
2. **UI History Must Be Managed by Plugin:** Because `--resume` does not replay prior turns over `stream-json`, the plugin must load and render prior conversation history (either from plugin state or by parsing the `.jsonl` transcript per RESEARCH §D) when opening a resumed session.
3. **Handling Startup Hook Events:** Because `SessionStart` hooks (`SessionStart:startup` or `SessionStart:resume`) fire immediately upon process launch before any user message is sent when hooks are configured, the UI's stream reducer must expect hook events upon process launch and avoid treating early non-init events as turn starts or errors.

---

## What this means for the history UI

Because a resumed session replays no prior conversation history on stdout, the plugin must reconstruct and render past history itself from the on-disk transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`). Resuming via the CLI restores conversation context into model memory, but past turns are never re-streamed to the client. UI display of historical turns is entirely the plugin's responsibility.
