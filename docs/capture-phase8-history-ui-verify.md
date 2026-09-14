# Independent Verification Report: Görev 8 Conversation History UI & Title Fallback

**Date:** 2026-09-14  
**Verifier:** Independent Verification Agent (Fresh Context)  
**Base Commit:** `c4eecf2` (`feat: resolve the active branch of an on-disk transcript, streaming`)  
**Code Under Review:** Working tree additions:
- `src/data/session-index.ts` (Title fallback, user record prompt extraction, origin rules)
- `src/ui/history-dropdown.ts` (History list dropdown component, keyboard navigation)
- `src/ui/chat-view.ts` (Seam integration, header action trigger, session selection event)
- `styles.css` (History dropdown, row item, typography, and empty state styling)
- `docs/scrub-capture.py` (Explicit skipped reporting for gitignored files)
- `docs/offline-checks.ts` (Section AJ: 59 checks across title fallback, UI shaping, keyboard handling, and scrub reporting)

---

## 1. Executive Summary & Verdict

### Overall Verdict: **`PASS`**

The implementation under review successfully delivers the core requirements for Phase 8 Görev 8:
1. **Title Fallback (`src/data/session-index.ts`):** Evaluated against 279 real session files across 5 project directories under `~/.claude/projects/`. 157 sessions (56.3%) resolved genuine `ai-title` records; 122 sessions (43.7%) resolved derived titles from user prompt text; 0 sessions produced empty, whitespace-only, or broken titles. Caller distinction between genuine `ai-title` and derived fallback is preserved through distinct summary properties (`title` vs `derivedTitle`) and the helper `sessionDisplayTitle`.
2. **History List UI (`src/ui/history-dropdown.ts` & `src/ui/chat-view.ts`):** Dropdown renders sessions newest-first preserving index order without re-sorting. Sessions lacking cost data render deliberately without layout disruption or empty badges. The empty state renders a clean notice. Session selection emits through `ChatView.onSessionSelected` without reaching into internal view components. Keyboard navigation (`ArrowDown`, `ArrowUp`, `Enter`, `Tab`, `Escape`) matches the existing `ComposerDropdown` key-for-key.
3. **Large-List Performance (Measured):** Shaping 500 rows takes 0.18 ms; full DOM generation takes 1.56 ms (total 1.75 ms). Row elements utilize CSS `content-visibility: auto; contain-intrinsic-size: 0 32px;` to avoid layout stalls in Chromium.
4. **Scrub Gitignore Reporting (`docs/scrub-capture.py`):** Gitignored files now explicitly report `{path}: skipped` with exit code 0. Clean and dirty paths maintain byte-identical output to `HEAD:docs/scrub-capture.py`.
5. **Test Suite Expansion & Integrity:** Check count increased from 1,556 to 1,615 (+59 checks). An independent fault injection (reversing dropdown list ordering) failed 4 checks, confirming tests actively guard the functionality.
6. **Findings Identified:** Five non-blocking findings are documented below:
   - *F1 (Defect / Assumption):* `r.toolUseResult === true` assumes a boolean type, whereas in real transcripts `toolUseResult` is an object/dict on ~88% of records and boolean `true` on 0%.
   - *F2 (Logic Quirk):* When the first user prompt lacks origin metadata and a subsequent turn contains explicit human origin metadata, the later turn is chosen as `firstHumanText`, overriding the first user prompt.
   - *F3 (Quality / Edge Case):* `isMeta: true` records are not excluded, causing 7 real sessions to derive titles from metadata prompts.
   - *F4 (Citation Mismatch):* The lane's handoff cited §4g of `docs/capture-phase8-transcript-schema.md` for the 4.9% human prompt statistic; §4g documents file sizes and paging. The actual statistic is in §1.3.
   - *F5 (Scope Claim Discrepancy):* The lane claimed "scope deviations: none", but `styles.css` received +74 lines.

---

## 2. Per-Check Verdict Table

| Check ID | Requirement | Verdict | Summary of Evidence & Findings |
|---|---|---|---|
| **V1** | Title Fallback Against Real Sessions | **PASS** *(with findings)* | Tested against 279 real session files across 5 project directories under `~/.claude/projects/`. 157 real `ai-title` (56.3%), 122 derived titles (43.7%), 0 none (0.0%). Structural quality: 0 empty, 0 whitespace-only, lengths min=2, median=46, mean=35.9, max=60. 57 capped at 60. Findings: `r.toolUseResult === true` type mismatch; unhandled `isMeta: true` (7 sessions); later human turn override (2 sessions). |
| **V2** | Origin Rule Evidence | **PASS** *(with finding)* | §4g of `docs/capture-phase8-transcript-schema.md` documents "Practical File Sizes & Paging Decision", not user origin. The 4.9% statistic is documented in §1.3. Independent measurement of 15,283+ user records confirms human prompts are ~8.9%–10.5% and tool results are ~84%–88%, validating that the rule's premise is sound. |
| **V3** | Real vs Derived Distinction | **PASS** | `SessionSummary` explicitly separates `title` and `derivedTitle`. `sessionDisplayTitle` returns `{ text, isDerived } \| null`. `shapeSessionRow` sets `isDerivedTitle: boolean`. In the UI, `.is-derived` has a tooltip, but lacks special CSS rules, maintaining visual uniformity. |
| **V4** | Independent Edge Cases | **PASS** | 12 fresh scenarios with 34 assertions executed independently: `ai-title` present/absent, strings vs block arrays, non-text block filtering, tool results, compaction summaries, synthetic origin, whitespace/newlines, over-length capping, missing user records, and real dict-style tool results. 34 passed, 0 failed. |
| **V5** | UI Verification (Headless) | **PASS** | Newest-first order preserved from session scanner; missing cost rows render deliberately; clean empty state rendered; selection emitted via `onSessionSelected`; Escape closes; keyboard navigation matches `src/ui/composer-dropdown.ts`. Obsidian-dependent items documented for human review. |
| **V6** | Large-List Performance (Measured) | **PASS** | Measured execution times: N=100 (1.05 ms), N=300 (1.49 ms), N=500 (1.75 ms), N=1000 (2.03 ms). DOM rendering takes <1.7 ms for 1,000 rows. CSS `content-visibility: auto; contain-intrinsic-size: 0 32px;` offloads off-screen layout/painting in Chromium. |
| **V7** | Scrub Change (Both Directions) | **PASS** | Gitignored files report `skipped` with exit 0. Clean files report `clean` with exit 0, byte-identical to HEAD. Dirty files report `DIRTY` with field details and exit 1, byte-identical to HEAD. Combined runs exit 0 for clean+skipped, 1 for dirty+skipped. |
| **V8** | Scope and Honesty | **PASS** *(with finding)* | Finding: Lane reported "scope deviations: none", but `styles.css` is modified (+74 lines). Legitimate minimal consequence of UI, but an unacknowledged diff. Verified untouched: `stream-reducer.ts`, `disk-transcript-loader.ts`, `readSession`, `--resume`, historical conversation redraw. Check count: 1,556 $\rightarrow$ 1,615 (+59 checks). |
| **V9** | Fault Injection (Break It Somewhere Else) | **PASS** | Inverted list ordering in `HistoryDropdown.openDropdown` with `.reverse()`. 4 offline checks failed (AJ2.12, AJ2.14, AJ2.16, AJ2.17). Restored cleanly; all 1,615 checks passed. Working tree clean. |

---

## 3. Detailed Verification Results

### V1: Title Fallback Against Real Sessions

#### Sampling and Distribution
The real scanner (`scanSessionsDir`) was run across 5 real project directories under `~/.claude/projects/` representing 279 total session files:

| Project Directory Alias | Total Sessions | Real `ai-title` | Derived Title | No Title |
|---|---|---|---|---|
| `~-Documents-EmreOS` | 154 | 89 (57.8%) | 65 (42.2%) | 0 (0.0%) |
| `~-Documents-otherprojects-draftcv` | 36 | 19 (52.8%) | 17 (47.2%) | 0 (0.0%) |
| `~-Documents-flutterprojects-doclyvo` | 36 | 25 (69.4%) | 11 (30.6%) | 0 (0.0%) |
| `~-Documents-otherprojects-sift` | 29 | 4 (13.8%) | 25 (86.2%) | 0 (0.0%) |
| `~-Documents-otherprojects-guki-obsidian-chat` | 24 | 20 (83.3%) | 4 (16.7%) | 0 (0.0%) |
| **Total** | **279** | **157 (56.3%)** | **122 (43.7%)** | **0 (0.0%)** |

#### Structural Quality Analysis (Derived Titles, N = 122)
- **Empty strings (length 0):** 0 (0.0%)
- **Whitespace-only:** 0 (0.0%)
- **Length Distribution:**
  - Length < 5 chars: 11 (9.0%)
  - Length 5–9 chars: 25 (20.5%)
  - Length 10–30 chars: 18 (14.8%)
  - Length 31–59 chars: 11 (9.0%)
  - Length == 60 chars (capped at `MAX_DERIVED_TITLE_LENGTH`): 57 (46.7%)
  - Length > 60 chars: 0 (0.0%)
  - Summary metrics: Min = 2 chars, Median = 46 chars, Mean = 35.9 chars, Max = 60 chars.
- **Short Titles (<10 chars, N = 36):**
  - Structural check reveals 29 are single words and 7 are two words (such as concise initial command names, questions, or test keywords).
- **Quality Findings:**
  1. *Tool Result Type Mismatch (Finding F1):* `extractUserPromptText` and `isSyntheticUser` check `r.toolUseResult === true`. Inspection of 18,714 real user records shows `toolUseResult` is present on 15,678 records (83.8%), but its value is a JSON object (`dict`), string, or array—never a boolean `true`. Fortunately, `extractUserPromptText` does not extract text from these because real tool result records contain blocks with `type: "tool_result"` (which the `type === "text"` check ignores). However, the explicit boolean guard `r.toolUseResult === true` is ineffective dead code against real on-disk records.
  2. *Unhandled Metadata Prompts (Finding F3):* 7 real sessions derived titles from records marked `isMeta: true` because `session-index.ts` does not check the `isMeta` field. An additional 8 sessions derived titles from XML-wrapped system prompts (e.g. `<instructions>...`).
  3. *Later Turn Override (Finding F2):* In `buildSessionSummary`:
     ```typescript
     if (isExplicitHumanUser(r)) {
         firstHumanText ??= text;
     } else if (!isSyntheticUser(r)) {
         firstCandidateText ??= text;
     }
     // ...
     const candidateText = firstHumanText ?? firstCandidateText;
     ```
     If Turn 1 has no `origin` metadata (common in earlier CLI sessions or direct CLI invocations), it is stored as `firstCandidateText`. If Turn 2 or Turn 3 was typed in the CLI with `origin: {kind: "human"}`, it is stored as `firstHumanText`. Because `firstHumanText` takes precedence over `firstCandidateText`, the later turn's prompt displaces the first user message. This occurred in 2 real sessions.

---

### V2: The Origin Rule's Evidence

#### Citation Verification
The lane's handoff documentation cited `docs/capture-phase8-transcript-schema.md` §4g as the source for the finding that "human prompts are ~4.9% of user records".
- Inspection of `docs/capture-phase8-transcript-schema.md` reveals:
  - **§4g:** Titled `### g) Practical File Sizes & Paging Decision`. It contains a table of Min/Median/Mean/Max bytes and lines across the corpus and discusses stream parsing vs pagination. It contains no statistics on user record origins.
  - **§1.3:** Titled `### 1.3 Top-Level Field Distribution per Record Type`. Under `2. user (total 648)`, it explicitly documents: `origin (4.9%), promptSource (4.8%), permissionMode (4.8%)`.
- **Finding (F4):** The handoff narrative attributed the statistic to §4g instead of §1.3. (The source code comment in `src/data/session-index.ts` line 96 correctly references §1.3).

#### Independent Measurement of the Rule
To verify whether the rule's human-preference principle is empirically justified, 15,283 user records across 285 session files were analyzed:
- Total user records: 15,283
- Records with `origin.kind == 'human'`: 1,610 (10.5%)
- Records with `promptSource == 'typed'`: 1,265 (8.3%)
- Records with `toolUseResult` (present / truthy): 12,807 (83.8%)
- Records with `isCompactSummary == true`: 22 (0.1%)
- Records with no `origin` field: 13,500 (88.3%)
- **Conclusion:** The core premise of the rule is valid. Genuine human prompts represent ~9%–11% of user records on disk; the vast majority (>83%) are tool results or automated summaries. Prioritizing human-origin prompts over synthetic/tool records is necessary to prevent tool outputs from becoming session titles.

---

### V3: Real vs Derived Distinction

#### Consumer Visibility
In `src/data/session-index.ts`:
- `SessionSummary` explicitly separates `title?: string` (genuine `ai-title`) and `derivedTitle?: string` (fallback prompt title). A consumer can check `summary.title !== undefined` to identify a real title with zero string heuristics.
- `sessionDisplayTitle(summary)` returns `{ text: string; isDerived: boolean } | null`, providing an explicit boolean discriminator.
- `shapeSessionRow(summary)` returns `HistoryRowItem` containing `isDerivedTitle: boolean`.

#### UI Presentation Analysis
In `src/ui/history-dropdown.ts`:
- Elements are created as:
  ```typescript
  const titleEl = itemEl.createSpan({
      cls: 'guki-history-title' + (item.isDerivedTitle ? ' is-derived' : ''),
      text: item.title,
  });
  if (item.isDerivedTitle) {
      titleEl.setAttribute('title', `Derived: ${item.title}`);
  }
  ```
- **Consequence Check:**
  - The DOM element receives the class `is-derived` and a native tooltip attribute `title="Derived: ..."`.
  - In `styles.css`, there are no specific CSS rules targeting `.is-derived`. Visually, real titles and derived titles render identically in font size, weight, and color.
  - When neither `title` nor `derivedTitle` exists, `shapeSessionRow` falls back to `"Untitled session"`. This maintains a readable label in the UI while `SessionSummary.title` and `derivedTitle` remain `undefined`.

---

### V4: Independent Edge Case Suite

A standalone test suite (`v4_edge_cases.ts`) was executed with 12 freshly authored scenarios. All 34 assertions passed:

```
PASS: C1 s1 exists
PASS: C1 s1 title is authentic ai-title
PASS: C1 s1 derivedTitle is undefined
PASS: C1 s1 sessionDisplayTitle isDerived is false
PASS: C1 s1 sessionDisplayTitle text matches ai-title
PASS: C2 s2 exists
PASS: C2 s2 title is undefined
PASS: C2 s2 derivedTitle matches string prompt
PASS: C2 s2 sessionDisplayTitle isDerived is true
PASS: C2 s2 sessionDisplayTitle text matches derived
PASS: C3 s3 exists
PASS: C3 s3 derivedTitle joins text blocks with space
PASS: C4 s4 exists
PASS: C4 s4 derivedTitle extracts only text block
PASS: C5 s5 exists
PASS: C5 s5 title is undefined
PASS: C5 s5 derivedTitle is undefined
PASS: C5 s5 sessionDisplayTitle is null (no placeholder)
PASS: C6 s6 exists
PASS: C6 s6 derivedTitle comes from human prompt, not tool result
PASS: C7 s7 exists
PASS: C7 s7 derivedTitle comes from human prompt, not compaction
PASS: C8 s8 exists
PASS: C8 s8 derivedTitle comes from human prompt, not synthetic injection
PASS: C9 s9 exists
PASS: C9 s9 title is undefined
PASS: C9 s9 derivedTitle is undefined (not empty string or placeholder)
PASS: C9 s9 sessionDisplayTitle is null
PASS: C10 s10 exists
PASS: C10 s10 length is capped at MAX_DERIVED_TITLE_LENGTH
PASS: C10 s10 matches prefix slice of 60 chars
PASS: C11 s11 is omitted from summaries because it has no user record
PASS: C12 s12 exists
PASS: C12 s12 derivedTitle skips tool result and picks human prompt
```

---

### V5: UI Verification (Headless) & Dropdown Comparison

#### Comparison with Existing Dropdown (`src/ui/composer-dropdown.ts`)
The source of `HistoryDropdown` was directly compared with `ComposerDropdown`:

| Feature / Behavior | `ComposerDropdown` (`src/ui/composer-dropdown.ts`) | `HistoryDropdown` (`src/ui/history-dropdown.ts`) | Match |
|---|---|---|---|
| **ArrowDown** | Increments index modulo `items.length`, updates highlight, scrolls into view. | Increments index modulo `items.length`, updates highlight, scrolls into view. | **Identical** |
| **ArrowUp** | Decrements index modulo `items.length`, updates highlight, scrolls into view. | Decrements index modulo `items.length`, updates highlight, scrolls into view. | **Identical** |
| **Enter / Tab** | Inserts/selects current item, closes dropdown, calls callback. | Selects current item, closes dropdown, calls `onSelectSession`. | **Identical** |
| **Escape** | Closes dropdown, prevents default. | Closes dropdown, prevents default. | **Identical** |
| **Scroll Alignment** | `selected.scrollIntoView({ block: 'nearest' })` | `selected.scrollIntoView({ block: 'nearest' })` | **Identical** |
| **Highlight Classes** | `addClass('is-selected')` | `addClass('is-selected')` | **Identical** |
| **Outside Click** | Closes on outside click. | Closes on `window` click outside dropdown & trigger element. | **Identical** |

#### Headless Checks Verified
1. **Newest-First Order Preserved:** `openDropdown` calls `this.items = rawSummaries.map(shapeSessionRow)`. No secondary sort is applied, preserving the chronological sort from `session-index.ts`.
2. **Missing Cost Handled Deliberately:** Rows without cost data set `costText: null`. In `render()`, the `.guki-history-cost` span is omitted entirely. Flexbox layout allows `.guki-history-title` (`flex: 1 1 auto`) to absorb the space while `.guki-history-date` stays aligned.
3. **Empty State:** When `items.length === 0`, `.guki-history-empty` displays: `"No past conversations found in this vault."`
4. **Event Emission Pattern:** `ChatView` configures `onSelectSession: (id) => this.handleSelectSession(id)`, which invokes `this.onSessionSelected?.(id)`. The dropdown interacts solely through its options callback interface.

#### Material for Human Verification (Running Obsidian)
The following behaviors depend on Obsidian's desktop Chromium host and cannot be fully verified headlessly:
- Header action icon placement and alignment via `ItemView.addAction('history', 'Conversation history', ...)` in the leaf chrome.
- Visual theme integration across third-party community themes (light/dark variables `--background-primary`, `--text-normal`, `--text-accent`, `--shadow-s`).
- Mouse wheel / touch scrolling smoothness over native scrollbars in Electron.

---

### V6: Large-List Performance (Measured)

Performance was benchmarked across lists of 100, 300, 500, and 1,000 synthetic session summaries:

| Row Count ($N$) | Data Shaping (`shapeSessionRow`) | DOM Rendering (`openDropdown`) | Total Duration |
|---|---|---|---|
| **100 rows** | 0.242 ms | 0.813 ms | **1.055 ms** |
| **300 rows** | 0.167 ms | 1.324 ms | **1.491 ms** |
| **500 rows** | 0.183 ms | 1.564 ms | **1.748 ms** |
| **1,000 rows** | 0.383 ms | 1.645 ms | **2.028 ms** |

- **DOM / Style Efficiency:** In `styles.css`:
  ```css
  .guki-history-item {
      content-visibility: auto;
      contain-intrinsic-size: 0 32px;
  }
  ```
  `content-visibility: auto` instructs Chromium to bypass rendering calculations for items outside the scroll viewport, guaranteeing no layout stalls even when vaults accumulate hundreds of sessions.

---

### V7: Scrub Change Verification (Both Directions)

`docs/scrub-capture.py` was compared against `HEAD:docs/scrub-capture.py`:

```python
# Working tree diff in docs/scrub-capture.py
if check_only and not include_ignored and is_gitignored(path):
    print(f'{path}: skipped')
    continue
```

1. **Gitignored File (`docs/NEXT.md`):**
   - HEAD output: `""` (exit code 0)
   - Working copy output: `"docs/NEXT.md: skipped\n"` (exit code 0)
2. **Clean File (`docs/capture-phase8-resume.jsonl`):**
   - HEAD output: `"docs/capture-phase8-resume.jsonl: clean\n"` (exit code 0)
   - Working copy output: `"docs/capture-phase8-resume.jsonl: clean\n"` (exit code 0)
   - **Byte-identical comparison:** `True`
3. **Dirty File (synthetic init event with unscrubbed plugin):**
   - HEAD output: `"DIRTY — init: plugins\n"` (exit code 1)
   - Working copy output: `"DIRTY — init: plugins\n"` (exit code 1)
   - **Byte-identical comparison:** `True`
4. **Combined Scenarios:**
   - Skipped + Clean: Exit code 0, reports both `skipped` and `clean`.
   - Skipped + Dirty: Exit code 1, reports both `skipped` and `DIRTY`.

---

### V8: Scope and Honesty

1. **`styles.css` Discrepancy (Finding F5):** The lane claimed "scope deviations: none", yet `styles.css` was modified (+74 lines). Adding styles for the history dropdown (`.guki-history-dropdown`, `.guki-history-item`, `.guki-history-title`, `.guki-history-date`, `.guki-history-cost`, `.guki-history-empty`) is an essential requirement of the UI task. However, stating "scope deviations: none" without acknowledging this file modification is a reporting oversight.
2. **Untouched Scope Boundaries:**
   - `src/core/stream-reducer.ts`: 0 diff against HEAD.
   - `src/data/disk-transcript-loader.ts`: 0 diff against HEAD.
   - `TranscriptStore.readSession`: Not implemented (remains a stub throwing error).
   - `--resume` CLI execution: Not implemented.
   - Redrawing historical conversation messages: Not implemented.
3. **Check Count:**
   - HEAD check count: 1,556
   - Working tree check count: 1,615 (+59 checks in Section AJ)
   - Verified: 1,615 checks pass with 0 failures (`npm test` exited 0). `npm run lint` reported 0 errors; `npm run build` completed cleanly.

---

### V9: Fault Injection (Break It Somewhere Else)

To confirm that tests guard structural logic beyond what the author tested:
1. In `src/ui/history-dropdown.ts` line 128, list ordering was inverted:
   ```typescript
   // Injected fault:
   this.items = rawSummaries.map(shapeSessionRow).reverse();
   ```
2. Executed `npm run check:offline`:
   ```
   FAIL AJ2.12 ordering preserved: first item is sess-1 — got "sess-3", want "sess-1"
   FAIL AJ2.14 ordering preserved: third item is sess-3 — got "sess-1", want "sess-3"
   FAIL AJ2.16 first row has cost element
   FAIL AJ2.17 first row cost element displays $0.12 — got undefined, want "$0.12"
   4 CHECK(S) FAILED
   ```
3. Restored `this.items = rawSummaries.map(shapeSessionRow)`.
4. Executed `npm run check:offline`: All 1,615 checks passed cleanly.
5. Confirmed `git diff` shows no residual changes.

---

## 4. Consolidated Findings Summary

| ID | Category | Severity | Description |
|---|---|---|---|
| **F1** | Defect / Assumption | Medium | In `extractUserPromptText` and `isSyntheticUser`, `r.toolUseResult === true` checks for boolean equality. On disk, `toolUseResult` is an object/dict on ~88% of records and never boolean `true`. The check is ineffective against real records, though `block.type === 'text'` currently compensates by ignoring `tool_result` blocks. |
| **F2** | Logic Quirk | Low | If Turn 1 lacks `origin` metadata (legacy/untyped CLI session), it is assigned to `firstCandidateText`. If a later turn has explicit `origin: {kind: "human"}`, it is assigned to `firstHumanText`. `firstHumanText ?? firstCandidateText` causes the later turn to override the first user prompt. |
| **F3** | Quality Edge Case | Low | `isMeta: true` is not checked by `session-index.ts`. In 7 real sessions, metadata prompts became derived session titles. |
| **F4** | Citation Mismatch | Minor | The lane's handoff documentation cited `capture-phase8-transcript-schema.md` §4g for the 4.9% user record statistic. §4g covers file sizes and paging; the statistic is in §1.3. |
| **F5** | Reporting Discrepancy | Minor | The lane claimed "scope deviations: none", but modified `styles.css` (+74 lines). While functionally required, it should have been explicitly noted. |
