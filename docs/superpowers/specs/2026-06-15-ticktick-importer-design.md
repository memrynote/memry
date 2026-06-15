# TickTick CSV Importer — Design Spec

**Date:** 2026-06-15
**Branch:** `import-tictick`
**Status:** Approved design → implementation

## 1. Goal

Let a TickTick user migrate their tasks into Memry by importing a TickTick
**backup `.csv`** export. The importer transforms the CSV into Memry-native
**projects, tasks (with subtasks), kanban statuses, tags, reminders, and repeat
rules**, written through the existing task domain layer so imported items are
indexed and sync-queued like any other task.

Offline, no auth, no network — fits Memry's offline-first + E2E-encrypted ethos.
This mirrors the sibling `notion-import` design (pure transform package + thin
desktop I/O service), adapted from notes to tasks.

## 2. Non-goals

- TickTick API / OAuth. The transform layer stays pure so an API source could
  plug in later.
- Round-trip / re-sync / dedup. This is a one-shot import; re-running creates
  fresh rows (decision: "always create fresh").
- Project **folders** — TickTick `Folder Name` has no Memry equivalent (projects
  are flat). Dropped, reported as a warning. (Empty in the reference export.)
- Importing TickTick "notes" as Memry **notes**. Every CSV row becomes a
  **task**; a rare TickTick note-kind row becomes a task carrying its content.

## 3. Ground truth (verified against the real export)

Reference file: `TickTick-backup-2026-06-15.csv` (322 lines, Version 7.2).

1. **Preamble before the header.** The file opens with metadata records —
   `"Date: …"`, `"Version: 7.2"`, and a **multiline** `"Status: …"` legend —
   each a single-column CSV record, _before_ the real 25-column header row whose
   first cell is `"Folder Name"`. The parser must locate that header row, not
   assume row 0.
2. **UTF-8 with BOM.** First byte is `0xFEFF`. Strip it (same as
   `notion-import/parse-csv.ts`).
3. **25 columns** (header order):
   `Folder Name, List Name, Title, Kind, Tags, Content, Is Check list,
Start Date, Due Date, Reminder, Repeat, Priority, Status, Created Time,
Completed Time, Order, Timezone, Is All Day, Is Floating, Column Name,
Column Order, View Mode, taskId, parentId, projectKind`.
4. **Lists** (`List Name`) in the data: `Inbox` (218), `Books` (41),
   `Video Tutorial` (31), `Articles` (16), plus a few blank. `Inbox` maps to
   Memry's existing inbox project (`getInboxProject()`), never duplicated.
5. **`Content` is multiline** and free-form: URLs, prose, and embedded markdown
   checklists (`- [ ] … - [x] …`). Kept **verbatim** as `task.description`.
6. **Hierarchy** via integer `taskId` / `parentId` (per-export, small ints).
   Parent first row has `taskId="1"`, `parentId=""`; children carry
   `parentId="1"`. (Note: `taskId`/`parentId` are blank for many rows — those
   are top-level tasks.)
7. **Kanban** lists carry `Column Name` (e.g. `To Do`, `Currently Watching...`)
   - `Column Order` (large signed ints, sort keys) + `View Mode=kanban`.
     List-view lists have empty `Column Name`.
8. **Priority** values seen: `0`, `3`, `5` (TickTick scale 0/1/3/5).
9. **Status** values seen: `0` (active) and `2` (completed — rows with `2` have
   a `Completed Time`). The file's own legend is unreliable; treat completion by
   data, not legend.
10. **Dates** are tz-aware ISO: `2020-08-28T07:59:18+0000`. `Is All Day` and
    `Timezone` columns present; `Is Floating` too.
11. **Reminder** = ISO-8601 duration offset from the due datetime:
    `PT0S` (at due), `-PT1440M` (1440 min before). Multiple may be
    `;`-separated.
12. **Repeat** = clean RRULE (no `RRULE:` prefix):
    `FREQ=YEARLY;INTERVAL=1`, `FREQ=YEARLY;INTERVAL=1;BYMONTH=4;BYMONTHDAY=4`,
    `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15`.

## 4. Architecture (Approach A — mirrors `notion-import`)

```
packages/ticktick-import/                ← PURE transform (no fs, no electron, no db)
  src/
    types.ts          TickTickRow, ImportPlan, ProjectPlan, StatusPlan,
                      TaskPlan, ReminderPlan, RepeatConfig, ImportWarning
    parse-csv.ts      BOM-safe RFC-4180 tokenizer (reused from notion-import) →
                      string[][]; + parseTickTickCsv(): finds the "Folder Name"
                      header, maps the 25 columns → TickTickRow[]
    map-rows.ts       mapRows(rows, { now }): TickTickRow[] → ImportPlan
                      (projects, statuses, tasks w/ resolved parentId/projectId/
                      statusId/tags/dates/priority/completed, reminders, repeat)
    rrule.ts          rruleToRepeatConfig(rrule): RepeatConfig | null
    duration.ts       parseIsoDurationMs(token): number | null  (for reminders)
    dates.ts          TickTick tz-aware datetime → { date, time } in task tz
    priority.ts       TickTick 0/1/3/5 → Memry 0/1/2/3
    index.ts          barrel
  test/               vitest unit tests + fixtures lifted from the real CSV

apps/desktop/src/main/import/ticktick/   ← I/O + DB orchestration (Node/electron)
  ticktick-import-service.ts
                      read file → parseTickTickCsv → mapRows → applyPlan within a
                      single better-sqlite3 transaction via the tasks domain layer
                      (createTaskDomain) + reminders service; returns ImportSummary
  ticktick-import-service.test.ts   in-memory DataDb integration test

packages/contracts/src/ticktick-import-api.ts        ← IPC contract (channel + zod)
apps/desktop/src/main/ipc/ticktick-import-handlers.ts ← IPC handler (dialog + run)
apps/desktop/src/preload/api/ticktick-import.ts       ← preload wrapper

apps/desktop/src/renderer/.../pages/settings/import-section.tsx  ← Settings → Import
apps/desktop/src/renderer/.../import/use-ticktick-import.ts      ← renderer hook
```

**Why a separate pure package:** the parsing + RRULE/duration/date mapping is
pure and fully unit-testable without electron/fs/db, matching the established
`notion-import` and `app-core` conventions. The desktop service is thin glue.

**Why the domain layer (not raw inserts):** routing creates through
`createTaskDomain(db)` (`createProject`, `createCustomStatuses` /
`createDefaultStatuses`, `createTask`, `setTaskTags`) and
`createRemindersService(db)` ensures imported tasks are published, search-indexed
and sync-queued — the same path the existing task IPC handlers use.

## 5. Data model (key interfaces — pure package)

```ts
// One CSV data row, typed from the 25 columns.
interface TickTickRow {
  folderName: string
  listName: string // '' → treated as Inbox
  title: string
  kind: string // TEXT | NOTE | CHECKLIST | ...
  tags: string[] // split on ',' + trim, lowercased
  content: string // verbatim, may be multiline
  isCheckList: boolean
  startDate: string // raw tz-aware ISO or ''
  dueDate: string
  reminder: string // raw, may hold ;-separated ISO durations
  repeat: string // raw RRULE or ''
  priority: number // raw TickTick 0/1/3/5
  status: number // 0 active, 2 completed, -1 won't-do
  createdTime: string
  completedTime: string
  order: string // signed int sort key (BigInt-compared)
  timezone: string // IANA, e.g. Europe/Istanbul
  isAllDay: boolean
  isFloating: boolean
  columnName: string // kanban column, '' for list view
  columnOrder: string // signed int sort key
  viewMode: string // kanban | list | ''
  taskId: string // per-export id, '' allowed
  parentId: string // references another row's taskId, '' allowed
  projectKind: string // TASK | NOTE
}

// Mirrors apps/desktop .../data/task-model.ts RepeatConfig, pre-serialized
// for the service layer (dates as 'YYYY-MM-DD' strings, createdAt ISO).
interface RepeatConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[] // 0=Sun..6=Sat
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  weekOfMonth?: number // 1-5 (5=last)
  dayOfWeekForMonth?: number
  endType: 'never' | 'date' | 'count'
  endDate?: string | null // 'YYYY-MM-DD'
  endCount?: number
  completedCount: number // 0 on import
  createdAt: string // ISO
}

interface StatusPlan {
  tempId: string
  name: string
  position: number
  isDefault: boolean
  isDone: boolean
}
interface ProjectPlan {
  tempId: string // local key used to wire tasks/statuses
  name: string
  useExistingInbox: boolean // true → bind to getInboxProject() at apply time
  statuses: StatusPlan[]
}
interface ReminderPlan {
  remindAt: string
  note?: string | null
} // absolute ISO
interface TaskPlan {
  tempId: string // from TickTick taskId (or synthetic)
  projectTempId: string
  parentTempId: string | null
  statusTempId: string | null
  title: string
  description: string | null
  priority: number // mapped 0-3
  position: number // derived from Order
  startDate: string | null // 'YYYY-MM-DD'
  dueDate: string | null
  dueTime: string | null // 'HH:mm' or null when all-day
  completedAt: string | null // ISO
  archivedAt: string | null // ISO (won't-do)
  createdAt: string | null
  tags: string[]
  repeatConfig: RepeatConfig | null
  repeatFrom: string | null
  reminders: ReminderPlan[]
}
interface ImportWarning {
  row?: number
  field?: string
  message: string
}
interface ImportPlan {
  projects: ProjectPlan[]
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: { rows: number; projects: number; tasks: number; subtasks: number; reminders: number }
}
```

The transform produces an `ImportPlan` **without touching the db/filesystem**.
The service executes it. This is the unit-test seam.

## 6. Mapping rules (`map-rows.ts`)

1. **Projects.** Group rows by `listName` (blank → `Inbox`). One `ProjectPlan`
   per distinct list. `Inbox` → `useExistingInbox: true`; others → new project.
2. **Statuses.** Per project, if any row has a non-empty `columnName` → kanban:
   build distinct columns sorted by `columnOrder` (BigInt compare); first =
   `isDefault`, a column whose name matches `/done|complete/i` → `isDone`.
   Otherwise (list view) → the standard default statuses
   (`To Do` / `In Progress` / `Done`) via `createDefaultStatuses`.
3. **Task identity & hierarchy.** Build `taskId → tempId` first; rows with blank
   `taskId` get a synthetic tempId. Resolve `parentTempId` from `parentId`
   (drop the link + warn if the parent isn't in the file). Parent and child may
   sit in any order in the CSV.
4. **Status assignment.** Kanban list → `statusTempId` = the row's column.
   List view → completed rows → `Done` status, else `To Do`.
5. **Priority.** `0→0, 1→1, 3→2, 5→3` (`priority.ts`); unknown → 0 + warn.
6. **Completion.** `completedAt` = `Completed Time` if present, else `now` when
   `status === 2`. `status === -1` (won't-do) → `archivedAt = now`.
7. **Description.** `content` verbatim (or `null` if empty).
8. **Tags.** `Tags` split on `,`, trimmed, lowercased, de-duplicated.
9. **Dates** (`dates.ts`). Parse the tz-aware ISO instant; render `date`
   (`YYYY-MM-DD`) and, when `Is All Day` is false, `time` (`HH:mm`) in the row's
   `Timezone` (fallback: the instant's own offset). `Start Date` → `startDate`
   (date only — schema has no start time). `Due Date` → `dueDate` (+ `dueTime`).
   `Created Time` → `createdAt`.
10. **Reminders** (`duration.ts`). For each `;`-separated ISO duration in
    `Reminder`, compute `remindAt = dueInstant + signedOffset` (negative =
    before). Anchor: due datetime; if all-day, the due date's local midnight.
    No due/start anchor, or unparseable token → skip that reminder + warn.
11. **Repeat** (`rrule.ts`). `rruleToRepeatConfig`: `FREQ→frequency`,
    `INTERVAL→interval`, `BYDAY→daysOfWeek`, `BYMONTHDAY→dayOfMonth`
    (`monthlyType='dayOfMonth'`), `BYDAY+BYSETPOS→weekOfMonth+dayOfWeekForMonth`
    (`monthlyType='weekPattern'`), `UNTIL→endDate` (`endType='date'`),
    `COUNT→endCount` (`endType='count'`), else `endType='never'`.
    `repeatFrom` = `startDate ?? dueDate`. Unknown/empty FREQ (e.g. HOURLY) →
    `null` + warn (task still imports without repeat).
12. **Position.** Within a project/status, order tasks by the `Order` column
    (BigInt compare), assigning sequential `position`.
13. **`Folder Name`** is recorded once as a warning if any row has one (no Memry
    target); otherwise ignored.

## 7. Service (`ticktick-import-service.ts`)

Given a `.csv` absolute path:

1. Read the file (UTF-8). `parseTickTickCsv` → rows. `mapRows(rows, { now })` →
   `ImportPlan`.
2. Open a single better-sqlite3 transaction.
3. For each `ProjectPlan`: bind to `getInboxProject()` when `useExistingInbox`,
   else `createProject`. Create statuses (`createCustomStatuses` for kanban,
   `createDefaultStatuses` otherwise). Build `tempId → real id` maps for
   projects + statuses.
4. For each `TaskPlan` (parents before children so `parentId` resolves):
   `createTask` with mapped `projectId`/`statusId`/`parentId` + dates/priority/
   completion/repeat; `setTaskTags`; create each reminder via the reminders
   service with `targetType:'task'`, the new `taskId`, and `remindAt`.
5. Commit. Return `ImportSummary { stats, warnings }`.
6. On any hard failure the transaction rolls back — no partial import.

Logging via `createLogger('TickTickImport')`; user-facing errors via
`extractErrorMessage`. Tag definitions: optionally insert a `tag_definitions`
row (default color) for new tag names so they render colored; skip if one
exists.

## 8. IPC + UX

- **Contract** `packages/contracts/src/ticktick-import-api.ts`: one invoke
  channel `ticktick-import:run` (Zod request/response: `{}` →
  `ImportSummary`), registered in `ipc-channels.ts`. Run `pnpm ipc:generate`
  then `pnpm ipc:check`.
- **Handler** `ticktick-import-handlers.ts`: `dialog.showOpenDialog`
  (`filters: [{ name: 'CSV', extensions: ['csv'] }]`, `properties:['openFile']`,
  reusing the `notes-handlers.ts` pattern) → run service → return summary
  (`{ canceled: true }` if the picker is dismissed).
- **Preload** `preload/api/ticktick-import.ts` → exported from `preload/api/index.ts`.
- **UI** new Settings **Data → Import** section (`import-section.tsx`,
  registered as a nav item + conditional render in `settings.tsx`):
  an "Import from TickTick (CSV)" button → calls the IPC → shows a loading state
  → result panel: "Imported N projects, M tasks (K subtasks), R reminders;
  S rows skipped" + an expandable warnings list. On success the renderer
  invalidates the task queries once (`taskKeys.all`).

## 9. Error handling

- Non-CSV / missing header / empty file → friendly error, no writes.
- Per-row mapping failure → skip that row, record a warning, continue.
- Unparseable reminder/RRULE/date → skip just that facet (task still imports) +
  warning.
- Missing parent reference → task imported top-level + warning.
- Whole apply is transactional: a hard DB error rolls back everything.

## 10. Testing (TDD)

- **Pure package (vitest, node):** fixtures lifted from the real CSV.
  - `parse-csv.test.ts` — BOM strip, quoted/embedded-comma/**multiline**
    fields, `""` escapes, preamble skipping, header detection.
  - `priority.test.ts`, `duration.test.ts`, `dates.test.ts` (incl. all-day +
    timezone), `rrule.test.ts` (YEARLY/MONTHLY/WEEKLY + BYMONTHDAY/BYDAY/UNTIL/
    COUNT + unknown-FREQ → null).
  - `map-rows.test.ts` — Inbox list-view, `Video Tutorial` kanban + subtasks,
    completed → `completedAt`, tags, priority, position ordering, reminders,
    repeat, won't-do → `archivedAt`, dropped-folder warning, missing-parent
    warning. Injected `now` for determinism.
- **Service (vitest, node):** in-memory `DataDb` → run service against a fixture
  CSV → assert projects/statuses/tasks/subtasks/tags/reminders written + summary
  counts; assert Inbox bound to the existing inbox project (not duplicated).
- **Manual validation:** run against the real backup via the Settings UI in a
  dev profile; confirm counts, subtask nesting, kanban columns, a completed
  task, a tagged task, a repeating task.
- Privacy: committed fixtures are small synthetic/redacted rows, not the full
  personal backup.

## 11. Decisions (approved)

- Source = TickTick backup `.csv` (offline).
- Entry point = Settings → Import + file picker.
- Fidelity = **full**: projects, kanban statuses, subtasks, tags, priority,
  start/due (+all-day) dates, completion, created time, content→description,
  **reminders** and **repeat rules**.
- Re-import = **always create fresh** (no dedup).
- `Content` = **verbatim** → `description` (no checklist→subtask parsing).

## 12. Follow-ups (out of scope for v1)

- Idempotent re-import (store a TickTick source id; skip/update existing).
- Checklist (`- [ ]` in `Content`) → real subtasks.
- TickTick "note" items → Memry notes (not tasks).
- Project folders if Memry gains a project-grouping concept.
- A CLI entry point over the same pure package (`app-core` pattern).
- TickTick API source plugged into the same transform.
