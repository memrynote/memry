# Project page hub redesign — design

Date: 2026-07-27
Status: Draft (design approved in brainstorming; spec pending user review)
Owner: Kaan

## 1. Context

The Project page (`apps/desktop/src/renderer/src/pages/project-home.tsx`, 267 lines) is a flat
vertical stack: a 5-tile stats row, the overview note, the task list, then Events / Notes /
Files sections that hide themselves when empty. Everything is on one scroll. There is no way
to focus a single category, linked items expose no metadata beyond a title, and clicking an
event opens the Calendar tab without navigating to the event's day
(`project-home.tsx:145-162` documents this as a known shortcut).

The data layer is already in place from the all-in-one hub work
(`docs/superpowers/specs/2026-07-20-project-all-in-one-hub-design.md`, phases 1-4 shipped):
`project_links` (`note` | `calendar_event` | `file`) plus `projects.home_note_id`, synced
inside the existing project payload.

This design replaces the page with a **hub**: a header that summarises the project, one
capture input, five in-page tabs, and a right rail carrying overview / progress / details.

### Verified current state (code)

- `pages/project-home.tsx` renders `ProjectStatsRow`, `ProjectOverviewNote`, `TaskList`,
  `ProjectEventsSection`, `ProjectNotesSection`, `ProjectFilesSection`.
- **`tasks:project-list-links` is called four times per page load** — once by
  `project-home.tsx:73` and once inside each of the three section components
  (`project-notes-section.tsx:39`, `project-files-section.tsx:51`,
  `project-events-section.tsx:60`). Each section then resolves every link with a **per-item
  IPC round trip** (`notesService.get`, `notesService.getFile`, `calendarService.getEvent`)
  inside a `Promise.all`. A project with 70 links costs ~74 IPC calls on open.
- Tab rendering: `components/split-view/tab-content.tsx:127` → `case 'project'` →
  `<LazyProjectHomePage projectId={tab.entityId} />`. Sidebar entry point:
  `components/sidebar/sortable-project-item.tsx:67`.
- `Tab.viewState?: Record<string, unknown>` (`contexts/tabs/types.ts:92`) already carries
  per-tab UI state.
- Calendar deep-link is already solved: `pages/canvas/canvas-redirect.ts:55-72` builds a
  Calendar tab with `focusCalendarEventId` + `focusDate` + `focusedAt`, consumed by
  `pages/calendar.tsx:221-234`.
- `Project.statuses: Status[]` is per-project and user-editable
  (`data/tasks-data.ts:21-32`) — status counts must be derived, never hardcoded to three.
- `Task` has **no** identifier/key field (`data/task-model.ts:39-74`). The `MEM-12` labels in
  the Paper mockups are design fiction.
- `projects` already has `modified_at` (`packages/db-schema/src/schema/projects.ts:19`),
  stamped by every mutation path in `main/database/queries/projects.ts` and already listed in
  `PROJECT_SYNCABLE_FIELDS` (`main/sync/field-merge.ts:37`). **No new column is needed for
  "Updated".**
- `note_metadata` and `calendar_events` live in the same data DB as `project_links`
  (`packages/db-schema/src/data-schema.ts`), so the aggregate query is a plain JOIN.
  `note_metadata` carries `title`, `emoji`, `fileType`, `mimeType`, `fileSize`, `modifiedAt` —
  everything the note and file rows render.
- `notesService.importFiles` returns `{destPath, filename, fileType}[]` with **no ids**
  (`main/vault/notes-crud.ts:184-190`); the indexer mints the id afterwards.
- `PanelRight` icon is already exported (`lib/icons/icon-map.ts:460`).
- `components/tasks/projects/projects-tab-content.tsx` is dead in the app — the only importer
  is `components/zero-leaf-surfaces.test.tsx`.

## 2. Goal and non-goals

### Goal

Rewrite the Project page as a hub where a project's tasks, notes, files and events are
readable and actionable from one place, with per-category focus and correct navigation into
each item's home view.

### Non-goals

- No change to the sync model or task↔project ownership. `project_links` gains one additive
  flag (D6) but keeps its meaning: membership stays many-to-many, reconciled inside the
  project payload.
- No per-project task keys (`MEM-12`). Explicitly rejected: it needs a schema change, a
  counter, a backfill and a sync field for a cosmetic label.
- No Canvas tab on the project page (the Paper mockups show one; out of scope here).
- No new app tab types. The five tabs are in-page state.

## 3. Key decisions

### D1 — Five in-page tabs, state in `tab.viewState.projectTab`

`Overview | Tasks | Notes | Files | Events`. Switching tabs never opens an app tab; it writes
`viewState.projectTab` on the active tab, so the choice survives tab switches and window
reloads for as long as the tab lives. Overview's per-section `View all` sets the same state.

### D2 — One main-process aggregate query, `tasks:project-list-contents`

Replaces the 4× `project-list-links` + N× per-item resolution described above with a single
call that joins `project_links` against `note_metadata` / `calendar_events` in SQLite and
returns resolved rows. Chosen over renderer-side batching because the cost is structural: it
grows with project size, and the product's promise is that growth stays fast. Orphaned links
(item deleted elsewhere) are dropped by the join, which also removes the defensive
null-filtering each section does today.

### D3 — Right rail on every tab, collapsible, toggle never disappears

The rail carries Overview / Progress / Details and stays visible on all five tabs so context
is not lost when focusing a category. A `PanelRight` toggle sits in the header next to the `⋯`
menu and **remains in place when the rail is closed**, so reopening is the same button — no
hidden affordance. State lives in `tab.viewState.railOpen` (default open).

### D4 — Hybrid capture input dispatches on content type

One input, three outcomes:

| input               | outcome                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| plain text          | task in this project, via the existing quick-add NLP parse (due date, priority, tags) |
| URL                 | note created from the link, then linked to the project                                |
| paperclip → file(s) | file(s) imported into the vault, then linked to the project                           |

URL and file paths are new main-process channels (§6). They are main-side because both need
work the renderer cannot do safely: URL title extraction, and — for files — the id the
**indexer** assigns after import. `importFiles` returns no ids, so a renderer-side
`notes:get-by-path` poll would race the indexer. One handler that imports, awaits indexing and
links is both simpler and correct.

### D5 — "Updated" reuses the existing `projects.modified_at`

The brainstorming decision was to add an `updated_at` column rather than derive the value.
Reading the schema showed the column already exists as `modified_at`: every project mutation
stamps it, and it is already a field-merged sync field. So the decision stands — Details reads
a real stored column, not a derived one — but it costs no migration and no sync change.

### D6 — Overview-pinned notes via `project_links.pinned`

The rail's Overview section lists notes the user explicitly puts there, so it needs to
distinguish "linked to this project" from "shown on the overview". A `pinned` flag on
`project_links` (additive, `INTEGER NOT NULL DEFAULT 0`) does this without a second link
table: a pinned note is an ordinary project link that also appears in the rail, and it stays
visible in the Notes tab. `+ add note` in the rail links the chosen note and pins it in one
step; unpinning leaves the link intact.

Rejected: `item_type = 'overview_note'`, which would hide those notes from the Notes tab and
split one concept across two types.

### D7 — Progress rows are generated from `project.statuses`

One row per status in the project's own configuration — a project with four `in_progress`
statuses gets four rows — plus a derived `Overdue` row (`dueDate < today` and the task's status
type is not `done`). Nothing about "To Do / In Progress / Done" is hardcoded.

## 4. UI

### Layout

```
┌──────────────────────────────────────────────────────────────────┬─────────────────────────────┐
│  ▣  memry v2     ( 12/30 done )  ( 3 overdue )            ▐│ [⋯] │  OVERVIEW                   │
│                                                                  │  <home note, inline editor> │
│  ┌────────────────────────────────────────────────────────────┐  │  📄 Product overview      › │
│  │ ⊕  Add to memry v2 — type a task, jot a note, paste… 📎 → │  │  + add note                 │
│  └────────────────────────────────────────────────────────────┘  │                             │
│                                                                  │  PROGRESS                   │
│  [Overview] Tasks 30   Notes 20   Files 40   Events 10           │  12 of 30 done         40%  │
│                                                                  │  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░  │
│  ⌄ Tasks  30                                     View all   +    │  ○  To Do              13   │
│   ◐  ▮▮▯  Review sync conflict edge cases      [sync]   Mar 11   │  ◐  In Progress         5   │
│   ○  ▮▯▯  Implement field-level merge          [sync]   Mar 16   │  ✓  Done               12   │
│   …  (5 rows)                                                    │  !  Overdue             3   │
│   +  Add task                                                    │                             │
│                                                                  │  DETAILS                    │
│  ⌄ Notes  20 · Files 40 · Events 10   (same shape, 5 rows each)  │  Created    Mar 2, 2026     │
│                                                                  │  Updated    2 hours ago     │
│                                                                  │  Linked  20 · 40 · 10       │
└──────────────────────────────────────────────────────────────────┴─────────────────────────────┘
```

### Header

Project icon (click → icon picker, existing `IconPickerButton`), name, `<done>/<total> done`,
and `<n> overdue` in destructive colour — the overdue pill is omitted entirely when zero. Then
the rail toggle and the existing `⋯` menu (edit / archive / delete).

### Overview tab

Four sections in the mockup order — Tasks, Notes, Files, Events — each showing a **fixed five
rows**, a `View all` control that switches to that tab, and a `+` that adds an item of that
type. Unlike today's sections, a category with no items still renders: heading, one-line empty
state, `+`. The hub should show what a project _can_ hold, not silently omit it.

### Rows (shared between Overview previews and the full tabs)

| row   | leading                                                     | body                           | trailing                               | click                                                         |
| ----- | ----------------------------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------------- |
| task  | status ring (popover) · priority bars (popover)             | title, strikethrough when done | tag chips · due date (overdue red)     | task detail drawer, in place                                  |
| note  | note icon/emoji — click opens the icon picker               | title                          | relative updated time                  | note tab                                                      |
| file  | icon by `fileType` (pdf / image / audio / video / markdown) | filename                       | size or page count · date              | file tab                                                      |
| event | calendar icon                                               | title                          | date · time, or date only when all-day | Calendar tab, focused on the event's day with its detail open |

Reused: `inline-status-popover.tsx`, `inline-priority-popover.tsx`, the
`folder-emoji-chip.tsx` icon-picker pattern (#801), `openRelatedVaultItem` for notes/files,
`buildRedirectTab` from `canvas-redirect.ts` for events, `TaskDetailDrawer` standalone (already
used this way by `calendar-task-popover.tsx`), and `components/filing/link-search.tsx` — the
inbox filing note search — for the rail's `+ add note`. The 2026-07-20 spec deferred
"pick an existing note" for want of a note picker; `LinkSearch` is that picker.

### Tasks / Notes / Files / Events tabs

Same header, capture input, tab bar and rail; the body is the full list with the same row
components. Tasks reuses the existing virtualized project task list.

### Right rail

- **OVERVIEW** — the home note rendered inline via the existing `ProjectOverviewNote`
  (BlockNote, autosave), moved into the rail and restyled. Below it, one row per
  overview-pinned note (D6) opening that note in a tab, and `+ add note`, which picks an
  existing note, links it to the project and pins it. Each row can be unpinned from a hover
  control; unpinning keeps the project link.
- **PROGRESS** — `<done> of <total> done` with a bar, then one row per project status (D7),
  then `Overdue`.
- **DETAILS** — Created, Updated (`projects.modified_at`), and Linked
  counts (`20 notes · 40 files · 10 events`).

### Conventions

New markup uses logical Tailwind properties (`ms/me/ps/pe/start/end`) per CLAUDE.md. Colour,
type and motion follow `PRODUCT.md` and `docs/DESIGN_TOKENS.md`; WCAG AA, reduced-motion and
RTL apply. All strings go through `useT('tasks')`; new keys are added to the `en` locale and
verified with `pnpm --filter @memry/desktop i18n:check`.

## 5. File layout

```
pages/project/
  index.tsx                  shell: project resolution, tab + rail state, empty state
  use-project-hub.ts         single data hook over tasks:project-list-contents
  project-header.tsx         icon, name, counts, rail toggle, ⋯ menu
  project-capture-input.tsx  hybrid quick-add (text / URL / attachment)
  project-tab-bar.tsx        five-tab segmented control with counts
  project-rail.tsx           OVERVIEW / PROGRESS / DETAILS
  tabs/overview-tab.tsx
  tabs/tasks-tab.tsx
  tabs/notes-tab.tsx
  tabs/files-tab.tsx
  tabs/events-tab.tsx
  rows/task-row.tsx
  rows/note-row.tsx
  rows/file-row.tsx
  rows/event-row.tsx
```

`tab-content.tsx:128` switches to the new `pages/project`.

### Deleted (dead once this lands)

```
pages/project-home.tsx                              + test
components/tasks/projects/project-stats-row.tsx     + test
components/tasks/projects/project-notes-section.tsx + test
components/tasks/projects/project-files-section.tsx + test
components/tasks/projects/project-events-section.tsx+ test
components/tasks/projects/projects-tab-content.tsx  + its refs in zero-leaf-surfaces.test.tsx
```

`projects-tab-content.tsx` is already unreachable from the app; this change orphans it
completely, so it goes with the rest.

**Kept:** `project-overview-note.tsx` (moves into the rail), `project-selector.tsx` (still used
by `project-picker.tsx` and `use-project-quick-create.tsx`), and the three
`add-*-to-project-dialog.tsx` dialogs (the reverse-direction entry points).

## 6. Data, IPC and sync

### Migration

Hand-written, additive — data-DB Drizzle snapshots are broken past 0021:

```sql
-- apps/desktop/src/main/database/drizzle-data/0040_project_link_pinned.sql
ALTER TABLE project_links ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
```

Only one column. "Updated" needs no migration (D5) — it reads the existing
`projects.modified_at`, which is already synced.

`project_links.pinned` defaults to `0`, so every existing link keeps its current behaviour.
`ProjectLinkSyncSchema` gains `pinned: z.number().optional()`.

**Landmine — `reconcileLinks` must not reset `pinned`.** Links reconcile wholesale rather than
field-merging (`main/sync/item-handlers/project-handler.ts:64`). Its update branch currently
writes a fixed column set, so a payload pushed by an older client — whose links carry no
`pinned` key — would overwrite every local pin with `0`. The update branch must therefore fall
back to the existing row's value, not to the default:

```ts
pinned: l.pinned ?? existing.pinned ?? 0 // update branch — preserve local when omitted
pinned: l.pinned ?? 0 // insert branch — new link, default unpinned
```

### New channels

Added to `packages/contracts/src/ipc-channels.ts` next to the existing `PROJECT_*` entries,
then `pnpm ipc:generate` && `pnpm ipc:check`:

- `tasks:project-list-contents` → `{ tasks, notes, files, events, pinnedNotes, counts,
homeNoteId, createdAt, modifiedAt }`. One SQL pass; notes/files/events resolved by joining
  `project_links` to their tables so orphaned links never reach the renderer. `pinnedNotes` is
  the `pinned = 1` subset of `notes`, ordered by `position`.
- `tasks:project-set-link-pinned` → `{ projectId, itemId, pinned }`. Pin or unpin an existing
  link without touching the link itself. Pinning a note that is not yet linked is a
  `project-link-item` call followed by this one, both issued by the rail's `+ add note`.
- `tasks:project-capture-url` → `{ projectId, url }`. Fetches the page title, creates the
  note, links it. Returns the note id.
- `tasks:project-import-files` → `{ projectId, sourcePaths }`. Imports into the vault, awaits
  indexing, links each resulting file. Returns linked ids plus per-file failures.

Errors surface through `extractErrorMessage`; handlers log via `createLogger`.

### Backward compatibility

Per the production mandate: the migration is additive and preserves every existing row; no
new `SyncItemType`; `item_type` stays `'project'`. `ProjectSyncPayloadSchema` and
`ProjectLinkSyncSchema` are plain `z.object`s, so older clients strip `pinned` rather than
rejecting the payload. A payload from an older client carries no `pinned` field, and the
`reconcileLinks` fallback above leaves the local value alone. No server change; the payload is an opaque encrypted blob in R2.

## 7. Testing

Unit:

- `use-project-hub` — shape mapping, counts, refresh on `onProjectUpdated`.
- Progress derivation — custom status sets (including two statuses of the same type), overdue
  boundary at local midnight, empty project (0 tasks → 0%, no divide-by-zero).
- Each row component — click target, popovers, icon fallbacks by file type.
- Tab state — `View all` writes `viewState.projectTab`; rail toggle writes `viewState.railOpen`.
- `tasks:project-list-contents` — orphaned links excluded; counts match rows; `pinnedNotes`
  is the pinned subset in `position` order.
- `tasks:project-import-files` — id resolved after indexing; partial failure reported.
- Pin / unpin — unpinning keeps the project link; pinning an unlinked note creates the link.

Sync (required by the backward-compat mandate):

- **A project payload whose links carry no `pinned` key leaves local pins intact** — this is
  the `reconcileLinks` landmine in §6 and the test that proves the fallback works. Mutate the
  fallback to `l.pinned ?? 0` and the test must fail.
- Push → pull round-trip preserves `pinned`.

E2E:

- Overview `View all` switches to the matching tab without opening a new app tab.
- Clicking a linked event opens Calendar on that event's day with its detail open.
- Rail toggle closes and reopens from the same button.

Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm ipc:check`,
`pnpm check:architecture`, `pnpm --filter @memry/desktop i18n:check`,
`pnpm docs:impact --base <base> --strict`, `pnpm docs:build`.

## 8. Risks

- **URL title extraction crosses a module boundary.** The existing fetcher lives in
  `main/inbox/metadata.ts`; importing it from a tasks handler may trip
  `pnpm check:architecture`. If it does, the fallback is to derive the title from the URL and
  leave enrichment to a follow-up — the feature still works.
- **Import → index → link is asynchronous.** The handler needs a bounded wait and must report
  a clear failure rather than hanging; the UI shows the file as pending until the link lands.
- **Rail on narrow windows.** At small widths the rail must collapse rather than squeeze the
  main column; the breakpoint behaviour is part of the implementation, defaulting to closed
  below the threshold without overwriting the user's stored preference.
- **`ProjectOverviewNote` in a narrow rail.** It was written for a full-width section; the
  BlockNote editor needs verification at rail width, especially with lists and code blocks.

```

```
