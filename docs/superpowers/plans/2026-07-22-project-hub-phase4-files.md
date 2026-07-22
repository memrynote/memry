# Project Hub — Phase 4 (Files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **Files** section to Project Home, let a user link a file to a project, and let a user drag a sidebar note/file onto a project to link it — closing out the Projects all-in-one hub (spec §9 Phase 4).

**Architecture:** A "file" in MemryNote is a note whose `fileType ∈ {pdf,image,audio,video}` (markdown = a regular note); there is no separate file/attachment table. Its stable id is the **note id**, resolved via `notesService.getFile(id) → FileMetadata | null` (returns `null` for markdown). The `project_links` table, the link/unlink/list IPC + RPC, and the sync payload are all **already generic over `item_type`** (contract enums already include `'file'`, `queries/projects.ts` types `itemType` as `string`, and the project sync payload selects _all_ links for a project). So Phase 4 is **renderer-only**: mirror the existing `ProjectNotesSection`/`AddNoteToProjectDialog` patterns for files, and add a native-HTML5 drop target on the sidebar project item. **No migration, no new `SyncItemType`, no contract/RPC/main-process change.**

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library (jsdom), Tailwind (logical props), `@memry/i18n`, dnd-kit (sidebar sortable) + native HTML5 DnD (sidebar note drag), `electron-log` logger, `sonner` toasts.

## Global Constraints

- **PRODUCTION, backward-compat MANDATORY:** additive only, no DB reset. Phase 4 adds **no** migration, **no** new `SyncItemType`, **no** contract/RPC change — file links ride the existing `project_links` + project sync payload. If a migration ever seems needed, STOP.
- **Deleting a project keeps notes/events/files** (only `project_links` + tasks cascade) — unchanged from Phase 1; nothing in this plan alters delete semantics.
- **Do NOT touch** the note-deletion / orphan-link-cleanup path (`main/notes/domain.ts`, `notes/runtime-effects.ts`, `cleanupProjectLinksForDeletedNote`). Only **defensively skip** null-target links in new read-only sections.
- `listForItem` consumers must guard `Array.isArray(result)` (served via `withDb`, may return an error envelope).
- New renderer code uses **logical Tailwind props only** (`ms/me/ps/pe/start/end`, `text-start/end`, `border-s/e`, `rounded-s/e`).
- Logging via `createLogger('Scope')`; user-facing errors via `extractErrorMessage(err, fallback)`.
- i18n: add English keys to `packages/i18n/src/locales/en/tasks.json`; `pnpm i18n:check` gates English only.
- Files are notes → resolve via `notesService.getFile(id)`; a `null` result means the link is orphaned (file deleted) OR the id is a markdown note — skip it in the Files section.
- Tests: renderer via `pnpm --filter @memry/desktop test:renderer` (runs the FULL suite; there is no file filter). Native context menus / `Picker` do NOT open in jsdom — unit-test rendered components + extracted pure logic, not menu-open flows.

---

## File Structure

**New files:**

- `apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.tsx` — Project Home "Files" section (mirror of `project-notes-section.tsx`).
- `apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.tsx` — "Add to project" dialog for a file (mirror of `add-note-to-project-dialog.tsx`).
- `apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.test.tsx`
- `apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.ts` — pure helper: read the dragged note id from a `DataTransfer`, resolve file-vs-note, link it. (Extracted so the drop logic is testable without dnd-kit context.)
- `apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.test.ts`

**Modified files:**

- `apps/desktop/src/renderer/src/pages/project-home.tsx` — mount `<ProjectFilesSection>` at the `FILES_SECTION_SLOT`; compute `fileCount`; pass it to `ProjectStatsRow`.
- `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.tsx` — add a required `fileCount` prop + a 5th "Files" tile (`grid-cols-5`).
- `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.test.tsx` — cover the new tile.
- `apps/desktop/src/renderer/src/pages/project-home.test.tsx` — new test: a file link renders in the Files section.
- `apps/desktop/src/renderer/src/pages/file.tsx` — "Add to project" button in the info bar + `ItemProjectChips` + dialog wiring.
- `apps/desktop/src/renderer/src/pages/file.test.tsx` — (create if absent) cover the new button/chips.
- `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx` — set `MEMRY_NOTE_DRAG_MIME` for **all** non-folder items (not just files).
- `apps/desktop/src/renderer/src/lib/drag-mime.ts` — update the doc comment to reflect notes + files.
- `apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.tsx` — native `onDragOver`/`onDragLeave`/`onDrop` to link a dragged sidebar item.
- `apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.test.tsx` — (create) cover the drop-to-link wiring.
- `packages/i18n/src/locales/en/tasks.json` — `projectFiles.*` + `projectHome.stats.files`.
- `apps/docs/src/user-guide/projects.md` — extend "Project Home" with Files.

**Reference (read, do not modify) — the patterns being mirrored:**

- `project-notes-section.tsx` — the section shape (filter links by `itemType`, resolve each item, skip nulls, unlink control, `return null` when empty).
- `project-events-section.tsx` — same shape with async resolution + per-item icon.
- `add-note-to-project-dialog.tsx` / `add-event-to-project-dialog.tsx` — the "Add to project" dialog.
- `item-project-chips.tsx` — membership chips (`Array.isArray` guard).
- `pages/project-home.tsx` — where sections mount; the `onProjectUpdated` refresh wiring.

---

## Task 1: Project Files section

Mirrors `ProjectNotesSection` for `itemType === 'file'`, resolving each link via `notesService.getFile` and skipping orphaned/markdown links.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.tsx`
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.test.tsx`
- Modify: `packages/i18n/src/locales/en/tasks.json`

**Interfaces:**

- Consumes: `tasksService.listProjectLinks(projectId) → Promise<ProjectLink[]>` where `ProjectLink = { id; projectId; itemType: string; itemId: string; position: number; createdAt: string }`; `tasksService.unlinkProjectItem({ projectId, itemType, itemId }) → Promise<{ success: boolean; error?: string }>`; `notesService.getFile(id) → Promise<FileMetadata | null>` where `FileMetadata` has `{ id: string; title: string; fileType: 'pdf'|'image'|'audio'|'video' }`.
- Produces: `export const ProjectFilesSection: (props: { projectId: string; onFileClick?: (fileId: string) => void; className?: string }) => React.JSX.Element | null`.

- [ ] **Step 1: Add i18n keys**

In `packages/i18n/src/locales/en/tasks.json`, add a `projectFiles` block as a sibling of the existing `projectNotes` block (keep the file valid JSON — add a comma after the preceding block):

```json
  "projectFiles": {
    "title": "Files",
    "loading": "Loading files…",
    "loadError": "Failed to load project files",
    "removeFromProject": "Remove from project",
    "removeError": "Failed to remove file from project"
  },
```

- [ ] **Step 2: Write the failing test**

Create `project-files-section.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectFilesSection } from './project-files-section'

const mocks = vi.hoisted(() => ({
  listProjectLinks: vi.fn(),
  unlinkProjectItem: vi.fn(),
  getFile: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjectLinks: mocks.listProjectLinks,
    unlinkProjectItem: mocks.unlinkProjectItem
  }
}))
vi.mock('@/services/notes-service', () => ({
  notesService: { getFile: mocks.getFile }
}))

const fileLink = (id: string) => ({
  id: `link-${id}`,
  projectId: 'p1',
  itemType: 'file',
  itemId: id,
  position: 0,
  createdAt: ''
})

describe('ProjectFilesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.unlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then lists only file-typed links, resolved by getFile', async () => {
    mocks.listProjectLinks.mockResolvedValue([
      fileLink('f1'),
      { id: 'link-n', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0, createdAt: '' }
    ])
    mocks.getFile.mockImplementation(async (id: string) =>
      id === 'f1' ? { id: 'f1', title: 'Budget.pdf', fileType: 'pdf' } : null
    )

    render(<ProjectFilesSection projectId="p1" />)

    expect(await screen.findByText('Budget.pdf')).toBeInTheDocument()
    // The note-typed link is never resolved as a file.
    expect(mocks.getFile).toHaveBeenCalledTimes(1)
    expect(mocks.getFile).toHaveBeenCalledWith('f1')
  })

  it('#then skips orphaned file links whose getFile returns null', async () => {
    mocks.listProjectLinks.mockResolvedValue([fileLink('f1'), fileLink('gone')])
    mocks.getFile.mockImplementation(async (id: string) =>
      id === 'f1' ? { id: 'f1', title: 'Slide.png', fileType: 'image' } : null
    )

    render(<ProjectFilesSection projectId="p1" />)

    expect(await screen.findByText('Slide.png')).toBeInTheDocument()
    expect(screen.queryByText('gone')).not.toBeInTheDocument()
  })

  it('#then renders nothing when there are no file links', async () => {
    mocks.listProjectLinks.mockResolvedValue([])
    const { container } = render(<ProjectFilesSection projectId="p1" />)
    await waitFor(() => expect(mocks.listProjectLinks).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('#then unlinks a file on remove click', async () => {
    mocks.listProjectLinks.mockResolvedValue([fileLink('f1')])
    mocks.getFile.mockResolvedValue({ id: 'f1', title: 'Budget.pdf', fileType: 'pdf' })

    render(<ProjectFilesSection projectId="p1" />)
    await screen.findByText('Budget.pdf')

    await userEvent.click(screen.getByRole('button', { name: 'Remove from project' }))

    await waitFor(() =>
      expect(mocks.unlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
    expect(screen.queryByText('Budget.pdf')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-files-section`
Expected: FAIL — `Cannot find module './project-files-section'`.

- [ ] **Step 4: Write the component**

Create `project-files-section.tsx` (mirror `project-notes-section.tsx`; per-`fileType` icon; `notesService.getFile` resolution; skip nulls):

```tsx
import { useCallback, useEffect, useState } from 'react'
import { File, FileText, Image, Music, Video, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { tasksService } from '@/services/tasks-service'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ProjectFiles')

type FileKind = 'pdf' | 'image' | 'audio' | 'video'

interface LinkedFile {
  itemId: string
  title: string
  fileType: FileKind
}

const FILE_ICONS = {
  pdf: FileText,
  image: Image,
  audio: Music,
  video: Video
} as const

interface ProjectFilesSectionProps {
  projectId: string
  onFileClick?: (fileId: string) => void
  className?: string
}

/**
 * Project Home "Files" section — lists the files (notes with a non-markdown
 * fileType) linked to a project via `project_links` and lets the user unlink
 * one. Files are resolved through `notesService.getFile`, which returns null
 * for a deleted file or a markdown note, so orphaned links are skipped.
 */
export const ProjectFilesSection = ({
  projectId,
  onFileClick,
  className
}: ProjectFilesSectionProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const [files, setFiles] = useState<LinkedFile[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadFiles = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const links = await tasksService.listProjectLinks(projectId)
      const fileLinks = links.filter((link) => link.itemType === 'file')
      const resolved = await Promise.all(
        fileLinks.map(async (link) => {
          // Defensive: getFile returns null for a deleted file (orphaned link)
          // or a markdown id; skip either. Cleanup of orphaned links is owned
          // by a concurrent effort.
          const file = await notesService.getFile(link.itemId)
          if (!file) return null
          return { itemId: link.itemId, title: file.title, fileType: file.fileType }
        })
      )
      setFiles(resolved.filter((file): file is LinkedFile => file !== null))
    } catch (error) {
      log.error(
        'Failed to load project files',
        extractErrorMessage(error, t('projectFiles.loadError'))
      )
    } finally {
      setIsLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const handleRemove = useCallback(
    async (itemId: string): Promise<void> => {
      try {
        await tasksService.unlinkProjectItem({ projectId, itemType: 'file', itemId })
        setFiles((prev) => prev.filter((file) => file.itemId !== itemId))
      } catch (error) {
        log.error(
          'Failed to remove file from project',
          extractErrorMessage(error, t('projectFiles.removeError'))
        )
      }
    },
    [projectId, t]
  )

  if (!isLoading && files.length === 0) return null

  return (
    <section className={cn('px-4 py-3 border-t border-border', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectFiles.title')}
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('projectFiles.loading')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {files.map((file) => {
            const Icon = FILE_ICONS[file.fileType] ?? File
            return (
              <div
                key={file.itemId}
                className="group relative flex items-center gap-2 rounded-md border border-border p-2 hover:bg-surface-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-start"
                  onClick={() => onFileClick?.(file.itemId)}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-sm">{file.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('projectFiles.removeFromProject')}
                  onClick={() => void handleRemove(file.itemId)}
                  className="shrink-0 rounded-sm p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default ProjectFilesSection
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- project-files-section`
Expected: PASS (4 tests).

- [ ] **Step 6: i18n gate**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (English keys present).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.tsx \
        apps/desktop/src/renderer/src/components/tasks/projects/project-files-section.test.tsx \
        packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): add Project Home Files section"
```

---

## Task 2: Mount Files section + Files stat tile

Mounts `ProjectFilesSection` on Project Home below the Events section and adds a Files count to the stats row.

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.test.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/project-home.tsx`
- Modify: `apps/desktop/src/renderer/src/pages/project-home.test.tsx`
- Modify: `packages/i18n/src/locales/en/tasks.json`

**Interfaces:**

- Consumes: `ProjectFilesSection` (Task 1); `ProjectLink.itemType`.
- Produces: `ProjectStatsRow` now requires `fileCount: number`.

- [ ] **Step 1: Add the stats i18n key**

In `packages/i18n/src/locales/en/tasks.json`, add `"files": "Files"` to the existing `projectHome.stats` object (which currently has `tasks`/`notes`/`events`/`progress`).

- [ ] **Step 2: Update the stats-row test (failing)**

In `project-stats-row.test.tsx`, add `fileCount` to the rendered props and assert the Files tile. (Read the existing test first; add a case mirroring the notes/events assertions, and add `fileCount={4}` to any existing render call so the required prop is satisfied.) Example new case:

```tsx
it('#then renders the files tile', () => {
  render(
    <ProjectStatsRow taskCount={1} noteCount={2} eventCount={3} fileCount={4} progressPct={50} />
  )
  expect(screen.getByText('Files')).toBeInTheDocument()
  expect(screen.getByText('4')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-stats-row`
Expected: FAIL — type error / missing `fileCount`.

- [ ] **Step 4: Add the prop + tile**

In `project-stats-row.tsx`: add `fileCount: number` to `ProjectStatsRowProps`, destructure it, add a Files tile between Events and Progress, and widen the grid to 5 columns:

```tsx
interface ProjectStatsRowProps {
  taskCount: number
  noteCount: number
  eventCount: number
  fileCount: number
  progressPct: number
  className?: string
}

export const ProjectStatsRow = ({
  taskCount,
  noteCount,
  eventCount,
  fileCount,
  progressPct,
  className
}: ProjectStatsRowProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tiles = [
    { label: t('projectHome.stats.tasks'), value: String(taskCount) },
    { label: t('projectHome.stats.notes'), value: String(noteCount) },
    { label: t('projectHome.stats.events'), value: String(eventCount) },
    { label: t('projectHome.stats.files'), value: String(fileCount) },
    { label: t('projectHome.stats.progress'), value: `${progressPct}%` }
  ]
  return (
    <div className={cn('grid grid-cols-5 gap-3 px-4 py-3', className)}>
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
```

- [ ] **Step 5: Wire Project Home**

In `project-home.tsx`:

1. Add the import next to the other section imports:

```tsx
import { ProjectFilesSection } from '@/components/tasks/projects/project-files-section'
```

2. Add a `fileCount` memo next to `noteCount`/`eventCount`:

```tsx
const fileCount = useMemo(() => links.filter((link) => link.itemType === 'file').length, [links])
```

3. Pass it to `<ProjectStatsRow>`:

```tsx
<ProjectStatsRow
  taskCount={projectTasks.length}
  noteCount={noteCount}
  eventCount={eventCount}
  fileCount={fileCount}
  progressPct={progressPct}
/>
```

4. Mount the section below `<ProjectNotesSection>` (the `FILES_SECTION_SLOT`). `handleNoteClick` already routes any vault item id via `openRelatedVaultItem`, so reuse it for files:

```tsx
;<ProjectNotesSection projectId={project.id} onNoteClick={handleNoteClick} />

{
  /* FILES_SECTION_SLOT */
}
;<ProjectFilesSection projectId={project.id} onFileClick={handleNoteClick} />
```

- [ ] **Step 6: Add the Project Home files test**

In `project-home.test.tsx`, add a test that a file link renders. `notesGetFile` is already mocked; make `listProjectLinks` return a file link and `getFile` resolve it:

```tsx
it('#then renders linked files in the Files section', async () => {
  mocks.listProjectLinks.mockResolvedValue([
    { id: 'l-f', projectId: 'p1', itemType: 'file', itemId: 'f1', position: 0, createdAt: '' }
  ])
  mocks.notesGetFile.mockResolvedValue({ id: 'f1', title: 'Budget.pdf', fileType: 'pdf' })

  render(<ProjectHomePage projectId="p1" />)

  expect(await screen.findByText('Budget.pdf')).toBeInTheDocument()
})
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- project-stats-row project-home`
Expected: PASS (stats-row + project-home suites, including the new cases).

- [ ] **Step 8: i18n gate + commit**

```bash
pnpm --filter @memry/desktop i18n:check
git add apps/desktop/src/renderer/src/pages/project-home.tsx \
        apps/desktop/src/renderer/src/pages/project-home.test.tsx \
        apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.tsx \
        apps/desktop/src/renderer/src/components/tasks/projects/project-stats-row.test.tsx \
        packages/i18n/src/locales/en/tasks.json
git commit -m "feat(projects): mount Files section and Files stat on Project Home"
```

---

## Task 3: "Add file to project" dialog

Mirrors `AddNoteToProjectDialog` with `itemType: 'file'`. Reuses the existing `addToProject.*` i18n copy.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.tsx`
- Test: `apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listProjects() → Promise<{ projects: ProjectWithStats[] }>`; `tasksService.linkProjectItem({ projectId, itemType, itemId }) → Promise<{ success: boolean; error?: string }>`.
- Produces: `export const AddFileToProjectDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void; fileId: string }) => React.JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `add-file-to-project-dialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddFileToProjectDialog } from './add-file-to-project-dialog'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  linkProjectItem: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { listProjects: mocks.listProjects, linkProjectItem: mocks.linkProjectItem }
}))

describe('AddFileToProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listProjects.mockResolvedValue({
      projects: [{ id: 'p1', name: 'Launch', color: '#f00', archivedAt: null }]
    })
    mocks.linkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then links the file to the chosen project as itemType file', async () => {
    render(<AddFileToProjectDialog open onOpenChange={vi.fn()} fileId="f1" />)

    await userEvent.click(await screen.findByText('Launch'))

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- add-file-to-project-dialog`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the dialog**

Create `add-file-to-project-dialog.tsx` — copy `add-note-to-project-dialog.tsx` verbatim, then change: the interface name → `AddFileToProjectDialogProps`, the prop `noteId` → `fileId`, the component name → `AddFileToProjectDialog`, the doc comment → "File info bar → 'Add to project'", and the link call to:

```tsx
const result = await tasksService.linkProjectItem({
  projectId: project.id,
  itemType: 'file',
  itemId: fileId
})
```

Full file:

```tsx
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { tasksService, type ProjectWithStats } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('AddToProject')

interface AddFileToProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileId: string
}

/**
 * File info bar → "Add to project": lists active projects and links the file
 * to the chosen one via `PROJECT_LINK_ITEM` (itemType 'file').
 */
export const AddFileToProjectDialog = ({
  open,
  onOpenChange,
  fileId
}: AddFileToProjectDialogProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setIsLoading(true)
    tasksService
      .listProjects()
      .then((res) => setProjects(res.projects.filter((project) => project.archivedAt == null)))
      .catch((error) => log.error('Failed to list projects', extractErrorMessage(error)))
      .finally(() => setIsLoading(false))
  }, [open])

  const handleSelect = async (project: ProjectWithStats): Promise<void> => {
    try {
      const result = await tasksService.linkProjectItem({
        projectId: project.id,
        itemType: 'file',
        itemId: fileId
      })
      if (!result.success) throw new Error(result.error)
      toast.success(t('addToProject.toastSuccess', { name: project.name }))
      onOpenChange(false)
    } catch (error) {
      toast.error(extractErrorMessage(error, t('addToProject.toastError')))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('addToProject.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[300px] -mx-2">
          <div className="space-y-1 px-2">
            {isLoading ? (
              <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
                {t('addToProject.loading')}
              </div>
            ) : projects.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
                {t('addToProject.noProjects')}
              </div>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => void handleSelect(project)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md p-2 text-start transition-colors',
                    'hover:bg-muted/50'
                  )}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-sm">{project.name}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

export default AddFileToProjectDialog
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- add-file-to-project-dialog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.tsx \
        apps/desktop/src/renderer/src/components/tasks/projects/add-file-to-project-dialog.test.tsx
git commit -m "feat(projects): add AddFileToProjectDialog"
```

---

## Task 4: FilePage "Add to project" entry point + chips

Adds an "Add to project" button to the `FilePage` info bar (mirroring the note ⋯ menu entry) and shows the file's project-membership chips.

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/file.tsx`
- Test: `apps/desktop/src/renderer/src/pages/file.test.tsx` (create if absent)

**Interfaces:**

- Consumes: `AddFileToProjectDialog` (Task 3); `ItemProjectChips` (`{ itemType: 'file'; itemId: string; onProjectClick? }`); `useTabActions().openTab`.

- [ ] **Step 1: Write the failing test**

Create/extend `file.test.tsx`. Mock `notesService.getFile` to resolve a file, mock `ItemProjectChips` + `AddFileToProjectDialog` to simple markers, and assert the button opens the dialog:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FilePage } from './file'

const mocks = vi.hoisted(() => ({ getFile: vi.fn(), openTab: vi.fn() }))

vi.mock('@/services/notes-service', () => ({ notesService: { getFile: mocks.getFile } }))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
vi.mock('@/components/tasks/projects/item-project-chips', () => ({
  ItemProjectChips: ({ itemType, itemId }: { itemType: string; itemId: string }) => (
    <div data-testid="chips" data-item-type={itemType} data-item-id={itemId} />
  )
}))
vi.mock('@/components/tasks/projects/add-file-to-project-dialog', () => ({
  AddFileToProjectDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-file-dialog" /> : null
}))

const renderPage = (fileId: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FilePage fileId={fileId} />
    </QueryClientProvider>
  )
}

describe('FilePage add-to-project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFile.mockResolvedValue({
      id: 'f1',
      title: 'Budget.pdf',
      absolutePath: '/v/Budget.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
      created: new Date(),
      modified: new Date()
    })
  })

  it('#then renders file chips with itemType file', async () => {
    renderPage('f1')
    const chips = await screen.findByTestId('chips')
    expect(chips).toHaveAttribute('data-item-type', 'file')
    expect(chips).toHaveAttribute('data-item-id', 'f1')
  })

  it('#then opens the add-to-project dialog from the info-bar button', async () => {
    renderPage('f1')
    await userEvent.click(await screen.findByRole('button', { name: 'Add to project' }))
    expect(screen.getByTestId('add-file-dialog')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- pages/file`
Expected: FAIL — no "Add to project" button / no chips.

- [ ] **Step 3: Implement the entry point**

In `file.tsx`:

1. Add imports:

```tsx
import { useState } from 'react'
import { Loader2, FileWarning, Download, ExternalLink, FolderPlus } from '@/lib/icons'
import { useTabActions } from '@/contexts/tabs'
import { ItemProjectChips } from '@/components/tasks/projects/item-project-chips'
import { AddFileToProjectDialog } from '@/components/tasks/projects/add-file-to-project-dialog'
```

(Keep the existing `@/lib/icons` import — just add `FolderPlus`. Merge the `useState` into the existing React import.)

2. Change `FileInfoBar` to accept an `onAddToProject` callback and render the button + chips. Add a `tTasks` hook for the tasks-namespace label:

```tsx
function FileInfoBar({ file, onAddToProject }: { file: FileMetadata; onAddToProject: () => void }) {
  const { t: tPhaseF } = useT('notes')
  const { t: tTasks } = useT('tasks')
  return (
    <div className="flex flex-col gap-1 border-b border-border bg-muted/30 flex-shrink-0">
      <div className="flex items-center justify-between gap-2 px-2 sm:px-4 py-2">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
          <h1 className="font-medium truncate flex-1 min-w-0">{file.title}</h1>
          <span className="text-xs text-muted-foreground uppercase flex-shrink-0 hidden sm:inline">
            {file.fileType}
          </span>
          <span className="text-xs text-muted-foreground flex-shrink-0 hidden md:inline">
            {formatFileSize(file.fileSize)}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddToProject}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={tTasks('addToProject.menuLabel')}
          >
            <FolderPlus className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tTasks('addToProject.menuLabel')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.api.notes.openExternal(file.id)}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={tPhaseF('phaseF.pagesFile.openInDefaultApp')}
          >
            <ExternalLink className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tPhaseF('phaseF.pagesFile.open')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void window.api.notes.revealInFinder(file.id)}
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            title={tPhaseF('phaseF.pagesFile.revealInFinder')}
          >
            <Download className="h-4 w-4 sm:me-1" />
            <span className="hidden sm:inline">{tPhaseF('phaseF.pagesFile.reveal')}</span>
          </Button>
        </div>
      </div>
      <div className="px-2 sm:px-4 pb-2">
        <ItemProjectChips itemType="file" itemId={file.id} />
      </div>
    </div>
  )
}
```

Note: `ItemProjectChips` returns `null` when the file has no projects, so the chip strip collapses cleanly.

3. In `FilePage`, add dialog state + wire the button, and pass an `onProjectClick` from chips to open the project (optional — chips already render). Update the success return:

```tsx
export function FilePage({ fileId }: FilePageProps) {
  const [addToProjectOpen, setAddToProjectOpen] = useState(false)
  // ...existing useQuery + guards unchanged...

  return (
    <div className={cn('flex h-full flex-col min-h-0')}>
      <FileInfoBar file={file} onAddToProject={() => setAddToProjectOpen(true)} />
      <FileViewer file={file} />
      <AddFileToProjectDialog
        open={addToProjectOpen}
        onOpenChange={setAddToProjectOpen}
        fileId={file.id}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- pages/file`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/file.tsx \
        apps/desktop/src/renderer/src/pages/file.test.tsx
git commit -m "feat(projects): add 'Add to project' + membership chips to FilePage"
```

---

## Task 5: Sidebar drag-note/file-onto-project → link

Widens `MEMRY_NOTE_DRAG_MIME` to cover markdown notes (not just files), then adds a native HTML5 drop target on the sidebar project item that links the dragged item (resolving file vs note).

**Files:**

- Create: `apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.ts`
- Test: `apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.test.ts`
- Modify: `apps/desktop/src/renderer/src/lib/drag-mime.ts` (doc comment only)
- Modify: `apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx` (drag source)
- Modify: `apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.tsx`
- Test: `apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.test.tsx` (create)

**Interfaces:**

- Consumes: `MEMRY_NOTE_DRAG_MIME`; `notesService.getFile(id) → Promise<{ id } | null>`; `tasksService.linkProjectItem(input) → Promise<{ success: boolean; error?: string }>`.
- Produces: `export async function linkSidebarItemToProject(dataTransfer: Pick<DataTransfer,'getData'|'types'>, projectId: string, deps: { getFile; link }): Promise<{ itemType: 'note'|'file'; itemId: string } | null>`.

- [ ] **Step 1: Write the failing helper test**

Create `link-sidebar-item-to-project.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { linkSidebarItemToProject } from './link-sidebar-item-to-project'
import { MEMRY_NOTE_DRAG_MIME } from './drag-mime'

const dt = (mime: string | null, id: string): Pick<DataTransfer, 'getData' | 'types'> => ({
  types: mime ? [mime] : [],
  getData: (type: string) => (type === mime ? id : '')
})

describe('linkSidebarItemToProject', () => {
  it('#then links a markdown note as itemType note', async () => {
    const getFile = vi.fn().mockResolvedValue(null)
    const link = vi.fn().mockResolvedValue({ success: true })

    const result = await linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'n1'), 'p1', {
      getFile,
      link
    })

    expect(link).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'note', itemId: 'n1' })
    expect(result).toEqual({ itemType: 'note', itemId: 'n1' })
  })

  it('#then links a file (getFile non-null) as itemType file', async () => {
    const getFile = vi.fn().mockResolvedValue({ id: 'f1' })
    const link = vi.fn().mockResolvedValue({ success: true })

    const result = await linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'f1'), 'p1', {
      getFile,
      link
    })

    expect(link).toHaveBeenCalledWith({ projectId: 'p1', itemType: 'file', itemId: 'f1' })
    expect(result).toEqual({ itemType: 'file', itemId: 'f1' })
  })

  it('#then no-ops when the drag carries no note MIME', async () => {
    const getFile = vi.fn()
    const link = vi.fn()

    const result = await linkSidebarItemToProject(dt(null, ''), 'p1', { getFile, link })

    expect(result).toBeNull()
    expect(getFile).not.toHaveBeenCalled()
    expect(link).not.toHaveBeenCalled()
  })

  it('#then throws when link fails', async () => {
    const getFile = vi.fn().mockResolvedValue(null)
    const link = vi.fn().mockResolvedValue({ success: false, error: 'boom' })

    await expect(
      linkSidebarItemToProject(dt(MEMRY_NOTE_DRAG_MIME, 'n1'), 'p1', { getFile, link })
    ).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- link-sidebar-item-to-project`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `link-sidebar-item-to-project.ts`:

```ts
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import type { ProjectItemType } from '@/services/tasks-service'

interface LinkSidebarItemDeps {
  getFile: (id: string) => Promise<{ id: string } | null>
  link: (input: {
    projectId: string
    itemType: ProjectItemType
    itemId: string
  }) => Promise<{ success: boolean; error?: string }>
}

/**
 * Links a sidebar item (dragged from the notes tree via MEMRY_NOTE_DRAG_MIME)
 * to a project. Files are notes with a non-markdown fileType, so
 * `getFile(id)` returns non-null exactly for files — the file/note
 * discriminator. Returns null when the drag carried no linkable item (so the
 * caller can skip the toast); throws when the link call reports failure.
 */
export async function linkSidebarItemToProject(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
  projectId: string,
  deps: LinkSidebarItemDeps
): Promise<{ itemType: ProjectItemType; itemId: string } | null> {
  if (!dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return null
  const itemId = dataTransfer.getData(MEMRY_NOTE_DRAG_MIME)
  if (!itemId) return null

  const file = await deps.getFile(itemId)
  const itemType: ProjectItemType = file ? 'file' : 'note'
  const result = await deps.link({ projectId, itemType, itemId })
  if (!result.success) throw new Error(result.error)
  return { itemType, itemId }
}
```

Note: `ProjectItemType` is `'note' | 'calendar_event' | 'file'` and is already exported from `@/services/tasks-service`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- link-sidebar-item-to-project`
Expected: PASS (4 tests).

- [ ] **Step 5: Widen the drag source**

In `virtualized-notes-tree.tsx` `handleDragStart` (currently ~line 928-935), move the `MEMRY_NOTE_DRAG_MIME` `setData` OUT of the `fileType !== 'markdown'` guard so **every** non-folder item carries it. Result:

```tsx
if (!isFolder(itemId)) {
  // Tag every note/file item so drop targets (note editor embed, sidebar
  // project link) can resolve it by id. getFile(id) later discriminates
  // a file (non-markdown, embeddable) from a plain note (returns null).
  e.dataTransfer.setData(MEMRY_NOTE_DRAG_MIME, itemId)
  // Every non-folder item is a note entity — tag it so the spatial canvas
  // can create a referencing card on drop (markdown notes set no other MIME).
  e.dataTransfer.setData(CANVAS_ITEM_DRAG_MIME, canvasDragPayload('note', itemId))
}
```

(The `noteMap`/`fileType` lookup for this block is no longer needed; remove those two now-orphaned lines but keep the rest of `handleDragStart` and its dependency array intact.)

- [ ] **Step 6: Update the drag-mime doc**

In `drag-mime.ts`, update the comment so it no longer claims "file-type item only":

```ts
/**
 * Custom drag data type set when any note or file item is dragged out of the
 * left sidebar (`VirtualizedNotesTree`). The payload is the item's note id.
 *
 * Consumers:
 * - the note editor embeds a *file* item by its own vault path
 *   (`window.api.notes.getFile(id)`; a markdown note resolves to null → no-op);
 * - a sidebar project drop links the item to the project (file vs note is
 *   resolved via `getFile`).
 */
export const MEMRY_NOTE_DRAG_MIME = 'application/x-memry-note'
```

- [ ] **Step 7: Write the failing project-item drop test**

Create `sortable-project-item.test.tsx`. Wrap in `DndContext` (dnd-kit hooks require it) and fire a native `drop` with a stub `dataTransfer`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { SortableProjectItem } from './sortable-project-item'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  linkProjectItem: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))
vi.mock('@/services/notes-service', () => ({ notesService: { getFile: mocks.getFile } }))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { linkProjectItem: mocks.linkProjectItem }
}))

const project = { id: 'p1', name: 'Launch', color: '#f00', taskCount: 0 } as unknown as Project

const renderItem = () =>
  render(
    <DndContext>
      <SortableContext items={['p1']}>
        <ul>
          <SortableProjectItem
            project={project}
            isActive={false}
            onClick={vi.fn()}
            onEdit={vi.fn()}
            onArchive={vi.fn()}
            onDelete={vi.fn()}
          />
        </ul>
      </SortableContext>
    </DndContext>
  )

const noteDataTransfer = (id: string) => ({
  types: [MEMRY_NOTE_DRAG_MIME],
  getData: (type: string) => (type === MEMRY_NOTE_DRAG_MIME ? id : ''),
  dropEffect: 'none'
})

describe('SortableProjectItem drop-to-link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.linkProjectItem.mockResolvedValue({ success: true })
  })

  it('#then links a dropped markdown note as a note', async () => {
    mocks.getFile.mockResolvedValue(null)
    renderItem()

    fireEvent.drop(screen.getByText('Launch').closest('li')!, {
      dataTransfer: noteDataTransfer('n1')
    })

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'note',
        itemId: 'n1'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it('#then links a dropped file as a file', async () => {
    mocks.getFile.mockResolvedValue({ id: 'f1' })
    renderItem()

    fireEvent.drop(screen.getByText('Launch').closest('li')!, {
      dataTransfer: noteDataTransfer('f1')
    })

    await waitFor(() =>
      expect(mocks.linkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'file',
        itemId: 'f1'
      })
    )
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- sortable-project-item`
Expected: FAIL — no drop handler wired (`linkProjectItem` never called).

- [ ] **Step 9: Wire the native drop target**

In `sortable-project-item.tsx`:

1. Add imports:

```tsx
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import { linkSidebarItemToProject } from '@/lib/link-sidebar-item-to-project'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
```

Add a tasks-namespace translation hook next to the existing `useT('notes')`:

```tsx
const { t: tTasks } = useT('tasks')
```

2. Add drop state + handlers inside the component:

```tsx
const [isNoteDragOver, setIsNoteDragOver] = useState(false)

const handleNoteDragOver = useCallback((e: React.DragEvent): void => {
  if (!e.dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  setIsNoteDragOver(true)
}, [])

const handleNoteDragLeave = useCallback((): void => {
  setIsNoteDragOver(false)
}, [])

const handleNoteDrop = useCallback(
  (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return
    e.preventDefault()
    setIsNoteDragOver(false)
    void (async () => {
      try {
        const linked = await linkSidebarItemToProject(e.dataTransfer, project.id, {
          getFile: (id) => notesService.getFile(id),
          link: (input) => tasksService.linkProjectItem(input)
        })
        if (linked) toast.success(tTasks('addToProject.toastSuccess', { name: project.name }))
      } catch (error) {
        toast.error(extractErrorMessage(error, tTasks('addToProject.toastError')))
      }
    })()
  },
  [project.id, project.name, tTasks]
)
```

3. Attach the handlers + affordance to the `<SidebarMenuItem>`. Add to its `className` a `isNoteDragOver && 'bg-primary/10 ring-2 ring-primary rounded-md'` clause (alongside the existing `isOver` clause), and add the event props:

```tsx
    <SidebarMenuItem
      ref={setRefs}
      style={style}
      onDragOver={handleNoteDragOver}
      onDragLeave={handleNoteDragLeave}
      onDrop={handleNoteDrop}
      className={cn(
        'group/project relative transition-all duration-150',
        isSortableDragging && 'opacity-50 z-50',
        showAsDropZone && 'border border-dotted border-muted-foreground/40 rounded-md',
        isOver && 'bg-primary/10 ring-2 ring-primary rounded-md shadow-sm',
        isNoteDragOver && 'bg-primary/10 ring-2 ring-primary rounded-md shadow-sm'
      )}
      {...attributes}
      {...listeners}
    >
```

Note: dnd-kit's `{...listeners}` are pointer-based (PointerSensor), so they do not conflict with native HTML5 drag events; the two DnD systems coexist.

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- sortable-project-item link-sidebar-item-to-project`
Expected: PASS.

- [ ] **Step 11: Guard against regressions in the drag source + editor**

Run the notes-tree and editor drop suites to confirm widening the MIME didn't break embed-on-drop:

Run: `pnpm --filter @memry/desktop test:renderer -- virtualized-notes-tree use-editor-file-upload`
Expected: PASS (or "no tests found" for a pattern with no suite — that is acceptable, not a failure).

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.ts \
        apps/desktop/src/renderer/src/lib/link-sidebar-item-to-project.test.ts \
        apps/desktop/src/renderer/src/lib/drag-mime.ts \
        apps/desktop/src/renderer/src/components/virtualized-notes-tree.tsx \
        apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.tsx \
        apps/desktop/src/renderer/src/components/sidebar/sortable-project-item.test.tsx
git commit -m "feat(projects): link a sidebar note/file to a project by drag-and-drop"
```

---

## Task 6: Documentation

Extends the user guide's "Project Home" section with Files, satisfying the docs gate.

**Files:**

- Modify: `apps/docs/src/user-guide/projects.md`

- [ ] **Step 1: Extend the Project Home docs**

Read `apps/docs/src/user-guide/projects.md`. In the "Project Home" section (which already documents Overview, Tasks, Notes, Events), add a **Files** subsection describing: linked files appear in the Files section; add one via a file's **Add to project** button, or by **dragging a note or file from the sidebar onto a project**; removing a file from a project (the X control) unlinks it but keeps the file in your vault; deleting the project keeps all linked files.

Match the surrounding heading level, tone, and formatting. If `pnpm docs:ai-update` is available and preferred, run it instead; otherwise write the prose manually.

- [ ] **Step 2: Docs gate**

Run (BASE = the branch this stack was cut from — `project-hub-calendar-overview` unless #819/#812 have since merged to `main`):

```bash
pnpm docs:impact --base origin/project-hub-calendar-overview --strict
pnpm docs:build
```

Expected: PASS (no `missing-docs`).

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/user-guide/projects.md
git commit -m "docs(projects): document the Project Home Files section"
```

---

## Final verification (run before opening the PR)

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm --filter @memry/desktop test:main` (unchanged, but confirm still green — backend untouched)
- [ ] `pnpm --filter @memry/desktop test:renderer`
- [ ] `pnpm ipc:check` (expected: no change — no contract edits — but verify)
- [ ] `pnpm --filter @memry/desktop i18n:check`
- [ ] `pnpm check:architecture`
- [ ] `git diff --check`
- [ ] `pnpm docs:impact --base origin/project-hub-calendar-overview --strict` + `pnpm docs:build`
- [ ] Real-app smoke (`pnpm dev`): (1) open a file → **Add to project** → it appears in that project's Files section; (2) drag a sidebar note onto a project → it links (Notes section); drag a file onto a project → it links (Files section); (3) delete the project → the files/notes still exist in the vault.

---

## Self-Review

**Spec coverage (spec §9 Phase 4 = "Files section + sidebar drag-to-project"):**

- Files section on Project Home → Tasks 1–2 (component + mount + stat + `FILES_SECTION_SLOT`). ✓
- Link a file to a project (`item_type='file'`, reuse `PROJECT_LINK_ITEM`) → Task 3 (dialog) + Task 4 (FilePage entry point). ✓
- Sidebar drag-note-onto-project via `MEMRY_NOTE_DRAG_MIME` → Task 5 (widen MIME + native drop, links note or file). ✓
- Backward compat / no migration / no new sync type → guaranteed by design (renderer-only; backend already generic); asserted by leaving `test:main` untouched + `ipc:check` unchanged. ✓
- Deleting a project keeps files → unchanged Phase 1 behavior; smoke-verified. ✓
- Orphaned links skipped defensively → Task 1 (`getFile` null → skip), tested. ✓

**Design decision recorded:** The "drag a note onto a project" ask crosses two DnD systems — the sidebar note drag is native HTML5, the project item is a dnd-kit droppable (for tasks). Chosen approach: widen the note-named `MEMRY_NOTE_DRAG_MIME` to all non-folder items (matches the spec's named mechanism and the constant's own name) + add a native drop handler to the project item; the drop resolves file-vs-note via `getFile`. This is editor-safe because `getFileById` returns `null` for markdown (`notes-crud.ts:353`), so the editor's existing embed-on-drop no-ops for a markdown id (and it also removes today's latent raw-uuid insertion when a note is dragged into an editor).

**Placeholder scan:** none — every code step contains complete code.

**Type consistency:** `linkSidebarItemToProject` signature is identical in the interface block, the helper impl, and the component call site; `ProjectItemType` (`'note'|'calendar_event'|'file'`) is the shared type; `fileCount` prop name is consistent across `ProjectStatsRow`, its test, and the `project-home.tsx` caller; `ProjectFilesSection` prop names (`projectId`, `onFileClick`) match between the component, its test, and the mount site.
