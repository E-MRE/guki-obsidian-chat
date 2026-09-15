# Evidence: Phase 7 / Task 9 / Lane 2 (P7T9-L2)
## Manual Rename in the History List

### 1. The Red Run
Before implementing the UI changes in `src/ui/history-dropdown.ts`, `src/ui/chat-view.ts`, and `styles.css`, Section AS checks were written and added to `docs/offline-checks.ts`. Running `npm run check:offline` against the unfixed code produced 33 failing assertions as expected.

Command:
```bash
npm run check:offline
```

Exit code: `1`

Output failure section:
```text
AS. Phase 7 Task 9 Lane 2: Manual rename in the history list
  ok   AS1.1 rendered row count is 2
  FAIL AS1.2 first row has pencil rename button
  FAIL AS1.3 second row has pencil rename button
  ok   AS1.4 clicking pencil does not trigger session selection
  ok   AS1.5 dropdown remains open after clicking pencil
  FAIL AS2.1 clicking pencil opened input in first row
  FAIL AS2.2 input is pre-filled with current row name — got undefined, want "CLI Title 1"
  FAIL AS2.3 input selection starts at 0 — got undefined, want 0
  FAIL AS2.4 input selection covers full title length — got undefined, want 11
  FAIL AS3.1 ArrowDown while input open does not advance selection — got 1, want 0
  ok   AS3.2 ArrowUp while input open does not change selection
  FAIL AS4.1 dropdown remains open across Enter save
  FAIL AS4.2 row item title updated to custom name — got undefined, want "My Custom Session Name"
  FAIL AS4.3 row item is NOT marked derived — got undefined, want false
  FAIL AS4.4 titleStore snapshot contains new custom title — got undefined, want "My Custom Session Name"
  FAIL AS4.5 saveData was called with full settings object
  FAIL AS4.6 saveData preserved claudeBinaryPath — got undefined, want "/custom/claude"
  FAIL AS4.7 saveData stored new title in conversationTitles — got undefined, want "My Custom Session Name"
  FAIL AS4.8 DOM row element displays updated title
  FAIL AS4.9 input element removed after save
  FAIL AS5.1 second row input opened
  FAIL AS5.2 second row input pre-filled with derived title — got undefined, want "Derived Prompt 2"
  FAIL AS5.3 dropdown remains open across Escape cancel
  FAIL AS5.4 row item retains original derived title — got undefined, want "Derived Prompt 2"
  FAIL AS5.5 row item retains derived status — got undefined, want true
  ok   AS5.6 titleStore does NOT contain canceled edit
  FAIL AS5.7 input element removed after Escape
  FAIL AS5.8 DOM row displays original derived title
  FAIL AS6.1 dropdown remains open after blur save
  FAIL AS6.2 titleStore contains name saved via blur — got undefined, want "Saved By Blur"
  FAIL AS6.3 row item displays name saved via blur — got undefined, want "Saved By Blur"
  FAIL AS6.4 name saved via blur is NOT marked derived — got undefined, want false
  ok   AS7.1 whitespace save removes entry from titleStore
  FAIL AS7.2 row falls back to CLI title — got undefined, want "CLI Title 1"
  FAIL AS7.3 CLI title fallback is NOT marked derived — got undefined, want false
  FAIL AS7.4 dropdown stays open after removing custom name
  ok   AS7.5 empty save removes entry from titleStore
  FAIL AS7.6 row falls back to derived prompt trim — got undefined, want "Derived Prompt 2"
  FAIL AS7.7 derived trim fallback IS marked derived — got undefined, want true
  FAIL AS7.8 dropdown stays open after empty save
  ok   AS8.1 view has history dropdown
  ok   AS8.2 ChatView passes titleStore to HistoryDropdown

33 CHECK(S) FAILED
```

After implementing inline editing, keyboard interception, blur/Enter save, Escape cancel, fallback resolution, and CSS styling:
Command:
```bash
npm run check:offline
```

Exit code: `0`

Passing section output:
```text
AS. Phase 7 Task 9 Lane 2: Manual rename in the history list
  ok   AS1.1 rendered row count is 2
  ok   AS1.2 first row has pencil rename button
  ok   AS1.3 second row has pencil rename button
  ok   AS1.4 clicking pencil does not trigger session selection
  ok   AS1.5 dropdown remains open after clicking pencil
  ok   AS2.1 clicking pencil opened input in first row
  ok   AS2.2 input is pre-filled with current row name
  ok   AS2.3 input selection starts at 0
  ok   AS2.4 input selection covers full title length
  ok   AS3.1 ArrowDown while input open does not advance selection
  ok   AS3.2 ArrowUp while input open does not change selection
  ok   AS4.1 dropdown remains open across Enter save
  ok   AS4.2 row item title updated to custom name
  ok   AS4.3 row item is NOT marked derived
  ok   AS4.4 titleStore snapshot contains new custom title
  ok   AS4.5 saveData was called with full settings object
  ok   AS4.6 saveData preserved claudeBinaryPath
  ok   AS4.7 saveData stored new title in conversationTitles
  ok   AS4.8 DOM row element displays updated title
  ok   AS4.9 input element removed after save
  ok   AS5.1 second row input opened
  ok   AS5.2 second row input pre-filled with derived title
  ok   AS5.3 dropdown remains open across Escape cancel
  ok   AS5.4 row item retains original derived title
  ok   AS5.5 row item retains derived status
  ok   AS5.6 titleStore does NOT contain canceled edit
  ok   AS5.7 input element removed after Escape
  ok   AS5.8 DOM row displays original derived title
  ok   AS6.1 dropdown remains open after blur save
  ok   AS6.2 titleStore contains name saved via blur
  ok   AS6.3 row item displays name saved via blur
  ok   AS6.4 name saved via blur is NOT marked derived
  ok   AS7.1 whitespace save removes entry from titleStore
  ok   AS7.2 row falls back to CLI title
  ok   AS7.3 CLI title fallback is NOT marked derived
  ok   AS7.4 dropdown stays open after removing custom name
  ok   AS7.5 empty save removes entry from titleStore
  ok   AS7.6 row falls back to derived prompt trim
  ok   AS7.7 derived trim fallback IS marked derived
  ok   AS7.8 dropdown stays open after empty save
  ok   AS8.1 view has history dropdown
  ok   AS8.2 ChatView passes titleStore to HistoryDropdown

ALL CHECKS PASSED
```

---

### 2. Final Check Tail and Assertion Count

Command:
```bash
npm run check:offline
```
Exit code: `0`

Assertion count:
- Baseline before L2: 1941 assertions
- After L2: 1983 assertions (42 new assertions, 0 failures, 1941 baseline assertions green and untouched)

Output tail:
```text
  ok   AS7.1 whitespace save removes entry from titleStore
  ok   AS7.2 row falls back to CLI title
  ok   AS7.3 CLI title fallback is NOT marked derived
  ok   AS7.4 dropdown stays open after removing custom name
  ok   AS7.5 empty save removes entry from titleStore
  ok   AS7.6 row falls back to derived prompt trim
  ok   AS7.7 derived trim fallback IS marked derived
  ok   AS7.8 dropdown stays open after empty save
  ok   AS8.1 view has history dropdown
  ok   AS8.2 ChatView passes titleStore to HistoryDropdown

ALL CHECKS PASSED
```

Command:
```bash
npm test
```
Exit code: `0`

Output tail:
```text
  ok   AS7.1 whitespace save removes entry from titleStore
  ok   AS7.2 row falls back to CLI title
  ok   AS7.3 CLI title fallback is NOT marked derived
  ok   AS7.4 dropdown stays open after removing custom name
  ok   AS7.5 empty save removes entry from titleStore
  ok   AS7.6 row falls back to derived prompt trim
  ok   AS7.7 derived trim fallback IS marked derived
  ok   AS7.8 dropdown stays open after empty save
  ok   AS8.1 view has history dropdown
  ok   AS8.2 ChatView passes titleStore to HistoryDropdown

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

### 3. File Ledger

`git status --short` verbatim:
```text
 M docs/offline-checks.ts
 M src/ui/chat-view.ts
 M src/ui/history-dropdown.ts
 M styles.css
?? .claude/
?? .orchestration/evidence/L1/lane.err
?? .orchestration/evidence/L1/lane.json
?? .orchestration/evidence/L2/
?? .orchestration/evidence/V1/
?? .orchestration/lanes/L1-title-data-layer.md
?? .orchestration/lanes/L2-rename-ui.md
?? .orchestration/lanes/V1-verify-data-layer.md
```

`git diff --stat` verbatim:
```text
 docs/offline-checks.ts     | 186 +++++++++++++++++++++++++++++++++++++++
 src/ui/chat-view.ts        |   1 +
 src/ui/history-dropdown.ts | 208 ++++++++++++++++++++++++++++++++++++++++-----
 styles.css                 |  51 +++++++++++
 4 files changed, 426 insertions(+), 20 deletions(-)
```

---

### 4. `docs/obsidian-stub.mjs` Modifications
`docs/obsidian-stub.mjs` was NOT modified. The stub already provides `setIcon()` and `FakeElement` in `docs/offline-checks.ts` supports all required DOM interfaces (`setSelectionRange`, `value`, `focus`, `blur`, `click`, `contains`). Existing check behavior is 100% unaffected.
