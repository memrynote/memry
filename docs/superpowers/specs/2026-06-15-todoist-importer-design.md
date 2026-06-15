# Todoist CSV Importer — Design Spec

**Date:** 2026-06-15
**Branch:** `import-todoist`
**Status:** Approved design → implementation

## 1. Goal

Let a Todoist user migrate a project into Memry by importing a Todoist
**project `.csv`** export. The importer transforms each CSV into one Memry
**project** holding its **tasks** (with sub-tasks, priority, best-effort due
dates, and comments folded into descriptions), written through the existing
task **domain layer** so imported items are indexed and sync-queued like any
other task.

Offline, no auth, no network — fits Memry's offline-first + E2E-encrypted ethos.
Mirrors the sibling `import-tictick` / `notion-import` designs: **pure transform
package + thin desktop I/O service + contract/handler/preload + Settings →
Import UI**. Two deliberate deviations from TickTick: (1) **preview-then-confirm**
(two IPC channels, not a single direct run); (2) **narrower fidelity** — Todoist
project CSV has no tags / status / kanban / reminder columns, so those are out.

## 2. Non-goals

- Todoist API / OAuth. The transform layer stays pure so an API source could
  plug in later.
- Round-trip / re-sync / dedup. One-shot import; re-running creates fresh rows
  (decision: "always create fresh").
- **Sections** (`TYPE=section`). Memry projects are flat (statuses are kanban
  columns, not Todoist sections). Tasks under a section are **flattened** into
  the project; each section name is reported as a warning. (None in the
  reference export.)
- **Reminders / repeat rules.** Todoist project CSV carries no reminder column;
  recurring due strings ("every day") are English phrases with no anchor date,
  so they are **not** converted to Memry repeat rules in v1 (task imports with
  no due date + a warning). Listed as a follow-up.
- **Attachment download.** Image/file comments become a markdown link in the
  task description; bytes are not fetched from `files.todoist.com`.
- **ZIP backups.** Todoist's full export is a `.zip` of per-project CSVs.
  v1 accepts raw `.csv` files only (multi-select supported). ZIP extraction is a
  follow-up.
- Labels (`@label`) and section refs (`#name`) embedded in task content are kept
  **literal** in the title (no tag conversion in v1).

## 3. Ground truth (verified against the real export)

Reference file: `Kişisel.csv` ("Personal", single project, 8 lines).

1. **15-column header (row 0):**
   `TYPE, CONTENT, DESCRIPTION, IS_COLLAPSED, PRIORITY, INDENT, AUTHOR,
RESPONSIBLE, DATE, DATE_LANG, TIMEZONE, DURATION, DURATION_UNIT, DEADLINE,
DEADLINE_LANG`.
2. **`TYPE` drives the row kind:** `meta` (first row, `CONTENT=view_style=list`
   — ignored), `task`, `note`, `section`, or **blank** (separator row — skipped).
3. **The project name is not in the file** — only `meta` `view_style`. The
   **filename** is the project name (`Kişisel.csv` → "Kişisel").
4. **`task` rows** seen:
   - `go home` — `PRIORITY=4`, `INDENT=1`, no date.
   - `repair` — `PRIORITY=4`, `INDENT=1`, `DATE="in 2 days"`, `DATE_LANG=en`,
     `TIMEZONE=Europe/Istanbul`.
   - `repair home` — `PRIORITY=2`, `INDENT=1`, `DATE="in 7 days"`.
5. **`PRIORITY` is 1–4, inverted:** `4`=P1 (highest), `3`=P2, `2`=P3, `1`=P4
   (no priority / default).
6. **`INDENT` is ≥1:** `1`=top-level; `n>1`=sub-task of the nearest preceding
   task at indent `n−1`.
7. **`DATE` is free-form, often relative** ("in 2 days", "in 7 days") and may be
   absolute ("2026-06-20"), named ("Jun 20"), keyword ("today"/"tomorrow"), or
   recurring ("every day"). `DATE_LANG` + `TIMEZONE` qualify it.
8. **`note` rows** are comments on the **preceding `task`** (or project, if
   before any task). `CONTENT` is comment text **or** an attachment token:
   `[[file {"file_name":…,"file_url":…,"image":…,…}]]` — note the JSON contains
   commas and escaped quotes, so the CSV parser must handle quoted fields with
   embedded commas/quotes. The reference note is an image attachment.
9. **`DEADLINE`** is a separate clean date (Memry has no deadline field).
   **`DURATION` / `DURATION_UNIT`** describe task duration (no Memry field).

## 4. Architecture (mirrors `notion-import` / `import-tictick`)

```
packages/todoist-import/                  ← PURE transform (no fs, electron, db)
  src/
    types.ts        TodoistRow, ImportPlan, ProjectPlan, TaskPlan, ImportWarning, ImportStats
    parse-csv.ts    RFC-4180 tokenizer (quoted fields, embedded commas/quotes/
                    newlines, "" escapes) → string[][]; + parseTodoistCsv():
                    maps the 15 columns by header → TodoistRow[]
    map-rows.ts     mapRows(rows, projectName, { now }): TodoistRow[] → ImportPlan
                    (one project; tasks w/ resolved parentTempId, priority, dates,
                    folded comments; warnings; stats)
    dates.ts        resolveDueDate(raw, { now, lang }): { date, time } | null
                    (absolute ISO/named, relative "in N units", today/tomorrow,
                    weekday; recurring "every…" → null + warn)
    priority.ts     todoistPriorityToMemry(n): 0|2|3|4
    attachments.ts  parseAttachmentToken(content): { name, url } | null;
                    commentToMarkdown(content): string
    index.ts        barrel
  test/             vitest unit tests + small synthetic fixtures

apps/desktop/src/main/import/todoist/      ← I/O + DB orchestration (Node/electron)
  todoist-import-service.ts
                    read file(s) → parseTodoistCsv → mapRows → applyPlan
                    sequentially via the tasks domain layer
                    (createProject + createTask); returns ImportSummary
  todoist-import-service.test.ts   in-memory DataDb integration test

packages/contracts/src/todoist-import-api.ts          ← IPC contract (channels + zod)
apps/desktop/src/main/ipc/todoist-import-handlers.ts   ← IPC handlers (dialog + run)
apps/desktop/src/preload/api/todoist-import.ts         ← preload wrapper

apps/desktop/src/renderer/.../pages/settings/import-section.tsx ← Settings → Import
apps/desktop/src/renderer/.../import/use-todoist-import.ts      ← renderer hook
apps/desktop/src/renderer/.../import/todoist-import-preview-dialog.tsx ← preview UI
```

**Why a separate pure package:** parsing + date/priority/attachment mapping is
pure and fully unit-testable without electron/fs/db, matching `notion-import`,
`import-tictick`, and `app-core` conventions. The desktop service is thin glue.

**Why the domain layer (not raw inserts):** routing creates through the desktop
tasks domain (`createDesktopTasksDomain(db, publisher, generateId)` →
`createProject`, `createTask`) ensures imported tasks are published,
search-indexed and sync-queued — the same path the task IPC handlers use.

## 5. Data model (pure package)

```ts
// One CSV data row, typed from the 15 columns. Unused columns
// (AUTHOR, RESPONSIBLE, IS_COLLAPSED, *_LANG) are parsed but mostly ignored.
interface TodoistRow {
  type: 'task' | 'note' | 'section' | 'meta' | ''
  content: string // title (task) | comment/attachment (note) | section name
  description: string // task description, verbatim
  priority: number // raw Todoist 1–4 (1 = none)
  indent: number // ≥1
  date: string // raw due string ('' = none)
  dateLang: string // e.g. 'en'
  timezone: string // e.g. 'Europe/Istanbul'
  deadline: string // raw deadline date ('' = none)
  rowNumber: number // 1-based source line, for warnings
}

interface TaskPlan {
  tempId: string // synthetic, wires parent/child
  parentTempId: string | null
  title: string
  description: string | null // task DESCRIPTION + folded comment markdown
  priority: 0 | 2 | 3 | 4 // mapped
  position: number // CSV order, sequential
  dueDate: string | null // 'YYYY-MM-DD'
  dueTime: string | null // 'HH:mm' or null
}

interface ProjectPlan {
  name: string // from filename
}

interface ImportWarning {
  row?: number
  message: string
}

interface ImportStats {
  rows: number
  tasks: number
  subtasks: number
  withDueDate: number
  comments: number // note rows folded into a task
  sectionsFlattened: number
  skipped: number // rows not imported (e.g. orphan note)
}

interface ImportPlan {
  project: ProjectPlan
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: ImportStats
  sampleTitles: string[] // first ~5 task titles, for the preview UI
}
```

The transform produces an `ImportPlan` **without touching the db/filesystem**.
The service executes it. This is the unit-test seam.

## 6. Mapping rules (`map-rows.ts`)

1. **Project.** One `ProjectPlan`, `name` = sanitized filename (basename minus
   `.csv`, trimmed; empty → "Imported Todoist Project").
2. **Row dispatch.** `meta` and blank rows → skipped silently. `section` → no
   task emitted; `stats.sectionsFlattened++` and a warning records the section
   name (its tasks continue to flatten into the project).
3. **Task identity & hierarchy.** Each `task` row gets a synthetic `tempId`.
   A **stack** keyed by `INDENT` resolves parents: a task at indent `n` is a
   child of the most recent task at indent `n−1`; indent `1` (or no shallower
   task) → top-level. A child whose parent is missing → top-level + warning.
   `stats.subtasks` counts tasks with a resolved parent.
4. **Title.** `CONTENT` verbatim (Todoist markdown / `@labels` / `#refs` kept
   literal). Empty content → "(untitled)" + warning.
5. **Description.** `DESCRIPTION` verbatim (or null). Each following `note` row
   (until the next `task`/`section`) is appended: a blank line, then the
   comment markdown (`commentToMarkdown` — plain text as-is; attachment token →
   `[file_name](file_url)`). `stats.comments` counts folded notes. A `note`
   before any task → skipped + warning (`stats.skipped++`).
6. **Priority.** `todoistPriorityToMemry`: `4→4` (urgent), `3→3` (high),
   `2→2` (medium), `1→0` (none). Out-of-range → 0 + warning.
7. **Due date** (`dates.ts`, `DATE_LANG` must be `en`, else skip + warn):
   - `''` → if `DEADLINE` non-empty, parse `DEADLINE` as the due date; else null.
   - Absolute `YYYY-MM-DD[THH:mm…]` → `dueDate` (+ `dueTime` if a time present).
   - Named month ("Jun 20", "20 June", optional year) → `dueDate`.
   - `today` / `tomorrow` / `yesterday` → relative to `now`.
   - Relative "in N day|week|month(s)" → `now` + N units (day granularity).
   - Weekday name ("Monday") → next such weekday from `now`.
   - Recurring "every …" or anything unrecognized → null + warning (task still
     imports). `stats.withDueDate` counts non-null results.
8. **Position.** Sequential over emitted tasks in CSV order.
9. **Ignored columns:** `IS_COLLAPSED`, `AUTHOR`, `RESPONSIBLE`, `DURATION`,
   `DURATION_UNIT`, `DEADLINE_LANG` (and `DEADLINE` once consumed as due
   fallback). A single warning notes that `DURATION` was dropped if any task had
   one.

## 7. Service (`todoist-import-service.ts`)

Given one or more `.csv` absolute paths:

1. For each path: read UTF-8 (strip a leading BOM if present),
   `parseTodoistCsv` → rows, derive `projectName` from the basename,
   `mapRows(rows, projectName, { now })` → `ImportPlan`.
2. **Preview** (`previewTodoistImport`): return per-file
   `{ fileName, projectName, stats, sampleTitles, warnings }` — **no writes**.
3. **Run** (`runTodoistImport`): the desktop tasks-domain methods are **async**
   (they publish + queue sync), so we create **sequentially** through the domain
   rather than inside a synchronous better-sqlite3 transaction. For each plan:
   a. `createProject({ name })` → `{ project }` (default statuses auto-created).
   b. For each `TaskPlan` (parents precede children, so `parentId` resolves):
   `createTask({ projectId, parentId, title, description, priority, dueDate,
dueTime, position })` → `{ task }`; record `tempId → real id` (`task.id`).
   Return `ImportSummary { files: [{ projectName, projectId, stats, warnings,
error? }] }`.
4. **Best-effort, per-file isolation:** a hard error on one file aborts only that
   file (captured as `error` in its summary entry); other files still import.
   Re-running creates fresh rows; a partially-created project can be deleted.

Logging via `createLogger('TodoistImport')`; user-facing errors via
`extractErrorMessage`.

## 8. IPC + UX

- **Contract** `packages/contracts/src/todoist-import-api.ts`: two invoke
  channels, registered in `ipc-channels.ts`:
  - `todoist-import:preview` — request `{}` (handler opens the file dialog) →
    response `{ canceled: true } | { canceled: false; filePaths: string[];
files: PreviewFile[] }`.
  - `todoist-import:run` — request `{ filePaths: string[] }` → response
    `ImportSummary`.
    Run `pnpm ipc:generate` then `pnpm ipc:check`.
- **Handler** `todoist-import-handlers.ts`:
  - preview → `dialog.showOpenDialog({ properties: ['openFile',
'multiSelections'], filters: [{ name: 'Todoist CSV', extensions: ['csv'] }] })`
    (mirrors `notes-handlers` SHOW_IMPORT_DIALOG); canceled → `{ canceled: true }`;
    else parse each file → `{ canceled: false, filePaths, files }`.
  - run → `runTodoistImport(filePaths)` → summary.
    Registered in `apps/desktop/src/main/ipc/index.ts`.
- **Preload** `preload/api/todoist-import.ts` → exported from `preload/api/index.ts`.
- **UI** new **Settings → Import** nav section (`import-section.tsx`, registered
  as a nav item + conditional render in `settings.tsx`):
  - Card "Import from Todoist (CSV)" + "Choose file(s)…" button → calls preview.
  - On a non-canceled preview → open `todoist-import-preview-dialog.tsx` listing,
    per file: project name + counts (tasks / sub-tasks / with-due / comments /
    skipped) + first few task titles + a collapsible warnings list, and an
    **Import** button.
  - Import → calls run → success toast ("Imported N projects, M tasks") →
    invalidate task queries once (`taskKeys.all`) so the new project appears.
  - Hook `use-todoist-import.ts` owns the preview/run state + loading flags.
  - i18n strings under `settings.json` `import.*` (en only required;
    `pnpm i18n:check` gates en).

## 9. Error handling

- Non-CSV / empty file / missing/short header → friendly error, no writes
  (per-file in preview; surfaced in the dialog).
- Per-row mapping failure → skip that row, record a warning, continue.
- Unparseable / non-en / recurring date → task imports with no due date +
  warning.
- Missing parent reference → task imported top-level + warning.
- `run` is best-effort per file (domain methods are async → no single SQL
  transaction): a hard error aborts only that file and is reported in its summary
  entry; other files still import. A partially-created project can be deleted.

## 10. Testing (TDD)

- **Pure package (vitest, node):** small synthetic fixtures (redacted — no real
  author id / attachment URL).
  - `parse-csv.test.ts` — header mapping, quoted field with embedded
    commas/quotes (the `[[file {…}]]` token), `""` escape, blank separator rows,
    CRLF, trailing newline.
  - `priority.test.ts` — `4→4, 3→3, 2→2, 1→0`, out-of-range → 0 + warn.
  - `dates.test.ts` — absolute ISO, named month, today/tomorrow, "in 2 days" /
    "in 7 days" (the real values), weekday, recurring "every day" → null + warn,
    `DEADLINE` fallback, non-en → null + warn. Injected `now` for determinism.
  - `attachments.test.ts` — attachment token → `[name](url)`; plain comment
    passthrough; malformed token → kept literal.
  - `map-rows.test.ts` — INDENT nesting (incl. missing-parent → top-level),
    comment folding into description, section flatten + warning, priority/date
    mapping, position ordering, stats counts, untitled task. Reference-derived
    rows ("go home" / "repair" / "repair home" + an image note).
- **Service (vitest, node, in-memory `DataDb`):** run service against a fixture
  CSV → assert project + tasks + sub-tasks (parentId) + due dates written,
  description holds folded comment link, summary counts correct.
- **Manual validation:** import the real `Kişisel.csv` via Settings → Import in a
  dev profile; confirm the "Kişisel" project, 3 tasks, the two relative due
  dates, and the image-link comment on "repair home".
- Privacy: committed fixtures are small synthetic/redacted rows, not the real
  personal backup; the real file is used only for local manual validation.

## 11. Decisions (approved)

- Source = Todoist project backup `.csv` (offline). Multi-file select supported.
- Scope = **Tasks + comments as text**: title, description, priority, due date,
  sub-tasks; comment `note` rows folded into the description; attachments as a
  markdown link (not downloaded).
- Target = **new project per CSV**, named from the filename.
- Dates = **best-effort parse**: absolute exact; relative resolved from import
  date; recurring → no due + warning.
- Confirm = **preview then import** (counts + sample, explicit Import click).
- Re-import = **always create fresh** (no dedup).

## 12. Follow-ups (out of scope for v1)

- ZIP backup support (extract per-project CSVs).
- Recurring "every …" → Memry `repeatConfig`.
- `@label` → Memry tags; `#section` handling beyond flatten.
- Attachment download into the vault attachments folder.
- `DEADLINE` as a distinct field if Memry gains one; `DURATION` mapping.
- Shared "Import" settings section unifying Todoist / TickTick / Notion once
  those branches merge.
- A CLI entry point over the same pure package (`app-core` pattern).
