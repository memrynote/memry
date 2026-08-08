import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

/** Render tallies for the app tree, used to prove updater ticks do not fan out. */
const treeRenders = { appSidebar: 0, splitView: 0, settingsModal: 0, taskDragOverlay: 0 }

const queryClientClear = vi.fn()
const openTab = vi.fn()
const openSettings = vi.fn()
const trackTelemetry = vi.fn()
const setProjects = vi.fn()
const taskDragEnd = vi.fn()
const updateSelectedTaskIds = vi.fn()
const reorderProjects = vi.fn()
const createNote = vi.fn()

let vaultState = {
  status: { isOpen: true, path: '/vault/a' },
  isLoading: false
}
let activeTab: { type: string } | null = { type: 'inbox' }
let tasks = [
  { id: 'task-1', projectId: 'project-a', statusId: 'todo', archivedAt: null },
  { id: 'task-2', projectId: 'project-b', statusId: 'done', archivedAt: null }
]
let projects = [
  {
    id: 'project-a',
    name: 'Alpha',
    statuses: [
      { id: 'todo', type: 'todo' },
      { id: 'done', type: 'done' }
    ]
  },
  {
    id: 'project-b',
    name: 'Beta',
    statuses: [
      { id: 'todo', type: 'todo' },
      { id: 'done', type: 'done' }
    ]
  }
]
let settingsOpenListener: ((section?: string) => void) | undefined
let newNoteShortcut: (() => void) | undefined

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: queryClientClear })
}))

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
  useTheme: () => ({ setTheme: vi.fn() })
}))

vi.mock('@/lib/icons', () => ({
  Loader2: ({ className }: { className?: string }) => (
    <div data-testid="loader" className={className} />
  )
}))

vi.mock('@/lib/startup-theme', () => ({
  THEME_STORAGE_KEY: 'theme',
  getStartupTheme: () => 'system'
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('@/lib/telemetry', () => ({
  trackTelemetry: (...args: unknown[]) => trackTelemetry(...args)
}))

vi.mock('@/data/tasks-data', () => ({
  taskViews: [{ id: 'all' }, { id: 'today' }]
}))

vi.mock('@/lib/task-utils', () => ({
  getFilteredTasks: (allTasks: unknown[]) => allTasks
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    reorderProjects: (...args: unknown[]) => reorderProjects(...args)
  },
  queueTaskReorder: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    create: (...args: unknown[]) => createNote(...args)
  }
}))

vi.mock('@/hooks', () => ({
  useTabKeyboardShortcuts: vi.fn(),
  useMouseNavButtons: vi.fn(),
  useChordShortcuts: () => true,
  useSettingsShortcut: vi.fn(),
  useNewNoteShortcut: (callback: () => void) => {
    newNoteShortcut = callback
  },
  useUndoKeyboardShortcut: vi.fn(),
  useReminderNotifications: vi.fn(),
  useInboxReviewNotifications: vi.fn(),
  useSearchShortcut: vi.fn(),
  useHintActivation: vi.fn(),
  useFolderViewEvents: vi.fn(),
  useFlushOnQuit: vi.fn(),
  useVault: () => vaultState,
  useTaskOrder: () => ({
    applyOrderUpdates: vi.fn(),
    getOrder: vi.fn(),
    getOrderedTasks: vi.fn((input) => input)
  }),
  useDragHandlers: () => ({
    handleDragEnd: taskDragEnd,
    droppedPriorities: new Map([['task-1', 3]])
  }),
  isInputFocused: () => false
}))

vi.mock('@/hooks/use-folder-view-events', () => ({
  useFolderViewEvents: vi.fn()
}))

vi.mock('@/hooks/use-flush-on-quit', () => ({
  useFlushOnQuit: vi.fn()
}))

vi.mock('@/hooks/use-theme-sync', () => ({
  useThemeSync: vi.fn()
}))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({ tasks, projects }),
  useTaskWorkspaceMutations: () => ({
    setProjects,
    updateTask: vi.fn(),
    deleteTask: vi.fn()
  })
}))

vi.mock('@/features/tasks/use-task-ui-store', () => ({
  useTaskUiStore: () => ({
    selectedTaskIds: new Set(['task-1']),
    setSelectedTaskIds: updateSelectedTaskIds
  })
}))

vi.mock('@/contexts/tabs', () => ({
  TabProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-provider">{children}</div>
  ),
  useTabs: () => ({ openTab }),
  useActiveTab: () => activeTab
}))

vi.mock('@/contexts/tabs/persistence', () => ({
  STORAGE_KEY: 'tabs-state',
  useTabPersistence: vi.fn(),
  useSessionRestore: vi.fn()
}))

vi.mock('@/contexts/tasks', () => ({
  TasksProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tasks-provider">{children}</div>
  )
}))

vi.mock('@/contexts/drag-context', () => ({
  DragProvider: ({
    children,
    onDragEnd
  }: {
    children: React.ReactNode
    onDragEnd: (event: unknown, state: { isDragging: boolean }) => void
  }) => (
    <div data-testid="drag-provider">
      <button
        type="button"
        onClick={() =>
          onDragEnd(
            {
              active: { id: 'project-b', data: { current: {} } },
              over: { id: 'project-a' }
            },
            { isDragging: false }
          )
        }
      >
        project drag
      </button>
      <button
        type="button"
        onClick={() =>
          onDragEnd(
            {
              active: { id: 'task-1', data: { current: { type: 'task' } } },
              over: { id: 'today' }
            },
            { isDragging: true }
          )
        }
      >
        task drag
      </button>
      {children}
    </div>
  )
}))

vi.mock('@/contexts/dropped-priority-context', () => ({
  DroppedPriorityProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropped-priority-provider">{children}</div>
  )
}))

vi.mock('@/contexts/ai-inline-context', () => ({
  AIInlineProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/day-panel-context', () => ({
  DayPanelProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDayPanel: () => ({
    isOpen: false
  })
}))

vi.mock('@/contexts/calendar-view-context', () => ({
  CalendarViewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/sidebar-drill-down', () => ({
  SidebarDrillDownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/selected-folder-context', () => ({
  SelectedFolderProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/hint-mode', () => ({
  HintModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  SettingsModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSettingsModal: () => ({ open: openSettings })
}))

vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: ({ viewCounts }: { viewCounts: Record<string, number> }) => {
    treeRenders.appSidebar += 1
    return <aside data-testid="app-sidebar">all:{viewCounts.all}</aside>
  }
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarInset: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <main data-testid="sidebar-inset" className={className}>
      {children}
    </main>
  ),
  useSidebar: () => ({ toggleSidebar: vi.fn() })
}))

vi.mock('@/components/window-controls', () => ({
  WindowControls: ({ className }: { className?: string }) => (
    <div data-testid="window-controls" className={className} />
  )
}))

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => <div data-testid="toaster" />
}))

vi.mock('@/components/day-panel', () => ({
  GlobalDayPanel: () => <div data-testid="global-day-panel" />
}))

vi.mock('@/components/tasks/drag-drop', () => ({
  TaskDragOverlay: ({ projects }: { projects: unknown[] }) => {
    treeRenders.taskDragOverlay += 1
    return <div data-testid="task-drag-overlay">{projects.length}</div>
  }
}))

vi.mock('@/components/tabs', () => ({
  TabDragProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-drag-provider">{children}</div>
  ),
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/split-view', () => ({
  SplitViewContainer: () => {
    treeRenders.splitView += 1
    return <div data-testid="split-view" />
  }
}))

vi.mock('@/components/keyboard', () => ({
  ChordIndicator: ({ isActive }: { isActive: boolean }) => (
    <div data-testid="chord-indicator">{String(isActive)}</div>
  ),
  KeyboardShortcutsDialog: ({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="shortcuts-dialog">{String(isOpen)}</div>
  )
}))

vi.mock('@/components/hint-overlay', () => ({
  HintOverlay: () => <div data-testid="hint-overlay" />,
  HintIndicator: () => <div data-testid="hint-indicator" />
}))

vi.mock('@/components/search/command-palette', () => ({
  CommandPalette: ({ open }: { open: boolean }) => (
    <div data-testid="command-palette">{String(open)}</div>
  )
}))

vi.mock('@/components/settings-modal', () => ({
  SettingsModal: () => {
    treeRenders.settingsModal += 1
    return <div data-testid="settings-modal" />
  }
}))

vi.mock('@/components/vault-onboarding', () => ({
  VaultOnboarding: () => <div data-testid="vault-onboarding" />
}))

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vaultState = {
      status: { isOpen: true, path: '/vault/a' },
      isLoading: false
    }
    activeTab = { type: 'inbox' }
    tasks = [
      { id: 'task-1', projectId: 'project-a', statusId: 'todo', archivedAt: null },
      { id: 'task-2', projectId: 'project-b', statusId: 'done', archivedAt: null }
    ]
    projects = [
      {
        id: 'project-a',
        name: 'Alpha',
        statuses: [
          { id: 'todo', type: 'todo' },
          { id: 'done', type: 'done' }
        ]
      },
      {
        id: 'project-b',
        name: 'Beta',
        statuses: [
          { id: 'todo', type: 'todo' },
          { id: 'done', type: 'done' }
        ]
      }
    ]
    settingsOpenListener = undefined
    newNoteShortcut = undefined
    createNote.mockResolvedValue({
      success: true,
      note: { id: 'note-1', title: 'Created note' }
    })
    setProjects.mockImplementation((updater: (current: typeof projects) => typeof projects) => {
      projects = updater(projects)
    })
    ;(
      window as Window & { api: { onSettingsOpenRequested?: unknown } }
    ).api.onSettingsOpenRequested = vi.fn((callback: (section?: string) => void) => {
      settingsOpenListener = callback
      return vi.fn()
    })
  })

  it('renders the vault loading state', () => {
    vaultState = {
      status: { isOpen: false, path: null },
      isLoading: true
    }

    render(<App />)

    expect(screen.getByTestId('loader')).toBeInTheDocument()
  })

  it('renders vault onboarding when no vault is open', () => {
    vaultState = {
      status: { isOpen: false, path: null },
      isLoading: false
    }

    render(<App />)

    expect(screen.getByTestId('vault-onboarding')).toBeInTheDocument()
    expect(screen.getByTestId('toaster')).toBeInTheDocument()
  })

  it('renders the app shell without first-run onboarding', () => {
    render(<App />)

    expect(screen.getByTestId('app-sidebar')).toHaveTextContent('all:2')
    expect(screen.getByTestId('split-view')).toBeInTheDocument()
    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
    expect(trackTelemetry).toHaveBeenCalledWith('page_viewed', {
      surface: 'inbox',
      action: 'viewed',
      objectType: 'inbox'
    })
    expect(screen.queryByText('complete onboarding')).not.toBeInTheDocument()
    expect(trackTelemetry).not.toHaveBeenCalledWith('onboarding_started', expect.anything())
    expect(trackTelemetry).not.toHaveBeenCalledWith('onboarding_completed', expect.anything())
  })

  it('handles global search, shortcut dialog, settings section, and new note events', async () => {
    render(<App />)

    expect(screen.getByTestId('command-palette')).toHaveTextContent('false')
    fireEvent(window, new Event('memry:open-search'))
    await waitFor(() => expect(screen.getByTestId('command-palette')).toHaveTextContent('true'))

    fireEvent(window, new Event('memry:open-shortcuts'))
    await waitFor(() => expect(screen.getByTestId('shortcuts-dialog')).toHaveTextContent('true'))

    fireEvent.keyDown(window, { key: '?' })
    await waitFor(() => expect(screen.getByTestId('shortcuts-dialog')).toHaveTextContent('false'))

    settingsOpenListener?.('general')
    expect(openSettings).toHaveBeenCalledWith('general')

    window.dispatchEvent(
      new CustomEvent('memry:test-open-note', {
        detail: { id: 'note-test', title: 'Test note', emoji: 'x' }
      })
    )
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        entityId: 'note-test',
        title: 'Test note'
      })
    )

    newNoteShortcut?.()

    await waitFor(() => expect(createNote).toHaveBeenCalledWith({ title: 'Untitled', content: '' }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'Created note',
        entityId: 'note-1'
      })
    )
  })

  it('keeps one updater subscription and does not re-render the tree per progress tick', async () => {
    const updaterListeners: Array<(state: Record<string, unknown>) => void> = []
    ;(window as Window & { api: { onUpdaterStateChanged?: unknown } }).api.onUpdaterStateChanged =
      vi.fn((callback: (state: Record<string, unknown>) => void) => {
        updaterListeners.push(callback)
        return vi.fn()
      })

    const downloading = {
      currentVersion: '1.0.0',
      status: 'downloading',
      updateSupported: true,
      availableVersion: '2.0.0',
      releaseName: null,
      releaseDate: null,
      releaseNotes: null,
      releaseNotesHtml: null,
      downloadProgressPercent: 0,
      lastCheckedAt: null,
      error: null,
      autoDownloadEnabled: true,
      autoCheckEnabled: true
    }

    await act(async () => {
      render(<App />)
    })

    // App, UpdatePromptDialog and UpdateReleaseNotesTabOpener share one subscription.
    expect(updaterListeners).toHaveLength(1)

    const push = async (percent: number): Promise<void> => {
      await act(async () => {
        for (const listener of updaterListeners) {
          listener({ ...downloading, downloadProgressPercent: percent })
        }
      })
    }

    await push(0)
    const baseline = { ...treeRenders }

    await push(10)
    await push(55)
    await push(100)

    expect(treeRenders.splitView - baseline.splitView).toBe(0)
    expect(treeRenders.appSidebar - baseline.appSidebar).toBe(0)
    expect(treeRenders.settingsModal - baseline.settingsModal).toBe(0)
    expect(treeRenders.taskDragOverlay - baseline.taskDragOverlay).toBe(0)

    // The installing screen still replaces the tree when main says so.
    await act(async () => {
      for (const listener of updaterListeners) {
        listener({ ...downloading, status: 'installing', downloadProgressPercent: 100 })
      }
    })
    expect(screen.queryByTestId('split-view')).not.toBeInTheDocument()
  })

  it('handles project drag reordering and delegates task drags', async () => {
    render(<App />)

    await userEvent.click(screen.getByText('project drag'))

    expect(reorderProjects).toHaveBeenCalledWith(['project-b', 'project-a'], [0, 1])

    await userEvent.click(screen.getByText('task drag'))

    expect(taskDragEnd).toHaveBeenCalled()
    expect(updateSelectedTaskIds).toHaveBeenCalledWith(new Set<string>())
  })
})
