# Project all-in-one hub — Phase 3 Implementation Plan (Overview note + first-class Project Home page)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Projects view into a dedicated first-class **Project Home page** (its own render target on the existing `project` tab type) showing an overview stats row, an inline **overview note**, and the Tasks / Notes / Calendar / Files sections — plus a sidebar projects list to reach it.

**Architecture:** MemryNote has no router; navigation is a VS Code–style tab system. A `switch (tab.type)` in `components/split-view/tab-content.tsx` renders a page per tab type. Today `case 'project'` shares the Tasks page. We **split `'project'` out** to a new lazy `ProjectHomePage` (`pages/project-home.tsx`) — no new `TabType`, no exhaustive-map edits, backward-safe for session restore. The page reuses `TaskList` (tasks), `ProjectNotesSection` (notes), the new `EventsSection` (Phase 2), and the reusable `ContentArea` BlockNote editor (overview note). The overview note is referenced by the additive `projects.home_note_id` column (Phase 1) via a pointer only — it is **not** auto-linked, so it renders as "Overview" without duplicating in the Notes section.

**Tech Stack:** TypeScript, React renderer, Electron IPC (`@memry/contracts` + `@memry/rpc`), BlockNote (`ContentArea`), Vitest + Testing Library, Zustand-ish tab reducer context.

**Spec:** `docs/superpowers/specs/2026-07-20-project-all-in-one-hub-design.md` (§7 UI, §9 Phase 3).

## Global Constraints

- Backward compatibility MANDATORY. No new `SyncItemType`; no schema change in this phase (`home_note_id` already added in Phase 1 migration `0036`). No DB reset.
- No new `TabType`. Reuse the existing `'project'` type — only change its render target. Do NOT add to `SINGLETON_TAB_TYPES` (one tab per project, dedup by `entityId`).
- New renderer code uses logical Tailwind props (`ms/me`, `ps/pe`, `start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`), never physical (`ml/mr`, `pl/pr`, `left/right`, `text-left/right`).
- Logging via `createLogger('Scope')`; user-facing errors via `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- After editing IPC contracts/RPC: run `pnpm ipc:generate` then `pnpm ipc:check`. Preload (`apps/desktop/src/preload/generated-rpc.ts`) and the invoke map are GENERATED — never hand-edit.
- All i18n strings for project-hub UI live in the `tasks` namespace (`packages/i18n/src/locales/en/tasks.json`). Run `pnpm --filter @memry/desktop i18n:check` after adding keys.
- Progress % is DERIVED (completed/total project tasks) — no stored column.
- Single-file test run: `pnpm --filter @memry/desktop test:renderer -- <path-substring>` (renderer) / `test:main -- <substring>` (main).
- **Do NOT touch the note-deletion path** (`apps/desktop/src/main/notes/domain.ts`, `notes/runtime-effects.ts`, orphan-cleanup commands) — owned by a concurrent session.

## Cross-phase execution order

This plan (Phase 3) is the container; Phase 2 (`2026-07-21-project-hub-phase2-calendar-events.md`) layers events + chips onto it. Recommended global order:

1. Phase 2 Task 1 (`listForItem` backend) — independent.
2. **Phase 3 Task 1** (`setProjectHomeNote` RPC wiring) — independent backend.
3. **Phase 3 Task 2** (Project Home page skeleton + stats + Tasks + Notes).
4. **Phase 3 Task 3** (Overview note inline + create/set/clear).
5. Phase 2 Task 2 (EventsSection — mounts on the page).
6. Phase 2 Task 3 (event "Add to project").
7. Phase 2 Task 4 (membership chips — needs `listForItem`).
8. **Phase 3 Task 4** (sidebar projects navigation).
9. Combined verification gate (in the Phase 2 plan's final task).

---

### Task 1: Surface `setProjectHomeNote` + `homeNoteId` to the renderer (RPC wiring)

`setProjectHomeNote` is fully wired main-side (channel `PROJECT_SET_HOME_NOTE` → handler → domain → repo → DB) but is **missing from the RPC**, so the renderer cannot call it. `getProject` must also expose `homeNoteId` so the page knows which note is home.

**Files:**

- Modify: `packages/rpc/src/tasks.ts` (add `setProjectHomeNote` method + `ProjectSetHomeNoteInput` type; ensure `ProjectWithStatuses`/`Project` carries `homeNoteId`)
- Modify: `packages/contracts/src/tasks-api.ts` (confirm `ProjectSetHomeNoteSchema` exists — Phase 1 added it at ~line 220; ensure the read `Project` type includes `homeNoteId`)
- Verify: `apps/desktop/src/main/database/queries/projects.ts` `getProject` selects the full project row (so `homeNoteId` is returned)
- Test: `packages/rpc/src/tasks.test.ts` if a sibling RPC test exists (else assert via the desktop IPC handler test)

**Interfaces:**

- Consumes: `TasksChannels.invoke.PROJECT_SET_HOME_NOTE` (`packages/contracts/src/ipc-channels.ts:153`), `ProjectSetHomeNoteSchema` (`tasks-api.ts`).
- Produces: `tasksService.setProjectHomeNote({ projectId, noteId: string | null }) => Promise<{ success; project; error? }>`; `ProjectWithStatuses.homeNoteId?: string | null` readable from `getProject`.

- [ ] **Step 1: Read the reuse targets**

Read `packages/rpc/src/tasks.ts` lines 213–252 (project methods `createProject`, `getProject`, `updateProject`, `linkProjectItem`) and `packages/contracts/src/tasks-api.ts` around `ProjectSetHomeNoteSchema` and the `Project` type. Confirm whether `Project`/`ProjectWithStatuses` already includes `homeNoteId`. If it does not, note the exact type to extend.

- [ ] **Step 2: Write the failing test**

Add to the RPC domain test (or, if none, `apps/desktop/src/main/ipc/tasks-handlers.test.ts`) a case asserting the RPC domain exposes `setProjectHomeNote` bound to the `PROJECT_SET_HOME_NOTE` channel. Minimal shape (RPC domain definition test):

```ts
import { tasksRpc } from './tasks'
import { TasksChannels } from '../../contracts/src/ipc-channels'

it('#then exposes setProjectHomeNote on the PROJECT_SET_HOME_NOTE channel', () => {
  expect(tasksRpc.methods.setProjectHomeNote.channel).toBe(
    TasksChannels.invoke.PROJECT_SET_HOME_NOTE
  )
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/rpc test -- tasks` (or the desktop handler test path).
Expected: FAIL — `tasksRpc.methods.setProjectHomeNote` is undefined.

- [ ] **Step 4: Add the RPC method**

In `packages/rpc/src/tasks.ts`, add near `linkProjectItem` (lines 241–252):

```ts
    setProjectHomeNote: defineMethod<(input: ProjectSetHomeNoteInput) => ProjectMutationResponse>({
      channel: TasksChannels.invoke.PROJECT_SET_HOME_NOTE,
      params: ['input']
    }),
```

Add the input type near `ProjectLinkItemInput` (line 31), importing `ProjectSetHomeNoteSchema` in the contracts import block (lines 3–11):

```ts
export type ProjectSetHomeNoteInput = z.input<typeof ProjectSetHomeNoteSchema>
```

- [ ] **Step 5: Ensure `homeNoteId` is on the read model**

If Step 1 found `Project`/`ProjectWithStatuses` lacks `homeNoteId`, add `homeNoteId?: string | null` to the `Project` interface in `packages/contracts/src/tasks-api.ts` (the source read type) so `getProject` return values type-check with the field. Confirm `getProject` in `apps/desktop/src/main/database/queries/projects.ts` returns the whole row (it selects `projects` — `homeNoteId` included). No handler change needed.

- [ ] **Step 6: Regenerate + validate IPC**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: `generated-rpc.ts` gains `setProjectHomeNote`; `ipc:check` passes.

- [ ] **Step 7: Run test + typecheck**

Run: `pnpm --filter @memry/rpc test -- tasks` → PASS. Then `pnpm typecheck` → no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/rpc/src/tasks.ts packages/contracts/src/tasks-api.ts apps/desktop/src/preload/generated-rpc.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts
git add -A
git commit -m "feat(projects): expose setProjectHomeNote + homeNoteId to renderer RPC"
```

---

### Task 2: Project Home page — skeleton, route re-point, stats row, Tasks + Notes

Create the first-class page and re-point the `'project'` tab to it. The page renders a header (project name/icon/color), a stats row (Tasks · Notes · Events · Progress %), the project's task list, and the existing `ProjectNotesSection`. (Overview note and Events section are added in Task 3 / Phase 2.)

**Files:**

- Create: `apps/desktop/src/renderer/src/pages/project-home.tsx`
- Create: `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx` (add `LazyProjectHomePage`; split `case 'project'` out of the shared task-views case)
- Modify: `packages/i18n/src/locales/en/tasks.json` (add a `projectHome` block)
- Test: `apps/desktop/src/renderer/src/pages/project-home.test.tsx`
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.test.tsx`

**Interfaces:**

- Consumes: `useTasksContext()` (`@/contexts/tasks`) → `{ tasks, projects, ... }`; `tasksService.listProjectLinks(projectId)`; `TaskList` (`@/components/tasks/task-list`); `ProjectNotesSection` (`@/components/tasks/projects/project-notes-section`).
- Produces: `ProjectHomePage({ projectId }: { projectId?: string })` named export; `ProjectStatsRow({ taskCount, noteCount, eventCount, progressPct })` named export.

- [ ] **Step 1: Read the reuse targets**

Read: `apps/desktop/src/renderer/src/pages/tasks.tsx:109–180` (how it consumes `useTasksContext`, how `selectedType='project'` filters tasks via `getFilteredTasks`/`scopeTasksByProject`), `apps/desktop/src/renderer/src/components/tasks/projects/project-notes-section.tsx` (props: `projectId`, `onNoteClick`, `className`), and `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx:26–60,110–216` (lazy block + the shared `case 'project'` at 121–159). Read one sibling page test (e.g. any `pages/*.test.tsx`) for the render/mock pattern and how `useTasksContext`/`window.api` are mocked.

- [ ] **Step 2: Write the failing stats-row test**

Create `project-stats-row.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ProjectStatsRow } from './project-stats-row'

describe('ProjectStatsRow', () => {
  it('#then renders counts and derived progress', () => {
    render(<ProjectStatsRow taskCount={4} noteCount={2} eventCount={1} progressPct={50} />)
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-stats-row`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement `ProjectStatsRow`**

Create `project-stats-row.tsx`. A presentational row of four stat tiles (label + value) using logical Tailwind props. Use `useT('tasks')` for labels (`projectHome.stats.tasks|notes|events|progress`). Example structure:

```tsx
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface ProjectStatsRowProps {
  taskCount: number
  noteCount: number
  eventCount: number
  progressPct: number
  className?: string
}

export const ProjectStatsRow = ({
  taskCount,
  noteCount,
  eventCount,
  progressPct,
  className
}: ProjectStatsRowProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tiles = [
    { label: t('projectHome.stats.tasks'), value: String(taskCount) },
    { label: t('projectHome.stats.notes'), value: String(noteCount) },
    { label: t('projectHome.stats.events'), value: String(eventCount) },
    { label: t('projectHome.stats.progress'), value: `${progressPct}%` }
  ]
  return (
    <div className={cn('grid grid-cols-4 gap-3 px-4 py-3', className)}>
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-lg border border-border bg-surface p-3 text-center"
        >
          <div className="text-lg font-semibold text-foreground">{tile.value}</div>
          <div className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">
            {tile.label}
          </div>
        </div>
      ))}
    </div>
  )
}

export default ProjectStatsRow
```

- [ ] **Step 5: Run stats-row test → PASS**

Run: `pnpm --filter @memry/desktop test:renderer -- project-stats-row` → PASS.

- [ ] **Step 6: Write the failing page test**

Create `project-home.test.tsx`. Mock `@/contexts/tasks` `useTasksContext` to return a project `{ id:'p1', name:'Launch', color:'#f00' }`, two tasks in `p1` (one with `completedAt` set), and mock `tasksService.listProjectLinks` → `[{ itemType:'note', itemId:'n1', ... }]`. Assert the page renders the project name, a stats row with task count 2 and progress 50%, and mounts the Notes section. Follow the sibling test's mocking pattern discovered in Step 1. Skeleton:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
// mock useTasksContext + tasksService + notesService per sibling pattern
import { ProjectHomePage } from './project-home'

describe('ProjectHomePage', () => {
  it('#then renders header, stats, and notes section', async () => {
    render(<ProjectHomePage projectId="p1" />)
    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(await screen.findByText('50%')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-home`
Expected: FAIL — page missing.

- [ ] **Step 8: Implement `ProjectHomePage`**

Create `project-home.tsx`. It:

- Reads `useTasksContext()` for `tasks`, `projects`; finds the project by `projectId`.
- Filters project tasks (reuse `scopeTasksByProject`/`getFilteredTasks` from `@/lib/task-utils`, same as `tasks.tsx`).
- Loads links via `tasksService.listProjectLinks(projectId)`; derives `noteCount` (filter `itemType==='note'`) and `eventCount` (filter `itemType==='calendar_event'`).
- Derives `progressPct = total === 0 ? 0 : Math.round(done / total * 100)` where `done = projectTasks.filter(t => t.completedAt != null).length`.
- Renders header (project name; a color dot from `project.color`; project icon if present), `<ProjectStatsRow .../>`, `<TaskList .../>` filtered to the project (mirror `projects-tab-content.tsx:140–159` props), and `<ProjectNotesSection projectId={projectId} onNoteClick={handleNoteClick} />`.
- `handleNoteClick` opens the note via the tab system: use `useTabActions().openTab` + `openRelatedVaultItem` (see `tasks.tsx:150–155`).
- Empty/guard: if no `projectId` or project not found, render a calm empty state (mirror `projects-tab-content.tsx:167–186`).
- Use `createLogger('ProjectHome')` and `extractErrorMessage` for the links fetch.
- Subscribe to `onProjectUpdated`/`onTaskUpdated` (from `@/services/tasks-service`) to refresh counts, OR re-derive counts from context tasks (tasks already live via context; only links need a manual refetch on `onProjectUpdated`). Keep it simple: refetch links on mount + on `onProjectUpdated` for this project id.

Leave a clearly-marked placeholder comment where the Overview note (Task 3) and Events section (Phase 2 Task 2) mount:

```tsx
{
  /* OVERVIEW_NOTE_SLOT — Phase 3 Task 3 */
}
{
  /* EVENTS_SECTION_SLOT — Phase 2 Task 2 */
}
```

- [ ] **Step 9: Re-point the `'project'` tab render target**

In `apps/desktop/src/renderer/src/components/split-view/tab-content.tsx`:

Add to the lazy block (after line 59):

```ts
const LazyProjectHomePage = React.lazy(async () => ({
  default: (await import('@/pages/project-home')).ProjectHomePage
}))
```

Remove `'project'` from the shared task-views `case` group (line 125) and add a dedicated case BEFORE it:

```ts
      case 'project':
        return <LazyProjectHomePage projectId={tab.entityId} />

      case 'tasks':
      case 'all-tasks':
      case 'today':
      case 'completed': {
        // ... unchanged body, but delete the `tab.type === 'project'` branches
        // inside selectionId/selectionType since 'project' no longer reaches here
      }
```

Simplify the now-dead `tab.type === 'project'` conditionals inside that block (selectionId/selectionType) since `'project'` no longer falls through. `tab.entityId` is already a dependency of the `useMemo` (line 216).

- [ ] **Step 10: Add i18n keys**

In `packages/i18n/src/locales/en/tasks.json`, add:

```json
"projectHome": {
  "stats": { "tasks": "Tasks", "notes": "Notes", "events": "Events", "progress": "Progress" },
  "emptyTitle": "No project selected",
  "emptyBody": "Pick a project from the sidebar to open its home."
}
```

- [ ] **Step 11: Run tests + typecheck**

Run: `pnpm --filter @memry/desktop test:renderer -- project-home` → PASS; `pnpm --filter @memry/desktop test:renderer -- project-stats-row` → PASS; `pnpm --filter @memry/desktop typecheck:web` → no errors; `pnpm --filter @memry/desktop i18n:check` → green.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/project-home.tsx apps/desktop/src/renderer/src/pages/project-home.test.tsx apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.tsx apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.test.tsx apps/desktop/src/renderer/src/components/split-view/tab-content.tsx packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): first-class Project Home page (stats + tasks + notes)"
```

---

### Task 3: Overview note — inline editor + create / set / clear

Render the project's overview note inline at the top of Project Home using the reusable `ContentArea` editor. Provide controls to create a new overview note, pick an existing note as overview, or clear it. Home is referenced by `projects.home_note_id` (a pointer) via `setProjectHomeNote` — NOT auto-linked, so it never duplicates in the Notes section.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/project-home.tsx` (mount overview at `OVERVIEW_NOTE_SLOT`)
- Modify: `packages/i18n/src/locales/en/tasks.json` (`projectHome.overview.*`)
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.test.tsx`

**Interfaces:**

- Consumes: `tasksService.getProject(projectId)` → `homeNoteId`; `tasksService.setProjectHomeNote({ projectId, noteId })` (Task 1); `notesService` (`@/services/notes-service`) create + get; `ContentArea` (`@/components/note/content-area` via `@/components/note`).
- Produces: `ProjectOverviewNote({ projectId, homeNoteId, onHomeNoteChange })` named export.

- [ ] **Step 1: Read the reuse targets**

Read `apps/desktop/src/renderer/src/pages/journal.tsx` around line 945 (how `ContentArea` is embedded: `noteId`, `initialContent`, `contentType`, `onMarkdownChange`), `apps/desktop/src/renderer/src/components/note/content-area/types.ts:80–147` (props), and `apps/desktop/src/renderer/src/services/notes-service.ts` (confirm the create method name/signature — e.g. `create`/`createNote` — and `get(id)`). Do NOT assume a create signature; use whatever `notes-service.ts` actually exports.

- [ ] **Step 2: Write the failing test**

Create `project-overview-note.test.tsx`. Mock `notesService.get` → `{ id:'n1', title:'Overview', content:'# Hi', ... }`, `tasksService.setProjectHomeNote`, `tasksService.getProject`. Two cases:

1. Given `homeNoteId='n1'`, renders the inline editor region (assert a `data-testid="overview-editor"` wrapper or the loaded content is present).
2. Given `homeNoteId={null}`, renders a "Create overview note" affordance; clicking it calls `notesService.<create>` then `tasksService.setProjectHomeNote` with the new id and fires `onHomeNoteChange`.

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
// mocks per Step 1 pattern
import { ProjectOverviewNote } from './project-overview-note'

it('#then offers create when no home note', async () => {
  render(<ProjectOverviewNote projectId="p1" homeNoteId={null} onHomeNoteChange={onChange} />)
  fireEvent.click(await screen.findByRole('button', { name: /overview note/i }))
  await waitFor(() => expect(setHomeSpy).toHaveBeenCalled())
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-overview-note`
Expected: FAIL — component missing.

- [ ] **Step 4: Implement `ProjectOverviewNote`**

Create `project-overview-note.tsx`:

- If `homeNoteId` present: load the note (`notesService.get(homeNoteId)`); render `<ContentArea noteId={homeNoteId} initialContent={note.content} contentType="markdown" onMarkdownChange={saveViaNotesService} placeholder=... />` inside a bordered "Overview" section. Wrap in the app's `EditorErrorBoundary` if the note page uses one (see `note.tsx`), and key the editor by `homeNoteId` to remount on change (mirror `note.tsx:1259`). Save-on-change routes through the same notes update path the note page uses (confirm in Step 1; if `ContentArea` already persists via `noteId`, do not double-save — read journal.tsx's usage to decide).
- A small `⋯`/menu or two buttons: "Change overview note" (opens a note picker — reuse `AddNoteToProjectDialog` pattern or a simpler note list; if a picker is heavy, ship "Clear" + "Create" only and defer "pick existing" — see decision note below) and "Clear overview" (`setProjectHomeNote({ projectId, noteId: null })` → `onHomeNoteChange(null)`).
- If `homeNoteId` is null: render a calm empty affordance with a "Create overview note" button. On click: create a blank note via `notesService.<create>` (title e.g. `t('projectHome.overview.defaultTitle')`), then `setProjectHomeNote({ projectId, noteId: newId })`, then `onHomeNoteChange(newId)`. Use `extractErrorMessage` + toast on failure.
- `createLogger('ProjectOverview')`.

> Decision note (state it in the commit): "pick existing note as overview" reuses the existing note-picker dialog if trivially available; otherwise this task ships **create + clear** (the spec's minimum: "create/set/clear"), and "set existing" is a labelled follow-up. Do NOT invent a new picker if one is not cheap to reuse.

- [ ] **Step 5: Mount in the page**

In `project-home.tsx`, replace the `OVERVIEW_NOTE_SLOT` comment with `<ProjectOverviewNote projectId={projectId} homeNoteId={homeNoteId} onHomeNoteChange={setHomeNoteId} />`, where `homeNoteId` comes from a `getProject` fetch (add a small effect that loads it on mount + on `onProjectUpdated`).

- [ ] **Step 6: Add i18n keys**

Add to `tasks.json` `projectHome`:

```json
"overview": {
  "sectionTitle": "Overview",
  "create": "Create overview note",
  "clear": "Clear overview",
  "defaultTitle": "Overview",
  "createError": "Could not create the overview note",
  "clearError": "Could not clear the overview note"
}
```

- [ ] **Step 7: Run tests + checks**

Run: `pnpm --filter @memry/desktop test:renderer -- project-overview-note` → PASS; `pnpm --filter @memry/desktop test:renderer -- project-home` → still PASS; `pnpm --filter @memry/desktop typecheck:web` → clean; `i18n:check` → green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.tsx apps/desktop/src/renderer/src/components/tasks/projects/project-overview-note.test.tsx apps/desktop/src/renderer/src/pages/project-home.tsx packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): inline overview note (create/set/clear) on Project Home"
```

---

### Task 4: Sidebar projects list → open Project Home

Without a sidebar entry, Project Home is only reachable via wiki-links. Revive the existing (test-only) sortable projects list in the sidebar; clicking a project opens its `project` tab (now the Project Home page).

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/app-sidebar.tsx` (render a projects section)
- Reuse: `apps/desktop/src/renderer/src/components/sidebar/sortable-project-list.tsx` + `sortable-project-item.tsx` (already built; currently test-only)
- Test: extend an existing sidebar test or add `apps/desktop/src/renderer/src/components/app-sidebar.projects.test.tsx`

**Interfaces:**

- Consumes: projects from the sidebar's existing data source (confirm in Step 1 — likely `useTasksContext`/a sidebar hook); `useSidebarNavigation().openSidebarItem` (`@/hooks/use-sidebar-navigation`); `SortableProjectList` (`onProjectClick(projectId)`).
- Produces: a visible, clickable projects list in the sidebar that calls `openSidebarItem({ type: 'project', title: project.name, icon: 'folder', path: '/project/' + project.id, entityId: project.id })`.

- [ ] **Step 1: Read the reuse targets**

Read `app-sidebar.tsx` (how other sections — Notes, Tasks — are rendered and where projects would slot; how it gets `openSidebarItem`, ~line 162), `sortable-project-list.tsx` (props: `projects`, `onProjectClick`, reorder handlers) and `sortable-project-item.tsx` (the `SidebarMenuButton onClick`), and `hooks/use-sidebar-navigation.ts:160–207` (`openSidebarItem` + `createTabFromSidebarItem`). Confirm where the sidebar sources the projects array.

- [ ] **Step 2: Write the failing test**

Add `app-sidebar.projects.test.tsx` (or extend an existing sidebar test). Mock the projects source with `[{ id:'p1', name:'Launch', color:'#f00' }]` and the `openSidebarItem` spy; render the sidebar; assert the project name appears; click it; assert `openSidebarItem` called with `type:'project'`, `entityId:'p1'`. Mock heavy children as needed per sibling-test patterns.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- app-sidebar.projects`
Expected: FAIL — no projects list rendered.

- [ ] **Step 4: Implement**

In `app-sidebar.tsx`, add a "Projects" section that renders `<SortableProjectList projects={activeProjects} onProjectClick={handleProjectClick} ... />` where `handleProjectClick(id)` calls `openSidebarItem({ type:'project', title: <project name>, icon:'folder', path: '/project/' + id, entityId: id })`. Source `activeProjects` the same way the sidebar sources other lists (Step 1). Keep drag/reorder wired only if the existing `SortableProjectList` requires those props to render; otherwise pass no-op handlers and defer reorder (label it). Logical Tailwind props only.

- [ ] **Step 5: Run test → PASS**

Run: `pnpm --filter @memry/desktop test:renderer -- app-sidebar.projects` → PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web` → clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/app-sidebar.tsx apps/desktop/src/renderer/src/components/app-sidebar.projects.test.tsx
git commit -m "feat(projects): sidebar projects list opens Project Home"
```

---

## Self-review notes

- Spec §7 coverage: first-class page (Task 2), overview note inline via editor (Task 3), stats row Tasks·Notes·Events·Progress% derived (Task 2), sidebar opens Project Home (Task 4). Events/Calendar + Files sections are Phase 2 / Phase 4.
- Spec §9 Phase 3 coverage: overview note create/set/clear (Task 3) + first-class page (Task 2). ✅
- Backward-compat: no schema/sync changes; `'project'` TabType reused (session-restore safe); `home_note_id` already migrated in Phase 1.
- Type consistency: `setProjectHomeNote({ projectId, noteId })`, `homeNoteId`, `ProjectHomePage({ projectId })`, `ProjectStatsRow({ taskCount, noteCount, eventCount, progressPct })`, `ProjectOverviewNote({ projectId, homeNoteId, onHomeNoteChange })` are used identically across tasks.
- Deferred/labelled: "set existing note as overview" (Task 3) and sidebar reorder (Task 4) if not cheaply reusable — must be logged, not silently dropped.
