import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  tasksService,
  tasksServiceLogger,
  queueTaskReorder,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onProjectUpdated
} from './tasks-service'

const commands = vi.hoisted(() => ({
  tasksCreate: vi.fn(),
  tasksGet: vi.fn(),
  tasksUpdate: vi.fn(),
  tasksComplete: vi.fn(),
  tasksReorder: vi.fn(),
  tasksConvertToSubtask: vi.fn(),
  tasksBulkMove: vi.fn(),
  tasksStatusUpdate: vi.fn(),
  tasksGetToday: vi.fn(),
  tasksGetUpcoming: vi.fn(),
  tasksProjectGet: vi.fn(),
  tasksProjectListForItem: vi.fn()
}))
type Handler = (event: { payload: unknown }) => void
const handlers = vi.hoisted(() => new Map<string, Handler>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: vi.fn((handler: Handler) => {
      handlers.set(name, handler)
      return Promise.resolve(() => handlers.delete(name))
    })
  })
  return {
    taskCreatedEvent: event('taskCreated'),
    taskUpdatedEvent: event('taskUpdated'),
    taskDeletedEvent: event('taskDeleted'),
    taskCompletedEvent: event('taskCompleted'),
    taskMovedEvent: event('taskMoved'),
    taskActivityCreatedEvent: event('taskActivityCreated'),
    projectCreatedEvent: event('projectCreated'),
    projectUpdatedEvent: event('projectUpdated'),
    projectDeletedEvent: event('projectDeleted')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

const view = {
  id: 'task-1',
  projectId: 'inbox',
  statusId: null,
  parentId: null,
  title: 'Write',
  description: null,
  priority: 2,
  position: 0,
  dueDate: '2026-05-10',
  dueTime: null,
  durationMinutes: null,
  startDate: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  sourceNoteId: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  modifiedAt: '2026-05-01T00:00:00.000Z',
  tags: [],
  linkedNoteIds: [],
  linkedCanvasIds: [],
  fields: {},
  hasSubtasks: false,
  subtaskCount: 0,
  completedSubtaskCount: 0
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('tasks-service', () => {
  beforeEach(() => {
    handlers.clear()
    for (const command of Object.values(commands)) command.mockReset()
  })

  it('answers a write in its envelope and passes a rejected command on', async () => {
    commands.tasksCreate.mockResolvedValue({ success: true, task: view })
    await expect(tasksService.create({ projectId: 'inbox', title: 'Write' })).resolves.toEqual({
      success: true,
      task: view
    })

    commands.tasksUpdate.mockRejectedValue({ code: 'storage', message: 'disk full' })
    await expect(tasksService.update({ id: 'task-1', title: 'x' })).rejects.toEqual({
      code: 'storage',
      message: 'disk full'
    })
  })

  it('names the next occurrence of a repeating completion by id and due date', async () => {
    commands.tasksComplete.mockResolvedValue({
      success: true,
      task: view,
      nextOccurrence: { ...view, id: 'task-2', dueDate: '2026-05-11' }
    })
    const result = await tasksService.complete({ id: 'task-1' })
    expect(result.nextOccurrence).toEqual({ id: 'task-2', dueDate: '2026-05-11' })
  })

  it('sends the positional arguments as the command inputs', async () => {
    commands.tasksReorder.mockResolvedValue({ success: true })
    commands.tasksConvertToSubtask.mockResolvedValue({ success: true, task: view })
    commands.tasksBulkMove.mockResolvedValue({ success: true, count: 2 })
    commands.tasksStatusUpdate.mockResolvedValue({ success: true })
    commands.tasksProjectListForItem.mockResolvedValue([])

    await tasksService.reorder(['t1', 't2'], [0, 1])
    await tasksService.convertToSubtask('t1', 'p1')
    await expect(tasksService.bulkMove(['t1', 't2'], 'proj-2')).resolves.toEqual({
      success: true,
      count: 2
    })
    await tasksService.updateStatus('s1', { name: 'Doing' })
    await tasksService.listForItem('note', 'n1')

    expect(commands.tasksReorder).toHaveBeenCalledWith({ taskIds: ['t1', 't2'], positions: [0, 1] })
    expect(commands.tasksConvertToSubtask).toHaveBeenCalledWith({ taskId: 't1', parentId: 'p1' })
    expect(commands.tasksBulkMove).toHaveBeenCalledWith({ ids: ['t1', 't2'], projectId: 'proj-2' })
    expect(commands.tasksStatusUpdate).toHaveBeenCalledWith({ id: 's1', name: 'Doing' })
    expect(commands.tasksProjectListForItem).toHaveBeenCalledWith({
      itemType: 'note',
      itemId: 'n1'
    })
  })

  it('answers the dated views in the list envelope, upcoming over 7 days by default', async () => {
    commands.tasksGetToday.mockResolvedValue([view])
    commands.tasksGetUpcoming.mockResolvedValue([])
    await expect(tasksService.getToday()).resolves.toEqual({
      tasks: [view],
      total: 1,
      hasMore: false
    })
    await tasksService.getUpcoming()
    expect(commands.tasksGetUpcoming).toHaveBeenCalledWith(7)
  })

  it('logs a reorder that fails or is refused in fire-and-forget flows', async () => {
    const error = new Error('reorder failed')
    commands.tasksReorder.mockRejectedValueOnce(error)
    queueTaskReorder(['t1'], [0])
    await flush()
    expect(tasksServiceLogger.error).toHaveBeenCalledWith('Failed to reorder tasks:', error)

    commands.tasksReorder.mockResolvedValueOnce({ success: false, error: 'not found' })
    queueTaskReorder(['t1'], [0])
    await flush()
    expect(tasksServiceLogger.error).toHaveBeenCalledWith('Failed to reorder tasks:', 'not found')
  })

  it('delivers Electron payloads, reading the record back by the event id', async () => {
    commands.tasksGet.mockResolvedValue(view)
    commands.tasksProjectGet.mockResolvedValue({ id: 'p1', name: 'P', statuses: [] })
    const created = vi.fn()
    const updated = vi.fn()
    const deleted = vi.fn()
    const project = vi.fn()
    onTaskCreated(created)
    onTaskUpdated(updated)
    onTaskDeleted(deleted)
    onProjectUpdated(project)
    await flush()

    handlers.get('taskCreated')?.({ payload: { id: 'task-1' } })
    handlers.get('taskUpdated')?.({ payload: { id: 'task-1' } })
    handlers.get('taskDeleted')?.({ payload: { id: 'task-9' } })
    handlers.get('projectUpdated')?.({ payload: { id: 'p1' } })
    await flush()

    expect(commands.tasksGet).toHaveBeenCalledWith('task-1')
    expect(created).toHaveBeenCalledWith({ task: view })
    expect(updated).toHaveBeenCalledWith({ id: 'task-1', task: view, changes: {} })
    expect(deleted).toHaveBeenCalledWith({ id: 'task-9' })
    expect(project).toHaveBeenCalledWith({
      id: 'p1',
      project: { id: 'p1', name: 'P', statuses: [] }
    })
  })

  it('skips a task gone before its read-back, and a listener unsubscribed meanwhile', async () => {
    const updated = vi.fn()
    const unsubscribe = onTaskUpdated(updated)
    await flush()

    commands.tasksGet.mockResolvedValueOnce(null)
    handlers.get('taskUpdated')?.({ payload: { id: 'gone' } })
    await flush()
    expect(updated).not.toHaveBeenCalled()

    let answer: (value: unknown) => void = () => undefined
    commands.tasksGet.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    handlers.get('taskUpdated')?.({ payload: { id: 'task-1' } })
    unsubscribe()
    answer(view)
    await flush()
    expect(updated).not.toHaveBeenCalled()
  })
})
