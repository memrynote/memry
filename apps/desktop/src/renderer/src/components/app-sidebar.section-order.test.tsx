import { fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DndContext } from '@dnd-kit/core'

import { AppSidebar } from './app-sidebar'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  isActiveItem: vi.fn(() => false),
  savedOrder: [] as string[],
  setSectionOrder: vi.fn(),
  projects: [{ id: 'p1', name: 'Launch', color: '#f00', isArchived: false }] as Array<{
    id: string
    name: string
    color: string
    isArchived: boolean
  }>
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/onboarding/use-first-run-tour', () => ({
  useFirstRunTour: () => {}
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

vi.mock('@/components/vault-switcher', () => ({
  VaultSwitcher: () => <div>Vault switcher</div>
}))

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SidebarContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  SidebarHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  SidebarRail: () => <div data-testid="sidebar-rail" />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/sidebar/sidebar-nav', () => ({
  SidebarNav: () => <nav>Sidebar nav</nav>
}))

vi.mock('@/components/sidebar-section', () => ({
  SidebarSection: ({
    label,
    actions,
    actionsAlwaysVisible,
    children
  }: {
    label: string
    actions?: ReactNode
    actionsAlwaysVisible?: boolean
    children: ReactNode
  }) => (
    // `actionsAlwaysVisible` surfaces as an attribute because the real reveal is
    // a Tailwind class the sidebar never sees; whether it is on screen is the
    // section's own test (sidebar-section.focus-reveal.test.tsx). What belongs
    // here is only that the sidebar asks for it in the empty case.
    <section aria-label={label} data-actions-pinned={actionsAlwaysVisible ? 'true' : 'false'}>
      <h2>{label}</h2>
      {actions}
      {children}
    </section>
  )
}))

vi.mock('@/components/tasks/project-modal', () => ({
  ProjectModal: ({ isOpen, project }: { isOpen: boolean; project?: { id: string } | null }) =>
    isOpen ? (
      <div data-testid="project-modal">{project ? `edit:${project.id}` : 'create'}</div>
    ) : null
}))

vi.mock('@/components/notes-tree', () => ({
  NotesTree: forwardRef(
    ({ onTargetFolderChange }: { onTargetFolderChange: (folder: string) => void }, ref) => {
      useImperativeHandle(ref, () => ({
        expandAll: vi.fn(),
        collapseAll: vi.fn(),
        createNote: vi.fn(),
        createFolder: vi.fn()
      }))
      useEffect(() => {
        onTargetFolderChange('')
      }, [onTargetFolderChange])
      return <div>Notes tree</div>
    }
  )
}))

vi.mock('@/components/sidebar/sidebar-tag-list', () => ({
  SidebarTagList: () => <div>Tag list</div>
}))

// Heavy child, and the only one that subscribes to canvas IPC events. The
// spatialCanvas flag defaults on, so this tree now mounts in every sidebar
// test; its own behavior is covered by canvas-tree.test.tsx.
vi.mock('@/components/sidebar/canvas-tree/canvas-tree', () => ({
  CanvasTree: () => <div>Canvas tree</div>
}))

vi.mock('@/components/sidebar/sidebar-bookmark-list', () => ({
  SidebarBookmarkList: () => <div>Bookmark list</div>
}))

vi.mock('@/components/sidebar/sidebar-drill-down-container', () => ({
  SidebarDrillDownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/sidebar/sidebar-update-button', () => ({
  SidebarUpdateButton: () => null
}))

vi.mock('@/components/sidebar/sidebar-feedback-button', () => ({
  SidebarFeedbackButton: () => null
}))

vi.mock('@/contexts/selected-folder-context', () => ({
  useSelectedFolder: () => ({ setSelectedFolder: vi.fn() })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { createInSelectedFolder: false } })
}))

vi.mock('@/hooks/use-sidebar-section-order', () => ({
  useSidebarSectionOrder: () => ({
    order: mocks.savedOrder,
    setOrder: mocks.setSectionOrder,
    error: null
  })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({
    openSidebarItem: mocks.openSidebarItem,
    isActiveItem: mocks.isActiveItem
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: vi.fn() })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { create: vi.fn(), importFiles: vi.fn() }
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'unauthenticated' } })
}))

vi.mock('@/components/sync/sync-status', () => ({
  SyncStatus: () => <button type="button">Sync status</button>
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxList: () => ({ items: [] })
}))

vi.mock('@/hooks/use-file-drop', () => ({
  FILE_DROP_FOLDER_ATTR: 'data-file-drop-folder',
  useFileDrop: () => ({ isDraggingFiles: false, dropFolder: null, dropHandlers: {} })
}))

vi.mock('@/components/ui/picker', () => ({
  Picker: Object.assign(({ children }: { children: ReactNode }) => <>{children}</>, {
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: () => null
  })
}))

// Projects data source: the sidebar reads active projects from the same
// TasksProvider context used elsewhere (@/contexts/tasks), via the nullable
// accessor so the sidebar still renders when no TasksProvider is mounted.
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({ projects: mocks.projects })
}))

// Heavy child (drag-and-drop, edit/archive/delete affordances) — this test only
// verifies the sidebar wires projects + click-through, not the list's own
// rendering, which is covered by its sibling component tests.
vi.mock('@/components/sidebar/sortable-project-list', () => ({
  SortableProjectList: ({
    projects,
    onProjectClick
  }: {
    projects: Array<{ id: string; name: string }>
    onProjectClick: (projectId: string) => void
  }) => (
    <div>
      {projects.map((project) => (
        <button key={project.id} type="button" onClick={() => onProjectClick(project.id)}>
          {project.name}
        </button>
      ))}
    </div>
  )
}))

// AppSidebar's sections are sortable, and dnd-kit's monitor requires an enclosing
// DndContext — the app mounts one in App.tsx (DragProvider) around everything.
const DndWrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <DndContext>{children}</DndContext>
)

describe('AppSidebar section order', () => {
  beforeEach(() => {
    mocks.savedOrder = []
    mocks.setSectionOrder.mockClear()
  })

  const renderedOrder = (): string[] =>
    screen
      .getAllByTestId('sidebar-section-sortable')
      .map((node) => node.getAttribute('data-section-id') ?? '')

  it('renders the default order when nothing was saved', () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />, { wrapper: DndWrapper })

    expect(renderedOrder()).toEqual(['collections', 'projects', 'bookmarks', 'canvases', 'tags'])
  })

  it('renders the saved order, slotting in sections it does not mention', () => {
    mocks.savedOrder = ['tags', 'bookmarks']

    render(<AppSidebar currentPage="inbox" viewCounts={{}} />, { wrapper: DndWrapper })

    expect(renderedOrder()).toEqual(['collections', 'projects', 'tags', 'bookmarks', 'canvases'])
  })

  it('ignores a saved id this build does not render', () => {
    mocks.savedOrder = ['shelves', 'tags', 'collections', 'projects', 'bookmarks', 'canvases']

    render(<AppSidebar currentPage="inbox" viewCounts={{}} />, { wrapper: DndWrapper })

    expect(renderedOrder()).toEqual(['tags', 'collections', 'projects', 'bookmarks', 'canvases'])
  })

  it('gives every section a named drag handle', () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />, { wrapper: DndWrapper })

    expect(screen.getAllByTestId('sidebar-section-drag')).toHaveLength(5)
    // `reorderSection` is the key; the mocked t() returns the last segment.
    expect(screen.getAllByLabelText('reorderSection')).toHaveLength(5)
  })
})
