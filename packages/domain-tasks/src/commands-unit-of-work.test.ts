import { describe, expect, it, vi } from 'vitest'
import {
  createTasksCommands,
  type TasksDomainEvent,
  type TasksUnitOfWork,
  type TasksWrite
} from './commands.ts'
import {
  createCommandRepository,
  createListItem,
  createProjectWithStatuses,
  createPublisher,
  createTask
} from './test-fixtures.ts'

/**
 * Records every `run` call and the moment it returned, so a test can assert
 * that one command's writes and events reached the host in one unit, and that
 * the publisher only ran after that unit committed (#2301).
 */
function createRecordingUnitOfWork() {
  const runs: Array<readonly TasksDomainEvent[]> = []
  const order: string[] = []
  const unitOfWork: TasksUnitOfWork = {
    run<W extends TasksWrite<unknown>>(write: () => W): W {
      order.push('begin')
      const out = write()
      runs.push(out.events)
      order.push('commit')
      return out
    }
  }
  return { unitOfWork, runs, order }
}

function buildDeps(overrides: Parameters<typeof createCommandRepository>[0] = {}) {
  let seq = 0
  const recording = createRecordingUnitOfWork()
  const publisher = createPublisher({
    projectDeleted: vi.fn(async () => {
      recording.order.push('publish:projectDeleted')
    }),
    taskDeleted: vi.fn(async ({ id }) => {
      recording.order.push(`publish:taskDeleted:${id}`)
    })
  })
  return {
    recording,
    deps: {
      repository: createCommandRepository(overrides),
      publisher,
      generateId: vi.fn(() => `gen-${++seq}`),
      unitOfWork: recording.unitOfWork
    }
  }
}

describe('createTasksCommands with a unit of work (#2301)', () => {
  // #2301: the cascade is one unit, so the host can commit the project delete
  // and every cascaded task's tombstone in the same transaction.
  it('hands deleteProject and every cascaded task delete to one run, then publishes', async () => {
    const project = createProjectWithStatuses({ id: 'proj-1' })
    const cascaded = [
      createListItem({ id: 'task-1', projectId: 'proj-1' }),
      createListItem({ id: 'task-2', projectId: 'proj-1' })
    ]
    const { deps, recording } = buildDeps({
      getProject: vi.fn(() => project),
      listTasks: vi.fn(() => cascaded)
    })

    await createTasksCommands(deps).deleteProject('proj-1')

    expect(recording.runs).toEqual([
      [
        { kind: 'projectDeleted', payload: { id: 'proj-1', snapshot: project } },
        { kind: 'taskDeleted', payload: { id: 'task-1', snapshot: cascaded[0] } },
        { kind: 'taskDeleted', payload: { id: 'task-2', snapshot: cascaded[1] } }
      ]
    ])
    expect(recording.order).toEqual([
      'begin',
      'commit',
      'publish:projectDeleted',
      'publish:taskDeleted:task-1',
      'publish:taskDeleted:task-2'
    ])
  })

  // #2301
  it('hands bulkDelete to one run with a snapshot per deleted task', async () => {
    const snapshots = new Map([
      ['task-1', createTask({ id: 'task-1' })],
      ['task-2', createTask({ id: 'task-2' })]
    ])
    const { deps, recording } = buildDeps({
      getTask: vi.fn((id: string) => snapshots.get(id)),
      bulkDeleteTasks: vi.fn(() => 2)
    })

    const result = await createTasksCommands(deps).bulkDelete(['task-1', 'task-2'])

    expect(result).toEqual({ success: true, count: 2 })
    expect(recording.runs).toEqual([
      [
        { kind: 'taskDeleted', payload: { id: 'task-1', snapshot: snapshots.get('task-1') } },
        { kind: 'taskDeleted', payload: { id: 'task-2', snapshot: snapshots.get('task-2') } }
      ]
    ])
    expect(recording.order.slice(0, 2)).toEqual(['begin', 'commit'])
  })

  // #2301: a write that throws rolls back in the host, so nothing may be
  // published for it.
  it('publishes nothing when the write throws', async () => {
    const { deps } = buildDeps({
      deleteProject: vi.fn(() => {
        throw new Error('disk full')
      })
    })

    await expect(createTasksCommands(deps).deleteProject('proj-1')).rejects.toThrow('disk full')

    expect(deps.publisher.projectDeleted).not.toHaveBeenCalled()
    expect(deps.publisher.taskDeleted).not.toHaveBeenCalled()
  })

  // #2301
  it('reports a task update with the changed fields the host maps to sync', async () => {
    const before = createTask({ id: 'task-1', title: 'Old' })
    const after = createTask({ id: 'task-1', title: 'New' })
    const { deps, recording } = buildDeps({
      getTask: vi.fn(() => before),
      updateTask: vi.fn(() => after)
    })

    await createTasksCommands(deps).updateTask({ id: 'task-1', title: 'New' })

    expect(recording.runs).toHaveLength(1)
    expect(recording.runs[0]).toMatchObject([
      { kind: 'taskUpdated', payload: { id: 'task-1', changedFields: ['title'] } }
    ])
    expect(deps.publisher.taskUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', changedFields: ['title'] })
    )
  })

  // #2301 review A-7: listTasks strips the sync clock, so the cascade
  // snapshots come from getTask, which keeps it for the tombstone.
  it('snapshots each cascaded task with getTask so the tombstone keeps its clock', async () => {
    const listed = [createListItem({ id: 'task-1', projectId: 'proj-1' })]
    const full = { ...createTask({ id: 'task-1', projectId: 'proj-1' }), clock: { 'device-B': 3 } }
    const { deps, recording } = buildDeps({
      listTasks: vi.fn(() => listed),
      getTask: vi.fn(() => full)
    })

    await createTasksCommands(deps).deleteProject('proj-1')

    expect(recording.runs[0]?.[1]).toEqual({
      kind: 'taskDeleted',
      payload: { id: 'task-1', snapshot: full }
    })
  })

  // #2301 review B-8: the write has committed by the time the publisher
  // runs, so one failing side effect must not skip the rest or reject.
  it('publishes every event and resolves when one publisher call throws', async () => {
    const cascaded = [
      createListItem({ id: 'task-1', projectId: 'proj-1' }),
      createListItem({ id: 'task-2', projectId: 'proj-1' })
    ]
    const onPublisherError = vi.fn()
    const { deps } = buildDeps({ listTasks: vi.fn(() => cascaded) })
    const failure = new Error('file cleanup failed')
    deps.publisher.projectDeleted = vi.fn(async () => {
      throw failure
    })

    await expect(
      createTasksCommands({ ...deps, onPublisherError }).deleteProject('proj-1')
    ).resolves.toEqual({ success: true })

    expect(deps.publisher.taskDeleted).toHaveBeenCalledTimes(2)
    expect(onPublisherError).toHaveBeenCalledWith('projectDeleted', failure)
  })
})
