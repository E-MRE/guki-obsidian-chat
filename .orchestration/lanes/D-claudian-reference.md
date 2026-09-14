# Task: Extract what the reference implementation actually does about titles

## Task ID
P7T9-D

## Mode
Explore (read-only). Do not modify anything outside your own evidence directory.

## Objective
Report, from source, how the Claudian Obsidian plugin generates, stores, displays and updates
conversation titles — as a set of concrete design decisions with their tradeoffs, so our spec can
adopt, adapt or reject each one deliberately.

## Context
Reference source: `/Users/emregultekir/Documents/otherprojects/claudian`. Relevant entry points named
in our plan are `TitleGenerationService.ts` (around the title generation call) and
`ConversationController.ts` (around where it is triggered), but verify the real locations rather
than trusting those names or line numbers.

IMPORTANT DIFFERENCE, already established: Claudian drives the Claude Agent SDK, while our plugin
drives the `claude` CLI as a child process. So Claudian's *mechanism* may be unavailable to us even
where its *behaviour* is worth copying. Report both separately.

## Scope
Read-only over `/Users/emregultekir/Documents/otherprojects/claudian`. Write only into
`/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat/.orchestration/evidence/D/`.

## Out of Scope
Our own plugin's source. Any implementation. Any recommendation about our architecture beyond
flagging where Claudian's mechanism cannot transfer.

## Questions to answer
1. **Trigger.** At what exact moment is title generation started — after the first user message,
   after the first assistant reply, after N messages, on idle? Cite the call site.
2. **Prompt.** What is the exact prompt/system prompt used, and what input is fed to it (first user
   message only, a truncated transcript, both sides)? Quote it verbatim.
3. **Model and cost control.** Which model does it request, and does it use a cheaper/faster tier
   than the conversation itself? Is there a token or length cap on the input?
4. **Storage.** Where does the generated title get written — a plugin-owned store, a sidecar file,
   frontmatter, the conversation record? Show the write and the read, and the on-disk shape.
5. **Failure and absence.** What happens when generation fails, is offline, or is slow? Is there a
   fallback label, a retry, a timeout? Is a failed title retried on next open, or is failure sticky?
6. **Update path.** Once generated, is the title ever regenerated (for example after the topic
   drifts)? Can the user rename it manually, and what does that do to a later generation?
7. **Displayed state.** Does the UI distinguish a generated title from a placeholder while
   generation is in flight (a spinner, a provisional label, nothing)?
8. **Transferability.** For each of the above, state whether the mechanism depends on the Agent SDK
   in a way that a CLI-child-process plugin could not reproduce. Be specific about which API call is
   the blocker where one exists.

## Invariants
- Cite as `path:symbolOrDistinctiveSubstring` — anchor to a searchable string, not a bare line number.
- Quote the prompt verbatim; do not paraphrase it.
- Label each claim measured (read in source) or inferred.
- Where the code has more than one path (for example a settings flag turning the feature off), report
  all paths rather than only the default one.

## Forbidden Actions
- Do not contact the operator.
- Do not modify any file in the reference repo.
- Do not create branches or worktrees, commit, merge, or push.
- Do not run the reference plugin or install its dependencies.
- Do not expand scope without escalation.

## Acceptance Criteria
- [ ] All eight questions answered or explicitly declared unanswerable with a reason.
- [ ] The generation prompt quoted verbatim.
- [ ] Storage shown as both a write site and a read site.
- [ ] Question 8 answered per-decision, not as one blanket sentence.

## Evidence Required
`EVIDENCE.md` under your evidence directory with the citations, the verbatim prompt, and the
relevant code excerpts kept short.

## Escalation Conditions
The reference repo is absent or does not contain a title feature at all, or the named files do not
exist under any similar name.

## Handoff
Return: the eight answers, the transferability verdict per decision, what you could not determine,
the evidence path, and a complete ledger of every file you wrote.
