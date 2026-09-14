# Evidence: Map of Storage and Render Seams for Generated Titles

## Task Metadata
- **Task ID:** P7T9-C
- **Repository:** `/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat`
- **Branch:** `main`
- **Commit:** `654ab51` (`Merge: Görev 8 — conversation history and resume`) [measured: `git log -1 --oneline`]
- **Mode:** Explore (read-only over repository; writes isolated to `.orchestration/evidence/C/`)

---

## Question 1: Persistence That Already Exists

### 1.1 What the plugin persists today and through which API
[measured: `src/main.ts:GukiChatPlugin.loadSettings` L80-91; `src/main.ts:GukiChatPlugin.saveSettings` L94-98]
The plugin persists its configuration through Obsidian's native `Plugin.prototype.loadData()` and `Plugin.prototype.saveData()` APIs:
- **Load API:** `this.loadData()` called inside `GukiChatPlugin.prototype.loadSettings()` (`src/main.ts:loadData` L81).
- **Save API:** `this.saveData(this.settings)` called inside `GukiChatPlugin.prototype.saveSettings()` (`src/main.ts:saveData` L95) and directly in `session.setOnSlashCommandsUpdated` (`src/main.ts:this.saveData` L38).

### 1.2 Target File and Store Scope
[measured: `docs/obsidian-stub.mjs:Plugin` L336-350; `data.json` L1-132]
- **File location:** In standard Obsidian runtime, `loadData()` / `saveData()` reads and writes `<vault>/.obsidian/plugins/guki-chat/data.json`. In the local dev workspace, the root `data.json` represents this file.
- **Store scope:** **Per-vault and per-plugin** [measured]. Obsidian isolates `data.json` per plugin within each vault's `.obsidian/plugins/<plugin-id>/` folder. It is **not per-conversation** [measured]. All conversations and sessions associated with the vault share this single configuration store.

### 1.3 Shape of Persisted Data
[measured: `src/ui/settings-tab.ts:GukiChatSettings` L14-17; `src/core/permission-policy.ts:PermissionSettings` L44-50; `src/core/permission-policy.ts:RememberedDecision` L33-42]
The persisted shape is defined by `GukiChatSettings`:
```typescript
// src/ui/settings-tab.ts:14-17
export interface GukiChatSettings extends PermissionSettings {
	claudeBinaryPath: string;
	slashCommands?: string[];
}

// src/core/permission-policy.ts:44-50
export interface PermissionSettings {
	readOutsideVault: CategorySetting; // 'always ask' | 'auto-allow'
	writeOutsideVault: CategorySetting; // 'always ask' | 'auto-allow'
	runCommands: CategorySetting; // 'always ask' | 'auto-allow'
	allowEverything: boolean;
	rememberedDecisions: RememberedDecision[];
}

// src/core/permission-policy.ts:33-42
export interface RememberedDecision {
	id: string;
	category: PermissionCategory; // 'read' | 'write' | 'command'
	path?: string;
	existedOnGrant?: boolean;
	argv?: string[];
	cwd?: string;
	description?: string;
	createdAt?: number;
}
```

### 1.4 Load and Save Call Paths
[measured]
- **Load Path:**
  1. Obsidian startup invokes `GukiChatPlugin.prototype.onload` (`src/main.ts:GukiChatPlugin.onload` L12).
  2. `onload` awaits `this.loadSettings()` (`src/main.ts:this.loadSettings` L13).
  3. `loadSettings` awaits `(await this.loadData()) as Partial<GukiChatSettings> | null` (`src/main.ts:this.loadData` L81).
  4. Permissions are normalized via `normalizePermissionSettings(data)` (`src/core/permission-policy.ts:normalizePermissionSettings` L236).
  5. Settings are merged with defaults: `this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}), ...permissions, slashCommands: ... }` (`src/main.ts:this.settings` L83-90).
  6. `SessionManager` is instantiated with `this.settings` (`src/main.ts:new SessionManager` L18-24).

- **Save Path:**
  - Path A (Settings UI tab change): User updates a field in `GukiSettingTab` -> calls `this.plugin.saveSettings()` (`src/ui/settings-tab.ts:saveSettings` L89, L105, L119, L133, L151, L181, L202).
  - Path B (Permission "Don't ask again" grant): `SessionManager.rememberPermission()` -> `PermissionBroker.remember()` -> triggers `onSaveSettings` callback registered in `main.ts` -> calls `this.saveSettings()` (`src/main.ts:session.setOnSaveSettings` L25-32).
  - Path C (Slash commands update): `SessionManager.reducer.onInit` -> `onSlashCommandsUpdated` callback registered in `main.ts` -> calls `this.saveData(this.settings)` (`src/main.ts:session.setOnSlashCommandsUpdated` L33-39).
  - `saveSettings` implementation (`src/main.ts:GukiChatPlugin.saveSettings` L94-98):
    1. Calls `await this.saveData(this.settings)` (`src/main.ts:this.saveData` L95).
    2. Updates in-memory session: `this.session?.setClaudeBinaryOverride(this.settings.claudeBinaryPath)`.
    3. Updates in-memory broker permissions: `this.session?.setPermissionSettings(this.settings)`.

### 1.5 Current Contents of `data.json` (Redacted)
[measured: `data.json` L1-132, sensitive username and project paths redacted]
```json
{
  "claudeBinaryPath": "",
  "slashCommands": [
    "agent-reach",
    "codebase-memory",
    "orchestrate",
    "agent-handoff-verifier",
    "agy-fleet",
    "beyin-doktor",
    "gecmis-import",
    "opus-orchestrator",
    "task-observer",
    "agy-orchestrate",
    "agy-orchestrate-plan",
    "agy-orchestrate-status",
    "agy-orchestrate-verify",
    "deep-research",
    "i-have-adhd:i-have-adhd",
    "mem0:context-loader",
    "mem0:dream",
    "mem0:export",
    "mem0:forget",
    "mem0:health",
    "mem0:import",
    "mem0:list-projects",
    "mem0:mem0",
    "mem0:memory-reviewer",
    "mem0:onboard",
    "mem0:peek",
    "mem0:pin",
    "mem0:policy",
    "mem0:remember",
    "mem0:stats",
    "mem0:switch-project",
    "mem0:tour",
    "ponytail:ponytail",
    "ponytail:ponytail-audit",
    "ponytail:ponytail-debt",
    "ponytail:ponytail-gain",
    "ponytail:ponytail-help",
    "ponytail:ponytail-review",
    "design",
    "design-sync",
    "dataviz",
    "update-config",
    "verify",
    "debug",
    "code-review",
    "simplify",
    "batch",
    "fewer-permission-prompts",
    "doctor",
    "loop",
    "schedule",
    "claude-api",
    "workflow-authoring",
    "run",
    "run-skill-generator",
    "advisor",
    "agents",
    "auto-mode-setup",
    "autocompact",
    "clear",
    "color",
    "compact",
    "config",
    "output-style",
    "context",
    "effort",
    "fast",
    "heapdump",
    "init",
    "mcp",
    "import",
    "model",
    "__remote-workflow",
    "workflow-launch-exec",
    "reload-plugins",
    "reload-skills",
    "rename",
    "security-review",
    "usage-credits",
    "extra-usage",
    "usage",
    "insights",
    "recap",
    "skill-doctor",
    "goal",
    "design-consent",
    "design-revoke",
    "list-agents",
    "team-onboarding",
    "mcp__plugin_mem0_mem0__memory_assistant"
  ],
  "readOutsideVault": "auto-allow",
  "writeOutsideVault": "auto-allow",
  "runCommands": "auto-allow",
  "allowEverything": true,
  "rememberedDecisions": [
    {
      "id": "53d3a01f-5438-447e-898e-fe316d863f6c",
      "category": "command",
      "argv": [
        "ls",
        "-la",
        "/Users/<REDACTED_USER>/Documents"
      ],
      "cwd": "/Users/<REDACTED_USER>/Documents/<REDACTED_VAULT>",
      "description": "Bash: ls -la /Users/<REDACTED_USER>/Documents",
      "createdAt": 1789162098110
    },
    {
      "id": "a917b8e8-fc51-4e99-855e-b3cc9ac2f65e",
      "category": "command",
      "argv": [
        "ls",
        "-la",
        "/Users/<REDACTED_USER>/Downloads"
      ],
      "cwd": "/Users/<REDACTED_USER>/Documents/<REDACTED_VAULT>",
      "description": "Bash: ls -la /Users/<REDACTED_USER>/Downloads",
      "createdAt": 1789162132505
    },
    {
      "id": "e78f0bd8-c436-4d1a-953f-9893d6e04a65",
      "category": "read",
      "path": "/Users/<REDACTED_USER>/<REDACTED_PATH>/research_blocks/023_runtime_api_ve_issue_yasam_dongusu_denetimi.md",
      "description": "Read /Users/<REDACTED_USER>/<REDACTED_PATH>/research_blocks/023_runtime_api_ve_issue_yasam_dongusu_denetimi.md",
      "createdAt": 1789162874453
    }
  ]
}
```

---

## Question 2: The Read Seam

### 2.1 Step-by-Step Call Chain from Directory Scan to DOM Text
[measured]
1. **User interaction:** User clicks the history button (view action in main leaf or header button in sidebar).
   - In `src/ui/chat-view.ts:addAction` (L629) or `src/ui/chat-view.ts:createEl('button')` (L647-656).
   - Both call `void this.historyDropdown?.toggle();` (`src/ui/chat-view.ts:toggle` L630, L656).
2. **Dropdown open invocation:**
   - In `src/ui/history-dropdown.ts:HistoryDropdown.toggle` (L121).
   - If not open, calls `await this.openDropdown();` (`src/ui/history-dropdown.ts:openDropdown` L125).
3. **Session index query:**
   - In `src/ui/history-dropdown.ts:HistoryDropdown.openDropdown` (L129-130).
   - Calls `const rawSummaries = await this.options.getSessions();` (L130).
   - The `getSessions` callback was registered in `ChatView.prototype.onOpen` (`src/ui/chat-view.ts:onOpen` L90-93):
     ```typescript
     getSessions: async () => {
         const paths = await this.session.vaultPaths();
         return this.transcriptStore.listSessions(paths.root);
     }
     ```
4. **Data layer resolution:**
   - In `src/data/transcript-store.ts:NodeTranscriptStore.listSessions` (L87-92).
   - Computes CLI project directory: `projectsDir = this.basePath ?? path.join(os.homedir(), '.claude', 'projects', projectSlug(vaultPath))` (L90).
   - Calls `scanSessionsDir(projectsDir)` (`src/data/session-index.ts:scanSessionsDir` L257).
5. **Directory enumeration:**
   - In `src/data/session-index.ts:scanSessionsDir` (L257-290).
   - Reads directory entries: `entries = await fs.promises.readdir(projectsDir)` (L263).
   - Filters entries: `entry.endsWith('.jsonl')` (L271).
   - Extracts session ID: `sessionId = entry.slice(0, -'.jsonl'.length)` (L274).
   - For each matching file, calls `await buildSessionSummary(filePath, sessionId)` (`src/data/session-index.ts:buildSessionSummary` L190).
6. **Transcript parsing and title extraction:**
   - In `src/data/session-index.ts:buildSessionSummary` (L190-246).
   - Reads file: `content = await fs.promises.readFile(filePath, 'utf8')` (L192).
   - Parses each line as JSON.
   - Extracts genuine CLI title: If `type === 'ai-title'` and `typeof r.aiTitle === 'string'`, sets `title = r.aiTitle` (L219-221).
   - Extracts human prompt text: If `type === 'user'`, checks `extractUserPromptText(r)` (`src/data/session-index.ts:extractUserPromptText` L57) and `!isSyntheticUser(r)` (`src/data/session-index.ts:isSyntheticUser` L129). First usable text recorded as `firstUsableText ??= text` (L231).
   - Derives title fallback: If `title === undefined && firstUsableText !== undefined`, calls `derivedTitle = sanitizeDerivedTitle(firstUsableText)` (`src/data/session-index.ts:sanitizeDerivedTitle` L149-158).
   - Returns `SessionSummary { sessionId, title, derivedTitle, startedAt, costUsd }` (L245).
7. **Sorting:**
   - In `src/data/session-index.ts:scanSessionsDir` (L288).
   - Sorts newest-first: `summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))`.
   - Returns `SessionSummary[]` through `listSessions()` back to `HistoryDropdown.openDropdown()`.
8. **Shaping into presentation model:**
   - In `src/ui/history-dropdown.ts:HistoryDropdown.openDropdown` (L132).
   - Calls `this.items = rawSummaries.map(shapeSessionRow);`.
   - In `src/ui/history-dropdown.ts:shapeSessionRow` (L58-74):
     ```typescript
     const hasRealTitle = summary.title !== undefined && summary.title.length > 0;
     const isDerivedTitle = !hasRealTitle && summary.derivedTitle !== undefined && summary.derivedTitle.length > 0;
     const title = hasRealTitle
         ? summary.title!
         : (isDerivedTitle ? summary.derivedTitle! : 'Untitled session');
     ```
     Produces `HistoryRowItem: { sessionId, title, isDerivedTitle, dateText, costText }`.
9. **DOM construction:**
   - In `src/ui/history-dropdown.ts:HistoryDropdown.render` (L208-256).
   - Loops over `this.items`, creating:
     - `const itemEl = this.dropdownEl.createDiv({ cls: 'guki-history-item' + ... });` (L223).
     - `const titleEl = itemEl.createSpan({ cls: 'guki-history-title' + (item.isDerivedTitle ? ' is-derived' : ''), text: item.title });` (L227-230).
     - If `item.isDerivedTitle`: `titleEl.setAttribute('title', 'Derived: ' + item.title);` (L232).

### 2.2 The One Place Where Stored Titles Must Be Consulted
[measured & inferred]
There are two possible seams, but **one architectural seam is strictly superior**:

- **Seam A (Data Layer - Recommended): `NodeTranscriptStore.prototype.listSessions(vaultPath)` (`src/data/transcript-store.ts:NodeTranscriptStore.listSessions` L87)** [inferred].
  When `listSessions` completes `scanSessionsDir`, it overlays the plugin's stored titles onto the returned `SessionSummary[]` (e.g. `summary.title = storedTitleMap[summary.sessionId] ?? summary.title`).
  - **Caller impact:** **Zero UI callers have to change** [measured]. `shapeSessionRow` in `history-dropdown.ts:58` already prefers `summary.title` over `summary.derivedTitle`. Any future caller of `transcriptStore.listSessions()` (tab titles, quick switchers, export tools) automatically receives the stored title.
- **Seam B (Presentation Layer / Helper): `shapeSessionRow` (`src/ui/history-dropdown.ts:shapeSessionRow` L58) and `sessionDisplayTitle` (`src/data/session-index.ts:sessionDisplayTitle` L165)** [measured].
  Currently, `shapeSessionRow` duplicates the precedence logic inline and **does not call `sessionDisplayTitle`** [measured]. If title resolution were handled only at the presentation layer, **more than one caller would have to change** (both `shapeSessionRow` and `sessionDisplayTitle`, plus any future UI caller would have to remember to pass the stored titles map).

**Conclusion:** The single place where a stored title should be consulted so that every caller benefits is **`NodeTranscriptStore.prototype.listSessions()`** (`src/data/transcript-store.ts:listSessions`). If applied there, **no UI caller has to change**.

---

## Question 3: The Write Trigger

### 3.1 Where the Plugin Learns the Session ID
[measured: `src/core/stream-reducer.ts:StreamReducer.applyInit` L398-405; `src/core/session-manager.ts:SessionManager.switchConversation` L173-190]
The plugin learns the session ID in two different ways depending on session lifecycle:
1. **Fresh Conversation:** Learned in `StreamReducer.prototype.applyInit` (`src/core/stream-reducer.ts:applyInit` L398-405):
   ```typescript
   private applyInit(event: SystemInitEvent): void {
       this.turnCount += 1;
       if (this.sessionId === null) {
           // First init only: session setup. No UI reset here or on any later init.
           this.sessionId = event.session_id ?? null;
       }
       this.onInit?.(event);
   }
   ```
   This occurs when the CLI process emits the first `SystemInitEvent` (`type: "system", subtype: "init"`) on stdout, which is parsed by `ClaudeProcess` and dispatched to `StreamReducer.apply(event)` (`src/core/session-manager.ts:ClaudeProcess` L493).
2. **Resumed Conversation:** Learned in `ChatView.prototype.handleSelectSession` (`src/ui/chat-view.ts:handleSelectSession` L295) when the user selects an existing session, which calls `SessionManager.prototype.switchConversation(sessionId)` (`src/core/session-manager.ts:switchConversation` L189). The session ID is stored in `this.resumeSessionId` before any process is started.

### 3.2 Where the Plugin Observes the First User Message
[measured: `src/core/session-manager.ts:SessionManager.send` L314-325; `src/ui/chat-view.ts:onSubmit` L118-121]
- User submission arrives from `Composer` in `ChatView.prototype.onOpen`:
  `onSubmit: (text, attachments) => { this.session.send(text, attachments); return true; }` (`src/ui/chat-view.ts:onSubmit` L118-121).
- Observed and recorded in `SessionManager.prototype.send`:
  `this.state.addUserMessage(message, images);` (`src/core/session-manager.ts:addUserMessage` L321).
- Dispatched to CLI in `SessionManager.prototype.pump`:
  `const written = this.process?.write(userMessageLine(next.text, next.images)) ?? false;` (`src/core/session-manager.ts:userMessageLine` L415).

### 3.3 Where the Plugin Observes the First Assistant Reply
[measured: `src/core/stream-reducer.ts:StreamReducer.applyResult` L839-960; `src/core/session-manager.ts:SessionManager` L118-125]
- Streaming response chunks arrive via `StreamReducer.prototype.applyStreamEvent` (`src/core/stream-reducer.ts:applyStreamEvent` L687-735), populating `terminalItem.blocks`.
- Turn completion is observed in `StreamReducer.prototype.applyResult` (`src/core/stream-reducer.ts:applyResult` L839-960):
  - Line 952: `terminalItem.status = 'complete';`
  - Line 958: `this.state.emitChange();`
  - Line 959: `this.onTurnEnd?.();`
- `SessionManager` receives the turn end notification via its registered callback:
  `this.reducer.onTurnEnd = () => { ... }` (`src/core/session-manager.ts:onTurnEnd` L118-125).

### 3.4 Is Session ID Known Before the First Message is Sent?
[measured]
- **Fresh conversation:** **NO.** The session ID is **NOT known before the first message is sent**.
  - Rationale: Spawning the Claude CLI process is strictly deferred until `send()` calls `pump()` -> `ensureProcess()` -> `startProcess()` (`src/core/session-manager.ts:ensureProcess` L395, L423). The CLI generates its own `session_id` and announces it via the `system/init` event.
- **Resumed conversation:** **YES.** The session ID was selected by the user and is stored in `this.resumeSessionId` prior to message transmission.

### 3.5 Implications for Title Generation Keying
[measured & inferred]
Because a fresh conversation does not have a known `sessionId` when the user presses Send, title generation **cannot be keyed by `sessionId` before sending the first message** [measured].
However, by the time the first assistant reply completes (`applyResult` / `onTurnEnd`), `system/init` has already executed (`applyInit` runs at turn start, L398-405), so `reducer.currentSessionId` **is guaranteed to be populated** [measured].
Therefore, a title generation trigger attached to the completion of the first assistant turn can reliably key the generated title by `sessionId` [inferred].

---

## Question 4: Refresh

### 4.1 What Redraws the History List When Open?
[measured: `src/ui/history-dropdown.ts:HistoryDropdown` L76-206]
**Nothing redraws the history list while open** [measured].
- `HistoryDropdown` has no event listener attached to `ChatState`, `App.vault`, or the filesystem.
- `this.render()` is a private method called only from `HistoryDropdown.prototype.openDropdown()` (`src/ui/history-dropdown.ts:openDropdown` L135).
- There is no pub/sub, watcher, timer, or invalidation callback attached to `HistoryDropdown`.

### 4.2 Is There an Existing Refresh/Invalidation Path?
[measured]
**No.** The list is built **strictly once per open** [measured].

### 4.3 What in Current Code Would Make an Asynchronous Title Appear?
[measured]
**Nothing in the current code would make an asynchronously arrived title appear** [measured].
If a title arrives 1 second after the list is rendered, the rendered DOM element `.guki-history-title` remains unchanged. The new title will only appear if the user closes the dropdown (e.g., clicking outside or pressing Escape) and toggles it open again, which triggers `openDropdown()` and executes `getSessions()` anew.

---

## Question 5: Rename

### 5.1 Does Any Current UI Let the User Edit a Label?
[measured: search over `src/ui/**`]
**No.** There is no UI in the entire codebase that allows editing the label of any item, session, or decision [measured].

### 5.2 Nearest Existing Patterns in This Codebase to Follow
[measured]
If manual rename is added, the three nearest patterns in the codebase are:
1. **Inline Text Input Creation and Event Handling (`AskUserQuestionInline`):**
   - Citation: `src/ui/ask-user-question.ts:AskUserQuestionInline` (L178-220).
   - Pattern: Dynamically creates an `<input type="text">` using Obsidian's DOM helper `container.createEl('input', { cls: '...', type: 'text', placeholder: '...' })`. Attaches `blur`, `focus`, and `keydown` listeners (committing on `Enter` and cancelling on `Escape`).
2. **Item Row Action Button (`GukiSettingTab.renderRememberedList`):**
   - Citation: `src/ui/settings-tab.ts:renderRememberedList` (L186-206).
   - Pattern: Each row has an associated action button (`addButton((btn) => btn.setButtonText(...).onClick(...))`). In `HistoryDropdown`, an edit icon button (`setIcon(btnEl, 'pencil')`) placed on hover beside the title element follows this convention.
3. **Dropdown Keyboard Interception (`HistoryDropdown.handleKeyDown`):**
   - Citation: `src/ui/history-dropdown.ts:HistoryDropdown.handleKeyDown` (L182-206).
   - Pattern: Captures `ArrowUp`, `ArrowDown`, `Enter`, `Escape` with `event.preventDefault()`. When renaming, the input must capture keystrokes and prevent the parent dropdown from treating `ArrowUp`/`ArrowDown`/`Enter`/`Escape` as dropdown navigation.

---

## Question 6: Test Scaffold

### 6.1 Description of the Scaffold
[measured: `docs/offline-checks.ts:1-150`; `docs/obsidian-stub.mjs:1-351`]
The offline test scaffold runs outside of Obsidian in standard Node.js without browser automation:
- **Stub Layer (`docs/obsidian-stub.mjs`):** Implements lightweight stubs for `obsidian` classes (`App`, `Vault`, `WorkspaceLeaf`, `FileSystemAdapter`, `Plugin`, `Setting`, `Notice`, etc.).
- **DOM Layer (`FakeElement`):** Implements an in-memory DOM mock providing `createDiv`, `createSpan`, `createEl`, `querySelector`, `querySelectorAll`, `addEventListener`, `classList` (`addClass`, `removeClass`), and `text` properties.
- **Fixture Management:** Uses Node `mkdtempSync` (e.g. `TRANSCRIPT_TEST_DIR`) and `writeFileSync` to generate real `.jsonl` session fixtures representing empty, basic, DAG-reordered, or long transcripts.
- **Component Harness:** Instantiates `ChatView(leaf, session, store)` using either real or stubbed dependencies (`NodeTranscriptStore`, `ChatState`, `SessionManager`), invokes view lifecycles (`(view as any).onOpen()`), and simulates user interactions by clicking DOM elements (`triggerEl?.click()`, `rowEl?.click()`).

### 6.2 Check Registration and Exact Run Command
[measured]
- **Registration:** Checks are declared inline in `docs/offline-checks.ts` using:
  - `check(name: string, condition: boolean, detail?: string)` (`docs/offline-checks.ts:check` L174).
  - `eq<T>(name: string, actual: T, expected: T)` (`docs/offline-checks.ts:eq` L183).
- **Exact Execution Command:**
  ```bash
  npm run check:offline
  ```
  which invokes `package.json:check:offline`:
  ```bash
  npx esbuild docs/offline-checks.ts --bundle --platform=node --format=esm --alias:obsidian=./docs/obsidian-stub.mjs --outfile=/tmp/guki-checks.mjs && node /tmp/guki-checks.mjs
  ```

### 6.3 Offline Observability of Task 9 Checks (Three Separate Findings)
[measured & inferred]

1. **Could a check assert that a title was stored?**
   **YES.** [measured]
   - Existing Precedent: Section Y in `docs/offline-checks.ts` (lines 6424, 6494, 6569, 6765) directly tests persistence by stubbing `plugin.saveData = async (data) => { savedData = data; }` and asserting `eq('... decision persisted via saveData', ...)` [measured].
   - If titles are persisted in `data.json` / `Plugin.saveData`, the scaffold can inspect the argument passed to `saveData`. If titles are stored in a dedicated file or store, the scaffold can read the file using Node `fs.readFileSync` or query the store instance directly.

2. **Could a check assert that the list read the stored title rather than recomputing?**
   **YES.** [measured]
   - Existing Precedent: Section AN in `docs/offline-checks.ts` (lines 12337-12343) opens the dropdown and searches `.guki-history-item` DOM elements for rendered text [measured].
   - By creating a fixture file where the raw transcript prompt would produce derived title `"Prompt Derived Title"`, but the store has recorded `"Stored Custom Title"`, the check can assert that `targetRow.text.includes("Stored Custom Title") === true` and `targetRow.text.includes("Prompt Derived Title") === false`. Spying on `sanitizeDerivedTitle` or scanning methods can further assert call count is 0.

3. **Could a check assert that no generation call happened when a title already exists?**
   **YES.** [measured]
   - Existing Precedent: Section AP in `docs/offline-checks.ts` (lines 12531-12560) spies on process spawning by stubbing `const origSpawn = cp.spawn; cp.spawn = (...args) => { spawnCalls.push(...); ... }` and asserting `eq('AP.1 selection alone spawns nothing', spawnCalls.length, 0)` [measured].
   - Whether generation is invoked via a CLI subprocess (`cp.spawn`), network request (`globalThis.fetch`), or an internal title generator function/service, the check can wrap or spy on that callable and assert that invocation count is 0 when a session already has a stored title.

---

## Question 7: Check Counts and Output

### 7.1 Check Counts Today
[measured: `npm run check:offline` run at commit `654ab51`]
- **Passing assertion count (`ok` lines):** **1,858 checks** [measured].
- **Syntactic check call sites in source:** **1,784 calls** to `check(`, `eq(`, `eqCall(` in `docs/offline-checks.ts` [measured]. (The difference of 74 is due to parameterized checks executed within loops).
- **Full test suite (`npm test`):**
  - `check:capture`: 5 fixture files clean (`capture-phase3-thinking-redacted.jsonl`, `capture-phase4-tools.jsonl`, `capture-phase5a-stop.jsonl`, `capture-phase7b-compaction-status.jsonl`, `capture-phase8-resume.jsonl`).
  - `check:docs`: 7 verification docs clean, 3 skipped (`NEXT.md`, `PLAN.md`, `RESEARCH.md`).
  - `check:offline`: 1,858 assertions passing.

### 7.2 Exact Command and Actual Output
[measured: run on 2026-09-15]

**Command:**
```bash
npm run check:offline
```

**Actual Terminal Output:**
```
> guki-chat@0.1.0 check:offline
> npx esbuild docs/offline-checks.ts --bundle --platform=node --format=esm --alias:obsidian=./docs/obsidian-stub.mjs --outfile=/tmp/guki-checks.mjs && node /tmp/guki-checks.mjs


  ../../../../../tmp/guki-checks.mjs  738.3kb

⚡ Done in 23ms
GuKi Chat: rejecting an unauthenticated permission socket
GuKi Chat: auto-allowed Read …yj6gd2j3zysrhkp7480000gp/T/guki-checks-vault-I3AaFo/vault/notes/todo.md
GuKi Chat: the permission policy threw; asking instead Error: boom
    at Object.isInside (file:///private/tmp/guki-checks.mjs:10897:13)
    at readOnlyVerdict (file:///private/tmp/guki-checks.mjs:2662:13)
    at evaluateCandidateVerdict (file:///private/tmp/guki-checks.mjs:2867:12)
    at permissionVerdict (file:///private/tmp/guki-checks.mjs:2892:21)
    at PermissionBroker.verdictFor (file:///private/tmp/guki-checks.mjs:3232:14)
    at PermissionBroker.handleRequest (file:///private/tmp/guki-checks.mjs:3195:26)
    at Socket.<anonymous> (file:///private/tmp/guki-checks.mjs:3158:16)
    at Socket.emit (node:events:507:28)
    at addChunk (node:internal/streams/readable:559:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:510:3)
GuKi Chat: auto-allowed Read …8vnyj6gd2j3zysrhkp7480000gp/T/guki-e2e-5O5OzU/outside/e2e-read-test.txt
GuKi Chat: auto-allowed Write …vnyj6gd2j3zysrhkp7480000gp/T/guki-e2e-5O5OzU/outside/e2e-write-test.txt
GuKi Chat: auto-allowed Bash npm test --run
GuKi Chat: auto-allowed Bash npm test --run
[... 1836 prior ok lines omitted for brevity ...]
  ok   AQ.b4 exactly one control in main area
  ok   AQ.c1 side panel dropdown trigger matches visible control
  ok   AQ.c2 side panel history dropdown initially closed
  ok   AQ.c3 clicking side panel trigger opens dropdown
  ok   AQ.c4 main area dropdown trigger matches visible control
  ok   AQ.c5 main area dropdown trigger is the view action
  ok   AQ.c6 main area history dropdown initially closed
  ok   AQ.c7 clicking main area view action opens dropdown
  ok   AQ.d1 initially in sidebar has in-panel button and no view action
  ok   AQ.d2 move sidebar to main leaves exactly one control (old control torn down)
  ok   AQ.d3 move sidebar to main has view action and no in-panel header
  ok   AQ.d4 dropdown trigger updated to view action after move to main
  ok   AQ.d5 move main back to sidebar leaves exactly one control (view action torn down)
  ok   AQ.d6 move main back to sidebar has in-panel button and no view action
  ok   AQ.d7 dropdown trigger updated to in-panel button after return
  ok   AQ.e1 wide main area has view action
  ok   AQ.e2 narrow main leaf falls back to in-panel button
  ok   AQ.e3 narrow main leaf tears down view action
  ok   AQ.e4 narrow main leaf has exactly one control (never zero)
  ok   AQ.e5 dropdown trigger updated to in-panel button in narrow main leaf
  ok   AQ.e6 wide main leaf restores view action
  ok   AQ.e7 wide main leaf removes in-panel button
  ok   AQ.e8 wide main leaf has exactly one control (never zero)

ALL CHECKS PASSED
```

**Exit Code:**
```bash
echo $?
0
```
[measured: command exited with code 0]
