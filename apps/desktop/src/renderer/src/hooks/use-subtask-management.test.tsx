import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useSubtaskManagement } from './use-subtask-management'

const mocks = vi.hoisted(() => ({
  autoCompleteParent: true,
  createSubtask: vi.fn(),
  createMultipleSubtasks: vi.fn(),
  reorderSubtasks: vi.fn(),
  promoteToTask: vi.fn(),
  demoteToSubtask: vi.fn(),
  deleteSubtask: vi.fn(),
  deleteParentWithSubtasks: vi.fn(),
  completeParentWithSubtasks: vi.fn(),
  getIncompleteSubtasks: vi.fn(),
  getSubtasks: vi.fn(),
  hasIncompleteSubtasks: vi.fn(),
  hasSubtasks: vi.fn(),
  checkAllSubtasksComplete: vi.fn(),
  completeAllSubtasks: vi.fn(),
  markAllSubtasksIncomplete: vi.fn(),
  setDueDateForAllSubtasks: vi.fn(),
  setPriorityForAllSubtasks: vi.fn(),
  deleteAllSubtasks: vi.fn(),
  completeParentTask: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
}))

vi.mock('./use-task-settings', () => ({
  useTaskSettings: () => ({
    subtaskSettings: { autoCompleteParent: mocks.autoCompleteParent }
  })
}))

vi.mock('@/lib/subtask-utils', () => ({
  createSubtask: mocks.createSubtask,
  createMultipleSubtasks: mocks.createMultipleSubtasks,
  reorderSubtasks: mocks.reorderSubtasks,
  promoteToTask: mocks.promoteToTask,
  demoteToSubtask: mocks.demoteToSubtask,
  deleteSubtask: mocks.deleteSubtask,
  deleteParentWithSubtasks: mocks.deleteParentWithSubtasks,
  completeParentWithSubtasks: mocks.completeParentWithSubtasks,
  getIncompleteSubtasks: mocks.getIncompleteSubtasks,
  getSubtasks: mocks.getSubtasks,
  hasIncompleteSubtasks: mocks.hasIncompleteSubtasks,
  hasSubtasks: mocks.hasSubtasks
}))

vi.mock('@/lib/subtask-bulk-utils', () => ({
  checkAllSubtasksComplete: mocks.checkAllSubtasksComplete,
  completeAllSubtasks: mocks.completeAllSubtasks,
  markAllSubtasksIncomplete: mocks.markAllSubtasksIncomplete,
  setDueDateForAllSubtasks: mocks.setDueDateForAllSubtasks,
  setPriorityForAllSubtasks: mocks.setPriorityForAllSubtasks,
  deleteAllSubtasks: mocks.deleteAllSubtasks,
  completeParentTask: mocks.completeParentTask
}))

const parent = {
  id: 'parent',
  title: 'Parent task',
  parentId: null,
  subtaskIds: ['child'],
  completedAt: null
} as any

const child = {
  id: 'child',
  title: 'Child task',
  parentId: 'parent',
  subtaskIds: [],
  completedAt: null
} as any

const done = {
  id: 'done',
  title: 'Done task',
  parentId: null,
  subtaskIds: [],
  completedAt: new Date('2026-01-01T00:00:00.000Z')
} as any

const leaf = {
  id: 'leaf',
  title: 'Leaf task',
  parentId: null,
  subtaskIds: [],
  completedAt: null
} as any

const updatedTasks = [{ id: 'updated' }] as any[]
const tasks = [parent, child, done, leaf]

function setup(callbacks: Record<string, any> = {}, taskList = tasks) {
  return renderHook(() =>
    useSubtaskManagement({
      tasks: taskList,
      projects: [],
      onTasksChange: callbacks.onTasksChange ?? vi.fn(),
      onAddTask: callbacks.onAddTask,
      onUpdateTask: callbacks.onUpdateTask,
      onDeleteTask: callbacks.onDeleteTask,
      onReorderTasks: callbacks.onReorderTasks
    })
  )
}

describe('useSubtaskManagement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.autoCompleteParent = true
    mocks.createSubtask.mockReturnValue({
      success: true,
      updatedTasks,
      newTask: { id: 'new-subtask' }
    })
    mocks.createMultipleSubtasks.mockReturnValue({
      success: true,
      updatedTasks,
      newTasks: [{ id: 'new-a' }, { id: 'new-b' }]
    })
    mocks.reorderSubtasks.mockReturnValue({
      success: true,
      updatedTasks,
      reorderedTasks: [{ id: 'child' }, { id: 'new-a' }]
    })
    mocks.promoteToTask.mockReturnValue({ success: true, updatedTasks })
    mocks.demoteToSubtask.mockReturnValue({ success: true, updatedTasks })
    mocks.deleteSubtask.mockReturnValue({ success: true, updatedTasks })
    mocks.deleteParentWithSubtasks.mockReturnValue({ success: true, updatedTasks })
    mocks.completeParentWithSubtasks.mockReturnValue({ success: true, updatedTasks })
    mocks.getIncompleteSubtasks.mockReturnValue([child])
    mocks.getSubtasks.mockReturnValue([child])
    mocks.hasSubtasks.mockReturnValue(true)
    mocks.hasIncompleteSubtasks.mockReturnValue(true)
    mocks.checkAllSubtasksComplete.mockReturnValue(true)
    mocks.completeAllSubtasks.mockReturnValue({
      success: true,
      updatedTasks,
      completedSubtasks: [child],
      affectedCount: 1
    })
    mocks.markAllSubtasksIncomplete.mockReturnValue({
      success: true,
      updatedTasks,
      incompleteSubtasks: [child],
      affectedCount: 1
    })
    mocks.setDueDateForAllSubtasks.mockReturnValue({
      success: true,
      updatedTasks,
      affectedCount: 1
    })
    mocks.setPriorityForAllSubtasks.mockReturnValue({
      success: true,
      updatedTasks,
      affectedCount: 1
    })
    mocks.deleteAllSubtasks.mockReturnValue({ success: true, updatedTasks, affectedCount: 1 })
    mocks.completeParentTask.mockReturnValue({ success: true, updatedTasks })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs direct subtask actions with database-aware callbacks and error toasts', () => {
    const onAddTask = vi.fn()
    const onUpdateTask = vi.fn()
    const onDeleteTask = vi.fn()
    const onReorderTasks = vi.fn()
    const { result } = setup({ onAddTask, onUpdateTask, onDeleteTask, onReorderTasks })

    act(() => result.current.handleAddSubtask('parent', 'New child'))
    expect(mocks.createSubtask).toHaveBeenCalledWith(
      { parentId: 'parent', title: 'New child' },
      tasks
    )
    expect(onAddTask).toHaveBeenCalledWith({ id: 'new-subtask' })

    act(() => result.current.handleBulkAddSubtasks('parent', ['A', 'B']))
    expect(onAddTask).toHaveBeenCalledWith({ id: 'new-a' })
    expect(onAddTask).toHaveBeenCalledWith({ id: 'new-b' })

    act(() => result.current.handleBulkAddSubtasks('parent', []))
    expect(mocks.createMultipleSubtasks).toHaveBeenCalledTimes(1)

    act(() => result.current.handleReorderSubtasks('parent', ['new-a', 'child']))
    expect(onReorderTasks).toHaveBeenCalledWith(['child', 'new-a'], [0, 1])

    act(() => result.current.handlePromoteToTask('child'))
    expect(onUpdateTask).toHaveBeenCalledWith('child', { parentId: null })

    act(() => result.current.handleDeleteSubtask('child'))
    expect(onDeleteTask).toHaveBeenCalledWith('child')

    mocks.createSubtask.mockReturnValueOnce({ success: false, error: new Error('nope') })
    act(() => result.current.handleAddSubtask('parent', 'Bad child'))
    expect(toast.error).toHaveBeenCalledWith('nope')
  })

  it('runs direct subtask fallback callbacks and error branches', () => {
    const onTasksChange = vi.fn()
    const { result } = setup({ onTasksChange })

    act(() => result.current.handleAddSubtask('parent', 'New child'))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)

    act(() => result.current.handleBulkAddSubtasks('parent', ['Solo']))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)
    expect(toast.success).toHaveBeenCalledWith('toasts.subtasks.added')

    act(() => result.current.handleReorderSubtasks('parent', ['child']))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)

    act(() => result.current.handlePromoteToTask('missing-child'))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)
    expect(toast.success).toHaveBeenCalledWith('toasts.subtasks.promoted')

    act(() => result.current.handleDeleteSubtask('child'))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)

    mocks.createMultipleSubtasks.mockReturnValueOnce({ success: false, error: new Error('bulk') })
    act(() => result.current.handleBulkAddSubtasks('parent', ['Bad']))
    expect(toast.error).toHaveBeenCalledWith('bulk')

    mocks.reorderSubtasks.mockReturnValueOnce({ success: false, error: new Error('order') })
    act(() => result.current.handleReorderSubtasks('parent', ['Bad']))
    expect(toast.error).toHaveBeenCalledWith('order')

    mocks.promoteToTask.mockReturnValueOnce({ success: false, error: new Error('promote') })
    act(() => result.current.handlePromoteToTask('child'))
    expect(toast.error).toHaveBeenCalledWith('promote')

    mocks.deleteSubtask.mockReturnValueOnce({ success: false, error: new Error('delete') })
    act(() => result.current.handleDeleteSubtask('child'))
    expect(toast.error).toHaveBeenCalledWith('delete')
  })

  it('drives parent dialogs, demotion, smart delete, and smart completion fallbacks', () => {
    const onTasksChange = vi.fn()
    const { result } = setup({ onTasksChange })

    act(() => result.current.openDeleteParentDialog(parent))
    expect(result.current.deleteParentDialogOpen).toBe(true)
    expect(result.current.pendingDeleteSubtaskCount).toBe(1)
    act(() => result.current.confirmDeleteParent(true))
    expect(mocks.deleteParentWithSubtasks).toHaveBeenCalledWith('parent', true, tasks)
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)
    expect(result.current.deleteParentDialogOpen).toBe(false)

    act(() => result.current.openCompleteParentDialog(parent))
    expect(result.current.pendingCompleteIncompleteSubtasks).toEqual([child])
    act(() => result.current.confirmCompleteParent(false))
    expect(mocks.completeParentWithSubtasks).toHaveBeenCalledWith('parent', false, tasks)

    act(() => result.current.openParentPickerDialog(leaf))
    expect(result.current.parentPickerDialogOpen).toBe(true)
    act(() => result.current.confirmDemoteToSubtask('parent'))
    expect(mocks.demoteToSubtask).toHaveBeenCalledWith('leaf', 'parent', tasks)
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)

    act(() => result.current.handleDeleteTask('child'))
    expect(mocks.deleteSubtask).toHaveBeenCalledWith('child', tasks)

    act(() => result.current.handleDeleteTask('parent'))
    expect(result.current.deleteParentDialogOpen).toBe(true)

    mocks.hasSubtasks.mockReturnValueOnce(false)
    act(() => result.current.handleDeleteTask('leaf'))
    expect(onTasksChange).toHaveBeenCalledWith(tasks.filter((task) => task.id !== 'leaf'))

    act(() => result.current.handleCompleteTask('done'))
    expect(onTasksChange).toHaveBeenCalledWith(
      tasks.map((task) => (task.id === 'done' ? { ...task, completedAt: null } : task))
    )

    act(() => result.current.handleCompleteTask('parent'))
    expect(result.current.completeParentDialogOpen).toBe(true)

    mocks.hasIncompleteSubtasks.mockReturnValueOnce(false)
    act(() => result.current.handleCompleteTask('leaf'))
    expect(toast.success).toHaveBeenCalledWith('phaseI.toasts.taskCompleted')
  })

  it('handles dialog guards and failure branches without leaking stale pending state', () => {
    const onTasksChange = vi.fn()
    const onUpdateTask = vi.fn()
    const { result } = setup({ onTasksChange, onUpdateTask })

    act(() => result.current.confirmDeleteParent(false))
    act(() => result.current.confirmCompleteParent(true))
    act(() => result.current.confirmDemoteToSubtask('parent'))
    act(() => result.current.autoCompleteParent())
    act(() => result.current.confirmBulkDueDate(null, false))
    act(() => result.current.confirmBulkPriority('low', true))
    act(() => result.current.confirmDeleteAllSubtasks())

    expect(mocks.deleteParentWithSubtasks).not.toHaveBeenCalled()
    expect(mocks.completeParentWithSubtasks).not.toHaveBeenCalled()
    expect(mocks.demoteToSubtask).not.toHaveBeenCalled()
    expect(mocks.setDueDateForAllSubtasks).not.toHaveBeenCalled()

    mocks.deleteParentWithSubtasks.mockReturnValueOnce({
      success: false,
      error: new Error('delete parent')
    })
    act(() => result.current.openDeleteParentDialog(parent))
    act(() => result.current.confirmDeleteParent(false))
    expect(toast.error).toHaveBeenCalledWith('delete parent')
    expect(result.current.pendingDeleteParent).toBeNull()

    mocks.completeParentWithSubtasks.mockReturnValueOnce({
      success: false,
      error: new Error('complete parent')
    })
    act(() => result.current.openCompleteParentDialog(parent))
    act(() => result.current.confirmCompleteParent(true))
    expect(toast.error).toHaveBeenCalledWith('complete parent')
    expect(result.current.pendingCompleteParent).toBeNull()

    mocks.demoteToSubtask.mockReturnValueOnce({ success: false, error: new Error('demote') })
    act(() => result.current.openParentPickerDialog(leaf))
    act(() => result.current.confirmDemoteToSubtask('parent'))
    expect(toast.error).toHaveBeenCalledWith('demote')
    expect(result.current.pendingDemoteTask).toBeNull()
  })

  it('handles completion automation and bulk subtask dialogs', () => {
    const onUpdateTask = vi.fn()
    const onTasksChange = vi.fn()
    const { result, rerender } = setup({ onTasksChange, onUpdateTask })

    act(() => result.current.handleCompleteSubtask('child'))
    expect(onUpdateTask).toHaveBeenCalledWith('child', { completedAt: expect.any(Date) })

    act(() => vi.advanceTimersByTime(200))
    expect(onUpdateTask).toHaveBeenCalledWith('parent', { completedAt: expect.any(Date) })

    act(() => result.current.handleCompleteAllSubtasks('parent'))
    expect(onUpdateTask).toHaveBeenCalledWith('child', { completedAt: expect.any(Date) })
    act(() => vi.advanceTimersByTime(1500))
    expect(onUpdateTask).toHaveBeenCalledWith('parent', { completedAt: expect.any(Date) })

    act(() => result.current.handleMarkAllSubtasksIncomplete('parent'))
    expect(onUpdateTask).toHaveBeenCalledWith('child', { completedAt: null })

    mocks.autoCompleteParent = false
    rerender()
    act(() => result.current.handleCompleteSubtask('child'))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.allSubtasksCompleteDialogOpen).toBe(true)

    act(() => result.current.keepParentOpen())
    expect(result.current.allSubtasksCompleteDialogOpen).toBe(false)

    act(() => result.current.openBulkDueDateDialog('parent'))
    act(() => result.current.confirmBulkDueDate(new Date('2026-01-01T00:00:00.000Z'), true))
    expect(mocks.setDueDateForAllSubtasks).toHaveBeenCalled()

    act(() => result.current.openBulkPriorityDialog('parent'))
    act(() => result.current.confirmBulkPriority('high', false))
    expect(mocks.setPriorityForAllSubtasks).toHaveBeenCalledWith('parent', 'high', false, tasks)

    act(() => result.current.openDeleteAllSubtasksDialog('parent'))
    act(() => result.current.confirmDeleteAllSubtasks())
    expect(mocks.deleteAllSubtasks).toHaveBeenCalledWith('parent', tasks)
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)
  })

  it('handles completion fallbacks, undo action, and bulk failure branches', () => {
    const onTasksChange = vi.fn()
    const { result } = setup({ onTasksChange })

    act(() => result.current.handleCompleteSubtask('child'))
    expect(onTasksChange).toHaveBeenCalledWith(
      tasks.map((task) => (task.id === 'child' ? { ...task, completedAt: expect.any(Date) } : task))
    )
    act(() => vi.advanceTimersByTime(200))
    expect(mocks.completeParentTask).toHaveBeenCalledWith('parent', expect.any(Array))
    expect(onTasksChange).toHaveBeenCalledWith(updatedTasks)

    const onUpdateTask = vi.fn()
    const completedChild = { ...child, completedAt: new Date('2026-01-01T00:00:00.000Z') }
    const withCompletedChild = [parent, completedChild, done, leaf]
    const completedSetup = setup({ onUpdateTask }, withCompletedChild)
    act(() => completedSetup.result.current.handleCompleteSubtask('child'))
    expect(onUpdateTask).toHaveBeenCalledWith('child', { completedAt: null })

    const fallbackCompletedSetup = setup({ onTasksChange }, withCompletedChild)
    act(() => fallbackCompletedSetup.result.current.handleCompleteSubtask('child'))
    expect(onTasksChange).toHaveBeenCalledWith(
      withCompletedChild.map((task) =>
        task.id === 'child' ? { ...task, completedAt: null } : task
      )
    )

    act(() => result.current.handleCompleteSubtask('missing'))
    act(() => result.current.handleCompleteSubtask('leaf'))

    const autoSetup = setup({ onUpdateTask })
    act(() => autoSetup.result.current.handleCompleteSubtask('child'))
    act(() => vi.advanceTimersByTime(200))
    const successCall = vi
      .mocked(toast.success)
      .mock.calls.find(
        ([message, options]) =>
          message === 'phaseI.toasts.allSubtasksCompleteTaskMarkedAsDone' && options
      )
    expect(successCall?.[1]).toMatchObject({
      duration: 10000,
      action: { label: 'action.undo', onClick: expect.any(Function) }
    })
    act(() => successCall?.[1]?.action.onClick())
    expect(onUpdateTask).toHaveBeenCalledWith('parent', { completedAt: null })

    const dialogSetup = setup({ onTasksChange })
    mocks.autoCompleteParent = false
    dialogSetup.rerender()
    act(() => dialogSetup.result.current.handleCompleteSubtask('child'))
    act(() => vi.advanceTimersByTime(1000))
    act(() => dialogSetup.result.current.autoCompleteParent())
    expect(mocks.completeParentTask).toHaveBeenCalledWith('parent', tasks)

    mocks.completeAllSubtasks.mockReturnValueOnce({ success: false, error: new Error('all done') })
    act(() => result.current.handleCompleteAllSubtasks('parent'))
    expect(toast.error).toHaveBeenCalledWith('all done')

    mocks.markAllSubtasksIncomplete.mockReturnValueOnce({
      success: false,
      error: new Error('incomplete')
    })
    act(() => result.current.handleMarkAllSubtasksIncomplete('parent'))
    expect(toast.error).toHaveBeenCalledWith('incomplete')

    act(() => result.current.openBulkDueDateDialog('missing-parent'))
    expect(result.current.bulkDueDateDialogOpen).toBe(false)

    act(() => result.current.openBulkPriorityDialog('missing-parent'))
    expect(result.current.bulkPriorityDialogOpen).toBe(false)

    act(() => result.current.openDeleteAllSubtasksDialog('missing-parent'))
    expect(result.current.deleteAllSubtasksDialogOpen).toBe(false)

    mocks.setDueDateForAllSubtasks.mockReturnValueOnce({
      success: true,
      updatedTasks,
      affectedCount: 2
    })
    act(() => result.current.openBulkDueDateDialog('parent'))
    act(() => result.current.confirmBulkDueDate(null, false))
    expect(toast.success).toHaveBeenCalledWith('toasts.subtasks.dueDateCleared')

    mocks.setDueDateForAllSubtasks.mockReturnValueOnce({
      success: false,
      error: new Error('due date')
    })
    act(() => result.current.openBulkDueDateDialog('parent'))
    act(() => result.current.confirmBulkDueDate(new Date('2026-01-01T00:00:00.000Z'), true))
    expect(toast.error).toHaveBeenCalledWith('due date')

    mocks.setPriorityForAllSubtasks.mockReturnValueOnce({
      success: false,
      error: new Error('priority')
    })
    act(() => result.current.openBulkPriorityDialog('parent'))
    act(() => result.current.confirmBulkPriority('urgent', true))
    expect(toast.error).toHaveBeenCalledWith('priority')

    mocks.deleteAllSubtasks.mockReturnValueOnce({ success: false, error: new Error('delete all') })
    act(() => result.current.openDeleteAllSubtasksDialog('parent'))
    act(() => result.current.confirmDeleteAllSubtasks())
    expect(toast.error).toHaveBeenCalledWith('delete all')
  })
})
