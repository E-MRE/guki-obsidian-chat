# Claudian Reference Evidence: Conversation Title Generation and Management

- **Target / Task ID**: P7T9-D
- **Scope**: Exploration of `/Users/emregultekir/Documents/otherprojects/claudian`
- **Output File**: `/Users/emregultekir/Documents/otherprojects/guki-obsidian-chat/.orchestration/evidence/D/EVIDENCE.md`

---

## 1. Trigger

### Exact Trigger Moment
- **[MEASURED]** Title generation is initiated immediately upon submitting the first user message, **before** any assistant response is streamed or generated.
- **[MEASURED]** In `src/features/chat/controllers/InputController.ts:executeSendMessage`, when a turn is executed:
  1. The user message is created and added to state: `state.addMessage(userMsg)`.
  2. The conversation shell is ensured: `await this.ensureConversationShell(linkedContentSubmission)`.
  3. Title generation is awaited: `await this.triggerTitleGeneration()`.
  4. Only after step 3 is the placeholder `assistantMsg` added to state and execution/streaming started.
- **[MEASURED]** Inside `src/features/chat/controllers/InputController.ts:triggerTitleGeneration`:
  - It checks message count:
    ```typescript
    if (state.messages.length !== 1) {
      return;
    }
    ```
    Because `userMsg` was just added and `assistantMsg` has not yet been added, `state.messages.length === 1`. On subsequent user messages, `state.messages.length > 1`, so the check immediately exits.
  - It extracts `userContent` from the first user message:
    ```typescript
    const firstUserMsg = state.messages.find(m => m.role === 'user');
    if (!firstUserMsg) return;
    const userContent = firstUserMsg.displayContent
      ?? extractUserDisplayContent(firstUserMsg.content)
      ?? firstUserMsg.content;
    ```
  - It immediately sets a synchronous local fallback title:
    ```typescript
    const fallbackTitle = conversationController.generateFallbackTitle(userContent);
    await plugin.renameConversation(state.currentConversationId, fallbackTitle);
    ```
  - It checks settings:
    ```typescript
    if (!plugin.settings.enableAutoTitleGeneration) {
      return;
    }
    ```
    If disabled by setting, it leaves the fallback title and exits.
  - If title generation service is available, it sets `titleGenerationStatus: 'pending'`, updates the history dropdown, and launches background generation:
    ```typescript
    await plugin.updateConversation(state.currentConversationId, { titleGenerationStatus: 'pending' });
    conversationController.updateHistoryDropdown();
    titleService.generateTitle(convId, userContent, callback).catch(() => {});
    ```

### Secondary Trigger: Manual Regeneration
- **[MEASURED]** In `src/features/chat/controllers/ConversationController.ts:regenerateTitle`:
  When a previous title generation has failed (`titleGenerationStatus === 'failed'`), the history list UI renders a "Regenerate title" button (`refresh-cw` icon). Clicking it calls `regenerateTitle(conversation.id)`.

---

## 2. Prompt and Input

### Input Fed to Generation
- **[MEASURED]** Input is **strictly the first user message only** (`userContent`). It does **not** include any assistant response, conversation history, tool calls, or transcript.
- **[MEASURED]** Length Cap on Input:
  In `src/core/prompt/titleGeneration.ts:MAX_TITLE_INPUT_LENGTH`, input is truncated to **500 characters**:
  ```typescript
  const MAX_TITLE_INPUT_LENGTH = 500;
  const truncated = userMessage.length > MAX_TITLE_INPUT_LENGTH
    ? `${userMessage.slice(0, MAX_TITLE_INPUT_LENGTH)}...`
    : userMessage;
  ```

### Verbatim User Prompt
- **[MEASURED]** `src/core/prompt/titleGeneration.ts:buildTitleGenerationPrompt`:
```text
User's request:
"""
${truncated}
"""

Generate a title for this conversation:
```

### Verbatim System Prompt
- **[MEASURED]** `src/core/prompt/titleGeneration.ts:buildTitleGenerationSystemPrompt` (combining `TITLE_GENERATION_SYSTEM_PROMPT_BASE` and language directive):
```text
You are a specialist in summarizing user intent.

**Task**: Generate a **concise, descriptive title** (max 50 chars) summarizing the user's task/request.

**Rules**:
1.  **Format**: Use sentence case when the target language has letter case. No surrounding quotes or trailing punctuation.
2.  **Structure**: Prefer concise, action-led wording when natural for the selected language.
3.  **Forbidden**: "Conversation with...", "Help me...", "Question about...", "I need...".
4.  **Tech Context**: Include the primary programming language or framework only when it is relevant and confidently identifiable.
5.  **Language**: Write the title in ${language}. Apply the format and structure rules naturally for that language.

**Output**: Return ONLY the raw title text.
```
*(Where `${language}` defaults to `'English'` or is localized based on `settings.titleGenerationLocale` / interface locale).*

### Post-Processing Parser
- **[MEASURED]** `src/core/prompt/titleGeneration.ts:parseTitleGenerationResponse`:
  - Trims whitespace.
  - Strips leading and trailing single/double quotes (`"` or `'`).
  - Strips trailing punctuation (`/[.!?:;,]+$/`).
  - Truncates to max 50 characters: if `title.length > 50`, slices to 47 chars and appends `'...'`.

---

## 3. Model and Cost Control

### Model Selection
- **[MEASURED]** For the default Claude provider (`src/providers/claude/registration.ts:resolveTitleGenerationModel`):
  ```typescript
  resolveTitleGenerationModel: (plugin) => {
    const titleModel = plugin.settings.titleGenerationModel;
    if (titleModel && claudeChatUIConfig.ownsModel(titleModel, plugin.settings)) {
      return toClaudeRuntimeModelId(titleModel);
    }
    const envVars = parseEnvironmentVariables(
      plugin.getActiveEnvironmentVariables('claude'),
    );
    return envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5';
  }
  ```
- **[MEASURED]** Cheaper tier: **YES**. Unless explicitly overridden in settings, it requests Haiku (`claude-haiku-4-5`), which is significantly cheaper and faster than the main conversation models (`claude-sonnet-4-6` or `claude-opus-4-6`).

### Execution Cost and Optimization Controls
- **[MEASURED]** Auxiliary Execution Controller (`src/core/auxiliary/AuxiliarySessionController.ts:AuxiliarySessionController`):
  Runs with `owner: 'title'` and tool policy `{ kind: 'passive' }`.
- **[MEASURED]** Tools Disabled:
  In `src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts:resolveToolPolicy`:
  Passive policy resolves to `tools: []` and empty `allowedTools`. No tool definitions or schemas are passed to the model.
- **[MEASURED]** Session Persistence Disabled:
  In `src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts:options.persistSession`:
  `options.persistSession = false` when `nativePersistence === 'disabled-if-supported'`. No Claude Code session file is created on disk.
- **[MEASURED]** Extended Thinking Disabled:
  In `src/providers/claude/execution/ClaudeExecutionRequestEncoder.ts:options`:
  `delete options.thinking; delete options.effort;`.
- **[MEASURED]** Early Exit:
  In `src/providers/claude/runtime/claudeColdStartQuery.ts:runPreparedColdStartQuery`:
  Runs with `stopAfterResult: true`, immediately breaking the stream loop upon receiving the result block.
- **[MEASURED]** Input Cap:
  Hard input truncation at 500 characters (`MAX_TITLE_INPUT_LENGTH = 500`).

---

## 4. Storage

### Storage Location
- **[MEASURED]** Stored in the conversation record in a plugin-owned JSON metadata file inside the Obsidian vault under:
  `<vault>/.claudian/sessions/devices/<deviceKey>/<conversationId>.meta.json` (device-scoped metadata)
  *(Legacy paths supported: `.claudian/sessions/<conversationId>.meta.json` or `.claude/sessions/<conversationId>.meta.json`).*
- **[MEASURED]** Neither frontmatter nor sidecar markdown files are used.

### On-Disk Shape (`SessionMetadata`)
- **[MEASURED]** `src/core/types/chat.ts:SessionMetadata` & `src/core/bootstrap/SessionStorage.ts`:
```json
{
  "id": "c7a8e104-e3c7-43b9-9c56-8217db56911c",
  "providerId": "claude",
  "title": "Fix Markdown Link Parsing",
  "titleGenerationStatus": "success",
  "createdAt": 1726359300000,
  "lastActivityAt": 1726359305000,
  "sessionId": "agent-session-uuid",
  "selectedModel": "claude-sonnet-4-6",
  "linkedContentPath": "notes/todo.md",
  "isPinned": false,
  "isArchived": false
}
```

### Write Sites
- **[MEASURED]** Controller level (`src/features/chat/controllers/InputController.ts:triggerTitleGeneration`):
  ```typescript
  await plugin.renameConversation(conversationId, result.title);
  await plugin.updateConversation(conversationId, { titleGenerationStatus: 'success' });
  ```
- **[MEASURED]** Plugin root bridge (`src/main.ts:renameConversation`):
  ```typescript
  async renameConversation(id: string, title: string): Promise<void> {
    await this.conversationRepository.rename(id, title);
    this.notifyConversationViewsChanged();
  }
  ```
- **[MEASURED]** Repository write site (`src/app/conversations/ConversationRepository.ts:rename`):
  ```typescript
  async rename(id: string, title: string): Promise<void> {
    const conversation = this.getSync(id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    await this.save(conversation);
  }
  ```
- **[MEASURED]** File persistence site (`src/core/bootstrap/ConversationPersistenceStore.ts:saveMetadata`):
  ```typescript
  async saveMetadata(
    metadata: SessionMetadata,
    target: SessionMetadataAuthority = 'device',
  ): Promise<void> {
    await this.assertMetadataWriteAuthority(metadata.id, target);
    await this.adapter.write(
      this.getMetadataPath(metadata.id, target),
      JSON.stringify(metadata, null, 2),
    );
  }
  ```

### Read Sites
- **[MEASURED]** Disk read site (`src/core/bootstrap/SessionStorage.ts:readMetadata`):
  ```typescript
  private async readMetadata(
    path: string,
    expectedId: string,
    source: SessionMetadataSource,
  ): Promise<SessionMetadataReadResult | null> {
    const content = await this.adapter.read(path);
    const parsed = JSON.parse(content);
    ...
    const { ...metadataFields } = rawMetadata;
    const metadata = { ...metadataFields, ... } as unknown as SessionMetadata;
    return { metadata, needsMigration, source };
  }
  ```
- **[MEASURED]** Startup scan read (`src/main.ts:onload`):
  ```typescript
  const initialMetadataScan = await StartupProfiler.run('load-session-metadata',
    () => this.loadSessionMetadataWithSources()
  );
  await this.conversationRepository.adoptMetadataConversations(initialEntries);
  ```
- **[MEASURED]** In-memory read (`src/app/conversations/ConversationRepository.ts:get` / `getSync`):
  Provides cached `Conversation` record with `.title` and `.titleGenerationStatus` to views and controllers.

---

## 5. Failure and Absence

### Fallback Labels
- **[MEASURED]** Initial fallback title (`src/features/chat/controllers/ConversationController.ts:generateFallbackTitle`):
  ```typescript
  generateFallbackTitle(firstMessage: string): string {
    const firstSentence = firstMessage.split(/[.!?\n]/)[0].trim();
    const autoTitle = firstSentence.substring(0, 50);
    const suffix = firstSentence.length > 50 ? '...' : '';
    return `${autoTitle}${suffix}`;
  }
  ```
  Immediately applied before LLM generation starts.
- **[MEASURED]** Empty conversation fallback (`src/app/conversations/ConversationRepository.ts:generateDefaultTitle`):
  If the conversation has no messages, title defaults to a localized date/time string:
  ```typescript
  const now = new Date();
  return now.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  ```

### Timeout
- **[MEASURED]** There is **no explicit software timeout** configured on title generation.
- **[MEASURED]** It relies on SDK network timeouts or cancellation via `AbortController` when the generation is cancelled or replaced.

### Failure Handling & Stickiness
- **[MEASURED]** If generation fails (offline, API error, or parse failure):
  - In `InputController.ts:triggerTitleGeneration` callback:
    ```typescript
    } else if (!userManuallyRenamed) {
      await plugin.updateConversation(conversationId, { titleGenerationStatus: 'failed' });
    }
    ```
  - The fallback title is retained.
  - The status is marked as `'failed'` and persisted to disk in the session metadata JSON.
- **[MEASURED]** Failure is **sticky**:
  - A failed title is **not** retried on the next session open, plugin restart, or subsequent turn.
  - The only retry path is manual user intervention via the regenerate button in the history list (`ConversationController.ts:regenerateTitle`).

---

## 6. Update Path and Manual Rename Precedence

### Topic Drift & Regeneration
- **[MEASURED]** The title is **never automatically regenerated** after the first turn.
- **[MEASURED]** `state.messages.length !== 1` aborts any generation attempt on later turns.

### Manual Rename & Precedence Guard
- **[MEASURED]** Users can manually rename a conversation at any time from the history list item menu (`ConversationController.ts:showRenameInput`).
- **[MEASURED]** In-flight race condition guard (`InputController.ts:triggerTitleGeneration` & `ConversationController.ts:regenerateTitle`):
  - Before starting generation, the current title is snapshotted:
    ```typescript
    const expectedTitle = fallbackTitle; // or fullConv.title in regenerateTitle
    ```
  - In the async completion callback:
    ```typescript
    const currentConv = await plugin.getConversationById(conversationId);
    if (!currentConv) return;

    const userManuallyRenamed = currentConv.title !== expectedTitle;

    if (result.success && !userManuallyRenamed) {
      await plugin.renameConversation(conversationId, result.title);
      await plugin.updateConversation(conversationId, { titleGenerationStatus: 'success' });
    } else if (!userManuallyRenamed) {
      await plugin.updateConversation(conversationId, { titleGenerationStatus: 'failed' });
    } else {
      // User manually renamed, clear status; user's choice takes precedence
      await plugin.updateConversation(conversationId, { titleGenerationStatus: undefined });
    }
    ```
  - If the user manually renames while generation is in flight, the AI-generated title is discarded and `titleGenerationStatus` is cleared to `undefined`.

---

## 7. Displayed State

### In-Flight State
- **[MEASURED]** Chat Header / Tab Bar (`src/features/chat/tabs/TabBar.ts`):
  - Immediately displays the synchronous fallback title (`firstSentence`).
  - No spinner or loading indicator is rendered in the tab bar.
- **[MEASURED]** History Dropdown Item (`src/features/chat/controllers/ConversationController.ts:renderConversationItem`):
  - Displays the fallback title text in `.claudian-history-item-title`.
  - In `.claudian-history-item-actions`, if `conversation.titleGenerationStatus === 'pending'`:
    - Renders a spinner icon (`loader-2`) with CSS classes `claudian-action-btn claudian-action-loading` and attribute `aria-label="Generating title..."`.

### Failed State
- **[MEASURED]** In the history dropdown item actions, if `conversation.titleGenerationStatus === 'failed'`:
  - Renders a regenerate button (`refresh-cw` icon) with attribute `aria-label="Regenerate title"`.
  - Clicking this button executes `regenerateTitle(conversation.id)`.

### Succeeded State
- **[MEASURED]** When `titleGenerationStatus === 'success'`:
  - Title text seamlessly updates to the AI title across all views (tab bar, history list).
  - Spinner/regenerate icons are removed.

---

## 8. Transferability to CLI Child-Process Plugin

| Decision | Transferability | Specific Blocker / Architectural Tradeoff |
| :--- | :--- | :--- |
| **D1: Trigger** (on 1st user msg, before assistant reply) | **Fully transferable** | No blocker. Triggering an async task upon dispatching the initial user turn is purely an application/controller orchestration pattern. |
| **D2: Prompt & Input** (500-char input cap, intent system prompt) | **Fully transferable** | No blocker. Pure prompt template construction and string slicing (`slice(0, 500)`). |
| **D3: Model & Cost Control** (Haiku out-of-band ephemeral run) | **Partially transferable / Mechanism differs** | **Blocker/Friction**: Claudian uses in-process `@anthropic-ai/claude-agent-sdk` `query()` with `persistSession: false` and `tools: []`. A CLI-based plugin driving `claude` binary cannot call in-process SDK methods. Spawning a second concurrent `claude` CLI child process incurs process startup latency (1-2s), potential session file pollution in `~/.claude/projects/`, and process contention with the main conversation turn. *Alternative*: If the user provides an Anthropic API key, a direct HTTPS fetch (`fetch("https://api.anthropic.com/v1/messages", ...)`) with Haiku is vastly superior to spawning a CLI process. If CLI-only, run `claude -p --model <haiku>` in a temp workspace or with ephemeral flags. |
| **D4: Storage** (vault JSON metadata file in `.claudian/sessions/...`) | **Fully transferable** | No blocker. Uses standard Obsidian vault adapter file operations. Entirely decoupled from agent runtime. |
| **D5: Failure & Absence** (immediate fallback title, sticky failure, manual retry) | **Fully transferable** | No blocker. Pure local state machine logic. Excellent UX pattern to adopt. |
| **D6: Update Path** (manual rename precedence guard, no topic drift regen) | **Fully transferable** | No blocker. Snapshotting `expectedTitle` and checking `currentConv.title !== expectedTitle` in callback prevents race conditions cleanly. |
| **D7: Displayed State** (fallback title in tab, spinner & retry in history list) | **Fully transferable** | No blocker. Standard DOM manipulation using Lucide icons (`loader-2`, `refresh-cw`). |

---

## What Could Not Be Determined
- **[INFERRED]** Exact upstream Anthropic default timeout for cold start query: Claudian's codebase does not specify an explicit timeout for auxiliary title queries, so it inherits whatever timeout behaviour is baked into `@anthropic-ai/claude-agent-sdk` or Node `fetch`.
