# NotePlan Importer — Design

Date: 2026-08-12
Status: approved, ready for implementation plan

## Goal

Import a NotePlan 3 vault into Memry: calendar (daily) notes become real Memry
journal entries, regular notes become notes, and NotePlan tasks become real
Memry task rows embedded in those notes.

## Source format

Reference export inspected:
`~/Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3/Backups/<stamp>/`

Layout:

```
Calendar/20260812.txt        daily notes (also YYYY-Wnn, YYYY-MM, YYYY-Qn, YYYY)
Notes/**/*.txt               folder tree, markdown content
Filters/                     binary plists + folders.views (not importable)
@Archive/                    archived notes (absent in a fresh install)
@Templates/, @Trash/         created on demand
```

Content facts that drive the design:

- Files are `.txt` containing markdown. NotePlan also writes `.md`; accept both.
- **Title is the first `# H1` line, not the filename.** `start-here.txt` has
  `# Start Here`. Wikilinks resolve by title, and Memry's
  `resolveNotesByTitles` (see `projections/projectors/note-derived-state-projector.ts`)
  does the same — so `[[Start Here]]` survives untouched provided the note is
  created with the H1 as its title.
- YAML frontmatter mixes semantic keys (`type`, `status`, `owner`, `team`,
  `date`, `attendees`, `created`, `folder`) with NotePlan-only styling keys
  (`icon`, `icon-color`, `bg-color`, `bg-color-dark`, `bg-pattern`).
- **List markers are inverted relative to plain markdown**: `*` is a task, `+`
  is a checklist, `-` is a plain bullet.
- Task state markers follow the marker: `[x]` done, `[-]` cancelled, `[>]`
  scheduled/forwarded.
- `>YYYY-MM-DD` inside a task line is its scheduled date.
- `@done(YYYY-MM-DD)` marks completion date.
- Hierarchical hashtags: `#books/decisive`, `#blogs/jamesclear`.
- Indentation is tabs.

## Architecture

Follows the established two-layer importer split: a pure, fs-free mapping
package plus a desktop orchestrator that does IO.

### 1. Pure package — `packages/importers/src/noteplan/`

| Module              | Responsibility                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `NotePlanFile`, `NotePlanPlan`, `NotePlanNote`, `NotePlanJournal`, `ParsedTask`                                   |
| `calendar-dates.ts` | Classify a calendar filename stem into `{ kind: 'day' \| 'week' \| 'month' \| 'quarter' \| 'year', iso?, label }` |
| `convert-body.ts`   | NotePlan markdown → Memry markdown + extracted tasks                                                              |
| `parse-tags.ts`     | Hierarchical `#tag/sub` extraction (mirrors `bear/parse-tags.ts`)                                                 |
| `map-properties.ts` | Split frontmatter into kept properties vs dropped styling keys                                                    |
| `map-files.ts`      | File descriptors → import plan (title, vault folder, journal-vs-note routing)                                     |
| `index.ts`          | Barrel                                                                                                            |

Exported from `packages/importers/package.json` as `./noteplan`.

#### `convert-body` line rules

| NotePlan                | Memry markdown                | DB row               |
| ----------------------- | ----------------------------- | -------------------- |
| `* task`                | `- [ ] task {task:<id>}`      | task, open           |
| `* [x] done`            | `- [x] done {task:<id>}`      | task, completed      |
| `* [-] cancelled`       | `- [x] cancelled {task:<id>}` | task, archived       |
| `* [>] scheduled`       | `- [ ] scheduled {task:<id>}` | task, open           |
| `+ checklist`           | `- [ ] checklist`             | none                 |
| `+ [x] checklist done`  | `- [x] checklist done`        | none                 |
| `- bullet`              | `- bullet`                    | none                 |
| `>YYYY-MM-DD` in a task | stripped from the title       | `dueDate`            |
| `@done(YYYY-MM-DD)`     | stripped from the title       | `completedAt`        |
| tab indentation         | 2-space indentation           | nesting → `parentId` |

Headings, tables, quotes, code fences and plain paragraphs pass through
unchanged.

`convert-body` is id-free: it emits `{np-task:<tempId>}` placeholders and
returns the matching `ParsedTask[]`. The orchestrator creates the real task
rows and swaps each placeholder for `{task:<realId>}` in one pass. This keeps
id generation and DB access out of the pure layer.

**Checklists (`+`) deliberately do not become task rows.** In NotePlan they
carry timeblocks and micro-steps (`+ 08:00 - 09:00 Reply to emails`);
promoting them would flood the Inbox project. Tasks (`*`) are the user's real
tasks. Checklists survive as plain markdown checkboxes, which round-trip
correctly because Memry's task reconciliation only touches lines carrying a
`{task:<id>}` suffix (`tasks/reconcile-markdown-tasks.ts`).

### 2. Orchestrator — `apps/desktop/src/main/import/noteplan/noteplan-importer.ts`

- `fileSpec: { directory: true, allowMultiple: false, defaultPath: <NotePlan container, macOS> }`.
- Accepts the NotePlan data root, a `Backups/<stamp>` folder (identical shape),
  or a bare `Notes/` folder.
- Ignores `Filters/`, `@Trash/`, `Plugins/`, `Caches/`, `.DS_Store`.
- Phase `scanning`: walk the tree, build descriptors.
- Phase `importing`: per item, in this order:
  1. pre-generate the note id (markdown importer pattern — attachments and
     tasks need it before the note exists),
  2. resolve co-located assets,
  3. `createTask(...)` per parsed task with `projectId` = Inbox,
     `sourceNoteId` = note id, `dueDate`, `parentId`,
  4. substitute `{task:<id>}` placeholders,
  5. `createNote(...)` / `createJournalEntry(...)` once with the final body.

  No create-then-update round trip.

Task creation uses the same deps the TickTick importer wires up:
`createDesktopTasksDomain(db, createTasksPublisher(), generateId)` for
`createTask` / `completeTask` / `archiveTask`, and `getInboxProject(db)?.id`
from `@main/database/queries/projects`.

### 3. Routing

```
Calendar/YYYYMMDD.txt        → vault/journal/YYYY-MM-DD.md   (real journal entry)
Calendar/YYYY-Wnn|MM|Qn|YYYY → NotePlan/Calendar/            (journal is day-keyed)
Notes/**                     → NotePlan/<original tree>
@Archive/**                  → NotePlan/Archive/
@Templates/**                → skipped (v1)
```

Journal collision: when an entry already exists for that date, the imported
body is **appended** under an `## Imported from NotePlan` rule. Never
overwrite — a journal entry is user-authored content.

## Two supporting extractions

Both are required by this work, and both land on paths already covered by
existing tests.

### `apps/desktop/src/main/journal/create-entry.ts`

The journal create pipeline — `writeJournalEntryWithContent` →
`syncJournalCache` → `flushProjectionEvents` → `enqueueJournalCreate` →
`initializeJournalCrdt` → emit `ENTRY_CREATED` — is currently inlined three
times inside `ipc/journal-handlers.ts` and is unreachable from anywhere but
IPC. No importer writes journal entries today.

Extract it into one helper; the IPC handlers and the importer both call it.
Handler behaviour (telemetry, event emission, canonical-id resolution via
`getCanonicalJournalByDate`) is preserved exactly.

### `apps/desktop/src/main/import/_shared/co-located-assets.ts`

Asset resolve → `saveAttachment` → body rewrite, including the `realpath`
traversal guard, is currently inline in `markdown-importer.ts` (lines
156-216). Lift it verbatim into `_shared/`, have the markdown importer call
it, and reuse it for NotePlan. The markdown importer's existing
`__fixtures__/nested-assets` integration test guards the move.

## Testing

Pure unit tests (vitest, no fs, no DB):

- `convert-body.test.ts` — every marker × state × indent depth × date form,
  plus pass-through of headings/tables/code fences and the placeholder/task
  pairing.
- `calendar-dates.test.ts` — all five calendar filename shapes plus rejects.
- `map-files.test.ts` — title from H1, filename fallback, folder routing,
  ignored directories.
- `parse-tags.test.ts`, `map-properties.test.ts`.

Integration test `noteplan-importer.test.ts`, against a fixture that mirrors
the real export (`Calendar/`, a nested `Notes/` tree, a `Filters/` folder) on
a real temp vault plus both databases — same harness as
`markdown-importer.test.ts`. Asserts:

- notes created with their H1 as title (so `[[Start Here]]` resolves),
- journal file written at `journal/2026-08-12.md`,
- task rows exist with correct due dates, parent links, and
  completed/archived state,
- `{task:<id>}` suffixes present in the written bodies,
- `Filters/` contributed nothing.

`journal/create-entry.test.ts` covers the extracted helper directly.

## Wiring

- Register in `apps/desktop/src/main/import/register-builtins.ts`.
- `import.sources.noteplan` description plus status strings in
  `packages/i18n/src/locales/en/settings.json`.
- New status/warning codes in `packages/importers/src/messages.ts`.
- `./noteplan` export in `packages/importers/package.json`.

## Out of scope (v1)

- `@Templates/` → Memry templates.
- NotePlan Filters / saved searches (binary plists).
- Promoting inline `#tags` to per-note tag rows beyond frontmatter.
- Re-run deduplication. This is a one-time import, consistent with every other
  importer in the repo.
- NotePlan Spaces / team content.
