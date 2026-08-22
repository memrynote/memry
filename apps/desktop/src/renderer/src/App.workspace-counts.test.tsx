import React from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { taskViews } from '@/data/tasks-data'

/**
 * Measures the work the App root performs to produce the sidebar view badges and
 * the per-project task counts. Both counters feed `TasksProvider` / `AppSidebar` /
 * `TaskDragOverlay` and recompute on every task mutation, so the cost has to stay
 * proportional to the task list — not to (views x tasks x projects).
 *
 * The probe counts reads of `task.projectId`, which is the lookup key every
 * incomplete/complete decision needs. One read per task per recompute means one
 * pass; more means the counts are being derived by re-filtering the whole list
 * once per view and once per project.
 */
let projectIdReads = 0

interface ProbeTask {
  id: string
  title: string
  projectId: string
  statusId: string
  parentId: string | null
  dueDate: Date | null
  archivedAt: Date | null
}

function makeTask(overrides: Partial<ProbeTask> & { id: string }): ProbeTask {
  const task: ProbeTask = {
    title: overrides.id,
    projectId: 'project-a',
    statusId: 'todo',
    parentId: null,
    dueDate: null,
    archivedAt: null,
    ...overrides
  }

  const projectId = task.projectId
  Object.defineProperty(task, 'projectId', {
    get() {
      projectIdReads += 1
      return projectId
    },
    enumerable: true,
    configurable: true
  })

  return task
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000)

function makeTasks(): ProbeTask[] {
  return [
    makeTask({ id: 'a-open', projectId: 'project-a', statusId: 'todo', dueDate: YESTERDAY }),
    makeTask({ id: 'a-open-sub', projectId: 'project-a', statusId: 'todo', parentId: 'a-open' }),
    makeTask({ id: 'a-done', projectId: 'project-a', statusId: 'done' }),
    makeTask({ id: 'b-open', projectId: 'project-b', statusId: 'todo' }),
    makeTask({ id: 'b-done', projectId: 'project-b', statusId: 'done' }),
    makeTask({
      id: 'b-archived',
      projectId: 'project-b',
      statusId: 'todo',
      archivedAt: YESTERDAY
    })
  ]
}

function makeProjects(): unknown[] {
  return [
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
}

let tasks: ProbeTask[] = makeTasks()
let projects: unknown[] = makeProjects()

let sidebarRenders = 0
let belowProviderRenders = 0
let lastViewCounts: Record<string, number> = {}
let lastProjectCounts: Record<string, number> = {}

const openTab = vi.fn()
// `useTabActions` is a separate subscription from `useTabs`, so the mock has to
// publish it too or every consumer under App throws at render.
const tabActions = {
  openTab,
  closeTab: vi.fn(),
  closeTabsByEntityId: vi.fn(),
  updateTabTitleByEntityId: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveGroup: vi.fn(),
  splitView: vi.fn(),
  dispatch: vi.fn()
}
const openSettings = vi.fn()
const createNote = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: vi.fn() })
}))

vi.mock('@/components/tabs/home-tab-title-sync', () => ({
  // Owns a react-query subscription; `@tanstack/react-query` is fully mocked
  // here. Its own suite covers it (`home-tab-title-sync.test.tsx`).
  HomeTabTitleSync: () => null
}))

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ setTheme: vi.fn() })
}))

vi.mock('@/lib/icons', () => ({
  Loader2: () => <div data-testid="loader" />
}))

vi.mock('@/lib/startup-theme', () => ({
  THEME_STORAGE_KEY: 'theme',
  getStartupTheme: () => 'system'
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/lib/telemetry', () => ({
  trackTelemetry: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { reorderProjects: vi.fn() },
  queueTaskReorder: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { create: (...args: unknown[]) => createNote(...args) }
}))

vi.mock('@/hooks', () => ({
  useTabKeyboardShortcuts: vi.fn(),
  useMouseNavButtons: vi.fn(),
  useChordShortcuts: () => true,
  useSettingsShortcut: vi.fn(),
  useNewNoteShortcut: vi.fn(),
  useUndoKeyboardShortcut: vi.fn(),
  useReminderNotifications: vi.fn(),
  useInboxReviewNotifications: vi.fn(),
  useSearchShortcut: vi.fn(),
  useHintActivation: vi.fn(),
  useFolderViewEvents: vi.fn(),
  useFlushOnQuit: vi.fn(),
  useVault: () => ({ status: { isOpen: true, path: '/vault/a' }, isLoading: false }),
  useTaskOrder: () => ({
    applyOrderUpdates: vi.fn(),
    getOrder: vi.fn(),
    getOrderedTasks: vi.fn((input) => input)
  }),
  useDragHandlers: () => ({ handleDragEnd: vi.fn(), droppedPriorities: new Map() }),
  isInputFocused: () => false
}))

vi.mock('@/hooks/use-folder-view-events', () => ({ useFolderViewEvents: vi.fn() }))
vi.mock('@/hooks/use-flush-on-quit', () => ({ useFlushOnQuit: vi.fn() }))
vi.mock('@/hooks/use-theme-sync', () => ({ useThemeSync: vi.fn() }))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({ tasks, projects }),
  useTaskWorkspaceMutations: () => ({
    setProjects: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn()
  })
}))

vi.mock('@/features/tasks/use-task-ui-store', () => ({
  useTaskUiStore: () => ({ selectedTaskIds: new Set<string>(), setSelectedTaskIds: vi.fn() })
}))

vi.mock('@/contexts/tabs', () => ({
  TabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTabs: () => ({ openTab }),
  useTabActions: () => tabActions,
  useActiveTab: () => ({ type: 'inbox' })
}))

vi.mock('@/contexts/tabs/persistence', () => ({
  STORAGE_KEY: 'tabs-state',
  useTabPersistence: vi.fn(),
  useSessionRestore: vi.fn(),
  useTabSessionPersistence: vi.fn()
}))

vi.mock('@/contexts/tasks', () => ({
  TasksProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/drag-context', () => ({
  DragProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/dropped-priority-context', () => ({
  DroppedPriorityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/ai-inline-context', () => ({
  AIInlineProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/contexts/day-panel-context', () => ({
  DayPanelProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDayPanel: () => ({ isOpen: false })
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
    sidebarRenders += 1
    lastViewCounts = viewCounts
    return <aside data-testid="app-sidebar" />
  }
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  useSidebar: () => ({ toggleSidebar: vi.fn() })
}))

vi.mock('@/components/window-controls', () => ({ WindowControls: () => <div /> }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => <div /> }))
vi.mock('@/components/day-panel', () => ({ GlobalDayPanel: () => <div /> }))

vi.mock('@/components/tasks/drag-drop', () => ({
  TaskDragOverlay: ({
    projects: withCounts
  }: {
    projects: { id: string; taskCount: number }[]
  }) => {
    belowProviderRenders += 1
    lastProjectCounts = Object.fromEntries(withCounts.map((p) => [p.id, p.taskCount]))
    return <div data-testid="task-drag-overlay" />
  }
}))

vi.mock('@/components/tabs', () => ({
  TabDragProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/split-view', () => ({ SplitViewContainer: () => <div /> }))

vi.mock('@/components/keyboard', () => ({
  ChordIndicator: () => <div />,
  KeyboardShortcutsDialog: () => <div />
}))

vi.mock('@/components/hint-overlay', () => ({
  HintOverlay: () => <div />,
  HintIndicator: () => <div />
}))

vi.mock('@/components/search/command-palette', () => ({ CommandPalette: () => <div /> }))
vi.mock('@/components/settings-modal', () => ({ SettingsModal: () => <div /> }))
vi.mock('@/components/vault-onboarding', () => ({ VaultOnboarding: () => <div /> }))

describe('App workspace count computation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    tasks = makeTasks()
    projects = makeProjects()
    projectIdReads = 0
    sidebarRenders = 0
    belowProviderRenders = 0
    lastViewCounts = {}
    lastProjectCounts = {}
    ;(
      window as Window & { api: { onSettingsOpenRequested?: unknown } }
    ).api.onSettingsOpenRequested = vi.fn(() => vi.fn())
  })

  it('derives every view badge and project badge from a single pass over the tasks', () => {
    const { rerender } = render(<App />)

    // A task mutation lands as a fresh array identity from the workspace query.
    tasks = makeTasks()
    projectIdReads = 0

    rerender(<App />)

    expect(projectIdReads).toBe(tasks.length)
  })

  it('keeps the exact counts the per-view filters produce', () => {
    render(<App />)

    expect(taskViews.map((view) => view.id)).toEqual(['all', 'today', 'completed'])
    // all: a-open + a-open-sub + b-open
    // today: a-open (overdue) + a-open-sub
    // completed: a-done + b-done
    expect(lastViewCounts).toEqual({ all: 3, today: 2, completed: 2 })
    // project-a: a-open, a-open-sub | project-b: b-open only — b-archived is
    // archived, so no view renders it and the badge must not count it (#1323)
    expect(lastProjectCounts).toEqual({ 'project-a': 2, 'project-b': 1 })
  })

  it('recomputes the counts when a task changes', () => {
    const { rerender } = render(<App />)
    expect(lastViewCounts.all).toBe(3)

    tasks = makeTasks().filter((task) => task.id !== 'b-open')
    rerender(<App />)

    expect(lastViewCounts).toEqual({ all: 2, today: 2, completed: 2 })
    // project-b is left with b-done and b-archived only, neither of which the
    // project view renders as an open task, so its badge is empty
    expect(lastProjectCounts).toEqual({ 'project-a': 2, 'project-b': 0 })
    expect(sidebarRenders).toBeGreaterThan(0)
    expect(belowProviderRenders).toBeGreaterThan(0)
  })
})
