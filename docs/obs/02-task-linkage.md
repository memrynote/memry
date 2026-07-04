# Note–Task Linkage — Design

**Date:** 2026-07-05
**Branch:** `obs-task-linkage`
**Status:** Approved, pending implementation

## Goal

Remove the visible `{task:<id>}` suffix (P0.2, decision log #3). A task line in a
`.md` file is plain `- [ ] Buy milk` — indistinguishable from an Obsidian
checkbox — while MemryNote's full task system (tasks table, projects, reminders,
sync) keeps its bidirectional link to that line. The open question this spec
answers: **where does the id live once it is no longer in the file?**

## Current behavior

The taskId lives in three places today; the file is one of them.

- **Serialization** — `packages/shared/src/task-block.ts:34` `serializeTaskBlock`
  emits `- [ ] Title {task:<id>}` (`x` when checked, 2-space indent when
  `parentTaskId`). Called from main writeback
  (`apps/desktop/src/main/sync/blocknote-converter.ts:98`,
  `yDocToMarkdown → blocksToMarkdownPreserving`) and renderer export
  (`content-area/markdown-utils.ts`, `serializeBlocksPreservingBlanks`).
- **Parsing** — `task-block.ts:45` `parseTaskBlockSuffix` + `:74`
  `normalizeTaskBlocks` upgrade suffix checkboxes to `taskBlock` nodes. Runs on
  CRDT seed (`main/sync/blocknote-converter.ts:162` `markdownToYFragment`, called
  by `main/sync/crdt-provider.ts:456` `seedFromMarkdown`) and on renderer load
  (`content-area/hooks/use-editor-sync.ts` `loadContent`). Note: the external-edit
  path (`main/vault/watcher.ts:137` `feedExternalEditToCrdt`) replaces the whole
  fragment via `markdownToBlocks` **without** normalizing — the renderer repairs
  it on next open.
- **Y.Doc (durable, synced)** — `taskBlock` props `{taskId, title, checked,
parentTaskId}` live inside the main-owned Y.Doc, persisted in LevelDB
  (`crdt-provider.ts:109`) and synced as CRDT snapshots. Inside MemryNote the
  Y.Doc, not the file, already carries the linkage.
- **Task rows (data.db, synced)** — `packages/app-core/src/tasks.ts:20,26`
  `sourceNoteId` / `linkedNoteIds`; `:117` `getLinkedTasks(noteId)` powers the
  linked-tasks panel and per-note prefetch. Task rows sync via
  `main/sync/item-handlers/task-handler.ts` (field-level vector clocks).

Flows: `/task` slash command converts the block and creates the task with
`linkedNoteIds: [noteId]` (`task-block/index.tsx:37`). Checkbox toggle in the note
updates props + `tasksService.complete` (`task-block-renderer.tsx:434`). Edits in
the tasks UI flow DB → block props via the sync effect
(`task-block-renderer.tsx:185`) — which also means an **external** `[x]` toggle is
currently reverted to DB state on next open. Writeback: doc change →
`scheduleWriteback` (500 ms debounce, `main/sync/crdt-writeback.ts:120`) → file.

So the suffix matters only at the **file → Y.Doc boundary**: seeding a doc from
disk and re-seeding after an external edit.

## Options considered

|     | Option                                                                              | File bytes                    | Survives external edits                                                          | Notes                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Block anchor `- [ ] Buy milk ^t4x9k2` as id carrier                                 | anchor visible in source mode | yes (anchor is the key)                                                          | Native syntax, enables `[[note#^id]]` — but every task line grows a suffix again, violating decision #3. Still needs a sidecar anchor→taskId map. |
| b   | Pure sidecar mapping (`.memry` DB row → taskId)                                     | fully clean                   | needs re-match heuristics + orphan policy                                        | Matches core principle (Memry state in sidecar). Fragile alone: title edits + reorders outside Memry.                                             |
| c   | **Hybrid: sidecar primary, re-match heuristics, anchor only on explicit user link** | clean by default              | yes (Y.Doc first, sidecar snapshot second, anchor as strongest key when present) | (b) plus opportunistic use of the one in-file metadata Obsidian users accept.                                                                     |

**Recommended: (c).** The Y.Doc is already the durable, synced id carrier; the
sidecar snapshot covers doc loss and external-edit re-matching; a `^anchor` is
emitted only when the user explicitly links to the task, and when present it is
the highest-confidence re-match key.

## Design

### Identity carriers, in priority order

1. **Y.Doc** — `taskBlock.props.taskId`, unchanged. Persisted + synced; covers
   every in-app flow and fresh devices (CRDT snapshot arrives with taskIds).
2. **Sidecar snapshot** — new data.db table `note_task_links` (survives index.db
   rebuild, local-only, not synced — the Y.Doc carries ids across devices):

```ts
// packages/db-schema — data schema
noteTaskLinks: {
  noteId: text, // internal sidecar note id (spec 01 path↔id map)
  taskId: text, // PK
  title: text, // last SERIALIZED title, not live task title
  checked: integer,
  position: integer, // occurrence index in doc order
  anchor: text | null,
  updatedAt: text
}
```

3. **Anchor** — optional `anchor` prop on `TaskBlockProps`; emitted as
   ` ^<anchor>` only when set by an explicit "link to this task" action.

### Writeback (Y.Doc → file)

`serializeTaskBlock` emits the plain line, plus ` ^anchor` when set. After a
successful write, `performWriteback` calls a new pure helper
`collectTaskLinks(blocks)` and replaces the note's `note_task_links` rows in one
transaction. The snapshot always mirrors the bytes just written.

### Seed / re-seed (file → Y.Doc) — the re-match algorithm

`normalizeTaskBlocks(blocks, candidates)` gets candidates from, in order: the
existing fragment's taskBlocks (external-edit path — extracted before the
replace), else `note_task_links` rows (cold seed after doc loss). Each candidate
binds at most once; checklist lines are walked in doc order:

1. **Anchor** — line ends in ` ^id` matching a candidate's anchor → bind.
2. **Legacy suffix** — line still ends in `{task:<id>}` → bind by id, strip
   suffix (pre-production migration path; next writeback emits the clean line).
3. **Exact title** — nth line with title T ↔ nth candidate with title T
   (occurrence-index pairing handles duplicate titles in one note; stable under
   reorder of distinct titles).
4. **Positional fuzzy** — exactly one unmatched line and one unmatched candidate
   left → treat as an external title edit: bind, update the task title through
   the tasks domain. More than one leftover on either side → do not guess.
5. **Unmatched line** → stays a plain `checkListItem` (an Obsidian user's
   checkbox never silently becomes a Memry task — unchanged from today).
6. **Unmatched candidate (orphan)** → line was deleted externally: delete the
   snapshot row, keep the task row (never destroy task data from a file edit);
   it remains reachable via `getLinkedTasks` / the tasks UI.

On every bind, if the file's `[x]` state differs from `task.completedAt`, apply
it through `tasksService.complete/reopen` in main — external toggles now win
instead of being reverted by the renderer sync effect.

### Flow coverage (recommended option)

- **Task created in note** — unchanged (`/task`, checklist promotion); snapshot
  row appears at next writeback.
- **Title edited in note / checkbox toggled in note** — unchanged renderer flows;
  writeback refreshes file + snapshot together.
- **Title edited in tasks UI** — DB → props sync effect updates the open note's
  doc → writeback. Closed notes keep the stale serialized title (same as today);
  the snapshot equals the file, so matching stays consistent until next open.
- **Checkbox toggled externally** — re-match step applies it to the task (fixed
  behavior, see above).
- **Note renamed/moved internally** — noteId stable, rows untouched. Externally —
  depends on spec 01's path↔id rename detection; if the move is detected as
  delete+create the links orphan per rule 6 (cross-ref 01).
- **Duplicate titles** — rule 3; worst case two identical-title tasks swap ids
  after an external reorder (accepted, titles identical by definition).
- **Task deleted in tasks UI** — delete its `note_task_links` rows; the ghost
  block serializes as a plain checkbox and parses back as one.
- **External reorder** — title matches are order-independent (rule 3).
- **CRDT** — re-match runs in main inside the existing `ORIGIN_LOCAL` transaction
  (`feedExternalEditToCrdt`); renderer receives it via the IPC provider like any
  main-originated update, so `sourceWindowId` loop-guarding is untouched. Task DB
  writes go through the tasks domain so events fire and vector clocks bump.
  Rebinding props re-serializes to identical bytes — spec 04's no-semantic-change
  guard suppresses the echo write.

## Implementation plan

1. `packages/db-schema` — add `note_task_links` to the data schema; run
   `pnpm --filter @memry/desktop db:generate`.
2. `packages/shared/src/task-block.ts` — `TaskBlockProps.anchor?`; plain-emit
   `serializeTaskBlock`; add `parseTaskAnchor` (trailing ` ^[A-Za-z0-9-]+`);
   add `matchTaskCandidates(lines, candidates)` implementing rules 1–6 as a pure,
   heavily-tested function; rework `normalizeTaskBlocks(blocks, candidates)` on
   top of it (keep `parseTaskBlockSuffix` internal for rule 2).
3. `apps/desktop/src/main/database/queries/` — new `note-task-links.ts`
   (get/replace-for-note, delete-by-task).
4. `apps/desktop/src/main/sync/blocknote-converter.ts` —
   `markdownToYFragment(markdown, fragment, candidates)`; thread candidates.
5. `apps/desktop/src/main/sync/crdt-provider.ts` — `seedFromMarkdown` loads
   candidates from `note_task_links`.
6. `apps/desktop/src/main/vault/watcher.ts` — `feedExternalEditToCrdt`: extract
   current taskBlocks as candidates, normalize (also fixes the missing
   normalize today), apply checked/title diffs via the tasks domain.
7. `apps/desktop/src/main/sync/crdt-writeback.ts` — after write, replace
   snapshot rows from `collectTaskLinks`.
8. Tasks domain delete path — remove `note_task_links` rows for deleted tasks.
9. Renderer — `content-area/markdown-utils.ts` inherits plain emit from shared;
   update `task-block-utils` re-exports; add the explicit "Copy block link"
   action that stamps a generated 6-char anchor (last, independently shippable).
10. Migration sweep — on vault open, notes whose cache content contains `{task:`
    get seeded (rule 2 binds) and re-serialized once; suffix disappears.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test:desktop`.
- New shared tests (`task-block` suite): plain emit ± anchor/indent/checked;
  anchor parse; legacy suffix bind+strip; exact-title bind; duplicate titles ×
  reorder; external title edit (single-leftover fuzzy); ambiguous leftovers → no
  guess; deleted line → orphan candidate; plain checkbox stays plain.
- `blocknote-converter.test.ts` — markdown ↔ fragment round-trip with plain task
  lines and candidate binding.
- Watcher-level external-edit test: toggle `[x]` in the file → task completed;
  reorder + retitle file → ids preserved per rules.
- `task-block-utils.test.ts` / `task-block-renderer.test.tsx` updated for the
  new signatures. Docs gate per CLAUDE.md.

## Interactions

- **01-frontmatter-diet** — `noteId` in `note_task_links` is the internal
  sidecar id from 01's path↔id map; external rename detection there decides
  whether task links survive an out-of-app move.
- **04-byte-preservation** — rebind-only reseeds must not produce a byte-diff
  write; golden round-trip fixtures must include plain task lines, duplicate
  titles, and one anchored line.
- **06-foreign-syntax-preservation** — user-authored `^block-ids`, Tasks-plugin
  emoji, and Dataview fields on checkbox lines are preserved verbatim; only
  anchors recorded in `note_task_links` are treated as task anchors, and emoji
  metadata round-trips inside the stored title unchanged.

## Resolved questions (Kaan, 2026-07-05)

1. **Positional fuzzy (rule 4) ships in v1.** The single-leftover constraint
   (exactly one unmatched line + exactly one unmatched link) makes false
   positives rare, while external title edits are the common case fuzzy heals.
   Known accepted risk: a delete+add of exactly one task each in a single
   external edit session mis-binds; golden tests must include this case as a
   documented limitation.
2. **`note_task_links` stays local-only, never a synced item type.** Y.Doc
   snapshot sync already carries taskIds across devices; re-match rebuilds the
   table from the doc.
3. **Explicit anchor action: task block context menu only in v1.**
   Drag-to-link from the tasks panel is a future enhancement, not in scope.
