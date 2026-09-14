# Evidence Report: Phase 7 / Task 9 (Lane B) — Cheapest One-Shot Title Generation Mechanism

**Task ID:** P7T9-B  
**Mode:** Explore (measurement, read-only with respect to plugin source)  
**Date:** 2026-09-15  
**Environment:** macOS (Darwin arm64)  
**Binary Under Test:** `/Users/emregultekir/.local/bin/claude` (Claude Code version `2.1.270`, commit `97ecbf7abeb4`, native install)  
**Scratch Working Directory:** `/tmp/p7t9-b/`  

---

## Executive Summary & Recommended Invocation

1. **Recommended Model:** `sonnet` (`claude-sonnet-5`).  
   **Counter-intuitive finding:** `sonnet` is both **cheaper** (~$0.0022/call vs ~$0.0044/call) and **over 2x faster** (~2.6s wall time vs ~6.4s) than `haiku` (`claude-haiku-4-5-20251001`). This occurs because Haiku 4.5 triggers mandatory extended thinking (generating 300–760 thinking tokens at low effort), while Sonnet 5 emits **0 thinking tokens** on short title generation, outputting only 15–20 tokens.
2. **Recommended Command Line:**
   ```bash
   /Users/emregultekir/.local/bin/claude \
     --model sonnet \
     --safe-mode \
     --no-session-persistence \
     --tools "" \
     --effort low \
     --system-prompt "You generate short 3-5 word conversation titles. Output ONLY the title, no quotes, no preamble." \
     -p "<USER_FIRST_MESSAGE>" \
     --output-format json < /dev/null
   ```
3. **Crucial Flag Discoveries:**
   - `--no-session-persistence`: Completely suppresses transcript `.jsonl` file creation under `~/.claude/projects/` (verified by before/after diff).
   - `--safe-mode`: Completely neutralizes working-directory `CLAUDE.md`, user hooks (e.g. Mem0), plugins, skills, and MCP servers.
   - `--tools ""`: Strips all built-in tool definitions from the system prompt, saving thousands of input tokens.
   - `< /dev/null`: Eliminates a 3-second stdin hang (without stdin redirection, `claude -p` waits 3s before proceeding).
   - `--bare` **fails**: Although documented in help, `--bare` disables macOS keychain and OAuth token access, failing with `Not logged in · Please run /login`.

---

## Question 1: Exact Invocation

### Verbatim Command Line
```bash
/Users/emregultekir/.local/bin/claude --model sonnet --safe-mode --no-session-persistence --tools "" --effort low --system-prompt "You generate short 3-5 word conversation titles. Output ONLY the title, no quotes, no preamble." -p "How do I configure TypeScript path aliases in a Vite React project?" --output-format json < /dev/null
```

### Breakdown of Arguments
- `claude`: Resolved executable at `/Users/emregultekir/.local/bin/claude`.
- `--model sonnet`: Directs CLI to use `Sonnet 5`.
- `--safe-mode`: Disables all customizations (`CLAUDE.md`, skills, plugins, hooks, MCP servers, custom commands).
- `--no-session-persistence`: Ensures no `.jsonl` transcript is written to disk under `~/.claude/projects/`.
- `--tools ""`: Disables all built-in tools (`Bash`, `Edit`, `Read`, etc.), preventing injection of tool schemas.
- `--effort low`: Sets thinking effort to minimum level.
- `--system-prompt "..."`: Replaces default multi-thousand-token CLI prompt with a concise title instruction.
- `-p, --print`: Non-interactive mode; prints output and exits.
- `--output-format json`: Returns structured JSON containing result, duration, exact cost, and token usage breakdown.
- `< /dev/null`: Closes stdin immediately to bypass the CLI's default 3-second stdin read timeout.
- Working directory: `/tmp/p7t9-b/` (outside `/Users/emregultekir/Documents/EmreOS` vault).

---

## Question 2: Selectable Models & Cheapest Model

### CLI Model Listing (Verbatim Evidence)
Executed command:
```bash
/Users/emregultekir/.local/bin/claude -p "/model" < /dev/null
```
Output:
```
Current model: `Opus 5 (1M context)` (effort: medium)
Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.
```

### Model Resolution & Status on This Machine
We tested resolving each alias and full ID on this machine:
1. `haiku`: Resolves to `Haiku 4.5` (`claude-haiku-4-5-20251001`). Available and functional.
2. `sonnet`: Resolves to `Sonnet 5` (`claude-sonnet-5`). Available and functional.
3. `opus`: Resolves to `Opus 5` (`claude-opus-5`). Available and functional.
4. `fable`: Resolves to `Fable 5.1`. Returns API error 429: `"Fable 5.1 requires usage credits. Switch to another model to continue."` (Not selectable without additional credits).
5. `claude-3-5-haiku-20241022`: Warns: `⚠ Claude 3.5 Haiku was retired on February 19, 2026. Consider switching to a newer model.`

### Cheapest Usable Model
**Measured Winner: `sonnet` (`Sonnet 5`).**  
Although `haiku` has a lower per-token list rate, in practice for title generation:
- `haiku` generates an internal reasoning trace (300 to 760 thinking tokens even with `--effort low`), costing **$0.0031 to $0.0053** per run.
- `sonnet` emits **0 thinking tokens**, generating strictly 15–20 output tokens. Together with the CLI's internal Haiku classifier step ($0.00098), total cost is **$0.00217 to $0.00219** per run.

---

## Question 3: Measured Latency

Three timed benchmark runs were executed per candidate model on the identical prompt:  
Prompt: `"How do I configure TypeScript path aliases in a Vite React project?"`  
Timing was measured both externally via `/usr/bin/time -p` (wall-clock) and internally via the CLI's JSON report (`duration_ms` and `duration_api_ms`).

### Latency Measurement Table

| Model | Run | External Wall Time (`/usr/bin/time -p`) | CLI `duration_ms` | CLI `duration_api_ms` | CLI TTFT (`ttft_ms`) |
|---|---|---|---|---|---|
| **haiku** (`Haiku 4.5`) | Run 1 | **5.16 s** | 4,087 ms | 4,715 ms | 3,923 ms |
| **haiku** (`Haiku 4.5`) | Run 2 | **7.15 s** | 6,062 ms | 6,568 ms | 5,913 ms |
| **haiku** (`Haiku 4.5`) | Run 3 | **7.00 s** | 5,875 ms | 6,360 ms | 5,720 ms |
| *haiku average* | | *6.44 s* | *5,341 ms* | *5,881 ms* | *5,185 ms* |
| **sonnet** (`Sonnet 5`) | Run 1 | **2.79 s** | 1,709 ms | 2,080 ms | 1,691 ms |
| **sonnet** (`Sonnet 5`) | Run 2 | **2.59 s** | 1,516 ms | 2,081 ms | 1,498 ms |
| **sonnet** (`Sonnet 5`) | Run 3 | **2.63 s** | 1,541 ms | 2,224 ms | 1,523 ms |
| *sonnet average* | | *2.67 s* | *1,589 ms* | *2,128 ms* | *1,571 ms* |
| **opus** (`Opus 5`) | Run 1 | **2.91 s** | 1,818 ms | 2,165 ms | 1,800 ms |
| **opus** (`Opus 5`) | Run 2 | **3.11 s** | 2,044 ms | 2,742 ms | 2,026 ms |
| **opus** (`Opus 5`) | Run 3 | **2.56 s** | 1,461 ms | 2,257 ms | 1,442 ms |
| *opus average* | | *2.86 s* | *1,774 ms* | *2,388 ms* | *1,756 ms* |

**Finding:** `sonnet` is the fastest candidate at ~2.67s wall-clock latency (~1.59s internal duration). `haiku` is more than 2.4x slower (~6.44s wall-clock) due to extended thinking generation.

---

## Question 4: Measured Cost & Token Usage

The Claude Code CLI **does directly report cost and token usage** in its JSON output (`--output-format json`).

### JSON Schema Fields Provided by CLI
- `total_cost_usd` (number): Aggregate cost for the call.
- `usage.input_tokens` (number): Prompt tokens.
- `usage.output_tokens` (number): Total completion tokens.
- `usage.output_tokens_details.thinking_tokens` (number): Extended thinking tokens.
- `modelUsage` (object): Map of model IDs to detailed usage metrics:
  - `inputTokens`, `outputTokens`, `thinkingTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, `canonicalModel`.

### Measured Values Per Benchmark Run

| Model | Run | Total Cost (USD) | Input Tokens | Output Tokens | Thinking Tokens | Model Usage Breakdown |
|---|---|---|---|---|---|---|
| **haiku** | Run 1 | **$0.003088** | 415 | 336 | 322 | `claude-haiku-4-5-20251001`: $0.003088 (in: 1323, out: 353, think: 322) |
| **haiku** | Run 2 | **$0.005278** | 415 | 774 | 761 | `claude-haiku-4-5-20251001`: $0.005278 (in: 1323, out: 791, think: 761) |
| **haiku** | Run 3 | **$0.004773** | 415 | 673 | 659 | `claude-haiku-4-5-20251001`: $0.004773 (in: 1323, out: 690, think: 659) |
| **sonnet** | Run 1 | **$0.002175** | 516 | 15 | 0 | `claude-haiku-4-5-20251001`: $0.000993 + `claude-sonnet-5`: $0.001182 |
| **sonnet** | Run 2 | **$0.002190** | 516 | 17 | 0 | `claude-haiku-4-5-20251001`: $0.000988 + `claude-sonnet-5`: $0.001202 |
| **sonnet** | Run 3 | **$0.002195** | 516 | 17 | 0 | `claude-haiku-4-5-20251001`: $0.000993 + `claude-sonnet-5`: $0.001202 |
| **opus** | Run 1 | **$0.003678** | 448 | 18 | 0 | `claude-haiku-4-5-20251001`: $0.000988 + `claude-opus-5`: $0.002690 |
| **opus** | Run 2 | **$0.003678** | 448 | 18 | 0 | `claude-haiku-4-5-20251001`: $0.000988 + `claude-opus-5`: $0.002690 |
| **opus** | Run 3 | **$0.003678** | 448 | 18 | 0 | `claude-haiku-4-5-20251001`: $0.000988 + `claude-opus-5`: $0.002690 |

*(Note: In the Sonnet and Opus runs, the CLI runs an internal intent/auto-mode classification step with Haiku costing ~$0.00099, followed by the generation step with Sonnet costing ~$0.00120 or Opus costing ~$0.00269).*

---

## Question 5: Session Transcript Persistence Under `~/.claude/projects/`

### Experiment Design
We ran two controlled invocations in dedicated subdirectories:
1. `Case A (without --no-session-persistence)` in `/tmp/p7t9-b/test-q5-persist`
2. `Case B (with --no-session-persistence)` in `/tmp/p7t9-b/test-q5-nopersist`

Directory snapshots of `~/.claude/projects/` were taken before and after each run.

### Measured Directory Diff (Case A: Without `--no-session-persistence`)
Command run:
```bash
/Users/emregultekir/.local/bin/claude --model haiku --safe-mode --tools "" -p "Hello test without no-session-persistence" --output-format json < /dev/null
```
Before/After diff of `ls -1 ~/.claude/projects`:
```diff
--- /tmp/p7t9-b/projects_before_persist.txt
+++ /tmp/p7t9-b/projects_after_persist.txt
@@ -25,6 +25,7 @@
 -private-tmp-guki-trust-test-path
 -private-tmp-guki-untrusted-test
 -private-tmp-p7t9-b
+-private-tmp-p7t9-b-test-q5-persist
 -private-tmp-sift-bench
 -private-tmp-sift-capcheck-repo
 -private-tmp-sift-capcheck-repo2
```
Listing of the created directory:
```
/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b-test-q5-persist/
└── 60b857ce-b4d6-43a5-b8a5-d00a8879621c.jsonl  (37,256 bytes)
```
**Conclusion:** Without `--no-session-persistence`, a session folder is created and a `.jsonl` transcript file matching the `session_id` is written to disk. This would pollute conversation history.

### Measured Directory Diff (Case B: With `--no-session-persistence`)
Command run:
```bash
/Users/emregultekir/.local/bin/claude --model haiku --safe-mode --no-session-persistence --tools "" -p "Hello test with no-session-persistence" --output-format json < /dev/null
```
Before/After diff of `ls -1 ~/.claude/projects`:
```
diff -u /tmp/p7t9-b/projects_before_nopersist.txt /tmp/p7t9-b/projects_after_nopersist.txt
(exit code 0, 0 lines diff)
```
Directory check:
```bash
ls -d ~/.claude/projects/*test-q5-nopersist*
# Result: Directory does not exist
```
**Conclusion:** Passing `--no-session-persistence` **100% suppresses session creation and persistence**. No folder or `.jsonl` file is written to disk.

---

## Question 6: Configuration Inheritance from Working Directory

### Experiment Design
Per the runtime rule to stay strictly outside `/Users/emregultekir/Documents/EmreOS`, two scratch directories were set up:
- Directory 1 (`cwd-clean`): `/tmp/p7t9-b/cwd-clean` (no `CLAUDE.md`, no local files).
- Directory 2 (`cwd-configured`): `/tmp/p7t9-b/cwd-configured` containing `CLAUDE.md`:
  ```markdown
  # Local Project Instructions
  When answering ANY prompt, you MUST begin your answer with the exact prefix "[INHERITED_CONFIG_MARKER]" followed by the answer.
  ```

Identical prompt executed from both directories: `"What is 2+2? Answer in one word."`

### Comparison 1: Without `--safe-mode` (Inheritance Active)
1. **In `cwd-clean`:**
   - Result: `"Mem0 Active | user=emregultekir | project=EmreOS | branch=unknown\n\nFour."`
   - Latency: **2,532 ms** (`duration_ms`)
   - Cost: **$0.093475** (23,038 prompt tokens due to global hooks and user configuration from `~/.claude/`).
2. **In `cwd-configured`:**
   - Result: `"[INHERITED_CONFIG_MARKER]\nMem0 Active | user=emregultekir | project=EmreOS | branch=unknown\n\nFour."`
   - Latency: **8,883 ms** (`duration_ms`)
   - Cost: **$0.053061** (23,231 tokens, 505 thinking tokens).

**Finding:** The subprocess inherits both local `CLAUDE.md` instructions (altering the output with `[INHERITED_CONFIG_MARKER]`) and global user hooks (Mem0), increasing latency ~3.5x and cost massively.

### Comparison 2: With `--safe-mode` (Inheritance Suppressed)
Executed in `cwd-configured`:
```bash
/Users/emregultekir/.local/bin/claude --model sonnet --safe-mode --no-session-persistence --tools "" -p "What is 2+2? Answer in one word." --output-format json < /dev/null
```
- Result: `"Four"`
- Latency: **1,443 ms** (`duration_ms`)
- Cost: **$0.007308**
- Marker present: **NO**. Local `CLAUDE.md` was completely ignored. Mem0 was completely ignored.

**Conclusion:** Working-directory configuration (`CLAUDE.md`) and user hooks drastically alter output, latency, and cost. Passing `--safe-mode` completely prevents this inheritance.

---

## Question 7: Suppression Flags (What Works vs What Failed)

### What Works
1. `--no-session-persistence`: Disables all session disk writes under `~/.claude/projects/`. Verified by 0-byte directory diff.
2. `--safe-mode`: Disables `CLAUDE.md`, user hooks, skills, plugins, and MCP servers. Reduces latency from 8.8s to 1.4s.
3. `--tools ""`: Disables all built-in tools. Eliminates tool definitions from the system prompt, reducing base prompt tokens from ~4,300 to ~400–500.
4. `--effort low`: Minimizes thinking tokens.
5. `< /dev/null`: Immediately closes stdin. Omitting this causes the CLI to hang for 3 seconds waiting for stdin (`Warning: no stdin data received in 3s, proceeding without it.`).

### What Was Tried That Did NOT Work
1. `--bare`:
   - Documented in help: *"Minimal mode: skip hooks, LSP, plugin sync... sets CLAUDE_CODE_SIMPLE=1."*
   - Attempted: `/Users/emregultekir/.local/bin/claude --model haiku --bare -p "..." --output-format json < /dev/null`
   - Failure: Exited code 1 with `Not logged in · Please run /login`.
   - Reason: `--bare` disables macOS keychain and OAuth token access, requiring an explicit `ANTHROPIC_API_KEY`.
2. `--effort none` / `--effort 0`:
   - Attempted: `/Users/emregultekir/.local/bin/claude --model haiku --effort none ...`
   - Failure: Emitted warning: `Warning: Unknown --effort value 'none' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.`
3. Prompting Haiku 4.5 not to think:
   - Added `"Do not think. Output only the title."` to prompt and system prompt.
   - Result: Model still spent 353 thinking tokens. In Claude Code 2.1.270, Haiku 4.5 extended thinking cannot be forced to 0 tokens via prompt instructions.

---

## Question 8: Quality Evaluation on Five Realistic First-Messages

Five prompts were tested across both candidate models (`sonnet` and `haiku`) using `--safe-mode --no-session-persistence --tools "" --effort low` with the title prompt:  
`"You generate short 3-5 word conversation titles. Output ONLY the title, no quotes, no preamble."`

### Results Table

| Prompt ID | First Message | Model | Generated Title | Word Count | Wall Time | Cost (USD) | Thinking Tokens | Usable as List Label? | Quality Notes |
|---|---|---|---|---|---|---|---|---|---|
| **P1** | `Bugünkü toplantı notlarını Obsidian günlüğüme aktarmak ve aksiyon maddelerini listelemek istiyorum.` | **sonnet** | **Toplantı Notları Obsidian Günlüğüne Aktarma** | 5 words | **3.00 s** | **$0.002419** | 0 | **YES** | Natural Turkish, accurate, perfect 5 words. |
| P1 | *(same)* | haiku | Meeting Notes and Action Items | 5 words | 8.37 s | $0.004821 | 659 | BORDERLINE | Translated Turkish prompt to English. |
| **P2** | `Sidebar'daki chat penceresi bazen açılmıyor, console'da TypeError veriyor.` | **sonnet** | **Sidebar Chat Penceresi TypeError Hatası** | 5 words | **3.02 s** | **$0.002282** | 0 | **YES** | Preserves component name and specific error. |
| P2 | *(same)* | haiku | Sidebar Chat TypeError Açılmıyor | 4 words | 6.35 s | $0.004166 | 534 | YES | Usable Turkish summary. |
| **P3** | `TypeScript plugin projesinde esbuild ayarlarını production build için minify edecek şekilde güncelle.` | **sonnet** | **Esbuild Production Minify Ayarları** | 4 words | **2.66 s** | **$0.002236** | 0 | **YES** | Concise, clear technical description. |
| P3 | *(same)* | haiku | TypeScript Esbuild Production Minify | 4 words | 6.68 s | $0.003777 | 456 | YES | Acceptable label. |
| **P4** | `How do I extract all links from a markdown note using regex in zsh?` | **sonnet** | **Extract Markdown Links with Regex** | 5 words | **2.68 s** | **$0.002158** | 0 | **YES** | Clean, standard title-cased English. |
| P4 | *(same)* | haiku | Extract Markdown Links with Regex | 5 words | 6.04 s | $0.003938 | 496 | YES | Identical title to Sonnet. |
| **P5** | `Faz 7 için test planını ve checklist maddelerini gözden geçirelim.` | **sonnet** | **Faz 7 Test Planı İncelemesi** | 5 words | **2.81 s** | **$0.002249** | 0 | **YES** | Flawless Turkish phrasing. |
| P5 | *(same)* | haiku | Faz 7 Test Planı İncelemesi | 5 words | 9.81 s | $0.008133 | 1317 | YES | Identical title, but 3.5x slower / 3.6x cost. |

### Usability Assessment
All 5 titles produced by `sonnet` were 100% usable as conversation sidebar labels. Sonnet correctly retained Turkish language for Turkish prompts, maintained title casing, adhered strictly to the 3–5 word boundary (all titles were either 4 or 5 words), and produced no markdown formatting, preamble, or punctuation. Haiku failed on P1 by translating Turkish to English, and took up to 9.8 seconds due to thinking token generation.

---

## File Ledger

### Files Created in Scratch Workspace (`/tmp/p7t9-b/`)
- `/tmp/p7t9-b/benchmark_results/haiku_run1.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/haiku_run2.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/haiku_run3.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/sonnet_run1.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/sonnet_run2.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/sonnet_run3.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/opus_run1.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/opus_run2.json` (and `.time`)
- `/tmp/p7t9-b/benchmark_results/opus_run3.json` (and `.time`)
- `/tmp/p7t9-b/run_benchmarks.sh`
- `/tmp/p7t9-b/run_q8.py`
- `/tmp/p7t9-b/q8_results.json`
- `/tmp/p7t9-b/projects_before_persist.txt`, `projects_after_persist.txt`
- `/tmp/p7t9-b/projects_before_nopersist.txt`, `projects_after_nopersist.txt`
- `/tmp/p7t9-b/cwd-configured/CLAUDE.md`

### Files Created Under `~/.claude/projects/` (Left Intact Per Invariant)
During initial flag probing and Question 5 persistence testing, the following session transcript files were created (and deliberately left untouched per instructions):
1. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b-test-q5-persist/60b857ce-b4d6-43a5-b8a5-d00a8879621c.jsonl`
2. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/23a662f4-2a54-449e-a3cc-e0a6baa3c45d.jsonl`
3. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/378cdc60-9a25-46fd-a108-10c66cbc8039.jsonl`
4. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/5e524de6-f849-42ad-ac2b-7b1ab7fe16a4.jsonl`
5. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/5ef90300-52ab-4e0e-9fa7-bfc42a2e0ce7.jsonl`
6. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/81d6f23f-ce26-440c-b91b-6117f395f905.jsonl`
7. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/a5edc99e-1cb4-444e-bb77-8f506194f522.jsonl`
8. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/a75c9f46-3b60-4d26-8616-9cd689a5b7ad.jsonl`
9. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/acd0a74e-ff9c-46d4-bdac-93e79ab0c2e0.jsonl`
10. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/c13c43d3-439a-4e43-9840-80eba1f19acd.jsonl`
11. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/c6a6b0e5-c33d-408d-a445-8cdf26dfc2d9.jsonl`
12. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/f093c5c8-8fb1-4f64-a251-72ba9fa5d2cf.jsonl`
13. `/Users/emregultekir/.claude/projects/-private-tmp-p7t9-b/f7bbf4a4-30a8-41cb-a57b-1457b83e4d9a.jsonl`

Zero session files were created under `cwd-clean`, `cwd-configured`, or `test-q5-nopersist` when `--no-session-persistence` was active.
