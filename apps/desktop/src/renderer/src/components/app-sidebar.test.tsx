import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppSidebar } from './app-sidebar'
import { BookmarkItemTypes } from '@memry/contracts/bookmarks-api'

const mocks = vi.hoisted(() => ({
  setSelectedFolder: vi.fn(),
  openSidebarItem: vi.fn(),
  isActiveItem: vi.fn(() => false),
  openTab: vi.fn(),
  openSettings: vi.fn(),
  createNote: vi.fn(),
  createCanvas: vi.fn(),
  importFiles: vi.fn(),
  notesTreeExpandAll: vi.fn(),
  notesTreeCollapseAll: vi.fn(),
  notesTreeCreateNote: vi.fn(),
  notesTreeCreateFolder: vi.fn(),
  canvasTreeCreateFolder: vi.fn(),
  authState: { status: 'unauthenticated' },
  inboxItems: [
    { id: 'inbox-1', type: 'note' },
    { id: 'reminder-1', type: 'reminder', viewedAt: null },
    { id: 'reminder-2', type: 'reminder', viewedAt: '2026-01-01T00:00:00Z' }
  ]
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/onboarding/use-first-run-tour', () => ({
  useFirstRunTour: () => {}
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
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
  SidebarNav: ({
    items,
    onNavClick,
    inboxCount,
    todayTasksCount
  }: {
    items: Array<{ title: string; page: string }>
    onNavClick: (page: never) => (event: React.MouseEvent) => void
    inboxCount: number
    todayTasksCount: number
  }) => (
    <nav>
      <span>Inbox count {inboxCount}</span>
      <span>Today count {todayTasksCount}</span>
      {items.map((item) => (
        <button key={item.page} type="button" onClick={onNavClick(item.page as never)}>
          {item.title}
        </button>
      ))}
    </nav>
  )
}))

vi.mock('@/components/sidebar-section', () => ({
  SidebarSection: ({
    label,
    actions,
    children,
    totalCount
  }: {
    label: string
    actions?: ReactNode
    children: ReactNode
    totalCount?: number
  }) => (
    <section>
      <h2>{label}</h2>
      {totalCount !== undefined && <span>{`${label} total ${totalCount}`}</span>}
      {actions}
      {children}
    </section>
  )
}))

vi.mock('@/components/notes-tree', () => ({
  NotesTree: forwardRef(
    (
      {
        onTargetFolderChange
      }: {
        onTargetFolderChange: (folder: string) => void
      },
      ref
    ) => {
      useImperativeHandle(ref, () => ({
        expandAll: mocks.notesTreeExpandAll,
        collapseAll: mocks.notesTreeCollapseAll,
        createNote: mocks.notesTreeCreateNote,
        createFolder: mocks.notesTreeCreateFolder
      }))
      useEffect(() => {
        onTargetFolderChange('Projects')
      }, [onTargetFolderChange])
      return <div>Notes tree</div>
    }
  )
}))

// Heavy child, and the only one that subscribes to canvas IPC events. The
// spatialCanvas flag defaults on, so this tree now mounts in every sidebar
// test; its own behavior is covered by canvas-tree.test.tsx. The stub reports a
// count and a target folder so the sidebar's half of that contract is testable.
vi.mock('@/components/sidebar/canvas-tree/canvas-tree', () => ({
  CanvasTree: forwardRef<
    { createFolder: () => void },
    {
      onCountChange?: (count: number) => void
      onTargetFolderChange?: (folder: string | null) => void
    }
  >(function CanvasTree({ onCountChange, onTargetFolderChange }, ref) {
    useImperativeHandle(ref, () => ({ createFolder: mocks.canvasTreeCreateFolder }))
    useEffect(() => {
      onCountChange?.(3)
      onTargetFolderChange?.('Work')
    }, [onCountChange, onTargetFolderChange])
    return <div>Canvas tree</div>
  })
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { create: mocks.createCanvas }
}))

vi.mock('@/components/sidebar/sidebar-tag-list', () => ({
  SidebarTagList: ({ onActionsReady }: { onActionsReady: (node: ReactNode) => void }) => {
    useEffect(() => {
      onActionsReady(<button type="button">Tag action</button>)
    }, [onActionsReady])
    return (
      <button
        type="button"
        onClick={() =>
          mocks.openSidebarItem({
            type: 'tag',
            title: 'work',
            path: '/tags/work',
            entityId: 'work',
            color: '#2563eb'
          })
        }
      >
        Tag work
      </button>
    )
  }
}))

vi.mock('@/components/sidebar/sidebar-bookmark-list', () => ({
  SidebarBookmarkList: ({
    onBookmarkClick
  }: {
    onBookmarkClick: (bookmark: {
      id: string
      itemType: string
      itemTitle: string
      itemId: string
      itemMeta: { path: string }
    }) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onBookmarkClick({
          id: 'bookmark-1',
          itemType: BookmarkItemTypes.NOTE,
          itemTitle: 'Bookmarked note',
          itemId: 'note-1',
          itemMeta: { path: '/note/note-1' }
        })
      }
    >
      Bookmark item
    </button>
  )
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
  useSelectedFolder: () => ({ setSelectedFolder: mocks.setSelectedFolder })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { createInSelectedFolder: true } })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({
    openSidebarItem: mocks.openSidebarItem,
    isActiveItem: mocks.isActiveItem
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    create: mocks.createNote,
    importFiles: mocks.importFiles
  }
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: mocks.authState })
}))

vi.mock('@/components/sync/sync-status', () => ({
  SyncStatus: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" onClick={onOpenSettings}>
      Sync status
    </button>
  )
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxList: () => ({ items: mocks.inboxItems })
}))

vi.mock('@/hooks/use-file-drop', () => ({
  useFileDrop: () => ({ isDraggingFiles: false, dropHandlers: {} })
}))

// Minimal stateful Picker mock: the real Radix Popover does not open on click in
// jsdom. Content is gated on a trigger click so the create-menu items only exist
// after the chevron is clicked (avoids colliding with other tests that query
// buttons like "newNote").
vi.mock('@/components/ui/picker', async () => {
  const React = await import('react')
  const PickerCtx = React.createContext<{ open: boolean; toggle: () => void }>({
    open: false,
    toggle: () => {}
  })
  const Picker = ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = React.useState(false)
    return (
      <PickerCtx.Provider value={{ open, toggle: () => setOpen((value) => !value) }}>
        {children}
      </PickerCtx.Provider>
    )
  }
  Picker.Trigger = ({ children }: { children: ReactNode }) => {
    const { toggle } = React.useContext(PickerCtx)
    return <span onClick={toggle}>{children}</span>
  }
  Picker.Content = ({ children }: { children: ReactNode }) => {
    const { open } = React.useContext(PickerCtx)
    return open ? <div>{children}</div> : null
  }
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Item = ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  )
  return { Picker }
})

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authState.status = 'unauthenticated'
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'note-1', title: 'New note' }
    })
    mocks.createCanvas.mockResolvedValue({ id: 'canvas-1', title: 'Fresh canvas' })
  })

  it('shows the canvas count and creates a canvas in the folder the tree reports', async () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    // The collapsed canvases header can only show `(n)` if the count reaches it.
    await waitFor(() => expect(screen.getByText('sectionLabel total 3')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'newCanvas' }))

    await waitFor(() => expect(mocks.createCanvas).toHaveBeenCalledWith({ folder: 'Work' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'canvas',
        title: 'Fresh canvas',
        entityId: 'canvas-1'
      })
    )
  })

  it('offers a root-level New folder beside New canvas, the way NOTES does', async () => {
    // A folder row's own menu can only create a CHILD folder, so without a
    // section-level control a user with no folders can never make their first.
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    fireEvent.click(screen.getByRole('button', { name: 'newCanvasFolder' }))

    expect(mocks.canvasTreeCreateFolder).toHaveBeenCalledTimes(1)
  })

  it('opens app sections, creates notes in selected folders, and forwards tree actions', async () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{ today: 5 }} />)

    expect(screen.getByText('Inbox count 2')).toBeInTheDocument()
    expect(screen.getByText('Today count 5')).toBeInTheDocument()
    expect(mocks.setSelectedFolder).toHaveBeenCalledWith('Projects')

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbox',
        title: 'Inbox',
        path: '/inbox',
        viewState: { focusCaptureAt: expect.any(Number) }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'new' }))
    await waitFor(() => {
      expect(mocks.createNote).toHaveBeenCalledWith({
        title: 'Untitled Note',
        content: '',
        folder: 'Projects'
      })
    })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'New note',
        entityId: 'note-1'
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand all folders' }))
    expect(mocks.notesTreeExpandAll).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all folders' }))
    expect(mocks.notesTreeCollapseAll).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'newNote' }))
    expect(mocks.notesTreeCreateNote).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'newFolder' }))
    expect(mocks.notesTreeCreateFolder).toHaveBeenCalled()
  })

  it('opens the new-item menu from the chevron and routes to journal', async () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    fireEvent.click(screen.getByRole('button', { name: 'newItemMenu' }))
    fireEvent.click(await screen.findByText('journal'))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'journal',
      title: 'Journal',
      path: '/journal'
    })
  })

  it('opens tags, bookmarks, account settings, and the settings panel via the gear', () => {
    render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Tag work' }))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'work',
      path: '/tags/work',
      entityId: 'work',
      color: '#2563eb'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Bookmark item' }))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'note',
      title: 'Bookmarked note',
      path: '/note/note-1',
      entityId: 'note-1'
    })

    fireEvent.click(screen.getByRole('button', { name: 'syncDisabled' }))
    expect(mocks.openSettings).toHaveBeenCalledWith('account')

    fireEvent.click(screen.getByRole('button', { name: 'settings' }))
    expect(mocks.openSettings).toHaveBeenCalledWith()
  })

  it('uses SyncStatus for authenticated accounts and hides sync action while checking', () => {
    mocks.authState.status = 'authenticated'
    const { rerender } = render(<AppSidebar currentPage="inbox" viewCounts={{}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync status' }))
    expect(mocks.openSettings).toHaveBeenCalledWith('account')

    mocks.authState.status = 'checking'
    rerender(<AppSidebar currentPage="inbox" viewCounts={{}} />)
    expect(screen.queryByRole('button', { name: 'Sync status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'syncDisabled' })).not.toBeInTheDocument()
  })
})
