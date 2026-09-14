# Task: Map the storage and render seams a generated title would plug into

## Task ID
P7T9-C

## Mode
Explore (read-only). Do not modify any file outside your own evidence directory.

## Objective
Produce an evidence-backed map of exactly where in the current plugin a title we generate ourselves
would have to be written, read, rendered, and invalidated — including what persistence the plugin
already has, so the spec does not invent a new one.

## Context
Repo: `/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat`, branch `main`, at commit
`654ab51` (Görev 8 just merged: conversation history list + resume).

Settled facts, do not re-derive:
- `src/data/session-index.ts` builds `SessionSummary { sessionId, title?, derivedTitle?, startedAt,
  costUsd? }` by scanning the CLI's own `.jsonl` transcripts. `title` comes from a `type:"ai-title"`
  record written by the CLI; `derivedTitle` is our own fallback from the first human user prompt.
  `sessionDisplayTitle()` returns which one is in use via an `isDerived` flag.
- The CLI's transcript files belong to the CLI. We read them; we do not write into them.

Therefore a title the plugin generates needs a home of our own. The question is where that home
already exists.

## Scope
Read-only over the whole repo, in particular:
`src/data/**`, `src/ui/history-dropdown.ts`, `src/ui/chat-view.ts`, `src/core/session-manager.ts`,
`src/core/chat-state.ts`, `src/main.ts`, `src/ui/settings-tab.ts`, `data.json`, `styles.css`,
`docs/offline-checks.ts`, `docs/obsidian-stub.mjs`, `package.json`.
Write only into `.orchestration/evidence/C/`.

## Out of Scope
Any source modification. Any opinion on whether titles should be generated. Claudian's source.

## Questions to answer
1. **Persistence that already exists.** What does the plugin persist today, through which API, into
   which file, with what shape? Show the load path and the save path and the actual current contents
   of `data.json` with anything sensitive redacted. Is that store per-vault, per-plugin, or per
   conversation?
2. **The read seam.** Trace, function by function, how a row in the history dropdown gets its label
   today, from the directory scan to the DOM text. Name each function and file. State the one place
   where a stored title would have to be consulted so that every caller benefits — and whether more
   than one caller would have to change.
3. **The write trigger.** Where in the code does the plugin first learn a conversation's session id,
   and where does it observe the first user message and the first assistant reply? Give the call
   sites. Is the session id known *before* the first message is sent, or only after the CLI reports
   it back? This determines whether a title can be keyed by session id at generation time.
4. **Refresh.** When the history list is open and something changes, what redraws it? Is there an
   existing refresh/invalidations path, or is the list built once per open? If a title arrived
   asynchronously a second after the list rendered, what in the current code would make it appear?
5. **Rename.** Does any current UI let the user edit a label of anything? If the spec adds manual
   rename, name the nearest existing pattern in this codebase to follow.
6. **Test scaffold.** Görev 8 left a scaffold that constructs `ChatView` offline. Describe how it
   works, how a check is registered and run (the exact command), and what a Task 9 check would be
   able to observe through it — specifically: could a check assert that a title was stored, that the
   list read the stored title rather than recomputing, and that no generation call happened when a
   title already exists? Answer each of those three separately; the spec depends on which are
   observable offline.
7. **Counts.** How many checks exist today and what is the exact command that runs them, with its
   current passing output?

## Invariants
- Cite every claim as `path:symbolOrDistinctiveSubstring`. A line number may accompany a citation,
  never replace it.
- Label each claim measured (you read it or ran it) or inferred.
- Where you are unsure whether two code paths are the same seam, say so rather than merging them.

## Forbidden Actions
- Do not contact the operator.
- Do not modify plugin source, `data.json`, or any file outside your evidence directory.
- Do not create branches or worktrees, commit, merge, or push.
- Do not expand scope without escalation.

## Acceptance Criteria
- [ ] All seven questions answered, with question 6 answered as three separate yes/no findings.
- [ ] The read seam is given as an ordered call chain with file and symbol at each step.
- [ ] The check command is shown with its actual output, not described.
- [ ] Every claim labelled measured or inferred.

## Evidence Required
`EVIDENCE.md` under your evidence directory, containing the call chains, citations, the redacted
`data.json` contents, and the check run with its exit code.

## Escalation Conditions
The repo is not at the stated commit, the checks do not pass on a clean tree, or a settled fact in
the Context section turns out to be false.

## Handoff
Return: the seam map, the three separate answers to question 6, what you could not determine, the
evidence path, and a complete ledger of every file you wrote.
