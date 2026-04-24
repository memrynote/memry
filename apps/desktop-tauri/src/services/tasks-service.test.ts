import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  tasksService,
  tasksServiceLogger,
  queueTaskReorder,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  onTaskMoved,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted
} from './tasks-service'

describe('tasks-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('exposes task RPC methods as callable forwarders', () => {
    // Phase H: forwarder is a Proxy, so methods are not identical references.
    expect(typeof tasksService.create).toBe('function')
    expect(typeof tasksService.update).toBe('function')
    expect(typeof tasksService.list).toBe('function')
    expect(typeof tasksService.bulkComplete).toBe('function')
    expect(typeof tasksService.getUpcoming).toBe('function')
  })

  it('forwards CRUD and list calls', async () => {
    api.tasks.create = vi.fn().mockResolvedValue({ success: true, task: { id: 'task-1' } })
    api.tasks.update = vi.fn().mockResolvedValue({ success: true, task: { id: 'task-1' } })
    api.tasks.delete = vi.fn().mockResolvedValue({ success: true })
    api.tasks.list = vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false })

    const createInput = { projectId: 'proj-1', title: 'Task' }
    const createResult = await tasksService.create(createInput)
    expect(api.tasks.create).toHaveBeenCalledWith(createInput)
    expect(createResult.success).toBe(true)

    const updateInput = { id: 'task-1', title: 'Updated' }
    await tasksService.update(updateInput)
    expect(api.tasks.update).toHaveBeenCalledWith(updateInput)

    await tasksService.delete('task-1')
    expect(api.tasks.delete).toHaveBeenCalledWith('task-1')

    await tasksService.list({ projectId: 'proj-1', limit: 10 })
    expect(api.tasks.list).toHaveBeenCalledWith({ projectId: 'proj-1', limit: 10 })
  })

  it('forwards bulk operations and upcoming queries', async () => {
    api.tasks.bulkComplete = vi.fn().mockResolvedValue({ success: true, count: 2 })
    api.tasks.bulkDelete = vi.fn().mockResolvedValue({ success: true, count: 1 })
    api.tasks.bulkMove = vi.fn().mockResolvedValue({ success: true, count: 3 })
    api.tasks.bulkArchive = vi.fn().mockResolvedValue({ success: true, count: 4 })
    api.tasks.getUpcoming = vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false })

    await tasksService.bulkComplete(['t1', 't2'])
    expect(api.tasks.bulkComplete).toHaveBeenCalledWith(['t1', 't2'])

    await tasksService.bulkDelete(['t3'])
    expect(api.tasks.bulkDelete).toHaveBeenCalledWith(['t3'])

    await tasksService.bulkMove(['t4', 't5'], 'proj-2')
    expect(api.tasks.bulkMove).toHaveBeenCalledWith(['t4', 't5'], 'proj-2')

    await tasksService.bulkArchive(['t6'])
    expect(api.tasks.bulkArchive).toHaveBeenCalledWith(['t6'])

    await tasksService.getUpcoming(7)
    expect(api.tasks.getUpcoming).toHaveBeenCalledWith(7)
  })

  it('logs reorder failures in fire-and-forget flows', async () => {
    const error = new Error('reorder failed')
    api.tasks.reorder = vi.fn().mockRejectedValue(error)

    queueTaskReorder(['t1', 't2'], [0, 1])
    await Promise.resolve()
    await Promise.resolve()

    expect(api.tasks.reorder).toHaveBeenCalledWith(['t1', 't2'], [0, 1])
    expect(tasksServiceLogger.error).toHaveBeenCalledWith('Failed to reorder tasks:', error)
  })

  it('registers task and project event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onTaskCreated = vi.fn(() => unsubscribe)
    api.onTaskUpdated = vi.fn(() => unsubscribe)
    api.onTaskDeleted = vi.fn(() => unsubscribe)
    api.onTaskCompleted = vi.fn(() => unsubscribe)
    api.onTaskMoved = vi.fn(() => unsubscribe)
    api.onProjectCreated = vi.fn(() => unsubscribe)
    api.onProjectUpdated = vi.fn(() => unsubscribe)
    api.onProjectDeleted = vi.fn(() => unsubscribe)

    expect(onTaskCreated(vi.fn())).toBe(unsubscribe)
    expect(onTaskUpdated(vi.fn())).toBe(unsubscribe)
    expect(onTaskDeleted(vi.fn())).toBe(unsubscribe)
    expect(onTaskCompleted(vi.fn())).toBe(unsubscribe)
    expect(onTaskMoved(vi.fn())).toBe(unsubscribe)
    expect(onProjectCreated(vi.fn())).toBe(unsubscribe)
    expect(onProjectUpdated(vi.fn())).toBe(unsubscribe)
    expect(onProjectDeleted(vi.fn())).toBe(unsubscribe)
  })
})
