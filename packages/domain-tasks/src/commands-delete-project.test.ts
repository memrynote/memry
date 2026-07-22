import { describe, expect, it, vi } from 'vitest'
import { createTasksCommands } from './commands.ts'
import {
  createCommandRepository,
  createListItem,
  createProjectWithStatuses,
  createPublisher
} from './test-fixtures.ts'

function buildDeps(overrides: Parameters<typeof createCommandRepository>[0] = {}) {
  let seq = 0
  const generateId = vi.fn(() => `gen-${++seq}`)
  const repository = createCommandRepository(overrides)
  const publisher = createPublisher()
  return { repository, publisher, generateId }
}

// #837: deleting a project cascades its tasks away locally via SQLite
// ON DELETE cascade, but a cascade is invisible to sync. Without an explicit
// tombstone per task the server keeps them alive forever, and every device then
// re-pulls a task whose project_id no longer resolves — FOREIGN KEY constraint
// failed, item skipped, manifest still sees it server-only, re-pull, forever.
describe('createTasksCommands — deleteProject', () => {
  it('tombstones every cascade-deleted task so the server does not keep orphans', async () => {
    const cascaded = [
      createListItem({ id: 'task-1', projectId: 'proj-1' }),
      createListItem({ id: 'task-2', projectId: 'proj-1' })
    ]
    const deps = buildDeps({
      getProject: vi.fn(() => createProjectWithStatuses({ id: 'proj-1' })),
      listTasks: vi.fn(() => cascaded)
    })
    const commands = createTasksCommands(deps)

    const result = await commands.deleteProject('proj-1')

    expect(result.success).toBe(true)
    expect(deps.publisher.projectDeleted).toHaveBeenCalledTimes(1)
    expect(deps.publisher.taskDeleted).toHaveBeenCalledTimes(2)
    expect(deps.publisher.taskDeleted).toHaveBeenCalledWith({
      id: 'task-1',
      snapshot: cascaded[0]
    })
    expect(deps.publisher.taskDeleted).toHaveBeenCalledWith({
      id: 'task-2',
      snapshot: cascaded[1]
    })
  })

  // Completed and archived tasks are cascaded by SQLite just the same, so they
  // must be listed too — otherwise they are exactly the rows left stranded.
  it('collects completed and archived tasks before the cascade runs', async () => {
    const listTasks = vi.fn(() => [])
    const deps = buildDeps({
      getProject: vi.fn(() => createProjectWithStatuses({ id: 'proj-1' })),
      listTasks
    })
    const commands = createTasksCommands(deps)

    await commands.deleteProject('proj-1')

    expect(listTasks).toHaveBeenCalledWith({
      projectId: 'proj-1',
      includeCompleted: true,
      includeArchived: true
    })
    expect(listTasks.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.repository.deleteProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    )
  })

  it('publishes nothing extra when the project has no tasks', async () => {
    const deps = buildDeps({
      getProject: vi.fn(() => createProjectWithStatuses({ id: 'proj-1' })),
      listTasks: vi.fn(() => [])
    })
    const commands = createTasksCommands(deps)

    await commands.deleteProject('proj-1')

    expect(deps.publisher.taskDeleted).not.toHaveBeenCalled()
  })
})
