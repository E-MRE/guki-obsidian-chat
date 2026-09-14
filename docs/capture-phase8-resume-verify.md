# Independent Verification Report: Claude CLI `--resume` in Persistent Process Mode

**Date:** 2026-09-14  
**Verifier:** Independent Verification Agent (Fresh Context)  
**Base Commit:** `568e0826927674c5ac6bd37ecd33be33e7b5600c` (`feat/gorev-8-conversation-history`)  
**Artifacts Verified:**
- `docs/capture-phase8-resume.md`
- `docs/capture-phase8-resume.jsonl`

---

## 1. Executive Summary & Verdict

### Overall Verdict: **`FAIL`**

While the core runtime capabilities of `--resume` and `--fork-session` in persistent `stream-json` mode were successfully reproduced and confirmed to function as required by `docs/RESEARCH.md` §D (the CLI accepts the flags, restores memory, appends to the same transcript, does not replay history, and forks cleanly), the submitted deliverable `docs/capture-phase8-resume.md` **fails independent verification** due to two substantive defects:

1. **Empirically False Contrast in Startup Sequence (V2):** The findings document repeatedly claims that non-resumed processes stay silent until the first stdin message and only emit hooks after a user message arrives. Independent runtime measurements with an identical pre-message observation window prove this is **false**: fresh (non-resumed) processes also execute `SessionStart` hooks (`SessionStart:startup`) immediately upon process spawn before any stdin message is received. Pre-message hook emission is an intrinsic property of Claude CLI process startup in `stream-json` mode, not a phenomenon unique to `--resume`.
2. **Broken Claim-to-Evidence Anchoring (V8):** Six of the eight line citations and quotes in `docs/capture-phase8-resume.md` do not match `docs/capture-phase8-resume.jsonl`. Lines 27, 28, 44, and 45 are off by 3 to 6 lines (pointing to partial streaming deltas rather than `result` or `init` events), and the quoted payloads for Lines 1, 12, 25, and 27 quote stale session IDs, models, costs, and token usages from an earlier uncommitted run.

---

## 2. Per-Check Verdict Table

| Check ID | Description | Result | Summary of Findings |
|---|---|---|---|
| **V1** | Reproduce Core Result (Memory Probe) | **PASS** | Baseline session created with unique token `COBALT-7749`. Resumed process answered `COBALT-7749` without tools. Context genuinely restored. |
| **V2** | Startup Sequence Claim | **FAIL** | Resumed process does emit `SessionStart:resume` hooks pre-message and delays `system/init` until stdin. However, the claim that fresh processes do *not* emit hooks pre-message is **empirically disproven** (fresh process emitted 12 `SessionStart:startup` hook events within 350ms of spawn with zero stdin input). |
| **V3** | Hook Count Claim ("11 hook events") | **PASS** | Determined that "11" is not a property of the CLI or `--resume`. It is an artifact of this machine's 5 configured hooks (1 in `~/.claude/settings.json` + 4 active plugins). |
| **V4** | File Append & Immutability Claim | **PASS** | Resumed session appended to `~/.claude/projects/<slug>/<sessionId>.jsonl`. Verified line-by-line: initial 30 lines were 100% byte-for-byte identical; 0 in-place edits. |
| **V5** | Fork Session Claim | **PASS** | `--resume` + `--fork-session` assigned a new UUID in `system/init`, left parent file completely untouched, created child transcript with cloned history, and correctly answered context recall (`"Sky"`). |
| **V6** | No Replay Claim (Load-Bearing) | **PASS** | Zero past conversation history replayed over stdout before or after turn 1. Stderr remained 0 bytes. Context is injected into model prompts from disk, not streamed to client. |
| **V7** | Artifact Privacy & Integrity | **PASS** | `docs/scrub-capture.py --check` exited 0. Structural inspection revealed zero credential leaks, zero operator usernames, and proper redaction placeholders. |
| **V8** | Claim-to-Evidence Anchoring | **FAIL** | 6 of 8 line/event citations in `docs/capture-phase8-resume.md` are stale, off-by-N lines, or quote payloads not matching `docs/capture-phase8-resume.jsonl`. |

---

## 3. Independent Runtime Verification (What was REPRODUCED)

All runtime tests were executed outside the repository in an isolated throwaway workspace (`/private/tmp/g8-verifier-workspace`), invoking the Mach-O binary `~/.local/bin/claude` (Claude Code 2.1.270) with stripped environment (`ENV_DENY_PATTERN = /^(CLAUDE|ANTHROPIC|AI_AGENT|HEADROOM)/i`) and exact stdio configuration (`stdio: ['pipe', 'pipe', 'pipe']`, `shell: false`).

### V1: Core Result Reproduction (Session Setup & Resume Memory Probe)

1. **Baseline Setup:**
   - **Workspace:** `/private/tmp/g8-verifier-workspace`
   - **Flags:** `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
   - **Distinct Memory Token:** `COBALT-7749` (avoiding previous runs' `ORCHID`)
   - **Turn 1 Input:**
     `"Remember that the magic word is COBALT-7749. Do not use any tools. Reply with exactly \"Understood, the magic word is COBALT-7749.\""`
   - **Turn 1 Output:**
     Model replied: `"... Understood, the magic word is COBALT-7749."` (`is_error: false`, `subtype: "success"`)
   - **Baseline Session ID:** `d5e61aa9-5b34-4b1b-8fdb-2a2c43c51ad0`
   - **Baseline Exit:** Clean exit `code=0` on `stdin.end()`.

2. **Resume & Memory Probe:**
   - **Command:**
     `~/.local/bin/claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --resume d5e61aa9-5b34-4b1b-8fdb-2a2c43c51ad0`
   - **Probe Input:**
     `"What is the magic word? Do not use any tools. Answer with just the magic word."`
   - **Probe Output:**
     Model replied: `"COBALT-7749"` (`is_error: false`, `subtype: "success"`, `cost: $0.018911`)
   - **Multi-Turn Follow-up 1:**
     `"What was the very first prompt instruction I gave you when you learned the magic word? Answer briefly in one sentence without tools."`  
     -> Reply: `"You told me to remember that the magic word is COBALT-7749, to use no tools, and to reply with exactly \"Understood, the magic word is COBALT-7749.\""`
   - **Multi-Turn Follow-up 2:**
     `"What color is the sky on a clear day? Do not use any tools. Answer in one word."`  
     -> Reply: `"Blue"`
   - **Process Exit:** Clean exit `code=0` on `stdin.end()`.

### V2: Startup Sequence Comparison (Fresh vs. Resumed)

To verify whether pre-message hook emission is specific to resume, both a fresh process and a resumed process were spawned and observed for a 4,000 ms silent pre-message window (no stdin input).

| Metric | Fresh (Non-Resumed) Process | Resumed Process (`--resume`) | Implementer's Claim |
|---|---|---|---|
| Pre-message wait window | 4,000 ms | 4,000 ms | 4,000 ms |
| Events received before first stdin write | **12 hook events** | **11 hook events** | Claimed: Resumed emits 11, Fresh emits **0** |
| Hook event type/subtype | `system/hook_started`, `system/hook_response`, `system/hook_progress` | `system/hook_started`, `system/hook_response`, `system/hook_progress` | Same |
| Hook Name | `SessionStart:startup` | `SessionStart:resume` | - |
| First hook arrival timestamp | **+302 ms** | **+341 ms** | Claimed: Only resumed fires on spawn |
| `system/init` pre-message? | **NO** (arrives after stdin message) | **NO** (arrives after stdin message) | Both delay `system/init` |

**Conclusion on V2:** The implementer's claim in `docs/capture-phase8-resume.md` (§Executive Summary item 4, §c item 2, and §g item 1) that non-resumed processes emit hooks only after the first message arrives is **empirically false**. In both cases, Claude CLI runs `SessionStart` hooks immediately upon process initialization.

### V4: Transcript File Mutability

- **Transcript Path:** `~/.claude/projects/-private-tmp-g8-verifier-workspace/d5e61aa9-5b34-4b1b-8fdb-2a2c43c51ad0.jsonl`
- **Baseline State (before resume):** 30 lines, 158,246 bytes, SHA-256: `d949f0034f73e3b0a18194d43d570a63b23540be91c1d67fe1a484e3680b9326`
- **Post-Resumed Turn 1:** 39 lines (+9 lines appended), 172,467 bytes (+14,221 bytes).
- **Prefix Verification:** Checked line-by-line for lines 1 through 30. Every line was identical byte-for-byte to the baseline file.
- **Post-Resumed Turn 3 + Exit:** 55 lines (+16 lines appended), 182,252 bytes. Lines 1 through 30 remained completely unaltered.

### V5: Fork Session Verification

- **Command:**
  `~/.local/bin/claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --resume d5e61aa9-5b34-4b1b-8fdb-2a2c43c51ad0 --fork-session`
- **First `system/init` Session ID:** `9b8f349d-d136-40f2-856a-d797d164472b` (distinct newly minted UUID).
- **Parent File Immutability:** Parent transcript SHA-256 hash was identical before and after child execution.
- **Child Transcript Created:** `~/.claude/projects/-private-tmp-g8-verifier-workspace/9b8f349d-d136-40f2-856a-d797d164472b.jsonl` (51 lines).
- **Child Transcript Content:** Pre-populated with parent session's turns; all session references rewritten to `9b8f349d-d136-40f2-856a-d797d164472b`.
- **Memory Retention in Fork:** Query `"What was asked about in the question right before this? Answer with just the noun."` correctly returned `"Sky"` (recalling Turn 3 of parent session). Exit code `0`.

### V6: "No Replay" Verification

- Over the 4,000 ms pre-message window, no user, assistant, or result events were emitted.
- Following message submission, stdout streamed only new turn events (`system/init`, `system/status`, `stream_event`, `assistant`, `rate_limit_event`, `result`).
- Stderr was monitored across all runs: exactly 0 bytes received.
- No side-channel or control event replayed past history.

---

## 4. Architectural & Environmental Audits (What was READ & ANALYZED)

### V3: Origin of the "11 Hook Events"

Inspection of the host system configuration revealed where the hook events originate:
- `~/.claude/settings.json` defines 1 `SessionStart` hook: `~/.claude/hooks/vault-context.sh`.
- `enabledPlugins` in `~/.claude/settings.json` enables 4 plugins: `i-have-adhd`, `swift-lsp`, `mem0`, `ponytail`.
- Three of these plugins (`i-have-adhd`, `ponytail`, `mem0`) register their own `SessionStart` hooks via `hooks.json`.
- When 5 hooks execute concurrently:
  - 5 `system/hook_started` events are emitted.
  - 1 or 2 `system/hook_progress` events are emitted (e.g. `mem0` status output).
  - 5 `system/hook_response` events are emitted.
  - Total: 5 + 1 + 5 = 11 events (or 12 events when `mem0` emits two progress chunks).

**Finding:** "11 hook events" is purely an artifact of this developer machine's local configuration. On an installation without custom hooks or plugins, zero hook events are emitted.

### V7: Privacy and Artifact Sanitization

The committed capture `docs/capture-phase8-resume.jsonl` was audited structurally and via `docs/scrub-capture.py`:
- `python3 docs/scrub-capture.py --check docs/capture-phase8-resume.jsonl` passed with exit code 0 (`clean`).
- Full structural scan of all 61 lines:
  - `system/hook_response` and `hook_progress` payloads (Lines 8, 9, 10, 11) were redacted to the standard placeholder text.
  - No personal paths: Only `/private/tmp/g8-clean`, `/redacted/memory/`, and socket paths appear. The operator's home path does not appear anywhere in `docs/capture-phase8-resume.jsonl`.
  - No secrets: No API tokens, SSH keys, or authorization headers are present.
  - Event count matches: Exactly 61 NDJSON lines (11 startup hook events + 3 turns of 16-17 events each).

---

## 5. Detailed Mismatches & Findings in `docs/capture-phase8-resume.md` (V8)

The table below catalogs every citation in `docs/capture-phase8-resume.md` compared against the committed file `docs/capture-phase8-resume.jsonl`.

| Citation in `.md` | Claimed Target & Content | Actual Target in `.jsonl` | Mismatch Description |
|---|---|---|---|
| **Lines 58–61** | Line 12: `system/init` quoting `"tools":[28]`, `"mcp_servers":[{"name":"codebase-memory-mcp","status":"connected"}]`, `"model":"claude-opus-5-20250819"` | Line 12: `system/init` | Quoted content does not match. Actual Line 12 contains `tools` as 56 tool names, `mcp_servers` with 13 servers, and `"model":"claude-opus-5"`. |
| **Lines 72–75** | Lines 6–10: `system/hook_response`, Line 11: `system/hook_progress` | Lines 6–9: `system/hook_response`, Line 10: `system/hook_progress`, Line 11: `system/hook_response` | Event subtype ordering inverted. Line 10 in `.jsonl` is `hook_progress`; Line 11 is `hook_response`. |
| **Lines 76–79** | Line 1: `hook_id="8fd56b57-60a5-..."`, `uuid="0b1b9e07-e851-..."` | Line 1: `hook_id="e60e4aef-812e-..."`, `uuid="37cbdafe-0ffb-..."` | Quoted UUIDs do not match Line 1 of `.jsonl`. |
| **Lines 87–90** | Line 25: `assistant` event quoting `"model":"claude-opus-5-20250819"`, `"id":"msg_011Cf3Bh22YQe7eKjP59B4Y6"`, `input_tokens: 3`, `output_tokens: 4` | Line 25: `assistant` event delivering `"ORCHID"` | Quoted model, message ID, and token usage do not match Line 25 of `.jsonl` (`"id":"msg_011Cf3BgcRcGtVAmJhLLSfCB"`, `input_tokens: 2`, `output_tokens: 8`). |
| **Lines 92–95** | Line 27: `result` event quoting `total_cost_usd: 0.0076845`, `duration_ms: 1653` | Line 27: `stream_event` (`message_delta`) | **Severe line offset.** Line 27 is a partial streaming delta. The actual `result` event is at **Line 30** (`total_cost_usd: 0.0188365`, `duration_ms: 2689`). |
| **Line 131** | Line 12: `system/init` for Turn 1 | Line 12: `system/init` | Matches. |
| **Line 132** | Line 27: `result/success` for Turn 1 | Line 30: `result/success` for Turn 1 | **Off by 3 lines.** Line 27 is `stream_event`. |
| **Line 133** | Line 28: `system/init` for Turn 2 | Line 31: `system/init` for Turn 2 | **Off by 3 lines.** Line 28 is `stream_event` (`message_stop`). |
| **Line 134** | Line 44: `result/success` for Turn 2 | Line 50: `result/success` for Turn 2 | **Off by 6 lines.** Line 44 is `stream_event` (`content_block_delta`). |
| **Line 135** | Line 45: `system/init` for Turn 3 | Line 51: `system/init` for Turn 3 | **Off by 6 lines.** Line 45 is `stream_event` (`content_block_delta`). |
| **Line 136** | Line 61: `result/success` for Turn 3 | Line 61: `result/success` for Turn 3 | Matches. |

**Root Cause of Anchoring Failures:** The narrative text was drafted from an initial test capture that omitted partial streaming messages (or had fewer tokens), resulting in Turn 1 ending at line 27 and Turn 2 ending at line 44. When the implementer subsequently regenerated `docs/capture-phase8-resume.jsonl` with `--include-partial-messages`, partial deltas shifted the line counts, but the markdown narrative was not updated to re-anchor the line numbers.

---

## 6. Required Remediations for Lane Acceptance

To achieve a `PASS`, the lane implementer must address the following in `docs/capture-phase8-resume.md`:

1. **Correct V2 Startup Sequence Narrative:**
   - Remove assertions claiming non-resumed processes stay silent until stdin input or only emit hooks post-message.
   - Accurately state that Claude CLI executes `SessionStart` hooks on spawn in both modes (`SessionStart:startup` vs `SessionStart:resume`), and both modes defer `system/init` until after the first user message is received on stdin.
2. **Clarify V3 Hook Count:**
   - Explicitly note that the "11 hook events" figure is an environmental artifact of local plugins and `~/.claude/settings.json`, not a constant of the Claude Code protocol.
3. **Re-anchor Line Citations to `docs/capture-phase8-resume.jsonl` (V8):**
   - Update Line 1 quote with the actual `hook_id` and `uuid`.
   - Update Line 12 quote to accurately reflect the actual payload.
   - Update Line 25 quote with the actual `msg_id` and token counts.
   - Re-anchor Turn 1 `result` to **Line 30** (and update cost/duration numbers).
   - Re-anchor Turn 2 `init` to **Line 31** and `result` to **Line 50**.
   - Re-anchor Turn 3 `init` to **Line 51** and `result` to **Line 61**.
   - Correct the hook sequence description (Line 10 is `hook_progress`, Line 11 is `hook_response`).
