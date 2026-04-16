import { describe, expect, it, vi } from 'vitest'
import {
  createTasksCommands,
  createTasksDomain,
  createTasksQueries
} from './index.ts'
import {
  createCommandRepository,
  createPublisher,
  createTask
} from './test-fixtures.ts'

describe('domain-tasks barrel', () => {
  it('re-exports the factories', () => {
    expect(typeof createTasksCommands).toBe('function')
    expect(typeof createTasksQueries).toBe('function')
    expect(typeof createTasksDomain).toBe('function')
  })

  it('createTasksDomain composes queries and commands over a single repository', async () => {
    const task = createTask()
    const repository = createCommandRepository({
      getTask: vi.fn(() => task),
      createTask: vi.fn(() => task)
    })
    const publisher = createPublisher()

    const domain = createTasksDomain({
      repository,
      publisher,
      generateId: () => 'gen-1'
    })

    expect(domain.getTask('task-1')).toBe(task)
    const createResult = await domain.createTask({ projectId: 'p1', title: 'x' })
    expect(createResult.success).toBe(true)
  })
})
