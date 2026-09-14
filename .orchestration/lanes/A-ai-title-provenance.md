# Task: Measure where `ai-title` records come from

## Task ID
P7T9-A

## Mode
Explore (read-only measurement). Do not modify any file outside your own evidence directory.

## Objective
Establish, from the real on-disk corpus, whether the Claude Code CLI writes `type: "ai-title"`
records for sessions started the way our Obsidian plugin starts them — and if it does not always,
what distinguishes the sessions that get one from the sessions that do not.

## Context
The plugin spawns a long-lived `claude` CLI process per conversation and reads the CLI's own
transcript files under `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the absolute
project path with every `/` replaced by `-`. A prior capture already established that `ai-title`
records exist and carry exactly three fields (`type`, `sessionId`, `aiTitle`). That is settled —
do not re-derive it. What is NOT known is the provenance: which sessions get one, and when.

The vault the plugin runs against is `/Users/emregultekir/Documents/EmreOS`, so its project
directory is `~/.claude/projects/-Users-emregultekir-Documents-EmreOS/`. Other project directories
under `~/.claude/projects/` come from ordinary terminal use of the CLI and are useful as contrast.

## Scope
Read-only: `~/.claude/projects/**`, and the plugin repo at
`/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat` for how sessions are spawned
(`src/cli/claude-process.ts`, `src/core/session-manager.ts`).
Write only into `/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat/.orchestration/evidence/A/`.

## Out of Scope
Any change to plugin source. Any design proposal for how we should generate titles. Cost analysis.

## Questions to answer
1. Across the whole corpus: how many `.jsonl` session files exist, and how many contain at least one
   `ai-title` record? Report the count and the ratio, per project directory, not only in total.
2. For the vault's own project directory specifically: how many sessions have an `ai-title`?
   If some do and some do not, characterise the difference with measured attributes — number of
   user turns, session duration, whether the session was resumed, presence of `cost-state`, the
   session's age. Do not guess a cause you have not measured.
3. Where does the `ai-title` record sit in the file — first line, last line, after N records? Report
   the distribution of its line position relative to the file's total line count, and the
   `timestamp` gap between the session's first user record and the `ai-title` record if the record
   or its neighbours carry a timestamp.
4. Can an `ai-title` appear *after* the plugin has already read and listed a session — i.e. does the
   CLI append it late, such that a list rendered at session start would show no title and a list
   rendered later would show one? Answer from timestamps/positions, not from intuition.
5. Do sessions that the plugin created (long-lived process, `--input-format stream-json`) differ
   from sessions created by ordinary interactive terminal use on this dimension? Identify which
   files belong to which class by a measurable marker you can name, and state the marker.
6. Does anything in the CLI's own configuration or environment appear to gate title generation
   (a setting in `~/.claude/settings.json` or similar)? Report what you find or report that you
   found nothing — do not infer a setting from behaviour.

## Invariants
- Every number you report must come with the exact command that produced it.
- Anchor every citation to something that survives file regeneration: a `jq`/`grep` expression or a
  verbatim distinctive substring. A bare line number is not acceptable on its own.
- Distinguish "measured" from "inferred" on every claim. Label them.
- If a question cannot be answered from the available data, say so explicitly and say what data
  would answer it. Do not fill the gap with a plausible story.

## Forbidden Actions
- Do not contact the operator.
- Do not create branches or worktrees, commit, merge, or push.
- Do not modify plugin source or any file under `~/.claude/` (read only).
- Do not expand scope without escalation.

## Acceptance Criteria
- [ ] Every one of the six questions has an answer or an explicit "not answerable, because X".
- [ ] Per-project-directory counts reported, plus the vault directory broken out separately.
- [ ] Each reported number is reproducible from a command included verbatim in the report.
- [ ] Every claim is labelled measured or inferred.

## Evidence Required
Write `EVIDENCE.md` under your evidence directory containing the commands, their raw output
(truncated sensibly but never edited into a summary where the number matters), and the resulting
table. Redact the contents of prompts: session titles and user text may be personal. Report
*shapes, counts and markers*, not the text of anyone's conversations. Where you must quote a title
to illustrate a point, quote at most three and keep them short.

## Escalation Conditions
Permission denied on a directory, a corpus too large to scan within your timebox, or a finding that
contradicts the settled facts in the Context section.

## Handoff
Return: what you measured, the answers, what you could not answer, the evidence file path, and a
complete ledger of every file you wrote.
