# Campaign: Faz 7 / Görev 9 — Automatic conversation title generation

## Status
Wave 1 (measurement) — dispatched 2026-09-15.

## Operator task
Write the SPEC for Görev 9. No implementation code this round. Orchestrator runs the process.

## Deliverable owned by the orchestrator
`docs/PHASE7-TASK9-SPEC.md` in the plugin repo + status line in the vault plan.

## Known before Wave 1 (do not re-measure)
- The CLI itself writes `type: "ai-title"` records (`aiTitle`, `sessionId`, `type`) into its own
  `.jsonl` transcript — 120 such records across the sampled corpus
  (`docs/capture-phase8-transcript-schema.md` §7).
- `src/data/session-index.ts` already reads `ai-title` into `SessionSummary.title`, and falls back
  to `derivedTitle` (first human user prompt, sanitised, 60 chars) — Görev 8 shipped this.
  `sessionDisplayTitle()` keeps the two apart honestly (`isDerived`).
- Görev 8 left a test scaffold that can construct `ChatView` offline. Task 9 must use it.

## Open questions for Wave 1
A. Does the CLI produce `ai-title` for sessions *our plugin* creates, and under what conditions?
B. If we must generate: what is the cheapest one-shot mechanism, its latency and cost?
C. Where does a title we generate get stored and read (the CLI transcript is not ours to write)?
D. What does the reference implementation (Claudian) actually do?

## Lanes
| Lane | Mode | Model | Question |
|---|---|---|---|
| A | Explore | gemini-3.8-flash-high | ai-title provenance in the real corpus |
| B | Explore | gemini-3.8-flash-high | one-shot generation mechanism, cost, latency |
| C | Explore | gemini-3.8-flash-high | our storage + render seams post-Görev 8 |
| D | Explore | gemini-3.8-flash-high | Claudian TitleGenerationService reference |

All four are read-only on the plugin source; B writes only under its own scratch dir. No write
claims conflict, so all four run concurrently.

## Wave 1 result (2026-09-15)

All four lanes finished on `gemini-3.8-flash-high`, none wrote code. Lane durations 4-12 min.

**Decisive finding (Lane A, independently re-counted by the orchestrator):** the CLI already
writes `ai-title` for plugin sessions on CLI >= 2.1.268 — 17 of 18 in the vault's own project
directory; the one miss had zero assistant records. Older CLI versions never did in headless mode
(0 of 62). This refutes the premise of Görev 9 as planned.

**Operator decision (Emre, asked with the measurement in hand):** no model call of our own.
Scope narrowed to (F1) refresh the open history list when a title arrives, (F2) manual rename
with precedence over the CLI title. F3 (title in the Obsidian tab) left as an open decision.

**Verification performed by the orchestrator, not taken on the lane's word:**
- Re-counted `ai-title` prevalence per entrypoint/version directly from `~/.claude/projects/`.
- Confirmed `--no-session-persistence`, `--safe-mode`, `--tools`, `--effort` exist in `claude --help`.

**Spec:** `🏰 300-Projects/GuKi Obsidian Plugin/Faz7-Gorev9-Spec.md` in the vault.

**Residue to clean up when Emre decides:** 13 throwaway session files under
`~/.claude/projects/-private-tmp-p7t9-b*` created by Lane B's measurements.

## Status
Wave 1 closed. No implementation wave opened — operator asked for a spec only.
