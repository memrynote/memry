# Project all-in-one hub — Phase 2 Implementation Plan (Calendar events + membership chips)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add a calendar **event** to a project, see linked events in an "Events" section on the Project Home page, and see **membership chips** ("in projects X, Y") on both the note view and the event view — with zero sync/schema change.

**Architecture:** Phase 1's `project_links` table + `reconcileLinks` are generic over `item_type`, and `ProjectLinkItemSchema.itemType` already allows `'calendar_event'` — so linking events needs **no migration and no new `SyncItemType`**; event links ride the existing project payload. The only new backend is a reverse-lookup query `listForItem(itemType, itemId) → projects`, added through every layer (contracts → domain-tasks → storage-data → main queries → IPC → RPC). The Events section mirrors `ProjectNotesSection` (resolving titles via `calendarService.getEvent`). A shared `ItemProjectChips` component renders membership on note + event views. Event "Add to project" reuses `PROJECT_LINK_ITEM` via a dialog cloned from `AddNoteToProjectDialog`, opened from the calendar item chip's native context menu.

**Tech Stack:** TypeScript, Drizzle (better-sqlite3), Zod, Electron IPC (`@memry/contracts` + `@memry/rpc`), React renderer, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-20-project-all-in-one-hub-design.md` (§6 `listForItem`, §7 assignment entry points + chips, §9 Phase 2).

## Global Constraints

- Backward compatibility MANDATORY. NO migration, NO new `SyncItemType`, NO sync change. `itemType='calendar_event'` is already allowed by `ProjectLinkItemSchema` (`packages/contracts/src/tasks-api.ts:214–218`). Deleting a project drops its `project_links` + tasks but keeps events (Phase 1 cascade already correct).
- Defensive orphan handling: any link whose target item fetch (`calendarService.getEvent` / `notesService.get`) returns `null` is **skipped** in rendering (read-only filter). Do NOT add deletion-cleanup logic here — the note-deletion path is owned by a concurrent session (`apps/desktop/src/main/notes/domain.ts`, `notes/runtime-effects.ts`).
- New renderer code uses logical Tailwind props (`ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`), never physical.
- Logging via `createLogger('Scope')`; user-facing errors via `extractErrorMessage`.
- After editing IPC contracts/RPC: `pnpm ipc:generate` then `pnpm ipc:check`. Preload + invoke map are GENERATED — never hand-edit.
- Project-hub UI strings live in the `tasks` namespace (`packages/i18n/src/locales/en/tasks.json`); a calendar-chip menu label lives in `calendar.json`. Run `pnpm --filter @memry/desktop i18n:check`.
- Use `itemType: 'calendar_event'` (underscore) — NOT `'event'` (that is the calendar projection `sourceType`, a different concept).
- The renderer `Picker`/native context menu does NOT open in jsdom — unit-test directly-rendered components (dialog, section, chips), not menu-open flows.
- Single-file test run: `test:main -- <substring>` / `test:renderer -- <substring>`.

## Cross-phase execution order

Phase 2 layers onto the Phase 3 Project Home page. See `2026-07-21-project-hub-phase3-home-page.md` "Cross-phase execution order". Task 1 (below) is independent backend and should run first; Task 2 (EventsSection) mounts on the Phase 3 page (Phase 3 Task 2 must exist first); Task 4 (chips) needs Task 1.

---

### Task 1: `listForItem(itemType, itemId)` reverse query — end-to-end

Returns the projects a given item (note/event/file) belongs to. Mirrors `listProjectLinks` structurally but filters by `(item_type, item_id)` and joins to `projects`.

**Files (mirror the `listProjectLinks` path at each layer):**

- Modify: `packages/contracts/src/tasks-api.ts` (add `ProjectListForItemSchema`)
- Modify: `packages/contracts/src/ipc-channels.ts` (add `PROJECT_LIST_FOR_ITEM` after line 153)
- Modify: `packages/domain-tasks/src/queries.ts` (interface `TasksQueryRepository` + `createTasksQueries`)
- Modify: `packages/domain-tasks/src/types.ts` (a `ProjectRef`/return type if needed)
- Modify: `packages/domain-tasks/src/test-fixtures.ts` (add `listForItem` mock)
- Modify: `packages/storage-data/src/tasks-repository.ts` (`ProjectQueryModule` interface + returned method)
- Modify: `apps/desktop/src/main/database/queries/projects.ts` (new join query)
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts` (register handler — 2-arg → `createValidatedHandler`)
- Modify: `packages/rpc/src/tasks.ts` (add `listForItem` method + input type)
- Test: `apps/desktop/src/main/tasks/project-links-domain.test.ts` (append a `listForItem` case) — NOTE: this file is being edited by the concurrent orphan-cleanup session in the MAIN repo; in THIS worktree it is the clean committed version. Append at the end to minimise merge overlap.

> **Concurrent-edit caution:** `packages/domain-tasks/src/commands.ts`, `packages/storage-data/src/tasks-repository.ts`, `apps/desktop/src/main/database/queries/projects.ts`, and `test-fixtures.ts` are being edited by another session on another branch. In this worktree you are on the clean committed base. Add your new functions at the END of each file's relevant section (do not interleave with existing link functions) to keep the eventual merge conflict-free.

**Interfaces:**

- Consumes: `projectLinks` + `projects` tables; existing `getProjectLinks` query as the structural mirror (`projects.ts:623`).
- Produces: `listForItem(itemType: string, itemId: string) => ProjectRef[]` where `ProjectRef = { id: string; name: string; color: string; icon: string | null }`, exposed as `tasksService.listForItem(itemType, itemId)`.

- [ ] **Step 1: Read the reuse targets**

Read every `listProjectLinks` layer: `packages/domain-tasks/src/queries.ts:22,82–84`; `packages/storage-data/src/tasks-repository.ts:122,376–378`; `apps/desktop/src/main/database/queries/projects.ts:623–625` (and the `and(eq(itemType), eq(itemId))` predicate pattern already present ~line 648); `apps/desktop/src/main/ipc/tasks-handlers.ts:232–235` (`PROJECT_LIST_LINKS`) and `:213–219` (`createValidatedHandler` shape); `packages/rpc/src/tasks.ts:249–252`. Confirm the `ProjectRef`/project mapper: check how `getProject`/`listProjects` in `projects.ts` map a `projects` row to the domain `Project` — reuse that mapper if one exists.

- [ ] **Step 2: Write the failing test**

Append to `apps/desktop/src/main/tasks/project-links-domain.test.ts`:

```ts
it('#then listForItem returns projects an item belongs to', () => {
  t = createTestDataDb()
  t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#111', position: 0 }).run()
  t.db.insert(projects).values({ id: 'p2', name: 'P2', color: '#222', position: 1 }).run()
  const d = domain(t)
  d.linkItemToProject({ projectId: 'p1', itemType: 'calendar_event', itemId: 'e1' })
  d.linkItemToProject({ projectId: 'p2', itemType: 'calendar_event', itemId: 'e1' })
  d.linkItemToProject({ projectId: 'p1', itemType: 'note', itemId: 'n9' })

  const result = d.listForItem('calendar_event', 'e1')
  expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  expect(result.find((p) => p.id === 'p1')?.name).toBe('P1')
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- project-links-domain`
Expected: FAIL — `d.listForItem is not a function`.
(If it errors with `better-sqlite3` `ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION`, run `pnpm --filter @memry/desktop rebuild:node` once, then re-run.)

- [ ] **Step 4: Add the main DB query**

In `apps/desktop/src/main/database/queries/projects.ts`, at the end of the "Project Links" section, add (adjust column refs / mapper to match Step 1):

```ts
export function getProjectsForItem(db: DrizzleDb, itemType: string, itemId: string) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      color: projects.color,
      icon: projects.icon
    })
    .from(projectLinks)
    .innerJoin(projects, eq(projectLinks.projectId, projects.id))
    .where(and(eq(projectLinks.itemType, itemType), eq(projectLinks.itemId, itemId)))
    .all()
}
```

Ensure `and`, `eq`, `innerJoin`, `projects`, `projectLinks` are imported at the top of the file (most already are).

- [ ] **Step 5: Thread through storage-data**

In `packages/storage-data/src/tasks-repository.ts`: add to `ProjectQueryModule<TDb>` interface (near `getProjectLinks`, line 122):

```ts
  getProjectsForItem: (db: TDb, itemType: string, itemId: string) => ProjectRef[]
```

Add a `ProjectRef` type export (`{ id: string; name: string; color: string; icon: string | null }`) if not already present, and add the returned repository method (near `listProjectLinks`, line 376):

```ts
  listForItem(itemType: string, itemId: string): ProjectRef[] {
    return projectQueries.getProjectsForItem(db, itemType, itemId)
  },
```

- [ ] **Step 6: Thread through domain-tasks**

In `packages/domain-tasks/src/queries.ts`: add to `TasksQueryRepository` interface (near line 22) `listForItem(itemType: string, itemId: string): ProjectRef[]`, and to `createTasksQueries` returned object (near line 82):

```ts
    listForItem: (itemType: string, itemId: string) => repository.listForItem(itemType, itemId),
```

Add `ProjectRef` to `packages/domain-tasks/src/types.ts` if not exported from storage-data in a way the domain can import; keep the shape identical. Add the desktop repository wiring: in `apps/desktop/src/main/database/queries/projects.ts` the repository object passed to storage-data must include `getProjectsForItem: (db, t, i) => getProjectsForItem(db, t, i)` (find where `getProjectLinks` is wired into that object and mirror it).

- [ ] **Step 7: Add the test-fixtures mock**

In `packages/domain-tasks/src/test-fixtures.ts`, add a `listForItem: vi.fn(() => [])` (or the file's non-vitest stub style) next to the `listProjectLinks` mock, so consumers of the fixtures type-check.

- [ ] **Step 8: Run the domain test → PASS**

Run: `pnpm --filter @memry/desktop test:main -- project-links-domain`
Expected: PASS (existing + new `listForItem` case).

- [ ] **Step 9: Add contracts channel + schema**

In `packages/contracts/src/ipc-channels.ts`, in `TasksChannels.invoke` after line 153:

```ts
    PROJECT_LIST_FOR_ITEM: 'tasks:project-list-for-item',
```

In `packages/contracts/src/tasks-api.ts`, add and export:

```ts
export const ProjectListForItemSchema = z.object({
  itemType: z.enum(['note', 'calendar_event', 'file']),
  itemId: z.string()
})
```

- [ ] **Step 10: Register the IPC handler**

In `apps/desktop/src/main/ipc/tasks-handlers.ts`, import `ProjectListForItemSchema` in the contracts import block, then register near `PROJECT_LIST_LINKS` (line 232):

```ts
ipcMain.handle(
  TasksChannels.invoke.PROJECT_LIST_FOR_ITEM,
  createValidatedHandler(
    ProjectListForItemSchema,
    withDb(
      (db, input) => createTaskDomain(db).listForItem(input.itemType, input.itemId),
      'Failed to list projects for item'
    )
  )
)
```

- [ ] **Step 11: Add the RPC method**

In `packages/rpc/src/tasks.ts`, add near `listProjectLinks` (line 249). Because the handler consumes one validated object, pass both args and wrap:

```ts
    listForItem: defineMethod<(itemType: string, itemId: string) => Promise<ProjectRef[]>>({
      channel: TasksChannels.invoke.PROJECT_LIST_FOR_ITEM,
      params: ['itemType', 'itemId'],
      invokeArgs: ['{ itemType, itemId }']
    }),
```

Add a `ProjectRef` interface to `packages/rpc/src/tasks.ts` (mirror `ProjectLink` at lines 47–54): `{ id: string; name: string; color: string; icon: string | null }`. Re-export it from `apps/desktop/src/renderer/src/services/tasks-service.ts`'s type block if the renderer needs the type.

- [ ] **Step 12: Regenerate + validate IPC**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: `generated-rpc.ts` gains `listForItem`; `ipc:check` passes.

- [ ] **Step 13: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (check `check:architecture`/`check:contracts` pass as part of it).

- [ ] **Step 14: Commit**

```bash
git add packages/contracts/src/ipc-channels.ts packages/contracts/src/tasks-api.ts packages/domain-tasks/src packages/storage-data/src/tasks-repository.ts apps/desktop/src/main/database/queries/projects.ts apps/desktop/src/main/ipc/tasks-handlers.ts packages/rpc/src/tasks.ts apps/desktop/src/main/tasks/project-links-domain.test.ts
git add -A
git commit -m "feat(projects): listForItem reverse query (projects for a note/event)"
```

---

### Task 2: Events section on Project Home

Mirror `ProjectNotesSection` for `itemType='calendar_event'`, resolving each event's title/time via `calendarService.getEvent`, and mount it on the Project Home page.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/project-events-section.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/project-home.tsx` (replace `EVENTS_SECTION_SLOT`)
- Modify: `packages/i18n/src/locales/en/tasks.json` (`projectEvents.*`)
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/project-events-section.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listProjectLinks(projectId)`; `tasksService.unlinkProjectItem`; `calendarService.getEvent(id)` → `CalendarEventRecord | null` (`title`, `startAt`, `isAllDay`).
- Produces: `ProjectEventsSection({ projectId, onEventClick?, className? })` named export.

- [ ] **Step 1: Read the reuse targets**

Read `apps/desktop/src/renderer/src/components/tasks/projects/project-notes-section.tsx` (the exact structure to mirror) and `apps/desktop/src/renderer/src/services/calendar-service.ts` + `packages/rpc/src/calendar.ts:82–85` (`getEvent`) + `packages/contracts/src/calendar-api.ts:164–187` (`CalendarEventRecord` fields). Note the display format for `startAt`/`isAllDay` used elsewhere (grep an existing event-time formatter in `components/calendar`).

- [ ] **Step 2: Write the failing test**

Create `project-events-section.test.tsx`. Mock `tasksService.listProjectLinks` → `[{ itemType:'calendar_event', itemId:'e1', ... }, { itemType:'note', itemId:'n1', ... }]` and `calendarService.getEvent` → for `e1` `{ id:'e1', title:'Kickoff', startAt:'2026-08-01T10:00:00Z', isAllDay:false }`. Assert: only the event link is rendered (note link ignored), "Kickoff" appears, and clicking its remove control calls `unlinkProjectItem` with `{ projectId, itemType:'calendar_event', itemId:'e1' }`. Add a second case: `getEvent` returns `null` → that link is skipped (defensive orphan filter), section renders nothing/empty.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-events-section`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement `ProjectEventsSection`**

Clone `project-notes-section.tsx`; change: filter `itemType === 'calendar_event'`; resolve with `calendarService.getEvent(link.itemId)`; **skip links whose `getEvent` resolves to `null`** (defensive); display `event.title` + a formatted date/time (all-day → date only). Icon: use a calendar icon from `@/lib/icons`. Remove control calls `unlinkProjectItem({ projectId, itemType:'calendar_event', itemId })`. `createLogger('ProjectEvents')`, `extractErrorMessage`, `useT('tasks')` with `projectEvents.*`. Return `null` when not loading and zero events (mirror notes section line 77).

- [ ] **Step 5: Mount in the page**

In `project-home.tsx`, replace `EVENTS_SECTION_SLOT` with `<ProjectEventsSection projectId={projectId} onEventClick={handleEventClick} />`. `handleEventClick` opens the calendar/event (reuse the tab system; if opening a specific event is non-trivial, open the calendar tab — label any shortcut taken).

- [ ] **Step 6: Add i18n keys**

Add to `tasks.json`:

```json
"projectEvents": {
  "title": "Events",
  "loading": "Loading events…",
  "loadError": "Could not load events",
  "removeFromProject": "Remove from project",
  "removeError": "Could not remove event"
}
```

- [ ] **Step 7: Run tests + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- project-events-section` → PASS; `test:renderer -- project-home` → still PASS; `typecheck:web` clean; `i18n:check` green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/project-events-section.tsx apps/desktop/src/renderer/src/components/tasks/projects/project-events-section.test.tsx apps/desktop/src/renderer/src/pages/project-home.tsx packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): Events section on Project Home"
```

---

### Task 3: Event "Add to project" entry point

Clone the note "Add to project" dialog for events, and open it from the calendar item chip's native context menu.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx` (add an `'add-to-project'` menu item + callback prop)
- Modify: the calendar wiring that owns dialog state: `apps/desktop/src/renderer/src/pages/calendar.tsx` (+ pass-through in `calendar-shell.tsx` and the day/week/month views, mirroring the existing `onDeleteItem` path)
- Modify: `packages/i18n/src/locales/en/tasks.json` (`addEventToProject.*`) and `packages/i18n/src/locales/en/calendar.json` (chip menu label)
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listProjects()`; `tasksService.linkProjectItem({ projectId, itemType:'calendar_event', itemId })`.
- Produces: `AddEventToProjectDialog({ open, onOpenChange, eventId })` named export; a new optional prop `onAddToProject?(eventId: string)` on the calendar item chip, threaded up to `calendar.tsx` which owns the dialog open state + selected event id.

- [ ] **Step 1: Read the reuse targets**

Read `apps/desktop/src/renderer/src/components/tasks/projects/add-note-to-project-dialog.tsx` (clone target), `apps/desktop/src/renderer/src/components/calendar/calendar-item-chip.tsx:72–86` (native `window.api.showContextMenu` menu — the exact place to add an item), and how `onDeleteItem` is threaded: `calendar-item-chip.tsx` → `calendar-shell.tsx:73–74,133–134` → day/week/month views → `pages/calendar.tsx`. Mirror that callback path for `onAddToProject`.

- [ ] **Step 2: Write the failing test**

Create `add-event-to-project-dialog.test.tsx` (clone the note dialog's test if one exists; else write fresh). Mock `tasksService.listProjects` → one active project; render `<AddEventToProjectDialog open eventId="e1" onOpenChange={fn} />`; click the project; assert `linkProjectItem` called with `{ projectId, itemType:'calendar_event', itemId:'e1' }` and a success toast path runs. (Do NOT test the native context-menu open — not jsdom-testable.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- add-event-to-project-dialog`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement the dialog**

Clone `add-note-to-project-dialog.tsx` → `add-event-to-project-dialog.tsx`; rename prop `noteId` → `eventId`; change the link call to `itemType: 'calendar_event', itemId: eventId`; use `useT('tasks')` with `addEventToProject.*` (or reuse `addToProject.*` shared keys — decide and be consistent). Keep the same structure, toasts, and error handling.

- [ ] **Step 5: Add the menu item + callback prop**

In `calendar-item-chip.tsx`, extend the `menuItems` array (lines 72–86) with `{ id: 'add-to-project', label: <calendar.json label> }`, and in the `.then((selectedId) => {...})` dispatch, on `'add-to-project'` call a new optional prop `onAddToProject?.(event id for this chip)`. Add `onAddToProject` to the chip's props. Thread it up through `calendar-shell.tsx` and the day/week/month view components exactly like `onDeleteItem`.

- [ ] **Step 6: Own dialog state in `calendar.tsx`**

In `pages/calendar.tsx`, add state `const [addToProjectEventId, setAddToProjectEventId] = useState<string | null>(null)`; pass `onAddToProject={setAddToProjectEventId}` down through the shell; render `<AddEventToProjectDialog open={addToProjectEventId != null} eventId={addToProjectEventId ?? ''} onOpenChange={(o) => { if (!o) setAddToProjectEventId(null) }} />`.

- [ ] **Step 7: Add i18n keys**

Add `addEventToProject` block to `tasks.json` (or reuse `addToProject`), and the chip label to `calendar.json` (mirror where `delete-dialog.context-menu-delete-label` lives), e.g. `"context-menu-add-to-project": "Add to project"`.

- [ ] **Step 8: Run tests + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- add-event-to-project-dialog` → PASS; `typecheck:web` clean; `i18n:check` green.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.tsx apps/desktop/src/renderer/src/components/tasks/projects/add-event-to-project-dialog.test.tsx apps/desktop/src/renderer/src/components/calendar/ apps/desktop/src/renderer/src/pages/calendar.tsx packages/i18n/src/locales/en/tasks.json packages/i18n/src/locales/en/calendar.json
git commit -m "feat(projects): add calendar event to project (chip menu + dialog)"
```

---

### Task 4: Shared membership chips on note + event views

A small shared `ItemProjectChips` component shows the projects a note/event belongs to, using `listForItem` (Task 1). Rendered on the note view (under the title) and the event popover (header).

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/item-project-chips.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/note.tsx` (insert after `<NoteTitle>`, ~line 1275, inside the `group/metadata` stack)
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx` (insert in the header area)
- Modify: `packages/i18n/src/locales/en/tasks.json` (`itemProjects.*`)
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/item-project-chips.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listForItem(itemType, itemId)` → `ProjectRef[]`; `onProjectUpdated` (from `@/services/tasks-service`) for live refresh; `openTab`/`openRelatedVaultItem` for click-through (host-provided `onProjectClick?`).
- Produces: `ItemProjectChips({ itemType, itemId, onProjectClick?, className? })` named export.

- [ ] **Step 1: Read the reuse targets**

Read `apps/desktop/src/renderer/src/pages/note.tsx:1266–1317` (the `group/metadata` stack: `NoteTitle` → `TagsRow` → `InfoSection`; confirm `noteId` in scope) and `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx` header/footer structure (find a header region + how it knows the event id). Read `project-notes-section.tsx` for the load/error pattern to mirror.

- [ ] **Step 2: Write the failing test**

Create `item-project-chips.test.tsx`. Mock `tasksService.listForItem` → `[{ id:'p1', name:'Launch', color:'#f00', icon:null }, { id:'p2', name:'Finance', color:'#0f0', icon:null }]`. Render `<ItemProjectChips itemType="note" itemId="n1" />`; assert both "Launch" and "Finance" chips appear. Second case: `listForItem` → `[]` → renders nothing (`null`). Third: clicking a chip calls `onProjectClick('p1')`.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- item-project-chips`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement `ItemProjectChips`**

Create `item-project-chips.tsx`. On mount + when `(itemType,itemId)` changes, call `tasksService.listForItem(itemType, itemId)`; store `ProjectRef[]`. Subscribe to `onProjectUpdated` and refetch (links ride project updates). Render a horizontal wrap of small pills: color dot (`style={{ backgroundColor: p.color }}`) + `p.name`; each pill is a button calling `onProjectClick?.(p.id)`. Return `null` when empty and not loading. Logical Tailwind props only. `useT('tasks')` with `itemProjects.*` (e.g. an `aria-label` `itemProjects.openProject`). `createLogger('ItemProjectChips')`, `extractErrorMessage`.

- [ ] **Step 5: Mount on the note view**

In `note.tsx`, insert `<ItemProjectChips itemType="note" itemId={noteId} onProjectClick={handleOpenProject} />` immediately after `<NoteTitle .../>` (closes ~line 1274), inside the `group/metadata` column. `handleOpenProject(projectId)` opens the project tab via `openTab` (mirror how the note page opens related items). If wiring `openTab` here is heavy, render chips without click-through for v1 and label the follow-up.

- [ ] **Step 6: Mount on the event popover**

In `calendar-event-popover.tsx`, render `<ItemProjectChips itemType="calendar_event" itemId={eventId} />` in the header area (below the title). Confirm the event id available in that component (Step 1). If the popover is used for not-yet-saved new events (no id), guard: only render when a real event id exists.

- [ ] **Step 7: Add i18n keys**

Add to `tasks.json`:

```json
"itemProjects": {
  "openProject": "Open project {name}"
}
```

- [ ] **Step 8: Run tests + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- item-project-chips` → PASS; `test:renderer -- note` (the note page test, if it exercises the header) → still PASS; `typecheck:web` clean; `i18n:check` green.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/item-project-chips.tsx apps/desktop/src/renderer/src/components/tasks/projects/item-project-chips.test.tsx apps/desktop/src/renderer/src/pages/note.tsx apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): membership chips on note + event views"
```

---

### Task 5: Combined verification gate (Phase 2 + Phase 3)

- [ ] **Step 1: Full desktop + package checks**

```bash
pnpm lint
pnpm typecheck
pnpm --filter @memry/contracts test
pnpm --filter @memry/desktop test:main
pnpm --filter @memry/desktop test:renderer
pnpm ipc:check
pnpm --filter @memry/desktop i18n:check
pnpm check:architecture
git diff --check
```

Expected: all green. If `better-sqlite3` `ERR_DLOPEN_FAILED` → `pnpm --filter @memry/desktop rebuild:node` once, re-run.

- [ ] **Step 2: Docs impact gate**

```bash
pnpm docs:impact --base project-links-hub --strict
```

If `missing-docs`: `pnpm docs:ai-update --base project-links-hub` or update `apps/docs/src/**`; re-run `--strict` + `pnpm docs:build`. If the docs AI tool is unavailable, note "write docs" as a remaining PR item and push with `MEMRY_DOCS_IMPACT_SKIP=1`.

- [ ] **Step 3: Manual smoke (real app)**

`pnpm dev`. Verify:

1. Open a project from the sidebar → Project Home page renders with stats row.
2. Create an overview note → renders inline; edit persists; clear works.
3. Add a calendar event to a project (event chip → Add to project) → appears in the Events section.
4. Membership chips show on the note view and the event popover.
5. Delete the project → its tasks go, but the linked notes/events still exist in the vault.
6. Two-profile sync: `pnpm --filter @memry/desktop dev:b` on the same vault → event link + homeNoteId sync across.

---

## Self-review notes

- Spec §6 coverage: `listForItem` end-to-end (Task 1). §7 assignment entry points: event "Add to project" (Task 3); chips on note + event (Task 4). §9 Phase 2: Events section (Task 2) + `listForItem` chips (Tasks 1, 4). ✅
- Backward-compat: no migration, no new `SyncItemType`, `calendar_event` already allowed. Delete-keeps-events verified in smoke Step 3.5.
- Defensive orphan filter: EventsSection skips `getEvent === null` links (Task 2 Step 4) — no deletion path touched.
- Type consistency: `listForItem(itemType, itemId) => ProjectRef[]`, `ProjectRef = { id, name, color, icon }`, `ProjectEventsSection({ projectId })`, `AddEventToProjectDialog({ open, onOpenChange, eventId })`, `ItemProjectChips({ itemType, itemId, onProjectClick? })` used identically across tasks.
- Concurrent-session safety: new functions appended at end of the co-edited backend files; note-deletion path untouched.
