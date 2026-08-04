/**
 * useBulkActions — i18n message contract tests.
 *
 * Every bulk toast in this hook used to be a hardcoded English string with
 * hand-rolled pluralization (`${n} task${n === 1 ? '' : 's'}`). They are now
 * single ICU plural messages, so the thing worth pinning is the *call*:
 * namespace + key + interpolated values. A regression that drops `count`, or
 * swaps one key for a sibling that happens to read identically in English, is
 * invisible in the rendered string but breaks every other locale.
 *
 * The fake `t` here therefore does two jobs: it records (namespace, key,
 * values), and it renders the real English ICU message through the i18next
 * singleton that `tests/setup-dom.ts` initializes. Assertions check both.
 *
 * Companion file: use-bulk-actions.test.tsx covers vault-vs-local dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import i18next from 'i18next'
import { useBulkActions } from './use-bulk-actions'
import type { Task, Priority } from '@/data/task-model'
import type { Project, Status } from '@/data/tasks-data'

// ============================================================================
// i18n recording mock
// ============================================================================

interface TCall {
  ns: string
  key: string
  values?: Record<string, unknown>
}

const { tCalls } = vi.hoisted(() => ({ tCalls: [] as TCall[] }))

/** Records the call, then resolves the real English ICU message. */
const recordAndRender = (ns: string, key: string, values?: Record<string, unknown>): string => {
  tCalls.push({ ns, key, values })
  return i18next.getFixedT(null, ns)(key, values) as string
}

// Stable identity per namespace so the hook's useCallback deps do not churn.
const tByNs = new Map<string, (key: string, values?: Record<string, unknown>) => string>()
const tFor = (ns: string) => {
  let fn = tByNs.get(ns)
  if (!fn) {
    fn = (key, values) => recordAndRender(ns, key, values)
    tByNs.set(ns, fn)
  }
  return fn
}

vi.mock('react-i18next', () => ({
  // useT('tasks') -> useTranslation('tasks')
  useTranslation: (ns: string) => ({ t: tFor(ns), i18n: i18next }),
  // getI18n().getFixedT(null, ns)(key) — the non-React path this hook uses for
  // toast action labels and a few phaseI messages.
  getI18n: () => ({
    getFixedT: (_lng: string | null, ns: string) => tFor(ns),
    // extractErrorMessage() reaches for this when a message is an `errors:` key.
    t: (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() }
}))
import { toast } from 'sonner'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

const mockVaultStatus = { isOpen: true }
vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({ status: mockVaultStatus })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    bulkComplete: vi.fn().mockResolvedValue({ success: true }),
    bulkMove: vi.fn().mockResolvedValue({ success: true }),
    bulkArchive: vi.fn().mockResolvedValue({ success: true }),
    bulkDelete: vi.fn().mockResolvedValue({ success: true })
  }
}))
import { tasksService } from '@/services/tasks-service'

vi.mock('@/lib/task-utils', () => ({
  getDefaultTodoStatus: (project: Project) => project.statuses.find((s) => s.type === 'todo'),
  getDefaultDoneStatus: (project: Project) => project.statuses.find((s) => s.type === 'done')
}))

// ============================================================================
// Assertion helpers
// ============================================================================

const callsFor = (key: string): TCall[] => tCalls.filter((c) => c.key === key)

/** Asserts exactly one i18n lookup for `key`, in `ns`, with exactly `values`. */
const expectLookup = (key: string, ns: string, values?: Record<string, unknown>): void => {
  const calls = callsFor(key)
  const seen = tCalls.map((c) => `${c.ns}:${c.key}`).join(', ')
  expect(calls.length, `expected one lookup of "${key}" — saw [${seen}]`).toBe(1)
  expect(calls[0].ns).toBe(ns)
  expect(calls[0].values).toEqual(values)
}

const expectNoLookup = (key: string): void => {
  expect(callsFor(key)).toHaveLength(0)
}

/** The real English render of a message, for cross-checking the toast text. */
const render = (ns: string, key: string, values?: Record<string, unknown>): string =>
  i18next.getFixedT(null, ns)(key, values) as string

// ============================================================================
// Fixtures
// ============================================================================

const createStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'todo-status',
  name: 'To Do',
  color: '#gray',
  type: 'todo',
  isDefault: true,
  position: 0,
  ...overrides
})

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  icon: '📁',
  color: '#6366f1',
  position: 0,
  isArchived: false,
  statuses: [
    createStatus({ id: 'todo-status', name: 'To Do', type: 'todo', isDefault: true }),
    createStatus({
      id: 'progress-status',
      name: 'In Progress',
      type: 'in_progress',
      isDefault: false
    }),
    createStatus({ id: 'done-status', name: 'Done', type: 'done', isDefault: false })
  ],
  ...overrides
})

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-x',
  title: 'Test Task',
  description: '',
  dueDate: null,
  dueTime: null,
  priority: 'none' as Priority,
  projectId: 'project-1',
  statusId: 'todo-status',
  position: 0,
  repeatConfig: null,
  completedAt: null,
  archivedAt: null,
  parentId: null,
  createdAt: new Date(),
  tags: [],
  linkedNoteIds: [],
  ...overrides
})

// ============================================================================
// Suite
// ============================================================================

describe('useBulkActions — i18n toast contract', () => {
  let project: Project
  let tasks: Task[]
  let onUpdateTask: ReturnType<typeof vi.fn>
  let onDeleteTask: ReturnType<typeof vi.fn>
  let onComplete: ReturnType<typeof vi.fn>
  let registerUndo: ReturnType<typeof vi.fn>
  let onAddTask: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    tCalls.length = 0
    mockVaultStatus.isOpen = true

    vi.mocked(tasksService.bulkComplete).mockResolvedValue({ success: true })
    vi.mocked(tasksService.bulkMove).mockResolvedValue({ success: true })
    vi.mocked(tasksService.bulkArchive).mockResolvedValue({ success: true })
    vi.mocked(tasksService.bulkDelete).mockResolvedValue({ success: true })

    project = createProject({ id: 'project-1' })
    tasks = [
      createTask({ id: 'task-1', title: 'Task 1', statusId: 'todo-status' }),
      createTask({ id: 'task-2', title: 'Task 2', statusId: 'todo-status' }),
      createTask({
        id: 'task-3',
        title: 'Task 3',
        statusId: 'done-status',
        completedAt: new Date('2026-01-01T00:00:00Z')
      }),
      createTask({
        id: 'task-4',
        title: 'Task 4',
        statusId: 'done-status',
        completedAt: new Date('2026-01-02T00:00:00Z')
      })
    ]

    onUpdateTask = vi.fn()
    onDeleteTask = vi.fn()
    onComplete = vi.fn()
    registerUndo = vi.fn().mockReturnValue('undo-1')
    onAddTask = vi.fn()
  })

  const setup = (selectedIds: string[], projects: Project[] = [project]) =>
    renderHook(() =>
      useBulkActions({
        selectedIds,
        tasks,
        projects,
        onUpdateTask,
        onDeleteTask,
        onComplete,
        registerUndo,
        onAddTask
      })
    )

  /** The `{ action }` object sonner was handed on the last success toast. */
  const lastToastAction = (): { label: string; onClick: () => void } => {
    const calls = vi.mocked(toast.success).mock.calls
    const opts = calls[calls.length - 1][1] as { action: { label: string; onClick: () => void } }
    return opts.action
  }

  // ==========================================================================
  // bulkComplete
  // ==========================================================================

  describe('bulkComplete', () => {
    it('resolves the singular arm with count 1', async () => {
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.bulk.completed', 'tasks', { count: 1 })
      expect(toast.success).toHaveBeenCalledWith('1 task completed', expect.any(Object))
    })

    it('resolves the plural arm with the real selection count', async () => {
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.bulk.completed', 'tasks', { count: 2 })
      expect(toast.success).toHaveBeenCalledWith('2 tasks completed', expect.any(Object))
    })

    it('counts only the tasks it actually completes, not the whole selection', async () => {
      // task-3 is already done, so the message must say 1, not 2.
      const { result } = setup(['task-1', 'task-3'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(tasksService.bulkComplete).toHaveBeenCalledWith(['task-1'])
      expectLookup('toasts.bulk.completed', 'tasks', { count: 1 })
      expectLookup('toasts.bulk.undoComplete', 'tasks', { count: 1 })
    })

    it('describes the undo entry with the same count', async () => {
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.bulk.undoComplete', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith('Complete 2 tasks', expect.any(Function))
    })

    it('tells the user nothing to do when every selected task is already done', async () => {
      const { result } = setup(['task-3', 'task-4'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.alreadyAllComplete', 'tasks', undefined)
      expect(toast.info).toHaveBeenCalledWith('All selected tasks are already complete')
      expectNoLookup('toasts.bulk.completed')
      expect(tasksService.bulkComplete).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('surfaces the backend error message and keeps the fallback key wired', async () => {
      vi.mocked(tasksService.bulkComplete).mockResolvedValueOnce({
        success: false,
        error: 'vault is sealed'
      })
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.completeFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('vault is sealed')
      expect(toast.success).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('falls back to the translated failure message when the backend gives no reason', async () => {
      vi.mocked(tasksService.bulkComplete).mockResolvedValueOnce({ success: false })
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expect(toast.error).toHaveBeenCalledWith('Failed to complete tasks')
    })

    it('reports the translated failure when the backend call throws', async () => {
      vi.mocked(tasksService.bulkComplete).mockRejectedValueOnce(new Error('ipc exploded'))
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('toasts.completeFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('Failed to complete tasks')
      expect(toast.success).not.toHaveBeenCalled()
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('offers an Undo action from common that really restores the prior statuses', async () => {
      const { result } = setup(['task-1', 'task-3'])

      await act(async () => {
        await result.current.bulkComplete()
      })

      expectLookup('action.undo', 'common', undefined)
      const action = lastToastAction()
      expect(action.label).toBe('Undo')

      onUpdateTask.mockClear()
      vi.mocked(toast.success).mockClear()
      act(() => {
        action.onClick()
      })

      // task-1 was the only one completed; undo puts it back where it was.
      expect(onUpdateTask).toHaveBeenCalledTimes(1)
      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        statusId: 'todo-status',
        completedAt: null
      })
      expectLookup('phaseI.toasts.changesUndone', 'tasks', undefined)
      expect(toast.success).toHaveBeenCalledWith('Changes undone')
    })
  })

  // ==========================================================================
  // bulkUncomplete
  // ==========================================================================

  describe('bulkUncomplete', () => {
    it('resolves the singular arm with count 1', () => {
      const { result } = setup(['task-3'])

      act(() => {
        result.current.bulkUncomplete()
      })

      expectLookup('toasts.bulk.restored', 'tasks', { count: 1 })
      expect(toast.success).toHaveBeenCalledWith('1 task restored')
    })

    it('resolves the plural arm and describes the undo entry with the same count', () => {
      const { result } = setup(['task-3', 'task-4'])

      act(() => {
        result.current.bulkUncomplete()
      })

      expectLookup('toasts.bulk.restored', 'tasks', { count: 2 })
      expect(toast.success).toHaveBeenCalledWith('2 tasks restored')
      expectLookup('toasts.bulk.undoUncomplete', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith('Uncomplete 2 tasks', expect.any(Function))
    })

    it('counts only the completed tasks in the selection', () => {
      const { result } = setup(['task-1', 'task-2', 'task-3'])

      act(() => {
        result.current.bulkUncomplete()
      })

      expectLookup('toasts.bulk.restored', 'tasks', { count: 1 })
    })

    it('tells the user when the selection holds no completed tasks', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkUncomplete()
      })

      expectLookup('toasts.noCompletedSelected', 'tasks', undefined)
      expect(toast.info).toHaveBeenCalledWith('No completed tasks selected')
      expectNoLookup('toasts.bulk.restored')
      expect(onUpdateTask).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('undo restores the original done statuses and timestamps', () => {
      const { result } = setup(['task-3'])

      act(() => {
        result.current.bulkUncomplete()
      })

      onUpdateTask.mockClear()
      registerUndo.mock.calls[0][1]()

      expect(onUpdateTask).toHaveBeenCalledWith('task-3', {
        statusId: 'done-status',
        completedAt: new Date('2026-01-01T00:00:00Z')
      })
    })
  })

  // ==========================================================================
  // bulkChangePriority
  // ==========================================================================

  describe('bulkChangePriority', () => {
    it('interpolates both the count and the translated priority label (singular)', () => {
      const { result } = setup(['task-1'])

      act(() => {
        result.current.bulkChangePriority('high')
      })

      expectLookup('priorityInline.high', 'tasks', undefined)
      expectLookup('toasts.bulk.prioritySet', 'tasks', { count: 1, priority: 'high' })
      expect(toast.success).toHaveBeenCalledWith('Priority set to high for 1 task')
    })

    it('interpolates both the count and the translated priority label (plural)', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('urgent')
      })

      expectLookup('priorityInline.urgent', 'tasks', undefined)
      expectLookup('toasts.bulk.prioritySet', 'tasks', { count: 2, priority: 'urgent' })
      expect(toast.success).toHaveBeenCalledWith('Priority set to urgent for 2 tasks')
    })

    it('uses the removal message for "none", never the set message', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('none')
      })

      expectLookup('toasts.bulk.priorityRemoved', 'tasks', { count: 2 })
      expectNoLookup('toasts.bulk.prioritySet')
      expectNoLookup('priorityInline.none')
      expect(toast.success).toHaveBeenCalledWith('Priority removed for 2 tasks')
    })

    it('uses the same message for the toast and the undo description', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('low')
      })

      expect(registerUndo).toHaveBeenCalledWith(
        'Priority set to low for 2 tasks',
        expect.any(Function)
      )
      expect(toast.success).toHaveBeenCalledWith('Priority set to low for 2 tasks')
    })

    it('undo restores each task to its previous priority', () => {
      tasks[0] = createTask({ id: 'task-1', priority: 'urgent' })
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangePriority('low')
      })

      onUpdateTask.mockClear()
      registerUndo.mock.calls[0][1]()

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { priority: 'urgent' })
      expect(onUpdateTask).toHaveBeenCalledWith('task-2', { priority: 'none' })
    })

    it('says nothing at all on an empty selection', () => {
      const { result } = setup([])

      act(() => {
        result.current.bulkChangePriority('high')
      })

      expect(tCalls).toHaveLength(0)
      expect(toast.success).not.toHaveBeenCalled()
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkChangeDueDate
  // ==========================================================================

  describe('bulkChangeDueDate', () => {
    it('uses the "set" message with the count when given a date (singular)', () => {
      const { result } = setup(['task-1'])

      act(() => {
        result.current.bulkChangeDueDate(new Date('2026-12-25'))
      })

      expectLookup('toasts.bulk.dueDateSet', 'tasks', { count: 1 })
      expectNoLookup('toasts.bulk.dueDateRemoved')
      expect(toast.success).toHaveBeenCalledWith('Due date set for 1 task')
    })

    it('uses the "set" message with the count when given a date (plural)', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeDueDate(new Date('2026-12-25'))
      })

      expectLookup('toasts.bulk.dueDateSet', 'tasks', { count: 2 })
      expect(toast.success).toHaveBeenCalledWith('Due date set for 2 tasks')
    })

    it('uses the "removed" message when clearing the date', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeDueDate(null)
      })

      expectLookup('toasts.bulk.dueDateRemoved', 'tasks', { count: 2 })
      expectNoLookup('toasts.bulk.dueDateSet')
      expect(toast.success).toHaveBeenCalledWith('Due date removed from 2 tasks')
    })

    it('describes the undo entry with the count and restores the old dates', () => {
      const previous = new Date('2026-03-03')
      tasks[0] = createTask({ id: 'task-1', dueDate: previous })
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeDueDate(new Date('2026-12-25'))
      })

      expectLookup('toasts.bulk.undoDueDate', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith(
        'Due date changed for 2 tasks',
        expect.any(Function)
      )

      onUpdateTask.mockClear()
      registerUndo.mock.calls[0][1]()

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { dueDate: previous })
      expect(onUpdateTask).toHaveBeenCalledWith('task-2', { dueDate: null })
    })

    it('says nothing at all on an empty selection', () => {
      const { result } = setup([])

      act(() => {
        result.current.bulkChangeDueDate(new Date('2026-12-25'))
      })

      expect(tCalls).toHaveLength(0)
      expect(toast.success).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkMoveToProject
  // ==========================================================================

  describe('bulkMoveToProject', () => {
    const target = createProject({
      id: 'project-2',
      name: 'Target Project',
      statuses: [
        createStatus({ id: 'target-todo', name: 'To Do', type: 'todo' }),
        createStatus({ id: 'target-done', name: 'Done', type: 'done' })
      ]
    })

    it('interpolates count and project name (singular)', async () => {
      const { result } = setup(['task-1'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expectLookup('toasts.bulk.movedToProject', 'tasks', { count: 1, project: 'Target Project' })
      expect(toast.success).toHaveBeenCalledWith('1 task moved to Target Project')
    })

    it('interpolates count and project name (plural)', async () => {
      const { result } = setup(['task-1', 'task-2'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expectLookup('toasts.bulk.movedToProject', 'tasks', { count: 2, project: 'Target Project' })
      expect(toast.success).toHaveBeenCalledWith('2 tasks moved to Target Project')
    })

    it('describes the undo entry with the count and restores project + status', async () => {
      const { result } = setup(['task-1', 'task-3'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expectLookup('toasts.bulk.undoMove', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith('Move 2 tasks', expect.any(Function))

      onUpdateTask.mockClear()
      registerUndo.mock.calls[0][1]()

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        projectId: 'project-1',
        statusId: 'todo-status',
        completedAt: null
      })
      expect(onUpdateTask).toHaveBeenCalledWith('task-3', {
        projectId: 'project-1',
        statusId: 'done-status',
        completedAt: new Date('2026-01-01T00:00:00Z')
      })
    })

    it('reports an unknown target project through i18n and moves nothing', async () => {
      const { result } = setup(['task-1'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-nope')
      })

      expectLookup('phaseI.toasts.projectNotFound', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('Project not found')
      expect(tasksService.bulkMove).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('surfaces the backend error message on a failed move', async () => {
      vi.mocked(tasksService.bulkMove).mockResolvedValueOnce({
        success: false,
        error: 'target project is archived'
      })
      const { result } = setup(['task-1'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expectLookup('toasts.moveFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('target project is archived')
      expect(toast.success).not.toHaveBeenCalled()
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('reports the translated failure when the move throws', async () => {
      vi.mocked(tasksService.bulkMove).mockRejectedValueOnce(new Error('ipc exploded'))
      const { result } = setup(['task-1'], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expectLookup('toasts.moveFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('Failed to move tasks')
      expect(toast.success).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('says nothing at all on an empty selection', async () => {
      const { result } = setup([], [project, target])

      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
      })

      expect(tCalls).toHaveLength(0)
      expect(toast.error).not.toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkChangeStatus
  // ==========================================================================

  describe('bulkChangeStatus', () => {
    it('interpolates count and status name (singular)', () => {
      const { result } = setup(['task-1'])

      act(() => {
        result.current.bulkChangeStatus('progress-status')
      })

      expectLookup('toasts.bulk.movedToStatus', 'tasks', { count: 1, status: 'In Progress' })
      expect(toast.success).toHaveBeenCalledWith('1 task moved to In Progress')
    })

    it('interpolates count and status name (plural)', () => {
      const { result } = setup(['task-1', 'task-2'])

      act(() => {
        result.current.bulkChangeStatus('done-status')
      })

      expectLookup('toasts.bulk.movedToStatus', 'tasks', { count: 2, status: 'Done' })
      expect(toast.success).toHaveBeenCalledWith('2 tasks moved to Done')
    })

    it('describes the undo entry with count and status, and restores the old statuses', () => {
      const { result } = setup(['task-1', 'task-3'])

      act(() => {
        result.current.bulkChangeStatus('progress-status')
      })

      expectLookup('toasts.bulk.undoStatus', 'tasks', { count: 2, status: 'In Progress' })
      expect(registerUndo).toHaveBeenCalledWith(
        'Status → In Progress for 2 tasks',
        expect.any(Function)
      )

      onUpdateTask.mockClear()
      registerUndo.mock.calls[0][1]()

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
        statusId: 'todo-status',
        completedAt: null
      })
      expect(onUpdateTask).toHaveBeenCalledWith('task-3', {
        statusId: 'done-status',
        completedAt: new Date('2026-01-01T00:00:00Z')
      })
    })

    it('leaves the status placeholder empty when the id belongs to no project', () => {
      const { result } = setup(['task-1'])

      act(() => {
        result.current.bulkChangeStatus('ghost-status')
      })

      expectLookup('toasts.bulk.movedToStatus', 'tasks', { count: 1, status: '' })
      expect(toast.success).toHaveBeenCalledWith('1 task moved to ')
    })

    it('says nothing at all on an empty selection', () => {
      const { result } = setup([])

      act(() => {
        result.current.bulkChangeStatus('done-status')
      })

      expect(tCalls).toHaveLength(0)
      expect(toast.success).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkArchive
  // ==========================================================================

  describe('bulkArchive', () => {
    it('resolves the singular arm with count 1', async () => {
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expectLookup('toasts.bulk.archived', 'tasks', { count: 1 })
      expect(toast.success).toHaveBeenCalledWith('1 task archived', expect.any(Object))
    })

    it('resolves the plural arm and describes the undo entry with the same count', async () => {
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expectLookup('toasts.bulk.archived', 'tasks', { count: 2 })
      expect(toast.success).toHaveBeenCalledWith('2 tasks archived', expect.any(Object))
      expectLookup('toasts.bulk.undoArchive', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith('Archive 2 tasks', expect.any(Function))
    })

    it('offers an Undo action that really unarchives the tasks', async () => {
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expectLookup('action.undo', 'common', undefined)
      const action = lastToastAction()
      expect(action.label).toBe('Undo')

      onUpdateTask.mockClear()
      vi.mocked(toast.success).mockClear()
      act(() => {
        action.onClick()
      })

      expect(onUpdateTask).toHaveBeenCalledWith('task-1', { archivedAt: null })
      expect(onUpdateTask).toHaveBeenCalledWith('task-2', { archivedAt: null })
      expectLookup('phaseI.toasts.tasksRestoredFromArchive', 'tasks', undefined)
      expect(toast.success).toHaveBeenCalledWith('Tasks restored from archive')
    })

    it('uses the errors namespace key as the fallback when the backend returns failure', async () => {
      vi.mocked(tasksService.bulkArchive).mockResolvedValueOnce({ success: false })
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      // Renders identically to phaseI.toasts.failedToArchiveTasks in English —
      // only the recorded key can tell the two branches apart.
      expectLookup('phaseI.errors.failedToArchiveTasks', 'tasks', undefined)
      expectNoLookup('phaseI.toasts.failedToArchiveTasks')
      expect(toast.error).toHaveBeenCalledWith('Failed to archive tasks')
      expect(toast.success).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('uses the toasts namespace key when the archive call throws', async () => {
      vi.mocked(tasksService.bulkArchive).mockRejectedValueOnce(new Error('ipc exploded'))
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expectLookup('phaseI.toasts.failedToArchiveTasks', 'tasks', undefined)
      expectNoLookup('phaseI.errors.failedToArchiveTasks')
      expect(toast.error).toHaveBeenCalledWith('Failed to archive tasks')
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('says nothing at all on an empty selection', async () => {
      const { result } = setup([])

      await act(async () => {
        await result.current.bulkArchive()
      })

      expect(tCalls).toHaveLength(0)
      expect(tasksService.bulkArchive).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // bulkDelete
  // ==========================================================================

  describe('bulkDelete', () => {
    it('resolves the singular arm with count 1 and attaches the description', async () => {
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expectLookup('toasts.bulk.deleted', 'tasks', { count: 1 })
      expectLookup('toasts.bulk.deletedDescription', 'tasks', undefined)
      expect(toast.success).toHaveBeenCalledWith('1 task deleted', {
        description: 'This action can be undone for a short time.'
      })
    })

    it('resolves the plural arm with the real selection count', async () => {
      const { result } = setup(['task-1', 'task-2', 'task-3'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expectLookup('toasts.bulk.deleted', 'tasks', { count: 3 })
      expect(toast.success).toHaveBeenCalledWith('3 tasks deleted', expect.any(Object))
    })

    it('describes the undo entry with the count and re-adds the deleted tasks', async () => {
      const { result } = setup(['task-1', 'task-2'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expectLookup('toasts.bulk.undoDelete', 'tasks', { count: 2 })
      expect(registerUndo).toHaveBeenCalledWith('Delete 2 tasks', expect.any(Function))

      registerUndo.mock.calls[0][1]()

      expect(onAddTask).toHaveBeenCalledTimes(2)
      expect(onAddTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }))
      expect(onAddTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-2' }))
    })

    it('surfaces the backend error message and keeps the fallback key wired', async () => {
      vi.mocked(tasksService.bulkDelete).mockResolvedValueOnce({
        success: false,
        error: 'db locked'
      })
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expectLookup('toasts.deleteFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('db locked')
      expect(toast.success).not.toHaveBeenCalled()
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('reports the translated failure when the delete throws', async () => {
      vi.mocked(tasksService.bulkDelete).mockRejectedValueOnce(new Error('ipc exploded'))
      const { result } = setup(['task-1'])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expectLookup('toasts.deleteFailed', 'tasks', undefined)
      expect(toast.error).toHaveBeenCalledWith('Failed to delete tasks')
      expect(toast.success).not.toHaveBeenCalled()
      expect(registerUndo).not.toHaveBeenCalled()
      expect(onComplete).not.toHaveBeenCalled()
    })

    it('says nothing at all on an empty selection', async () => {
      const { result } = setup([])

      await act(async () => {
        await result.current.bulkDelete()
      })

      expect(tCalls).toHaveLength(0)
      expect(tasksService.bulkDelete).not.toHaveBeenCalled()
      expect(onDeleteTask).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Cross-cutting: no bulk message may be hardcoded English
  // ==========================================================================

  describe('namespace discipline', () => {
    it('routes every message through i18n — nothing is passed to sonner unresolved', async () => {
      const target = createProject({ id: 'project-2', name: 'Target Project' })
      const { result } = setup(['task-1', 'task-2'], [project, target])

      await act(async () => {
        await result.current.bulkComplete()
      })
      act(() => {
        result.current.bulkChangePriority('high')
        result.current.bulkChangeDueDate(null)
        result.current.bulkChangeStatus('done-status')
      })
      await act(async () => {
        await result.current.bulkMoveToProject('project-2')
        await result.current.bulkArchive()
        await result.current.bulkDelete()
      })

      const namespaces = new Set(tCalls.map((c) => c.ns))
      expect([...namespaces].sort()).toEqual(['common', 'tasks'])

      // Every string handed to sonner came out of a recorded lookup.
      const rendered = new Set(tCalls.map((c) => render(c.ns, c.key, c.values)))
      for (const [message] of vi.mocked(toast.success).mock.calls) {
        expect(rendered.has(message as string)).toBe(true)
      }
    })
  })
})
