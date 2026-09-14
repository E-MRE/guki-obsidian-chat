# FROZEN CONTRACT — Phase 7 / Task 9

Frozen by the orchestrator before fan-out. No lane may change anything in this file. A lane that
believes the contract is wrong must stop and escalate to the orchestrator instead of adapting it.

Branch for every lane: `feat/gorev-9-baslik`. Do not create branches; you are already on it.

## 0. What this task is (and is not)

Measured: the Claude Code CLI already writes `ai-title` records for this plugin's sessions on CLI
>= 2.1.268 (17 of 18 in the real corpus). **No lane generates a title with a model call.** There is
no `claude -p` invocation, no network call, no API key, in any part of this task.

Three features:
- **F1** refresh the open history list when a title arrives.
- **F2** manual rename of a conversation, persisted, overriding the CLI title.
- **F3** the panel header shows the conversation's name; `GuKi Chat` when it has none.

## 1. New module: `src/data/conversation-titles.ts`

```ts
export interface StoredTitle { title: string; updatedAt: number }
export type ConversationTitleMap = Record<string, StoredTitle>;

export class ConversationTitleStore {
  constructor(initial: ConversationTitleMap | undefined,
              save: (map: ConversationTitleMap) => Promise<void>);
  /** The user-given name, or undefined. Never returns an empty string. */
  get(sessionId: string): string | undefined;
  /** Empty or whitespace-only title REMOVES the entry (this is the documented undo path). */
  set(sessionId: string, title: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  /** Drops entries whose sessionId is not in `existingIds`. Returns true if anything was
   *  removed. Saves only when something changed. */
  pruneTo(existingIds: Iterable<string>): Promise<boolean>;
  /** Defensive copy for checks and for persistence. */
  snapshot(): ConversationTitleMap;
}
```

Invariants:
- `set` trims the title before storing and stamps `updatedAt: Date.now()`.
- The store never writes to disk itself; it calls the injected `save` callback.
- A malformed persisted map (not an object, entries missing `title`) degrades to empty rather
  than throwing. An old install with no `conversationTitles` key behaves exactly as today.

## 2. `SessionSummary` gains one field — `src/data/session-index.ts`

```ts
customTitle?: string;   // the user-given name; NEVER set by scanSessionsDir
```

`scanSessionsDir` and `buildSessionSummary` must not know this field exists. Only the overlay in
§3 sets it. Görev 8's honesty rule stands: `title` stays the CLI's `ai-title` and `derivedTitle`
stays our first-message trim. **Do not smuggle a custom title into `title`.**

## 3. The single seam — `NodeTranscriptStore.listSessions`

```ts
constructor(basePath?: string, titles?: ConversationTitleStore)
```

`listSessions(vaultPath)`:
1. scan as today,
2. set `customTitle` on each summary from `titles?.get(sessionId)`,
3. prune dead entries: `titles?.pruneTo(ids of the scanned sessions)`.

**Prune safety invariant (mandatory):** never prune when the scan returned zero sessions. A
temporarily unreadable directory must not wipe every name the user has given. A check must cover
this case specifically.

Nothing else in the codebase resolves a custom title. Any other call site that needs one calls
`listSessions` or the functions in §4.

## 4. Precedence lives in exactly one place — `src/data/session-index.ts`

```ts
export type TitleSource = 'custom' | 'ai' | 'derived' | 'none';
export function resolveSessionTitle(s: SessionSummary): { text: string; source: TitleSource };
export function panelTitleFor(s: SessionSummary | null | undefined): string | null;
```

- `resolveSessionTitle`: `customTitle` > `title` > `derivedTitle` > `'Untitled session'`
  (source `'none'`).
- `panelTitleFor`: returns the text when the source is `'custom'` or `'ai'`; returns **`null`**
  for `'derived'` and `'none'`. A derived first-message trim is NOT a name and must never appear
  in the panel header.
- `sessionDisplayTitle` keeps its current signature and delegates to `resolveSessionTitle`
  (`isDerived === (source === 'derived')`).
- `shapeSessionRow` in `src/ui/history-dropdown.ts` must call `resolveSessionTitle` instead of
  duplicating the precedence inline. `isDerivedTitle` is true only for source `'derived'`.

No second copy of this rule anywhere. A lane that finds itself writing `??` over these fields
outside these two functions is violating the contract.

## 5. Persistence — no new store

`GukiChatSettings` gains `conversationTitles?: ConversationTitleMap`. It is persisted through the
existing `plugin.saveData(this.settings)` path in `src/main.ts` only.

**Mandatory:** every save writes the WHOLE settings object. Writing a partial object would erase
the permission settings and the slash-command list that live in the same `data.json`.

No new file, no sidecar, no vault-visible artifact, no new dependency.

## 6. Forbidden in every lane

- No model call, no network, no `claude -p`.
- No polling timer or filesystem watcher. The refresh signal is the existing turn-end callback.
- No new npm dependency.
- No change to Görev 8's paging, resume, or transcript translation behavior.
- No `git add -A` (it sweeps up other lanes' files); stage only the files your lane touched.
- No branch creation, no merge, no push, no history rewriting.

## 7. Checks — the standard for this task

Command: `npm run check:offline`. Baseline at the start of this task: **1858 assertions, all green.**
Full gate: `npm test` (capture + docs + offline) and `npm run build`.

**Red-run rule (mandatory, no exceptions):** for every new check you add, you must first run it
against the UNFIXED code and show it failing, then implement, then show it passing. Paste both
outputs in your handoff. A check written after the fix, never observed failing, is not accepted as
evidence and the lane will be sent back.

Checks assert the mechanism, not only the rendered text, wherever the requirement is a mechanism
(for example: "the list did not rescan" must be measured with a scan counter, not inferred from
the screen).
