import { describe, expect, it, vi } from 'vitest'
import { createTasksCommands } from './commands.ts'
import {
  createCommandRepository,
  createPublisher,
  createStatus,
  createTask
} from './test-fixtures.ts'

function buildDeps(overrides: Parameters<typeof createCommandRepository>[0] = {}) {
  let seq = 0
  const generateId = vi.fn(() => `gen-${++seq}`)
  const repository = createCommandRepository(overrides)
  const publisher = createPublisher()
  return { repository, publisher, generateId }
}

describe('createTasksCommands — moveTask', () => {
  it('moves task with all targets, publishes changedFields, returns success', async () => {
    const moved = createTask({ projectId: 'p2', statusId: 's2', parentId: 'parent', position: 3 })
    const deps = buildDeps({ moveTask: vi.fn(() => moved) })
    const commands = createTasksCommands(deps)

    const result = await commands.moveTask({
      taskId: 'task-1',
      targetProjectId: 'p2',
      targetStatusId: 's2',
      targetParentId: 'parent',
      position: 3
    })

    expect(result.success).toBe(true)
    expect(result.task).toBe(moved)
    expect(deps.repository.moveTask).toHaveBeenCalledWith('task-1', {
      projectId: 'p2',
      statusId: 's2',
      parentId: 'parent',
      position: 3
    })
    expect(deps.publisher.taskMoved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        changedFields: expect.arrayContaining(['position', 'projectId', 'statusId', 'parentId'])
      })
    )
  })

  it('resolves equivalent status when crossing projects without targetStatusId', async () => {
    const existing = createTask({ projectId: 'p1', statusId: 's-p1' })
    const currentStatus = createStatus({ id: 's-p1', projectId: 'p1' })
    const equivalent = createStatus({ id: 's-p2', projectId: 'p2' })
    const moved = createTask({ projectId: 'p2', statusId: 's-p2', position: 0 })
    const deps = buildDeps({
      getTask: vi.fn(() => existing),
      getStatus: vi.fn(() => currentStatus),
      getEquivalentStatus: vi.fn(() => equivalent),
      moveTask: vi.fn(() => moved)
    })
    const commands = createTasksCommands(deps)

    await commands.moveTask({
      taskId: 'task-1',
      targetProjectId: 'p2',
      position: 0
    })

    expect(deps.repository.getEquivalentStatus).toHaveBeenCalledWith('p2', currentStatus)
    expect(deps.repository.moveTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ statusId: 's-p2' })
    )
  })

  it('does not resolve equivalent status when task is already in target project', async () => {
    const existing = createTask({ projectId: 'p2' })
    const deps = buildDeps({
      getTask: vi.fn(() => existing),
      moveTask: vi.fn(() => createTask({ projectId: 'p2' }))
    })
    const commands = createTasksCommands(deps)

    await commands.moveTask({ taskId: 'task-1', targetProjectId: 'p2', position: 0 })

    expect(deps.repository.getEquivalentStatus).not.toHaveBeenCalled()
  })

  it('omits projectId/statusId from changedFields when not supplied', async () => {
    const moved = createTask()
    const deps = buildDeps({ moveTask: vi.fn(() => moved) })
    const commands = createTasksCommands(deps)

    await commands.moveTask({ taskId: 'task-1', position: 5 })

    const call = vi.mocked(deps.publisher.taskMoved).mock.calls[0][0]
    expect(call.changedFields).toEqual(['position'])
  })

  it('returns error when repository reports no task', async () => {
    const deps = buildDeps({ moveTask: vi.fn(() => undefined) })
    const commands = createTasksCommands(deps)

    const result = await commands.moveTask({ taskId: 'missing', position: 0 })

    expect(result).toEqual({ success: false, task: null, error: 'Task not found' })
    expect(deps.publisher.taskMoved).not.toHaveBeenCalled()
  })

  it('does not mutate the input object', async () => {
    const deps = buildDeps({ moveTask: vi.fn(() => createTask()) })
    const commands = createTasksCommands(deps)
    const input = { taskId: 'task-1', targetProjectId: 'p2', position: 0 }
    const snapshot = JSON.stringify(input)

    await commands.moveTask(input)

    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
