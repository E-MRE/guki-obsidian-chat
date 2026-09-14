# Evidence: Phase 7 / Task 9 / Lane 1 (P7T9-L1)
## Title Storage, Precedence, and the listSessions Overlay

### 1. The Red Run
Before implementing the production logic, stub declarations were created for type-checking and the test suite was run against the unfixed code to observe failures.

Command:
```bash
npm run check:offline
```

Exit code: `1`

Output failure section:
```text
AR. Phase 7 Task 9 Lane 1: Title data layer and listSessions overlay
  ok   AR1.1 malformed null initial data degrades to empty snapshot
  ok   AR1.2 malformed non-object initial data degrades to empty snapshot
  ok   AR1.3 entries missing title degrade to empty
  ok   AR1.4 get returns undefined for non-existent session
  FAIL AR1.5 get returns stored trimmed name — got undefined, want "User Given Name"
  FAIL AR1.6 snapshot contains stored entry — got undefined, want "User Given Name"
  FAIL AR1.7 updatedAt is stamped with current time
  FAIL AR1.8 save callback was called once — got 0, want 1
  FAIL AR1.9 save callback received current snapshot — got undefined, want "User Given Name"
  FAIL AR1.10 mutating snapshot does not affect store — got undefined, want "User Given Name"
  ok   AR1.11 setting empty string removes the entry
  FAIL AR1.12 save callback was called on removal — got 0, want 2
  ok   AR1.13 snapshot after empty set has no session-1
  FAIL AR1.14 entry re-added — got undefined, want "Temp Title"
  ok   AR1.15 setting whitespace-only string removes the entry
  ok   AR1.16 remove method deletes entry
  FAIL AR1.17 remove calls save callback when entry was present — got 0, want 1
  ok   AR1.18 remove does not call save when nothing was deleted
  FAIL AR1.19 pruneTo returns true when entries were dropped — got false, want true
  ok   AR1.20 dropped entry removed from store
  FAIL AR1.21 kept entry 1 remains — got undefined, want "Keep 1"
  FAIL AR1.22 kept entry 2 remains — got undefined, want "Keep 2"
  FAIL AR1.23 pruneTo called save callback once — got 0, want 1
  ok   AR1.24 pruneTo returns false when nothing removed
  ok   AR1.25 pruneTo does not call save when nothing changed
  FAIL AR2.1 custom+ai precedence: custom wins text — got "stub", want "My Custom Name"
  FAIL AR2.2 custom+ai precedence: source is custom — got "none", want "custom"
  FAIL AR2.3 panelTitleFor returns custom title — got "stub", want "My Custom Name"
  FAIL AR2.4 sessionDisplayTitle on custom returns text — got "AI Given Title", want "My Custom Name"
  ok   AR2.5 sessionDisplayTitle on custom isDerived is false
  FAIL AR2.6 custom+derived precedence: custom wins text — got "stub", want "Renamed Project"
  FAIL AR2.7 custom+derived precedence: source is custom — got "none", want "custom"
  FAIL AR2.8 panelTitleFor on custom+derived returns custom title — got "stub", want "Renamed Project"
  FAIL AR2.9 ai-only precedence: ai title wins text — got "stub", want "Claude AI Generated Title"
  FAIL AR2.10 ai-only precedence: source is ai — got "none", want "ai"
  FAIL AR2.11 panelTitleFor on ai returns ai title — got "stub", want "Claude AI Generated Title"
  ok   AR2.12 sessionDisplayTitle on ai returns text
  ok   AR2.13 sessionDisplayTitle on ai isDerived is false
  FAIL AR2.14 derived-only precedence: derived text wins — got "stub", want "Help me fix the compiler error"
  FAIL AR2.15 derived-only precedence: source is derived — got "none", want "derived"
  FAIL AR2.16 panelTitleFor on derived returns null (never show trim in header) — got "stub", want null
  ok   AR2.17 sessionDisplayTitle on derived returns text
  ok   AR2.18 sessionDisplayTitle on derived isDerived is true
  FAIL AR2.19 none precedence: text is Untitled session — got "stub", want "Untitled session"
  ok   AR2.20 none precedence: source is none
  FAIL AR2.21 panelTitleFor on none returns null — got "stub", want null
  FAIL AR2.22 panelTitleFor on null returns null — got "stub", want null
  FAIL AR2.23 panelTitleFor on undefined returns null — got "stub", want null
  ok   AR2.24 sessionDisplayTitle on none returns null
  FAIL AR3.1 shapeSessionRow uses customTitle when present — got "AI Title", want "Manual Session Title"
  ok   AR3.2 shapeSessionRow isDerivedTitle is false for customTitle
  ok   AR3.3 derived trim is absent from row title
  ok   AR3.4 shapeSessionRow uses AI title when customTitle absent
  ok   AR3.5 shapeSessionRow isDerivedTitle is false for AI title
  ok   AR3.6 shapeSessionRow uses derivedTitle when both custom and ai absent
  ok   AR3.7 shapeSessionRow isDerivedTitle is true for derivedTitle
  ok   AR3.8 shapeSessionRow falls back to Untitled session
  ok   AR3.9 shapeSessionRow isDerivedTitle is false for Untitled session
  ok   AR4.1 scanned sessions count is 1
  ok   AR4.2 scanned session title is aiTitle
  ok   AR4.3 scanSessionsDir NEVER sets customTitle
  ok   AR5.1 listSessions returned two scanned sessions
  FAIL AR5.2 live-1 has customTitle overlaid from store — got undefined, want "Custom One"
  ok   AR5.3 live-2 without customTitle has customTitle undefined
  ok   AR5.4 dead-session was pruned from titleStore
  FAIL AR5.5 live-1 survived in titleStore — got undefined, want "Custom One"
  FAIL AR5.6 save callback called once on scan pruning dead entry — got 0, want 1
  ok   AR5.7 saved map does not contain dead-session
  FAIL AR5.8 saved map contains live-1 — got undefined, want "Custom One"
  ok   AR5.9 empty scan returned 0 sessions
  ok   AR5.10 prune safety invariant: save callback was NOT called on zero sessions scan
  FAIL AR5.11 stored titles survive empty scan — got undefined, want "Custom One"
  ok   AR6.1 loadSettings restores conversationTitles
  ok   AR6.2 loadSettings preserves claudeBinaryPath
  ok   AR6.3 loadSettings preserves slashCommands
  FAIL AR6.4 plugin created titleStore

37 CHECK(S) FAILED
```

After implementing all production modules per contract, the same checks pass:
Command:
```bash
npm run check:offline
```
Exit code: `0`

Passing section output:
```text
AR. Phase 7 Task 9 Lane 1: Title data layer and listSessions overlay
  ok   AR1.1 malformed null initial data degrades to empty snapshot
  ok   AR1.2 malformed non-object initial data degrades to empty snapshot
  ok   AR1.3 entries missing title degrade to empty
  ok   AR1.4 get returns undefined for non-existent session
  ok   AR1.5 get returns stored trimmed name
  ok   AR1.6 snapshot contains stored entry
  ok   AR1.7 updatedAt is stamped with current time
  ok   AR1.8 save callback was called once
  ok   AR1.9 save callback received current snapshot
  ok   AR1.10 mutating snapshot does not affect store
  ok   AR1.11 setting empty string removes the entry
  ok   AR1.12 save callback was called on removal
  ok   AR1.13 snapshot after empty set has no session-1
  ok   AR1.14 entry re-added
  ok   AR1.15 setting whitespace-only string removes the entry
  ok   AR1.16 remove method deletes entry
  ok   AR1.17 remove calls save callback when entry was present
  ok   AR1.18 remove does not call save when nothing was deleted
  ok   AR1.19 pruneTo returns true when entries were dropped
  ok   AR1.20 dropped entry removed from store
  ok   AR1.21 kept entry 1 remains
  ok   AR1.22 kept entry 2 remains
  ok   AR1.23 pruneTo called save callback once
  ok   AR1.24 pruneTo returns false when nothing removed
  ok   AR1.25 pruneTo does not call save when nothing changed
  ok   AR2.1 custom+ai precedence: custom wins text
  ok   AR2.2 custom+ai precedence: source is custom
  ok   AR2.3 panelTitleFor returns custom title
  ok   AR2.4 sessionDisplayTitle on custom returns text
  ok   AR2.5 sessionDisplayTitle on custom isDerived is false
  ok   AR2.6 custom+derived precedence: custom wins text
  ok   AR2.7 custom+derived precedence: source is custom
  ok   AR2.8 panelTitleFor on custom+derived returns custom title
  ok   AR2.9 ai-only precedence: ai title wins text
  ok   AR2.10 ai-only precedence: source is ai
  ok   AR2.11 panelTitleFor on ai returns ai title
  ok   AR2.12 sessionDisplayTitle on ai returns text
  ok   AR2.13 sessionDisplayTitle on ai isDerived is false
  ok   AR2.14 derived-only precedence: derived text wins
  ok   AR2.15 derived-only precedence: source is derived
  ok   AR2.16 panelTitleFor on derived returns null (never show trim in header)
  ok   AR2.17 sessionDisplayTitle on derived returns text
  ok   AR2.18 sessionDisplayTitle on derived isDerived is true
  ok   AR2.19 none precedence: text is Untitled session
  ok   AR2.20 none precedence: source is none
  ok   AR2.21 panelTitleFor on none returns null
  ok   AR2.22 panelTitleFor on null returns null
  ok   AR2.23 panelTitleFor on undefined returns null
  ok   AR2.24 sessionDisplayTitle on none returns null
  ok   AR3.1 shapeSessionRow uses customTitle when present
  ok   AR3.2 shapeSessionRow isDerivedTitle is false for customTitle
  ok   AR3.3 derived trim is absent from row title
  ok   AR3.4 shapeSessionRow uses AI title when customTitle absent
  ok   AR3.5 shapeSessionRow isDerivedTitle is false for AI title
  ok   AR3.6 shapeSessionRow uses derivedTitle when both custom and ai absent
  ok   AR3.7 shapeSessionRow isDerivedTitle is true for derivedTitle
  ok   AR3.8 shapeSessionRow falls back to Untitled session
  ok   AR3.9 shapeSessionRow isDerivedTitle is false for Untitled session
  ok   AR4.1 scanned sessions count is 1
  ok   AR4.2 scanned session title is aiTitle
  ok   AR4.3 scanSessionsDir NEVER sets customTitle
  ok   AR5.1 listSessions returned two scanned sessions
  ok   AR5.2 live-1 has customTitle overlaid from store
  ok   AR5.3 live-2 without customTitle has customTitle undefined
  ok   AR5.4 dead-session was pruned from titleStore
  ok   AR5.5 live-1 survived in titleStore
  ok   AR5.6 save callback called once on scan pruning dead entry
  ok   AR5.7 saved map does not contain dead-session
  ok   AR5.8 saved map contains live-1
  ok   AR5.9 empty scan returned 0 sessions
  ok   AR5.10 prune safety invariant: save callback was NOT called on zero sessions scan
  ok   AR5.11 stored titles survive empty scan
  ok   AR6.1 loadSettings restores conversationTitles
  ok   AR6.2 loadSettings preserves claudeBinaryPath
  ok   AR6.3 loadSettings preserves slashCommands
  ok   AR6.4 plugin created titleStore
  ok   AR6.5 saveData was called with whole settings object
  ok   AR6.6 saved data has newly added title
  ok   AR6.7 saved data preserves claudeBinaryPath
  ok   AR6.8 saved data preserves slashCommands
  ok   AR6.9 saved data preserves permissionMode

ALL CHECKS PASSED
```

---

### 2. Full Final `npm run check:offline` Tail
Command:
```bash
npm run check:offline
```
Exit code: `0`

Assertion count:
Baseline: 1858 assertions
After Lane 1: 1939 assertions (81 new assertions, 0 failures, 1858 existing assertions untouched)

Output tail:
```text
  ok   AR5.9 empty scan returned 0 sessions
  ok   AR5.10 prune safety invariant: save callback was NOT called on zero sessions scan
  ok   AR5.11 stored titles survive empty scan
  ok   AR6.1 loadSettings restores conversationTitles
  ok   AR6.2 loadSettings preserves claudeBinaryPath
  ok   AR6.3 loadSettings preserves slashCommands
  ok   AR6.4 plugin created titleStore
  ok   AR6.5 saveData was called with whole settings object
  ok   AR6.6 saved data has newly added title
  ok   AR6.7 saved data preserves claudeBinaryPath
  ok   AR6.8 saved data preserves slashCommands
  ok   AR6.9 saved data preserves permissionMode

ALL CHECKS PASSED
```

---

### 3. Full Gate: `npm test` and `npm run build`
Command:
```bash
npm test
```
Exit code: `0`

Output tail:
```text
  ok   AR5.9 empty scan returned 0 sessions
  ok   AR5.10 prune safety invariant: save callback was NOT called on zero sessions scan
  ok   AR5.11 stored titles survive empty scan
  ok   AR6.1 loadSettings restores conversationTitles
  ok   AR6.2 loadSettings preserves claudeBinaryPath
  ok   AR6.3 loadSettings preserves slashCommands
  ok   AR6.4 plugin created titleStore
  ok   AR6.5 saveData was called with whole settings object
  ok   AR6.6 saved data has newly added title
  ok   AR6.7 saved data preserves claudeBinaryPath
  ok   AR6.8 saved data preserves slashCommands
  ok   AR6.9 saved data preserves permissionMode

ALL CHECKS PASSED
```

Command:
```bash
npm run build
```
Exit code: `0`

Output:
```text
> guki-chat@0.1.0 build
> tsc -noEmit -skipLibCheck && node esbuild.config.mjs production
```

---

### 4. File Ledger

`git status --short`:
```text
 M docs/offline-checks.ts
 M src/data/session-index.ts
 M src/data/transcript-store.ts
 M src/main.ts
 M src/ui/chat-view.ts
 M src/ui/history-dropdown.ts
 M src/ui/settings-tab.ts
?? .claude/
?? .orchestration/evidence/L1/
?? .orchestration/lanes/L1-title-data-layer.md
?? src/data/conversation-titles.ts
```

`git diff --stat`:
```text
 docs/offline-checks.ts       | 313 +++++++++++++++++++++++++++++++++++++++++++
 src/data/session-index.ts    |  50 +++++--
 src/data/transcript-store.ts |  24 +++-
 src/main.ts                  |  19 ++-
 src/ui/chat-view.ts          |  14 +-
 src/ui/history-dropdown.ts   |  16 +--
 src/ui/settings-tab.ts       |   2 +
 7 files changed, 414 insertions(+), 24 deletions(-)
```

Untracked files created by this lane:
- `src/data/conversation-titles.ts`
- `.orchestration/evidence/L1/EVIDENCE.md`
