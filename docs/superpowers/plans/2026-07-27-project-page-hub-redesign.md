# Project Page Hub Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Project page with a hub — header summary, hybrid capture input, five in-page tabs (Overview / Tasks / Notes / Files / Events), and a collapsible right rail carrying overview note, progress and details.

**Architecture:** One main-process aggregate query (`tasks:project-list-contents`) replaces today's 4× link-list + N× per-item IPC fan-out. The renderer gets a single `useProjectHub` hook feeding a `pages/project/` component tree. Tab and rail state live in `tab.viewState`, so no new app tab types. One additive migration adds `project_links.pinned` for overview-pinned notes.

**Tech Stack:** Electron + React 19, TypeScript, Drizzle ORM over better-sqlite3, Vitest, Playwright, Tailwind (logical properties), i18next.

**Spec:** `docs/superpowers/specs/2026-07-27-project-page-hub-redesign-design.md`

## Global Constraints

- **Production data.** Migrations are additive and hand-written (data-DB Drizzle snapshots are broken past 0021). No DB reset, no destructive ALTER.
- **Backward compatible sync.** No new `SyncItemType`. `ProjectSyncPayloadSchema` / `ProjectLinkSyncSchema` stay plain `z.object` so old clients strip unknown fields.
- **Logging:** `createLogger('Scope')` from `electron-log`. Never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **IPC:** renderer↔main goes through `packages/contracts`. After editing contracts/preload/handlers/rpc: `pnpm ipc:generate` then `pnpm ipc:check`.
- **Tailwind RTL:** new code uses logical classes only — `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml/mr/pl/pr/left/right/text-left/text-right/border-l/border-r/rounded-l/rounded-r`.
- **i18n:** every user-visible string goes through `useT('tasks')`; new keys added to `packages/i18n/src/locales/en/tasks.json`. Verify with `pnpm --filter @memry/desktop i18n:check`.
- **Design register** (`PRODUCT.md`): calm, private, crafted. WCAG AA, reduced-motion, RTL.
- **Commit style:** no `Co-Authored-By` trailer.

---

### Task 1: `project_links.pinned` — schema, sync, and the reconcile landmine

**Files:**

- Create: `apps/desktop/src/main/database/drizzle-data/0040_project_link_pinned.sql`
- Modify: `apps/desktop/src/main/database/drizzle-data/meta/_journal.json`
- Modify: `packages/db-schema/src/schema/project-links.ts`
- Modify: `packages/contracts/src/sync-payloads.ts:84-91` (`ProjectLinkSyncSchema`)
- Modify: `apps/desktop/src/main/sync/item-handlers/project-handler.ts:64-95` (`reconcileLinks`)
- Test: `apps/desktop/src/main/sync/item-handlers/project-handler.test.ts`

**Interfaces:**

- Produces: `projectLinks.pinned` (Drizzle column, `integer`, notNull, default `0`); `ProjectLinkSync.pinned?: number`.

- [ ] **Step 1: Write the failing sync test**

In `project-handler.test.ts`, add a test proving an old-client payload (links without `pinned`) does not clear local pins:

```ts
it('preserves local pinned when an incoming link omits the field', () => {
  // seed: project p1 with link l1 pinned = 1
  seedProject(db, 'p1')
  db.insert(projectLinks)
    .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, pinned: 1 })
    .run()

  // an older client pushes the same link with no `pinned` key
  applyUpsert(db, 'p1', {
    links: [{ id: 'l1', itemType: 'note', itemId: 'n1', position: 0 }]
  })

  const link = db.select().from(projectLinks).where(eq(projectLinks.id, 'l1')).get()
  expect(link?.pinned).toBe(1)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @memry/desktop test:main -- project-handler`
Expected: FAIL — `pinned` does not exist on the schema yet.

- [ ] **Step 3: Write the migration**

`apps/desktop/src/main/database/drizzle-data/0040_project_link_pinned.sql`:

```sql
ALTER TABLE `project_links` ADD `pinned` integer DEFAULT 0 NOT NULL;
```

Append the matching entry to `meta/_journal.json`, copying the shape of the `0039_attachment_upload_queue` entry (same `version`/`when` field names, `idx` incremented, `tag` set to `0040_project_link_pinned`).

- [ ] **Step 4: Add the Drizzle column**

In `packages/db-schema/src/schema/project-links.ts`, after `position`:

```ts
    pinned: integer('pinned').notNull().default(0),
```

- [ ] **Step 5: Add the sync field**

In `packages/contracts/src/sync-payloads.ts`, `ProjectLinkSyncSchema`:

```ts
  position: z.number(),
  pinned: z.number().optional(),
  createdAt: z.string().optional()
```

Optional so an older client's payload still parses.

- [ ] **Step 6: Fix `reconcileLinks` to preserve local pins**

`project-handler.ts` — the update branch currently writes a fixed column set. Change both branches:

```ts
    if (existing) {
      tx.update(projectLinks)
        .set({
          itemType: l.itemType,
          itemId: l.itemId,
          position: l.position,
          // Old clients push links with no `pinned` key. Falling back to the
          // column default would wipe every local pin on their next push, so
          // fall back to the row we already have.
          pinned: l.pinned ?? existing.pinned ?? 0
        })
        .where(eq(projectLinks.id, l.id))
        .run()
    } else {
      tx.insert(projectLinks)
        .values({
          id: l.id,
          projectId,
          itemType: l.itemType,
          itemId: l.itemId,
          position: l.position,
          pinned: l.pinned ?? 0,
```

- [ ] **Step 7: Include `pinned` in the push payload**

In the same file, wherever links are selected for `fetchLocal` / `buildPushPayload` / `seedUnclocked`, confirm the select carries `pinned` (a bare `select()` does; an explicit column list must add it).

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @memry/desktop test:main -- project-handler`
Expected: PASS, including a round-trip test that a payload _with_ `pinned: 1` applies.

- [ ] **Step 9: Mutation-check the fallback**

Temporarily change `pinned: l.pinned ?? existing.pinned ?? 0` to `pinned: l.pinned ?? 0` and re-run. The new test MUST fail. Revert.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/database/drizzle-data packages/db-schema/src/schema/project-links.ts packages/contracts/src/sync-payloads.ts apps/desktop/src/main/sync/item-handlers/project-handler.ts apps/desktop/src/main/sync/item-handlers/project-handler.test.ts
git commit -m "feat(projects): add project_links.pinned with pin-preserving reconcile"
```

---

### Task 2: `listProjectContents` — one aggregate query through every layer

**Files:**

- Modify: `apps/desktop/src/main/database/queries/projects.ts` (add `getProjectContents`)
- Modify: `packages/storage-data/src/tasks-repository.ts:377` (add `listProjectContents`)
- Modify: `packages/domain-tasks/src/queries.ts:23,84` (add `listProjectContents`)
- Modify: `packages/contracts/src/ipc-channels.ts:152` (add `PROJECT_LIST_CONTENTS`)
- Modify: `packages/rpc/src/tasks.ts:51,260` (add `ProjectContents` type + `listProjectContents` method)
- Modify: `apps/desktop/src/main/ipc/tasks-handlers.ts:234`
- Test: `apps/desktop/src/main/database/queries/projects.test.ts`

**Interfaces:**

- Consumes: `projectLinks.pinned` from Task 1.
- Produces:

```ts
export interface ProjectLinkedNote {
  id: string
  title: string
  emoji: string | null
  modifiedAt: string
  pinned: boolean
}
export interface ProjectLinkedFile {
  id: string
  title: string
  fileType: string
  mimeType: string | null
  fileSize: number | null
  modifiedAt: string
}
export interface ProjectLinkedEvent {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
}
export interface ProjectContents {
  notes: ProjectLinkedNote[]
  files: ProjectLinkedFile[]
  events: ProjectLinkedEvent[]
  counts: { notes: number; files: number; events: number }
}
```

`notes` = links whose target has `fileType = 'markdown'`; `files` = links whose target has any other `fileType`. `pinnedNotes` is derived in the renderer as `notes.filter(n => n.pinned)` — no separate array, so the two can never disagree.

- [ ] **Step 1: Write the failing query test**

```ts
it('returns linked notes, files and events, skipping orphaned links', () => {
  seedNote(db, { id: 'n1', title: 'Spec', fileType: 'markdown' })
  seedNote(db, { id: 'f1', title: 'diagram.png', fileType: 'image', fileSize: 2048 })
  seedEvent(db, { id: 'e1', title: 'Review', startAt: '2026-08-08T12:00:00Z' })
  linkAll(db, 'p1', [
    ['note', 'n1', 1], // pinned
    ['file', 'f1', 0],
    ['calendar_event', 'e1', 0],
    ['note', 'gone', 0] // orphan: no such note
  ])

  const contents = getProjectContents(db, 'p1')

  expect(contents.notes).toEqual([
    { id: 'n1', title: 'Spec', emoji: null, modifiedAt: expect.any(String), pinned: true }
  ])
  expect(contents.files[0]).toMatchObject({ id: 'f1', fileType: 'image', fileSize: 2048 })
  expect(contents.events[0]).toMatchObject({ id: 'e1', startAt: '2026-08-08T12:00:00Z' })
  expect(contents.counts).toEqual({ notes: 1, files: 1, events: 1 })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @memry/desktop test:main -- queries/projects`
Expected: FAIL — `getProjectContents is not a function`.

- [ ] **Step 3: Implement the query**

In `apps/desktop/src/main/database/queries/projects.ts`, two inner joins — one against `note_metadata`, one against `calendar_events`. The join is what drops orphaned links, so no null-filtering is needed downstream:

```ts
export function getProjectContents(db: DataDb, projectId: string): ProjectContents {
  const noteRows = db
    .select({
      id: noteMetadata.id,
      title: noteMetadata.title,
      emoji: noteMetadata.emoji,
      fileType: noteMetadata.fileType,
      mimeType: noteMetadata.mimeType,
      fileSize: noteMetadata.fileSize,
      modifiedAt: noteMetadata.modifiedAt,
      pinned: projectLinks.pinned,
      position: projectLinks.position
    })
    .from(projectLinks)
    .innerJoin(noteMetadata, eq(noteMetadata.id, projectLinks.itemId))
    .where(
      and(eq(projectLinks.projectId, projectId), inArray(projectLinks.itemType, ['note', 'file']))
    )
    .orderBy(projectLinks.position, noteMetadata.title)
    .all()

  const eventRows = db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      isAllDay: calendarEvents.isAllDay
    })
    .from(projectLinks)
    .innerJoin(calendarEvents, eq(calendarEvents.id, projectLinks.itemId))
    .where(and(eq(projectLinks.projectId, projectId), eq(projectLinks.itemType, 'calendar_event')))
    .orderBy(calendarEvents.startAt)
    .all()

  // `item_type` records what the user linked; `file_type` is what the row
  // actually is. Trust the row — a link written before a file was converted
  // would otherwise land in the wrong list.
  const notes = noteRows
    .filter((r) => r.fileType === 'markdown')
    .map((r) => ({
      id: r.id,
      title: r.title,
      emoji: r.emoji,
      modifiedAt: r.modifiedAt,
      pinned: r.pinned === 1
    }))
  const files = noteRows
    .filter((r) => r.fileType !== 'markdown')
    .map((r) => ({
      id: r.id,
      title: r.title,
      fileType: r.fileType,
      mimeType: r.mimeType,
      fileSize: r.fileSize,
      modifiedAt: r.modifiedAt
    }))
  const events = eventRows.map((r) => ({
    id: r.id,
    title: r.title,
    startAt: r.startAt,
    endAt: r.endAt,
    isAllDay: Boolean(r.isAllDay)
  }))

  return {
    notes,
    files,
    events,
    counts: { notes: notes.length, files: files.length, events: events.length }
  }
}
```

- [ ] **Step 4: Run the query test**

Run: `pnpm --filter @memry/desktop test:main -- queries/projects`
Expected: PASS.

- [ ] **Step 5: Thread it through repository and domain**

`packages/storage-data/src/tasks-repository.ts`, next to `listProjectLinks`:

```ts
    listProjectContents(projectId: string): ProjectContents {
      return projectQueries.getProjectContents(db, projectId)
    },
```

`packages/domain-tasks/src/queries.ts` — add to the interface (near line 23) and the implementation (near line 84):

```ts
  listProjectContents(projectId: string): ProjectContents
```

```ts
    listProjectContents(projectId: string): ProjectContents {
      return repository.listProjectContents(projectId)
    },
```

- [ ] **Step 6: Add the channel, the RPC method and the handler**

`packages/contracts/src/ipc-channels.ts`, after `PROJECT_LIST_LINKS`:

```ts
    PROJECT_LIST_CONTENTS: 'tasks:project-list-contents',
```

`packages/rpc/src/tasks.ts` — export the four interfaces above, then next to `listProjectLinks`:

```ts
    listProjectContents: defineMethod<(projectId: string) => Promise<ProjectContents>>({
      channel: TasksChannels.invoke.PROJECT_LIST_CONTENTS,
      params: ['projectId']
    }),
```

`apps/desktop/src/main/ipc/tasks-handlers.ts`, mirroring the `PROJECT_LIST_LINKS` handler:

```ts
ipcMain.handle(
  TasksChannels.invoke.PROJECT_LIST_CONTENTS,
  createStringHandler(async (id) => createTaskDomain(requireDatabase()).listProjectContents(id))
)
```

- [ ] **Step 7: Regenerate and check the IPC map**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts packages/rpc packages/domain-tasks packages/storage-data apps/desktop/src/main
git commit -m "feat(projects): add tasks:project-list-contents aggregate query"
```

---

### Task 3: `setProjectLinkPinned` — pin and unpin

**Files:**

- Modify: `apps/desktop/src/main/database/queries/projects.ts`
- Modify: `packages/storage-data/src/tasks-repository.ts`
- Modify: `packages/domain-tasks/src/queries.ts` (or the mutations module beside it — follow whichever file holds `setProjectHomeNote`)
- Modify: `packages/contracts/src/ipc-channels.ts`, `packages/contracts/src/tasks-api.ts` (schema)
- Modify: `packages/rpc/src/tasks.ts`, `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Test: `apps/desktop/src/main/database/queries/projects.test.ts`

**Interfaces:**

- Consumes: `projectLinks.pinned` (Task 1).
- Produces: `tasksService.setProjectLinkPinned({ projectId, itemId, pinned }): Promise<ProjectMutationResponse>`.

- [ ] **Step 1: Write the failing test**

```ts
it('pins and unpins a link without removing it', () => {
  linkAll(db, 'p1', [['note', 'n1', 0]])

  setProjectLinkPinned(db, 'p1', 'n1', true)
  expect(getProjectLink(db, 'p1', 'note', 'n1')?.pinned).toBe(1)

  setProjectLinkPinned(db, 'p1', 'n1', false)
  const link = getProjectLink(db, 'p1', 'note', 'n1')
  expect(link).toBeDefined() // link survives
  expect(link?.pinned).toBe(0)
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @memry/desktop test:main -- queries/projects`
Expected: FAIL — `setProjectLinkPinned is not a function`.

- [ ] **Step 3: Implement the query**

```ts
export function setProjectLinkPinned(
  db: DataDb,
  projectId: string,
  itemId: string,
  pinned: boolean
): void {
  db.update(projectLinks)
    .set({ pinned: pinned ? 1 : 0 })
    .where(and(eq(projectLinks.projectId, projectId), eq(projectLinks.itemId, itemId)))
    .run()
  // Bump the project so the change rides the next sync push.
  db.update(projects)
    .set({ modifiedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId))
    .run()
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @memry/desktop test:main -- queries/projects`
Expected: PASS.

- [ ] **Step 5: Add schema, channel, RPC method and handler**

`packages/contracts/src/tasks-api.ts`:

```ts
export const ProjectSetLinkPinnedSchema = z.object({
  projectId: z.string(),
  itemId: z.string(),
  pinned: z.boolean()
})
```

`ipc-channels.ts`: `PROJECT_SET_LINK_PINNED: 'tasks:project-set-link-pinned',`

`packages/rpc/src/tasks.ts`:

```ts
export type ProjectSetLinkPinnedInput = z.input<typeof ProjectSetLinkPinnedSchema>
```

```ts
    setProjectLinkPinned: defineMethod<
      (input: ProjectSetLinkPinnedInput) => ProjectMutationResponse
    >({
      channel: TasksChannels.invoke.PROJECT_SET_LINK_PINNED,
      params: ['input']
    }),
```

`tasks-handlers.ts` — copy the `PROJECT_SET_HOME_NOTE` handler shape (`createValidatedHandler(ProjectSetLinkPinnedSchema, withDb(...))`), and emit `PROJECT_UPDATED` the same way it does so open project pages refresh.

- [ ] **Step 6: Regenerate and check**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages apps/desktop/src/main
git commit -m "feat(projects): add tasks:project-set-link-pinned"
```

---

### Task 4: `useProjectHub` — the renderer's single data source

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/use-project-hub.ts`
- Test: `apps/desktop/src/renderer/src/pages/project/use-project-hub.test.ts`

**Interfaces:**

- Consumes: `tasksService.listProjectContents` (Task 2), `useTasksContext()` for `tasks` + `projects`, `onProjectUpdated` from `@/services/tasks-service`.
- Produces:

```ts
export type ProjectTabKey = 'overview' | 'tasks' | 'notes' | 'files' | 'events'

export interface ProjectStatusProgress {
  id: string
  name: string
  color: string
  type: StatusType
  count: number
}
export interface ProjectHubData {
  project: Project | null
  tasks: Task[]
  notes: ProjectLinkedNote[]
  pinnedNotes: ProjectLinkedNote[]
  files: ProjectLinkedFile[]
  events: ProjectLinkedEvent[]
  counts: { tasks: number; notes: number; files: number; events: number }
  progress: {
    done: number
    total: number
    pct: number
    statuses: ProjectStatusProgress[]
    overdue: number
  }
  homeNoteId: string | null | undefined
  isLoading: boolean
  refresh: () => void
}
export function useProjectHub(projectId: string | undefined): ProjectHubData
```

- [ ] **Step 1: Write the failing progress test**

Progress derivation is the part with real logic, so test it directly:

```ts
describe('progress derivation', () => {
  it('emits one row per project status, including duplicate types', () => {
    const project = makeProject({
      statuses: [
        { id: 's1', name: 'To Do', color: '#000', type: 'todo', order: 0 },
        { id: 's2', name: 'Building', color: '#000', type: 'in_progress', order: 1 },
        { id: 's3', name: 'Reviewing', color: '#000', type: 'in_progress', order: 2 },
        { id: 's4', name: 'Done', color: '#000', type: 'done', order: 3 }
      ]
    })
    const tasks = [
      makeTask({ statusId: 's1' }),
      makeTask({ statusId: 's2' }),
      makeTask({ statusId: 's3' }),
      makeTask({ statusId: 's4', completedAt: new Date() })
    ]

    const progress = deriveProgress(project, tasks)

    expect(progress.statuses.map((s) => [s.name, s.count])).toEqual([
      ['To Do', 1],
      ['Building', 1],
      ['Reviewing', 1],
      ['Done', 1]
    ])
    expect(progress.done).toBe(1)
    expect(progress.total).toBe(4)
    expect(progress.pct).toBe(25)
  })

  it('counts overdue as past-due tasks not in a done status', () => {
    const project = makeProject()
    const yesterday = new Date(Date.now() - 86_400_000)
    const tasks = [
      makeTask({ statusId: 'todo', dueDate: yesterday }),
      makeTask({ statusId: 'done', dueDate: yesterday, completedAt: new Date() })
    ]
    expect(deriveProgress(project, tasks).overdue).toBe(1)
  })

  it('reports 0% for an empty project without dividing by zero', () => {
    expect(deriveProgress(makeProject(), []).pct).toBe(0)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-project-hub`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deriveProgress` and the hook**

Export `deriveProgress(project, tasks)` as a pure function from the same module so the test above needs no React. Then the hook: resolve the project from `useTasksContext()`, filter tasks with `getFilteredTasks(tasks, projectId, 'project', projects)`, load contents once with `tasksService.listProjectContents(projectId)` behind a request-id guard (mirror the `latestHomeNoteRequestRef` pattern in the current `project-home.tsx:96-116` so an out-of-order response for a previous project cannot stomp fresher state), load `homeNoteId` via `tasksService.getProject`, and re-run both on `onProjectUpdated` when `event.id === projectId`.

Overdue compares against local midnight today, not `Date.now()`, so a task due earlier today is not counted overdue.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @memry/desktop test:renderer -- use-project-hub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/project
git commit -m "feat(projects): add useProjectHub with derived progress"
```

---

### Task 5: Row components

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/rows/{task,note,file,event}-row.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/rows/{task,note,file,event}-row.test.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/rows/file-icon.ts`

**Interfaces:**

- Consumes: types from Task 2, `deriveProgress` unused here.
- Produces: `TaskRow`, `NoteRow`, `FileRow`, `EventRow`, and `fileIconFor(fileType, title): LucideIcon`.

Reuse, do not reimplement: `InlineStatusPopover`, `InlinePriorityPopover` (`components/tasks/`), the icon-picker popover pattern from `components/folder-view/folder-emoji-chip.tsx`, `NoteIconDisplay` from `@/lib/render-note-icon`.

- [ ] **Step 1: Write the failing file-icon test**

```ts
describe('fileIconFor', () => {
  it('maps by fileType', () => {
    expect(fileIconFor('pdf', 'a.pdf')).toBe(FileText)
    expect(fileIconFor('image', 'a.png')).toBe(Image)
    expect(fileIconFor('audio', 'a.mp3')).toBe(Music)
    expect(fileIconFor('video', 'a.mov')).toBe(Video)
  })
  it('uses the .md extension when fileType is markdown', () => {
    expect(fileIconFor('markdown', 'spec.md')).toBe(FileCode)
  })
  it('falls back to a generic file icon', () => {
    expect(fileIconFor('unknown', 'a.bin')).toBe(File)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- rows/file-icon`
Expected: FAIL.

- [ ] **Step 3: Implement `fileIconFor` and the four rows**

Row anatomy — leading control, body, trailing metadata, all in one `<li>` with `group` hover:

- `TaskRow` — `InlineStatusPopover` (status ring) · `InlinePriorityPopover` (priority bars) · title with `line-through` when the task's status type is `done` · tag chips · due date, `text-destructive` when overdue. Body click → `onTaskClick(task.id)`.
- `NoteRow` — icon button opening the icon picker (`onIconChange(noteId, emoji)`) · title · relative modified time. Body click → `onOpen(note.id)`.
- `FileRow` — `fileIconFor(...)` · filename · formatted `fileSize` · date. Body click → `onOpen(file.id)`.
- `EventRow` — calendar icon · title · `Intl.DateTimeFormat` date, plus time when `!isAllDay`. Body click → `onOpen(event)` (the whole event — the caller needs `startAt`).

Spacing/colour tokens follow `docs/DESIGN_TOKENS.md`. Logical Tailwind classes only.

- [ ] **Step 4: Write and run row behaviour tests**

One test per row asserting: the body click fires the callback with the right id; the leading control does NOT fire the body callback (`stopPropagation`); the trailing metadata renders. For `TaskRow`, also assert a done task renders with a line-through and an overdue date carries the destructive class.

Run: `pnpm --filter @memry/desktop test:renderer -- pages/project/rows`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/project/rows
git commit -m "feat(projects): add hub row components"
```

---

### Task 6: Page shell — header, tab bar, rail toggle

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/index.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/project-header.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/project-tab-bar.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/project-view-state.ts`
- Test: `apps/desktop/src/renderer/src/pages/project/project-view-state.test.ts`

**Interfaces:**

- Consumes: `useProjectHub` (Task 4), `useActiveTab` / `useTabActions` from `@/contexts/tabs`.
- Produces: `ProjectPage({ projectId, className })`; `readProjectTab(viewState): ProjectTabKey`, `readRailOpen(viewState): boolean`.

- [ ] **Step 1: Write the failing view-state test**

`viewState` is `Record<string, unknown>`, so parsing must be total:

```ts
describe('readProjectTab', () => {
  it('defaults to overview', () => {
    expect(readProjectTab(undefined)).toBe('overview')
    expect(readProjectTab({})).toBe('overview')
  })
  it('rejects an unknown value', () => {
    expect(readProjectTab({ projectTab: 'canvas' })).toBe('overview')
    expect(readProjectTab({ projectTab: 7 })).toBe('overview')
  })
  it('accepts a known tab', () => {
    expect(readProjectTab({ projectTab: 'files' })).toBe('files')
  })
})

describe('readRailOpen', () => {
  it('defaults to open', () => {
    expect(readRailOpen(undefined)).toBe(true)
    expect(readRailOpen({})).toBe(true)
  })
  it('honours an explicit false', () => {
    expect(readRailOpen({ railOpen: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-view-state`
Expected: FAIL.

- [ ] **Step 3: Implement the view-state helpers and the shell**

`project-view-state.ts` exports the two readers plus `PROJECT_TAB_KEYS`. `index.tsx` reads them off `useActiveTab()?.viewState`, writes back through the tab context's view-state setter (same mechanism `pages/calendar.tsx` uses to consume `focusDate`), and renders header → capture input → tab bar → active tab body, with the rail beside the body when open.

`project-header.tsx`: project icon button (`IconPickerButton`), name, `<done>/<total> done` pill, `<n> overdue` pill rendered only when `overdue > 0`, then the `PanelRight` toggle and the existing `⋯` menu. The toggle stays mounted in both states — closing the rail must never hide the way back.

`project-tab-bar.tsx`: five buttons with counts, `role="tablist"`, arrow-key roving focus, active tab marked `aria-selected`.

Keep the existing empty state from `project-home.tsx:197-210` for an unknown `projectId`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @memry/desktop test:renderer -- pages/project`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/project
git commit -m "feat(projects): add hub page shell with tab and rail state"
```

---

### Task 7: Right rail

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/project-rail.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/rail-overview.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/rail-progress.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/rail-details.tsx`
- Test: `apps/desktop/src/renderer/src/pages/project/rail-progress.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.tsx` (rail-width styling)

**Interfaces:**

- Consumes: `ProjectHubData` (Task 4), `NoteRow` (Task 5), `tasksService.setProjectLinkPinned` (Task 3), `LinkSearch` from `components/filing/link-search.tsx`.

- [ ] **Step 1: Write the failing progress-panel test**

```tsx
it('renders one row per project status plus overdue', () => {
  render(
    <RailProgress
      progress={{
        done: 12,
        total: 30,
        pct: 40,
        overdue: 3,
        statuses: [
          { id: 's1', name: 'To Do', color: '#6b7280', type: 'todo', count: 13 },
          { id: 's2', name: 'In Progress', color: '#f59e0b', type: 'in_progress', count: 5 },
          { id: 's3', name: 'Done', color: '#10b981', type: 'done', count: 12 }
        ]
      }}
    />
  )
  expect(screen.getByText('To Do')).toBeInTheDocument()
  expect(screen.getByText('13')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
})

it('hides the overdue row when nothing is overdue', () => {
  render(<RailProgress progress={{ ...base, overdue: 0 }} />)
  expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- rail-progress`
Expected: FAIL.

- [ ] **Step 3: Implement the three panels**

- `rail-overview.tsx` — `ProjectOverviewNote` (unchanged behaviour, restyled for rail width) then a `NoteRow` per `pinnedNotes` with a hover unpin control calling `setProjectLinkPinned({ projectId, itemId, pinned: false })`, then `+ add note` opening `LinkSearch`; picking a note calls `linkProjectItem` then `setProjectLinkPinned(..., true)`.
- `rail-progress.tsx` — `<done> of <total> done` with a `role="progressbar"` bar carrying `aria-valuenow`, one row per status (dot in the status colour, name, count), then the overdue row in destructive colour, omitted at zero.
- `rail-details.tsx` — Created (`project.createdAt`), Updated (`project.modifiedAt`, relative), Linked (`counts`).

In `project-overview-note.tsx`, adjust only the container/padding classes for rail width. Do not touch its save/flush logic — it is registered with the app save registry.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @memry/desktop test:renderer -- pages/project`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/project apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.tsx
git commit -m "feat(projects): add hub right rail"
```

---

### Task 8: Tabs, wiring, and dead-code removal

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/tabs/{overview,tasks,notes,files,events}-tab.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/open-linked-item.ts`
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx:65,127-128`
- Modify: `apps/desktop/src/renderer/src/components/zero-leaf-surfaces.test.tsx:14,247,270,284`
- Delete: `pages/project-home.tsx` + `pages/project-home.test.tsx`
- Delete: `components/tasks/projects/project-stats-row.tsx` + test
- Delete: `components/tasks/projects/project-notes-section.tsx` + test
- Delete: `components/tasks/projects/project-files-section.tsx` + test
- Delete: `components/tasks/projects/project-events-section.tsx` + test
- Delete: `components/tasks/projects/projects-tab-content.tsx`
- Test: `apps/desktop/src/renderer/src/pages/project/open-linked-item.test.ts`

**Interfaces:**

- Consumes: rows (Task 5), shell (Task 6), rail (Task 7).
- Produces: `openLinkedEvent(event, openTab, now)`.

Do **not** delete `project-selector.tsx` — `project-picker.tsx` and `use-project-quick-create.tsx` still use it. Do not delete the three `add-*-to-project-dialog.tsx` files — they are the reverse-direction entry points.

- [ ] **Step 1: Write the failing event-navigation test**

```ts
it('opens the calendar on the event day with the event focused', () => {
  const openTab = vi.fn()
  openLinkedEvent(
    { id: 'e1', title: 'Review', startAt: '2026-08-08T14:00:00Z', endAt: null, isAllDay: false },
    openTab,
    1_700_000_000
  )
  expect(openTab).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'calendar',
      viewState: {
        focusCalendarEventId: 'e1',
        focusDate: '2026-08-08',
        focusedAt: 1_700_000_000
      }
    })
  )
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- open-linked-item`
Expected: FAIL.

- [ ] **Step 3: Implement `openLinkedItem`**

Delegate to the proven builder rather than re-deriving the viewState:

```ts
import { buildRedirectTab } from '@/pages/canvas/canvas-redirect'

export function openLinkedEvent(
  event: ProjectLinkedEvent,
  openTab: (tab: RedirectTab) => void,
  now: number
): void {
  const tab = buildRedirectTab({
    entityType: 'calendar_event',
    entityId: event.id,
    title: event.title,
    startAt: event.startAt,
    now
  })
  if (tab) openTab(tab)
}
```

Notes and files keep using `openRelatedVaultItem(id, openTab)`.

- [ ] **Step 4: Build the five tabs**

- `overview-tab.tsx` — four sections in order Tasks, Notes, Files, Events. Each: heading with count, `View all` (calls `onTabChange('tasks' | …)`), `+`, then `items.slice(0, 5)` rendered with the Task 5 rows. A section with zero items renders its heading, a one-line empty state and the `+` — it is not hidden.
- `tasks-tab.tsx` — the existing `TaskList` with `selectedType="project"`.
- `notes-tab.tsx` / `files-tab.tsx` / `events-tab.tsx` — the full list with the same rows.

Extract the section chrome (heading + count + `View all` + `+`) into one small local component used four times rather than repeating it.

- [ ] **Step 5: Point the tab router at the new page**

`tab-content.tsx:65` — change the lazy import to `(await import('@/pages/project')).ProjectPage`, and line 128 to `<LazyProjectPage projectId={tab.entityId} />`.

- [ ] **Step 6: Delete the dead files and their references**

Remove the files listed above, plus the `ProjectsTabContent` import and its two render blocks in `zero-leaf-surfaces.test.tsx`.

- [ ] **Step 7: Verify nothing dangles**

Run: `pnpm typecheck && pnpm --filter @memry/desktop test:renderer`
Expected: clean — a missed import surfaces here.

- [ ] **Step 8: Commit**

```bash
git add -A apps/desktop/src/renderer/src
git commit -m "feat(projects): replace project page with tabbed hub, drop superseded sections"
```

---

### Task 9: Capture input — text and URL

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project/project-capture-input.tsx`
- Create: `apps/desktop/src/renderer/src/pages/project/capture-intent.ts`
- Test: `apps/desktop/src/renderer/src/pages/project/capture-intent.test.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`, `packages/contracts/src/tasks-api.ts`, `packages/rpc/src/tasks.ts`, `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Create: `apps/desktop/src/main/tasks/capture-url.ts`
- Test: `apps/desktop/src/main/tasks/capture-url.test.ts`

**Interfaces:**

- Produces: `classifyCapture(text): 'url' | 'text'`; `tasksService.captureUrlToProject({ projectId, url }): Promise<{ success: boolean; noteId?: string; error?: string }>`.

- [ ] **Step 1: Write the failing classifier test**

```ts
describe('classifyCapture', () => {
  it.each(['https://example.com/a', 'www.example.com', 'example.com/path'])(
    'treats %s as a url',
    (input) => {
      expect(classifyCapture(input)).toBe('url')
    }
  )

  it.each([
    'Ship the beta build friday p1',
    'read example.com later', // url is not the whole value
    'multi\nline with https://x.com' // multi-line is a note-shaped capture, not a link
  ])('treats %s as text', (input) => {
    expect(classifyCapture(input)).toBe('text')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- capture-intent`
Expected: FAIL.

- [ ] **Step 3: Implement the classifier**

Lift the already-proven regex and the multi-line guard from `components/capture-input.tsx:76-89` into `capture-intent.ts` and re-export `normalizeUrl` from there, so the two surfaces cannot drift apart. Update `capture-input.tsx` to import from the new module rather than keeping its own copy.

- [ ] **Step 4: Write the failing main-side URL test**

```ts
it('creates a note titled from the page and links it to the project', async () => {
  fetchTitle.mockResolvedValue('CRDT survey')
  const result = await captureUrlToProject(deps, { projectId: 'p1', url: 'https://x.com/a' })
  expect(result.success).toBe(true)
  expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'CRDT survey' }))
  expect(linkItemToProject).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p1', itemType: 'note' })
  )
})

it('falls back to the url as the title when metadata is unavailable', async () => {
  fetchTitle.mockRejectedValue(new Error('offline'))
  const result = await captureUrlToProject(deps, { projectId: 'p1', url: 'https://x.com/a' })
  expect(result.success).toBe(true)
  expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ title: 'x.com/a' }))
})
```

- [ ] **Step 5: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:main -- capture-url`
Expected: FAIL.

- [ ] **Step 6: Implement `captureUrlToProject`**

Take the title fetcher as an injected dependency so the test needs no network. Wire the real one to the existing fetcher in `apps/desktop/src/main/inbox/metadata.ts`. If `pnpm check:architecture` rejects that import, fall back to the URL-derived title and leave enrichment to a follow-up — the feature still works either way. Note content is the URL as a markdown link.

- [ ] **Step 7: Add the channel and handler, then regenerate**

Channel `PROJECT_CAPTURE_URL: 'tasks:project-capture-url'`, `ProjectCaptureUrlSchema` (`{ projectId: string, url: string }`), RPC method `captureUrlToProject`, validated handler.

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm check:architecture`
Expected: clean.

- [ ] **Step 8: Build the input component**

`project-capture-input.tsx` — one text field. On submit: `classifyCapture` → `'text'` runs the existing quick-add NLP path and creates a task in this project (reuse the parse from `components/tasks/quick-add-input.tsx`); `'url'` calls `captureUrlToProject`. The paperclip button is rendered but disabled until Task 10. Placeholder from i18n.

Per the known gotcha in CLAUDE.md, if the submit button disables itself while submitting, fire from `onPointerDown` and keep `onClick` as the keyboard fallback.

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @memry/desktop test:renderer -- pages/project && pnpm --filter @memry/desktop test:main -- capture-url`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A apps/desktop packages
git commit -m "feat(projects): add hub capture input with url capture"
```

---

### Task 10: Capture input — file attachment

**Files:**

- Create: `apps/desktop/src/main/tasks/import-files-to-project.ts`
- Test: `apps/desktop/src/main/tasks/import-files-to-project.test.ts`
- Modify: `packages/contracts/src/ipc-channels.ts`, `packages/contracts/src/tasks-api.ts`, `packages/rpc/src/tasks.ts`, `apps/desktop/src/main/ipc/tasks-handlers.ts`
- Modify: `apps/desktop/src/renderer/src/pages/project/project-capture-input.tsx`

**Interfaces:**

- Produces: `tasksService.importFilesToProject({ projectId, sourcePaths }): Promise<{ success: boolean; linked: string[]; failed: { path: string; error: string }[] }>`.

- [ ] **Step 1: Write the failing import test**

The id is minted by the indexer after import, so the handler must resolve it by path and tolerate the indexer lagging:

```ts
it('links each imported file once the indexer has assigned an id', async () => {
  importFiles.mockResolvedValue({
    success: true,
    imported: 1,
    failed: 0,
    errors: [],
    importedFiles: [{ destPath: 'notes/a.pdf', filename: 'a.pdf', fileType: 'pdf' }]
  })
  getByPath.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'file-1' })

  const result = await importFilesToProject(deps, { projectId: 'p1', sourcePaths: ['/tmp/a.pdf'] })

  expect(result.linked).toEqual(['file-1'])
  expect(linkItemToProject).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p1', itemType: 'file', itemId: 'file-1' })
  )
})

it('reports a file that never gets indexed instead of hanging', async () => {
  importFiles.mockResolvedValue({
    success: true,
    imported: 1,
    failed: 0,
    errors: [],
    importedFiles: [{ destPath: 'notes/b.pdf', filename: 'b.pdf', fileType: 'pdf' }]
  })
  getByPath.mockResolvedValue(null)

  const result = await importFilesToProject(deps, { projectId: 'p1', sourcePaths: ['/tmp/b.pdf'] })

  expect(result.linked).toEqual([])
  expect(result.failed).toEqual([{ path: 'notes/b.pdf', error: expect.stringMatching(/index/i) }])
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm --filter @memry/desktop test:main -- import-files-to-project`
Expected: FAIL.

- [ ] **Step 3: Implement the handler**

Import, then resolve each `destPath` through `getByPath` with a bounded retry (fixed interval, hard deadline — inject both the clock and the delay so the timeout test runs instantly). Link every id that resolves; collect the rest into `failed`. Never reject the whole batch because one file lagged.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @memry/desktop test:main -- import-files-to-project`
Expected: PASS.

- [ ] **Step 5: Add the channel and handler, then regenerate**

Channel `PROJECT_IMPORT_FILES: 'tasks:project-import-files'`, `ProjectImportFilesSchema` (`{ projectId: string, sourcePaths: string[] }`), RPC method, validated handler.

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: clean.

- [ ] **Step 6: Enable the paperclip**

In `project-capture-input.tsx`, the paperclip opens the OS file dialog, calls `importFilesToProject`, shows a pending state while it runs, and surfaces per-file failures with `toast.error(extractErrorMessage(...))`. On success the hub refreshes via `refresh()`.

- [ ] **Step 7: Commit**

```bash
git add -A apps/desktop packages
git commit -m "feat(projects): import and link files from the hub capture input"
```

---

### Task 11: i18n, E2E, docs and gates

**Files:**

- Modify: `packages/i18n/src/locales/en/tasks.json`
- Create: `apps/desktop/e2e/project-hub.spec.ts`
- Modify: `apps/docs/src/**` (whatever `pnpm docs:impact` routes to)

- [ ] **Step 1: Add the i18n keys**

Add a `projectHub` block covering the header pills, tab labels, section headings, empty states, capture placeholder, rail headings, and every toast. Remove keys that belonged only to the deleted sections (`projectNotes`, `projectFiles`, `projectEvents`, `projectHome.stats`) once nothing references them.

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: clean.

- [ ] **Step 2: Write the E2E spec**

Three scenarios, each asserting the thing the redesign promises:

```ts
test('View all switches the in-page tab without opening a tab', async ({ page }) => {
  // seed a project with tasks + notes, open it
  const tabCountBefore = await page.locator('[role="tab"][data-app-tab]').count()
  await page
    .getByRole('button', { name: /view all/i })
    .first()
    .click()
  await expect(page.getByRole('tab', { name: /tasks/i })).toHaveAttribute('aria-selected', 'true')
  expect(await page.locator('[role="tab"][data-app-tab]').count()).toBe(tabCountBefore)
})

test('clicking a linked event opens the calendar on that day', async ({ page }) => {
  await page.getByRole('button', { name: 'Sync architecture review' }).click()
  await expect(page.getByTestId('calendar-anchor-date')).toHaveText('2026-08-08')
})

test('the rail closes and reopens from the same control', async ({ page }) => {
  await page.getByRole('button', { name: /toggle details/i }).click()
  await expect(page.getByTestId('project-rail')).toBeHidden()
  await page.getByRole('button', { name: /toggle details/i }).click()
  await expect(page.getByTestId('project-rail')).toBeVisible()
})
```

Run: `pnpm test:e2e -- project-hub`
Expected: PASS.

- [ ] **Step 3: Run every gate**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm ipc:check
pnpm check:architecture
pnpm check:contracts
pnpm --filter @memry/desktop i18n:check
git diff --check
```

Expected: all clean. Fix anything that is not.

- [ ] **Step 4: Docs**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` (or run `pnpm docs:ai-update --base origin/main`), then re-run it and `pnpm docs:build`.

- [ ] **Step 5: Rename the branch and open the draft PR**

The current branch is `claude/project-page-redesign-30debb`; CLAUDE.md forbids agent-branded branch names.

```bash
git branch -m project-page-hub-redesign
git push -u origin project-page-hub-redesign
gh pr create --draft --title "Project page hub redesign" --body-file <(...)
```

The PR body describes the hub, the one additive migration, the three new channels and the removed components. No agent/tool branding.

- [ ] **Step 6: Commit any remaining doc changes**

```bash
git add -A
git commit -m "docs(projects): document the project hub"
```

---

## Self-Review

**Spec coverage:** D1 → Task 6 (`project-view-state`) + Task 8 (`View all`). D2 → Task 2. D3 → Task 6 (toggle) + Task 7 (panels). D4 → Tasks 9, 10. D5 → Task 7 (`rail-details` reads `modifiedAt`; no migration, per the corrected spec). D6 → Tasks 1, 3, 7. D7 → Task 4 (`deriveProgress`). UI rows → Task 5. Deletions → Task 8. Backward-compat sync test → Task 1 Step 1 + Step 9 mutation check. i18n / E2E / gates / docs → Task 11.

**Risks carried from the spec:** the `main/inbox/metadata.ts` import is resolved inside Task 9 Step 6 with a stated fallback rather than left open. The import→index race is Task 10's two tests. Rail behaviour at narrow widths is a styling concern inside Task 7. `ProjectOverviewNote` at rail width is Task 7 Step 3.

**Type consistency:** `ProjectContents` / `ProjectLinkedNote` / `ProjectLinkedFile` / `ProjectLinkedEvent` are defined once in Task 2 and consumed unchanged in Tasks 4, 5, 7, 8. `ProjectTabKey` is defined in Task 4 and used in Tasks 6, 8. `pinned` is `integer` in SQLite (Task 1), `number | undefined` on the wire (Task 1), and `boolean` at the renderer boundary (Task 2's mapper) — the conversion happens in exactly one place.
