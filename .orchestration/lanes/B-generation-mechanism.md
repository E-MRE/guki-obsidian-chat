# Task: Measure the cheapest one-shot title generation mechanism

## Task ID
P7T9-B

## Mode
Explore (measurement, may run commands). Read-only with respect to the plugin repo.

## Objective
Determine, by actually running it, the cheapest and fastest way for the plugin to obtain a 3-5 word
title for a conversation from the Claude Code CLI, and report its measured latency and cost.

## Context
The plugin is an Obsidian plugin that already spawns the `claude` CLI as a long-lived child process
per conversation, using `--input-format stream-json --output-format stream-json`. See
`src/cli/claude-process.ts` and `src/cli/binary-resolver.ts` in the repo at
`/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat`.

For a title we would want a *separate, short-lived, cheap* call: feed it the first user message (and
possibly the first assistant reply), get back a few words, exit. The candidate mechanism is
`claude --print` with a small model.

CRITICAL RUNTIME RULE: any `claude` process you start must run with its working directory OUTSIDE
`/Users/emregultekir/Documents/EmreOS`. That directory is a vault with a `CLAUDE.md` that a
subprocess would silently inherit, which corrupts the measurement. Use a scratch directory such as
`/tmp/p7t9-b/` as the cwd for every `claude` invocation.

## Scope
- Read-only: the plugin repo's `src/cli/**`.
- Run `claude --help`, `claude --print ...` and equivalents from a scratch cwd outside the vault.
- Write only into `/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat/.orchestration/evidence/B/`
  and your scratch directory.

## Out of Scope
Implementing anything in the plugin. Deciding whether we should generate titles at all. Prompt
wording beyond what you need to measure.

## Questions to answer
1. What is the exact invocation for a single non-interactive call that returns only a short title?
   Give the full command line, verbatim, that you actually ran.
2. Which models are selectable for such a call on this machine, and what is the cheapest one that
   still returns a usable 3-5 word title? Take model identifiers from the CLI's own model listing,
   never from memory, and include that listing as evidence.
3. Measured latency: run each candidate at least three times and report the individual wall-clock
   timings, not only an average.
4. Measured cost: does the CLI report cost/token usage for such a call (for example via
   `--output-format json`)? If it does, report the exact fields and the measured values per call.
   If it does not, say so — do not estimate a price from a published rate card and present it as a
   measurement.
5. Does such a call create a new session transcript file under `~/.claude/projects/`? If it does,
   that is a side effect that would pollute our own history list — measure it: run a call, then
   diff the directory listing before and after, and report exactly what appeared.
6. Does the call inherit configuration (settings, MCP servers, skills, hooks, `CLAUDE.md`) from its
   working directory, and does that measurably change latency or output? Demonstrate by running the
   same prompt from two different working directories and comparing.
7. Is there a way to suppress session-file creation, skills, or MCP startup for a call this small
   (flags such as those shown in `claude --help`)? Report what exists and what you measured, and
   what you tried that did not work.
8. Quality check: using five short first-messages that you write yourself in the style of a user
   opening a chat (mix Turkish and English — the plugin's operator writes in Turkish), report the
   titles produced by the cheapest model. Judge whether they are usable as list labels and say where
   they failed if they did.

## Invariants
- Every timing and cost number must come from a command you ran, with the command shown.
- Never run a `claude` process with cwd inside the vault path given above.
- Label every claim measured or inferred.
- If a measurement is impossible in your environment (for example no network), stop and report that
  rather than producing plausible numbers.

## Forbidden Actions
- Do not contact the operator.
- Do not modify plugin source.
- Do not create branches or worktrees, commit, merge, or push.
- Do not delete anything under `~/.claude/` — if your measurement creates session files there, leave
  them and report their paths so the orchestrator can decide.
- Do not expand scope without escalation.

## Acceptance Criteria
- [ ] All eight questions answered or explicitly declared unanswerable with a reason.
- [ ] At least three timed runs per candidate model, individual timings reported.
- [ ] Question 5 answered with a before/after directory diff, not an opinion.
- [ ] Question 6 answered with two runs from two different working directories.
- [ ] Every command shown verbatim.

## Evidence Required
`EVIDENCE.md` under your evidence directory: commands, exit codes, raw output, timings table. Keep
any generated titles short and non-sensitive; the test prompts are yours to invent, so do not feed
real user data into a model call.

## Escalation Conditions
`claude` binary not found, no network, authentication failure, quota exhaustion, or a flag the help
text documents but the binary rejects.

## Handoff
Return: what you measured, the answers, the recommended cheapest mechanism WITH its measured cost
and latency, what you could not measure, the evidence file path, and a complete ledger of every
file you wrote (including anything that appeared under `~/.claude/`).
