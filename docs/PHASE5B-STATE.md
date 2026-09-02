# PHASE 5b — the permission policy (working state)

Phase 5a built the bridge and ends every request at a card. 5b is the decision itself: PLAN §2b's
table plus the Bash whitelist. Kept current as the work goes, per NEXT.md's rule.

## Baseline taken before any edit (2026-09-02)

- `npm run build` clean, `npm run lint` clean.
- `docs/offline-checks.ts`: **349 ok, 0 FAIL**, sections A–M.

## What was read

- `docs/NEXT.md` whole.
- `docs/PLAN.md` §1, §2, §2b (incl. the Bash whitelist), and Phase 5's own section.
- `docs/RESEARCH.md` B5 (incl. B5b) and D — the two NEXT.md names. D turned out to be v2 transcript
  material with nothing in it for the policy; B5/B5b is the load-bearing half.

### A doc inaccuracy worth recording

NEXT.md line 22 says "two B5 claims are now stale — see traps 22 and 23." The two traps that
actually correct B5's text are **25** (`permission_prompt` *is* in `init.tools` at CLI 2.1.250,
contradicting RESEARCH.md:257) and **26** (`permission_suggestions` never sent). Trap 22 refines
B5's "a denied tool is not a failed turn" at the *tool_result* level and 23 is about
`terminal_reason`. Neither pair changes anything for 5b — the policy never reads those fields — but
the pointer is off by two and the next reader should not go looking for a contradiction in 22/23.

## Design settled before writing code

Three files, because the policy must stay free of `obsidian` and Node imports so
`docs/offline-checks.ts` can drive it with no process, no socket and no DOM:

| File | Role | Imports |
|---|---|---|
| `src/core/permission-policy.ts` | PLAN §2b's table. `(toolName, input, VaultPaths) => 'allow' \| 'ask'` | none but `./bash-whitelist` |
| `src/core/bash-whitelist.ts` | the 3-step gate. `(command, VaultPaths) => 'allow' \| 'ask'` | type-only, from the policy |
| `src/core/vault-path-resolver.ts` | the impure half: builds `VaultPaths` over real `fs.realpathSync.native` | `node-api` |

`VaultPaths` is the seam: `{ root, resolve(raw), isInside(raw) }`. The policy never touches a filesystem itself, so
every case in the table is exercisable from a fixture, and the one part that *must* touch a real
filesystem (symlink resolution) is small enough to test against real symlinks in a temp dir.

`PermissionBroker` gains an explicit `vaultRoot` constructor argument rather than re-deriving it
from `app`. The vault root is the security boundary; it is worth naming at the call site, and it is
what lets the offline checks pin a temp directory as "the vault" instead of depending on the real
one being present.

## Deliberate deviations from PLAN §2b — all in the stricter direction

Round 1 listed six. **One is gone** (settled by measurement), and the review found a **seventh that
had gone the other way and was not listed at all** — now fixed, so it is no longer a deviation.

Each remaining one is a named constant or a one-line list move if it is ever to be relaxed.

1. **`WebFetch` allowed only for `http:`/`https:` urls.** PLAN says web is free, and it is — but the
   tool takes a URL and a `file://` URL is a local file read.
2. **`Write` with empty or whitespace-only `content` ⇒ `ask`.** PLAN's row is "an existing file being
   emptied". Deciding "existing" would need a filesystem read *inside the decision* and a
   check-to-write window; emptying a file that does not exist is harmless, so asking in both cases
   costs one needless card at worst.
3. **Any resolved path with a `.git` segment ⇒ `ask`**, even inside the vault. The auto-allow rests
   on "git makes it reversible"; a write into `.git` is the one edit that revokes that argument.
4. **The metacharacter veto is extended** beyond PLAN's list with `$ ~ * ? [ ] { } ( ) \ !` and `#`.
   PLAN's list has a real hole: it vetoes `$(` but not bare `$`, and `cat $HOME/.ssh/id_rsa` has
   nothing on PLAN's list — step 3 would then resolve the *literal* token `$HOME/.ssh/id_rsa`, which
   does not exist, and PLAN's step 3 only rejects tokens that "resolve to an existing filesystem
   path", so it would have been **allowed** and the shell would have expanded it. Same for `~` and
   for globs (`cat ../*`).
5. **Step 3 is stronger than PLAN's wording:** *every* non-flag token must resolve inside the vault,
   whether or not it exists. The existence qualifier is what opens hole 4. A flag token (leading `-`)
   is skipped, except that a flag containing `/` ⇒ `ask`.
   PLAN's own worked example `"cat ~/.ssh/id_rsa" -> ask` is only reachable through one of these two
   changes: under PLAN's literal text `~/.ssh/id_rsa` is a relative path resolving to
   `<vault>/~/.ssh/id_rsa`, which is **inside** the vault. The spec's own negative test fails against
   the spec's own rules.

### Closed: `Task`/`Agent` (was deviation 1)

Round 1 asked about `Agent` against PLAN's table, on the grounds that PLAN's rationale ("no side
effect outside the session") is wrong — a subagent runs its own tools — and that the Phase 4 capture
could not settle it, having been taken with no bridge attached.

**Manual step 8 settled it: inner subagent calls are gated individually.** The subagent's own
`Write /tmp/agent-test.md` produced its own card with Allow/Deny, and its follow-up
`Bash ls -la /tmp/…` produced a second one. Allowing the parent therefore grants nothing. `Agent`
and `Task` are both in `NO_SIDE_EFFECT_TOOLS` now, and the comment there records what was measured
rather than what was suspected.

**The trap that came with it, because it fooled the in-app assistant during the run:** the subagent
reported "no permission prompt appeared", and that is not evidence of anything. A subagent never
sees the prompt — it is intercepted at the broker and shown to the reader; from inside the subagent
an approved call and an ungated one are identical. Anything reasoning about gating must read the
transcript's own cards, never a subagent's self-report.

### Was a deviation the wrong way, now fixed (F1)

`isDestructiveEdit` handled `Write`, `NotebookEdit` and malformed `MultiEdit` but had **no `Edit`
branch**, so an `Edit` whose `new_string` was empty and whose `old_string` was the whole file
emptied it silently — PLAN's "existing file being emptied", verbatim, going the permissive way while
the deviations list claimed all six went the strict way. `Edit` requires `old_string` to match, so
the file provably exists.

Now: an empty `new_string` on `Edit`, or on **any** entry of a `MultiEdit`, is destructive and asks.
An empty `new_string` also describes deleting a fragment from a larger file and the two are not
distinguishable from the input alone — so the same trade is made as for `Write`, in the same
direction, for the same reason. The common deletion shape anchors on context
(`"a\nb\nc"` → `"a\nc"`) and stays silent; that case is asserted so the cost stays visible.

## What was built

| File | Lines it owns |
|---|---|
| `src/core/permission-policy.ts` | the §2b table; `permissionVerdict(toolName, input, VaultPaths)` and `containsPath` |
| `src/core/bash-whitelist.ts` | the three-step gate; `bashVerdict`, `tokenizeCommand`, and the two tables |
| `src/core/vault-path-resolver.ts` | `createVaultPaths(root)` — the only part that touches a filesystem |
| `src/core/permission-broker.ts` | changed: takes `vaultRoot`, builds the resolver in `start()`, and decides in `handleRequest` |
| `src/core/session-manager.ts` | changed: one line, hands its own `vaultPath` to the broker |
| `docs/offline-checks.ts` | §N, plus a real temp vault the bridge sections now run against |

The broker answers an `allow` on the socket immediately and logs it; only an `ask` becomes a card.
Nothing else about the transport, the card or the tool card changed.

## The defect §N found, which is the reason the section exists

**`fs.realpathSync` is not `fs.realpathSync.native`, and the difference is a permissive hole.**

Node's JavaScript `realpathSync` starts by calling `path.resolve`, which collapses `..` *lexically*,
before a single symlink has been followed. For `<vault>/escape/../outside/x`, where `escape` is a
symlink pointing out of the vault, it computes `<vault>/outside/x` — a path **inside** the vault —
where the kernel's `realpath(3)` answers `<outside>/x`. `realpathSync.native` calls the latter.

Measured on Node v23.9.0, on this machine:

```
js     THREW ENOENT      (it had already rewritten the path to <vault>/outside/x)
native -> <base>/outside/sibling.txt
```

The first version of the resolver used the JS one. The ancestor walk then climbed to
`<vault>/escape/..`, which the JS version resolved to `<vault>` rather than `<base>`, and the whole
thing read as **inside the vault**. It produced no card and no error — exactly the invisible failure
this phase is about. The check that caught it is
`§N2 ".. is applied after the symlink, not before it"`.

Second, smaller, same shape: the *first* version of that check used `path.join(...)` to build its
fixture, and `join` collapses `..` itself — so it handed the resolver an already-normalised path and
passed against the broken code. Fixtures for a path-resolution test have to be built by string
concatenation. Both facts are in the code comments where someone will hit them.

## Reversion sweep — 35 guards, 35 red

`scratchpad/sweep.py`, one guard at a time, from a **copied** snapshot (`git checkout` restores
nothing for untracked files, and three of the new files are untracked). Every run is classified on
two signals, not one: whether any `FAIL` line appeared **and** whether the run reached its summary
line at all, because a check that dies by crashing is indistinguishable from a check that never ran.

Result after round 2: **35 RED, 0 GREEN, 0 CRASHED**, tree verified byte-identical to the snapshot
at the end (including the NUL byte in `src/ui/tool-card.ts`, trap 27, untouched and still matching
HEAD).

Round 1's 25 (one was superseded in round 2): the metacharacter veto; PLAN's literal metacharacter
list vs the extended one; the glob characters; argv exact match vs first-token match; step 3
entirely; a flag carrying a path; the unbalanced-quote refusal; `containsPath`'s separator; its
root-of-`/` guard; a required path argument going missing; the emptied-`Write` check; the
`NotebookEdit` delete check; the `MultiEdit` malformed-`edits` check; the `.git` exclusion; the
`WebFetch` scheme check; unknown-tool fail-closed; the glob-escape check; the edit path check;
`realpathSync.native`; the `~` refusal; concatenation vs `path.join`; symlink resolution at all; the
broker's fail-closed null resolver; the broker's auto-allow branch being wired in; and the vault
root `SessionManager` hands over.

Round 2 added 10, one per fix and one per state where a fix has states:

| # | Guard reverted | Goes red on |
|---|---|---|
| 27 | F1: the `Edit` emptying branch | `Edit emptying its target asks` |
| 28 | F1: the `MultiEdit` any-entry emptying branch | `MultiEdit with any entry emptying its target asks` |
| 29 | F2: the depth-exhaustion fallback | `a path too deep to walk is not resolved into the vault` — a **real symlink** and a 70-component path |
| 30 | F3: the `try`/`catch` around the policy | `a throwing policy still produces a card` (see the crash note below) |
| 31 | F4: the broker reading the file at all — the **content** state | `the broker read the file before the card existed` |
| 32 | F4: the reader's absent/unknown distinction — the **absent** state | `the reader is told the file does not exist yet` |
| 33 | F4: the `(not read)` label — the **unknown** state | `...it renders as not read` |
| 34 | F4: the parser honouring prior content | `the Before pane holds what is about to be destroyed` |
| 35 | F4: the card's wiring that carries `priorContent` | `the permission card reads the prior content off the item` |
| 36 | D1: `Agent`/`Task` in the allow set | `Agent is silent — its inner calls are carded individually` |

**Honesty about entry 33.** The unknown *state* is proven by 31 and 32, which go red on
`priorContent.kind`. Entry 33 proves the unknown *label*, and it goes red only through a string
comparison of the rendered text — `(empty)` vs `(not read)`. That is a weaker kind of evidence than
the others, and it is also exactly what the reader sees, so it is worth having; it is recorded here
rather than counted as if it were the same thing.

Four entries are worth calling out because they would otherwise look "obviously fine": reverting
**`path.join` for relative paths** goes red on one assertion only; reverting **the broker's
auto-allow branch** goes red only because §N10 drives the whole bridge rather than calling the
policy directly; reverting **the card's wiring** (35) goes red on exactly one assertion, which is
the one that exists because `renderBody` needs a DOM the harness does not have; and **29** needed a
new assertion built specifically for it, because every pre-existing symlink check in §N passes
against the broken code.

## Round 2 — the review and acceptance findings

Four defects, one settled decision, one broken test list. All fixed in this round.

| | What | Where |
|---|---|---|
| **F4** | The approval card rendered `Before: (empty)` for **every** `Write`, including one about to destroy a file with content. The one decision the reader actually sees, shown wrong. | `chat-state.ts` (`PriorContent`), `vault-path-resolver.ts` (the reader), `permission-broker.ts`, `diff-view.ts`, `permission-card.ts` |
| **F1** | `Edit`/`MultiEdit` emptying a file was silently allowed. | `permission-policy.ts` |
| **F2** | `resolveClosest`'s depth fallback called `path.resolve`, reopening the lexical-`..` hole at the back door. | `vault-path-resolver.ts` |
| **F3** | `permissionVerdict` was called unguarded inside the socket handler; a throw means the CLI is never answered. | `permission-broker.ts` |
| **D1** | `Agent`/`Task` moved to allow — measured, see above. | `permission-policy.ts` |
| **T1** | Manual steps 1 and 6 demanded a console line that can never appear. | this file |

### F4, in detail, because it is the one that reached the reader

`Write`'s tool input carries only the new content, and nothing read the file, so `oldText` was never
populated. The fix reads the target **before the card item is created** — synchronously, through
`fs`, not through Obsidian's vault adapter. Both choices are deliberate and both are about the same
thing:

- the adapter is async, so the card would appear first and its Before pane fill in afterwards, and
  the reader can press **Allow** in that window, on a pane that has not resolved yet;
- the adapter only reaches inside the vault, and the paths that produce a card are very often the
  ones *outside* it — exactly where the reader most needs to see what is about to be overwritten.

Three states, and the third is the point: `(empty)` is a claim about the file and is only ever made
when someone looked. `{kind:'absent'}` (no such file — a create) renders `(empty)`, which keeps
steps 2 and 4 correct; `{kind:'unknown'}` (unreadable, a directory, over 512 KB, or never attempted)
renders `(not read)`. It is display only — nothing in `permission-policy.ts` reads a file, which is
what keeps the check-to-write window closed.

The tool card is deliberately untouched: it renders a call that already happened, and
`src/ui/tool-card.ts` is the NUL-byte file (trap 27). `diffFromToolInput`'s default is unchanged, so
its behaviour there is exactly what it was.

## What the acceptance run established, beyond the defects

Four things worth keeping, none of them a code change:

1. **The Bash whitelist's `ask` path is load-bearing; its `allow` path is largely redundant.**
   `cat /etc/hosts` produced a card: the CLI declined to auto-approve it, routed it to us, step 1
   passed, step 2 matched `cat`, and **step 3 returned `ask` on the out-of-vault path**. That is the
   first live proof of the step added on top of Emre's three rules and approved by him on
   2026-08-28 — the `cat ~/.ssh/id_rsa` case, demonstrated. Meanwhile the starting whitelist's own
   entries are the same read-only commands the CLI already resolves itself, so the `allow` branch
   rarely fires. Neither half is a defect; both are worth knowing before anyone "simplifies" the
   whitelist away.
2. **The CLI is more permissive than this policy about what it never forwards — and nothing it
   silently allowed was outside the vault.** In-vault reads and cwd-local read-only Bash pass
   silently; `ls -la /tmp/…`, `Read /etc/hosts` and `cat /etc/hosts` were all forwarded and all
   carded. The CLI's own boundary tracks its cwd, which is the vault root.
3. **The plugin's CLI inherits the vault's `.claude/` configuration, hooks included.** Proof: the
   panel's first output in the run was the vault's `SessionStart` hook banner. All three settings
   layers were checked and none carries a `permissions` key or `defaultMode`, and the one
   `PreToolUse` hook (`Grep|Glob`) returns no permission decision — so there is no interference
   today. **But a `PreToolUse` hook that returned a permission decision would bypass this policy
   silently, and nothing would report it.** PLAN does not account for that path at all.
4. **The startup self-check needs no manual step.** `session-manager.ts:350` blocks input and raises
   a loud notice when `guki-perm` is not connected, so a run that accepted input at all had a
   connected gate.

## Numbers

- `docs/offline-checks.ts`: **349 → 501 → 535** assertions, sections A–N, all green.
- **Reversion sweep: 35 guards, 35 red, 0 green, 0 crashed.** Tree verified byte-identical to the
  snapshot afterwards, `src/ui/tool-card.ts`'s NUL byte included.
- `npm run build` and `npm run lint`: clean. Neither is an acceptance criterion.

### Two things the second sweep exposed about sweeping

- **A reversion that crashes the harness is not a red.** Removing F3's `try`/`catch` made the policy
  throw out of the socket's `data` handler — an *uncaught* exception, which killed the run before
  its summary line, so the first attempt reported `CRASHED`, not `RED`. §N13 now installs a scoped
  `process.on('uncaughtException')` that converts the crash into a reported failure and removes it
  again at the end of the section. Only then did the guard prove itself.
- **Two sweep entries went `PATCH-MISS` because this round's own fixes moved their anchors** — the
  `MultiEdit` malformed-`edits` check and the broker's null-resolver guard. A miss is not a pass,
  and a sweep script that silently stops matching is the same class of problem as a check that never
  ran. Both were repaired and both are red.

## Manual acceptance test — for Emre (round 2)

`npm run build` and `npm run lint` are clean and `docs/offline-checks.ts` is 535/535 green. **None
of that is an acceptance criterion.** Every real bug in five phases passed both — including F4
below, which passed the whole suite while showing the reader a falsehood.

A production build has been run, so `main.js` and `mcp-permission-server.mjs` are current.
**Obsidian must be fully quit with Cmd+Q and reopened** before step 1.

### Which tools reach the bridge, and which never do

Round 1's list demanded a `GuKi Chat: auto-allowed …` console line for an in-vault `Read` and for
`Bash git status`, and **that line can never appear for those tools.** A controlled probe during the
run, console filtered on `GuKi Chat`, one tool per turn:

| Probe | Card | Console line |
|---|---|---|
| `Bash git status` | none | **none** |
| `Read`, in-vault | none | **none** |
| `Edit`, in-vault | none | **present** |

The CLI resolves low-risk calls itself and never forwards them — RESEARCH B5, and PLAN §2b's own
"safety net, not the only defence". For those tools **no card and no log is the correct, healthy
state**, and the round-1 list would have reported two false failures on a clean build.

So the witness rule holds only where the bridge is actually consulted — `Write`, `Edit`,
`MultiEdit`, `Bash` that the CLI declines to resolve, and anything outside the vault. Steps below
say which kind each one is.

| # | Where | Do this | Pass means |
|---|---|---|---|
| 0 | Any text editor | Open `YourVault/.claude/settings.local.json` | No `permissions` key — only `env`. Verified 2026-09-02; re-check only if edited since. An allowlisted tool never reaches our prompt tool, so the policy would look like it works while never being consulted. |
| 1 | Main area | Cmd+Q, reopen, open the chat, ask: *"📥 000-Inbox/Dump klasöründeki dosyaları listele ve içlerinden birini oku"* | **No approval card**, and the answer is correct. **Do not expect a console line** — an in-vault `Read`/`Glob` never reaches the bridge; the CLI resolves it. Silence on both surfaces is the pass. |
| 2 | Main area + console (Cmd+Opt+I) | Ask: *"📥 000-Inbox/Dump klasörüne perm-b-test.md diye bir not oluştur, içine tek satır: merhaba"* | **No card.** The note exists with that content, **and** the console shows `GuKi Chat: auto-allowed Write …`. `Write` does reach the bridge, so here the witness line is required. |
| 3 | Main area + console | Ask: *"aynı nota ikinci bir satır ekle: dünya"* | **No card**, the line is added, console shows `auto-allowed Edit …`. |
| 4 | Main area | Ask: *"/tmp/guki-outside.md diye bir dosya oluştur"* | **A card appears.** Before pane reads `(empty)` — the file does not exist, and that is verified, not assumed. Deny: card reads "Denied. The turn continues.", **no red, no error badge**, and the file does not exist. |
| 5 | Main area | Ask: *"/etc/hosts dosyasını oku"* | **A card appears** — a read outside the vault is still asked about. Deny; same neutral outcome. |
| 6 | Main area | Ask: *"terminalde `git status` ve `ls -la` çalıştır"* | **No card**, and the commands really ran. **No console line expected** — the CLI resolves these itself and they never reach our whitelist. (The whitelist's `allow` path is mostly redundant with the CLI; its `ask` path is what carries the weight — step 7.) |
| 7 | Main area | Ask: *"terminalde `git status; echo merhaba > /tmp/x.txt` çalıştır"* | **A card appears** showing the full command — the metacharacter veto. Deny, and confirm `/tmp/x.txt` was not created. |
| 8 | Main area | Ask: *"bir subagent başlat ve /tmp/agent-test.md'ye yazmasını iste"* | **No card for the `Agent` call itself** — that changed this round. **A card for the subagent's own `Write`**, because inner calls are judged individually. Deny the inner one. |
| 9 | Main area | Ask: *"perm-b-test.md dosyasının içeriğini tamamen sil, boş bırak"* | **A card appears** — emptying a file is destructive. See step 9b for what its Before pane must show. |
| **9b** | **Main area — read the card carefully** | On step 9's card, look at the **Before** pane before answering | **It shows `merhaba` and `dünya`** — the content actually about to be destroyed — and the summary counts them as removed. **This is the F4 fix.** In round 1 this pane read `(empty)`, telling the reader nothing was being lost while the whole file was about to go. `(empty)` here again is a **failure**; `(not read)` means the file could not be read and is a different, honest state. Then Deny, and confirm the note still has both lines. |
| 10 | **Right sidebar** | Drag the panel to the right sidebar and repeat step 4 | The card is legible narrow — path wraps, header not centred, diff panes stack, Allow / Deny two half-width buttons. Regression check on Phase 5a's fixes. |

**Step 11 from round 1 is gone.** It hand-checked that `guki-perm` was `connected`, and that cannot
silently fail: `session-manager.ts:350` blocks input and raises a loud notice when it is not. If any
step above accepted input at all, the gate was connected. Nothing to check by hand.

Re-run **4, 7, 9 and 9b** after any fix. Phase 4's and 5a's second rounds each found more than their
first, and 5a needed three.

## Status

- [x] baseline recorded
- [x] `permission-policy.ts`, `bash-whitelist.ts`, `vault-path-resolver.ts`
- [x] broker wiring + auto-allow logging
- [x] offline checks §N — 535 assertions, A–N green
- [x] reversion sweep — 35/35 red, 0 crashed
- [x] round 2: F1, F2, F3, F4 fixed; D1 settled; T1 test list corrected
- [ ] **Emre's re-run: steps 4, 7, 9, 9b** — the commit waits for it
- [ ] on close: lift the lessons into `NEXT.md`, move this file to `docs/archive/`

### For `NEXT.md` when this closes

- `fs.realpathSync` vs `.native` (the `..`-before-symlink collapse), and the fixture corollary: build
  path fixtures by concatenation, never `path.join`.
- A reversion that crashes the harness reads as neither red nor green — convert the crash.
- A sweep anchor that stops matching after a later fix is a silent hole in the sweep.
- A subagent's "no prompt appeared" self-report is not evidence about gating.
- The CLI never forwards in-vault reads or cwd-local read-only Bash, so "no card **and** no log" is
  the healthy state for those — a test list that demands a witness line for them manufactures
  failures.
- A `PreToolUse` hook in the vault's `.claude/` that returned a permission decision would bypass this
  policy silently. Unaccounted for in PLAN.
