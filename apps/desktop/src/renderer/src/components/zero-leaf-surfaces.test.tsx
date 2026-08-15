import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveConfirmationDialog } from './bulk/archive-confirmation-dialog'
import { FindBar } from './find-bar/find-bar'
import { KeyboardShortcutsModal } from './keyboard-shortcuts-modal'
import { EditorErrorBoundary } from './note/editor-error-boundary'
import {
  createHashTagSpacePlugin,
  matchHashTagBeforeCursor
} from './note/content-area/hash-tag-space-plugin'
import { TabErrorBoundary } from './tabs/tab-error-boundary'
import { KanbanDragOverlay } from './tasks/kanban/kanban-drag-overlay'
import { useSnoozeCountdown } from './snooze/use-snooze-countdown'
import { VaultSettings } from '@/pages/settings/vault-section'

const mocks = vi.hoisted(() => ({
  dragState: {
    isDragging: false,
    overType: null as string | null,
    overId: null as string | null,
    sourceContainerId: null as string | null,
    sourceType: null as string | null,
    draggedTasks: [] as any[]
  },
  refreshStorage: vi.fn(),
  openIncidentReport: vi.fn()
}))

vi.mock('@/components/diagnostics/incident-report-provider', () => ({
  useReportIncident: () => mocks.openIncidentReport
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count === undefined ? key : `${key}:${options.count}`
  })
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  getKeyboardShortcuts: () => [
    { title: 'General', shortcuts: [{ key: 'Cmd+K', label: 'Search' }] },
    { title: 'Editor', shortcuts: [{ key: 'Esc', label: 'Close' }] }
  ]
}))

vi.mock('@/hooks/use-storage-usage', () => ({
  useStorageUsage: () => ({
    loading: false,
    data: {
      used: 2_048,
      limit: 4_096,
      breakdown: { notes: 1_024, attachments: 1_024, hidden: 1 }
    },
    refresh: mocks.refreshStorage
  })
}))

vi.mock('@/components/tasks/projects/project-selector', () => ({
  ProjectSelector: ({ projects, onProjectSelect, onCreateProject }: any) => (
    <div>
      <button type="button" onClick={() => onProjectSelect(projects[0]?.id)}>
        project selector
      </button>
      <button type="button" onClick={onCreateProject}>
        create project
      </button>
    </div>
  )
}))

vi.mock('@/components/tasks/task-list', () => ({
  TaskList: ({ tasks, onQuickAdd, onTaskClick }: any) => (
    <div>
      <div>task-list:{tasks.length}</div>
      <button
        type="button"
        onClick={() => onQuickAdd('New task', { priority: 'high', projectId: null })}
      >
        quick add
      </button>
      <button type="button" onClick={() => onTaskClick(tasks[0]?.id)}>
        open task
      </button>
    </div>
  )
}))

vi.mock('@/contexts/drag-context', () => ({
  useDragContext: () => ({ dragState: mocks.dragState })
}))

vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({ children }: { children?: ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  defaultDropAnimationSideEffects: () => vi.fn()
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => 'translate3d(0, 0, 0)' } }
}))

vi.mock('./tasks/kanban/kanban-card', () => ({
  KanbanCardContent: ({ task, project, isDone }: any) => (
    <div>
      kanban-card:{task.title}:{project?.name}:{String(isDone)}
    </div>
  )
}))

vi.mock('@/lib/task-utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/task-utils')>('@/lib/task-utils')
  return {
    ...actual,
    getFilteredTasks: (tasks: any[], projectId: string) =>
      tasks.filter((task) => task.projectId === projectId)
  }
})

const baseTask = {
  id: 'task-1',
  title: 'Task one',
  description: '',
  statusId: 'todo',
  projectId: 'project-1',
  priority: 'none',
  dueDate: null,
  completedAt: null,
  createdAt: new Date('2026-05-10T00:00:00Z'),
  updatedAt: new Date('2026-05-10T00:00:00Z'),
  parentTaskId: null,
  subtaskIds: [],
  tags: [],
  linkedNoteIds: []
} as any

const projects = [
  { id: 'project-1', name: 'Work', color: '#111111', isArchived: false },
  { id: 'project-2', name: 'Archived', color: '#222222', isArchived: true }
] as any[]

describe('zero-covered leaf surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mocks.dragState = {
      isDragging: false,
      overType: null,
      overId: null,
      sourceContainerId: null,
      sourceType: null,
      draggedTasks: []
    }
    ;(window as any).api = {
      vault: {
        getStatus: vi.fn().mockResolvedValue({ path: '/Users/kaan/Vault' }),
        reveal: vi.fn().mockResolvedValue(undefined)
      },
      syncOps: {
        getLargeNotes: vi.fn().mockResolvedValue({ maxBytes: 3_826_189, notes: [] })
      }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('matches hash-tag space completions and builds the plugin', () => {
    expect(matchHashTagBeforeCursor('Plan #Work-2026 ')).toBe('Work-2026')
    expect(matchHashTagBeforeCursor('Plan #x ')).toBeNull()
    expect(matchHashTagBeforeCursor('Plan #bad. ')).toBeNull()

    const plugin = createHashTagSpacePlugin((tag) => `color:${tag}`)
    expect(plugin.key).toContain('hashTagSpaceComplete')
  })

  it('drives find bar keyboard and close controls', () => {
    const onQueryChange = vi.fn()
    const onNext = vi.fn()
    const onPrev = vi.fn()
    const onClose = vi.fn()

    render(
      <FindBar
        isOpen
        query="note"
        matchCount={3}
        currentIndex={1}
        inputRef={createRef<HTMLInputElement>()}
        onQueryChange={onQueryChange}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    )

    const input = screen.getByDisplayValue('note')
    fireEvent.change(input, { target: { value: 'journal' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button'))

    expect(onQueryChange).toHaveBeenCalledWith('journal')
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2/3')).toBeInTheDocument()
  })

  it('renders keyboard shortcuts and closes from controls', () => {
    const onClose = vi.fn()
    render(<KeyboardShortcutsModal isOpen onClose={onClose} />)

    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.getByText('Cmd+K')).toBeInTheDocument()
    fireEvent.keyDown(
      screen.getByText('phaseF.componentsKeyboardShortcutsModal.keyboardShortcuts'),
      { key: 'Escape' }
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsKeyboardShortcutsModal.closeShortcutsHelp'
      })
    )

    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('renders vault storage, refreshes usage, and reveals the vault path', async () => {
    render(<VaultSettings />)

    await waitFor(() => expect(screen.getByText('/Users/kaan/Vault')).toBeInTheDocument())
    expect(screen.getByText('vault.storage.categories.notes')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button')[0])
    await waitFor(() => expect(mocks.refreshStorage).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'vault.reveal' }))
    expect((window as any).api.vault.reveal).toHaveBeenCalled()
  })

  it('confirms archive actions', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ArchiveConfirmationDialog isOpen itemCount={4} onConfirm={onConfirm} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByText('bulk.archiveDialog.confirm:4'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onConfirm).toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('recovers editor and tab error boundaries', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let editorShouldThrow = true
    let tabShouldThrow = true
    const onRecover = vi.fn()
    const onEditorError = vi.fn()
    const onTabError = vi.fn()

    const EditorChild = () => {
      if (editorShouldThrow) throw new Error('editor failed')
      return <div>editor recovered</div>
    }
    const TabChild = () => {
      if (tabShouldThrow) throw new Error('tab failed')
      return <div>tab recovered</div>
    }

    render(
      <EditorErrorBoundary onRecover={onRecover} onError={onEditorError}>
        <EditorChild />
      </EditorErrorBoundary>
    )
    expect(screen.getByText('editor.errorBoundary.title')).toBeInTheDocument()
    editorShouldThrow = false
    fireEvent.click(screen.getByText('editor.errorBoundary.reload'))
    expect(onRecover).toHaveBeenCalled()
    expect(onEditorError).toHaveBeenCalled()
    expect(screen.getByText('editor recovered')).toBeInTheDocument()

    render(
      <TabErrorBoundary onError={onTabError}>
        <TabChild />
      </TabErrorBoundary>
    )
    expect(
      screen.getByText('phaseF.componentsTabsTabErrorBoundary.somethingWentWrong')
    ).toBeInTheDocument()
    tabShouldThrow = false
    fireEvent.click(screen.getByText('phaseF.componentsTabsTabErrorBoundary.tryAgain'))
    expect(onTabError).toHaveBeenCalled()
    expect(screen.getByText('tab recovered')).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it('opens the incident report dialog from the tab error boundary CTA', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('tab failed')
    const TabChild = () => {
      throw error
    }

    render(
      <TabErrorBoundary>
        <TabChild />
      </TabErrorBoundary>
    )

    fireEvent.click(screen.getByText('phaseF.componentsTabsTabErrorBoundary.sendReport'))
    expect(mocks.openIncidentReport).toHaveBeenCalledWith({
      source: 'tab_error_boundary',
      errorCode: 'Error',
      stack: error.stack
    })
    consoleError.mockRestore()
  })

  it('renders kanban drag overlays for empty and active drags', () => {
    const { rerender } = render(<KanbanDragOverlay projects={projects} allTasks={[baseTask]} />)
    expect(screen.getByTestId('drag-overlay')).toBeEmptyDOMElement()

    mocks.dragState = {
      isDragging: true,
      overType: 'task',
      overId: 'task-1',
      sourceContainerId: 'done',
      sourceType: 'kanban',
      draggedTasks: [{ ...baseTask, completedAt: '2026-05-10T00:00:00Z' }]
    }
    rerender(<KanbanDragOverlay projects={projects} allTasks={[baseTask]} />)
    expect(screen.getByText('kanban-card:Task one:Work:true')).toBeInTheDocument()
  })

  it('updates snooze countdown on timers and visibility changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T09:00:00Z'))
    const target = new Date('2026-05-10T10:00:00Z')

    const { result, unmount } = renderHook(() => useSnoozeCountdown(target))
    expect(result.current).toContain('1h')

    act(() => {
      vi.advanceTimersByTime(60_000)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).not.toBeNull()
    unmount()

    const empty = renderHook(() => useSnoozeCountdown(null))
    expect(empty.result.current).toBeNull()
  })
})
