import { fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AppSidebar } from './app-sidebar'

const mocks = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  isActiveItem: vi.fn(() => false),
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
    children
  }: {
    label: string
    actions?: ReactNode
    children: ReactNode
  }) => (
    <section>
      <h2>{label}</h2>
      {actions}
      {children}
    </section>
  )
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
  useFileDrop: () => ({ isDraggingFiles: false, dropHandlers: {} })
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

describe('AppSidebar projects section', () => {
  it('renders active projects and opens Project Home on click', () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    expect(screen.getByText('Launch')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Launch'))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'project',
        entityId: 'p1'
      })
    )
  })
})
