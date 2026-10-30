import { describe, it, expect, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createDesktopTasksDomain } from './domain'
import { generateId } from '../lib/id'

function noopPublisher(): TasksDomainPublisher {
  return {
    taskCreated: vi.fn(),
    taskUpdated: vi.fn(),
    taskDeleted: vi.fn(),
    taskCompleted: vi.fn(),
    taskMoved: vi.fn(),
    projectCreated: vi.fn(),
    projectUpdated: vi.fn(),
    projectDeleted: vi.fn(),
    statusCreated: vi.fn(),
    statusUpdated: vi.fn(),
    statusDeleted: vi.fn()
  }
}

// A task is done in two stored places: `completedAt`, which the calendar, the
// timeline and the overdue counts read, and its status's `isDone`, which the
// Tasks views read. Every write path must leave the two agreeing, or a task
// ticked in one surface shows as open and overdue in another.
describe('task completion and status stay in agreement', () => {
  let t: TestDatabaseResult
  afterEach(() => t?.close())

  function setup() {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    t.db
      .insert(statuses)
      .values([
        { id: 's-todo', projectId: 'p1', name: 'To Do', position: 0, isDefault: true },
        { id: 's-doing', projectId: 'p1', name: 'In Progress', position: 1 },
        { id: 's-done', projectId: 'p1', name: 'Done', position: 2, isDone: true }
      ])
      .run()
    return createDesktopTasksDomain(t.db as never, noopPublisher(), generateId)
  }

  function stored(id: string) {
    return t.db
      .select({ statusId: tasks.statusId, completedAt: tasks.completedAt })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get()
  }

  async function newTask(d: ReturnType<typeof setup>, statusId = 's-todo') {
    const created = await d.createTask({ projectId: 'p1', title: 'T', statusId })
    return created.task!.id
  }

  it('completes a task whose status is set to a done status', async () => {
    const d = setup()
    const id = await newTask(d)

    await d.updateTask({ id, statusId: 's-done' })

    const row = stored(id)
    expect(row?.statusId).toBe('s-done')
    expect(row?.completedAt).not.toBeNull()
  })

  it('reopens a completed task whose status is set to an open status', async () => {
    const d = setup()
    const id = await newTask(d)
    await d.completeTask({ id })

    await d.updateTask({ id, statusId: 's-doing' })

    expect(stored(id)).toEqual({ statusId: 's-doing', completedAt: null })
  })

  it('keeps the completion time when a done task moves between done statuses', async () => {
    const d = setup()
    const id = await newTask(d)
    await d.completeTask({ id, completedAt: '2026-01-02T03:04:05.000Z' })

    await d.updateTask({ id, statusId: 's-done' })

    expect(stored(id)).toEqual({ statusId: 's-done', completedAt: '2026-01-02T03:04:05.000Z' })
  })

  it('moves a task to the project done status when it is completed', async () => {
    const d = setup()
    const id = await newTask(d, 's-doing')

    await d.completeTask({ id })

    const row = stored(id)
    expect(row?.statusId).toBe('s-done')
    expect(row?.completedAt).not.toBeNull()
  })

  it('moves a task to the default open status when it is reopened', async () => {
    const d = setup()
    const id = await newTask(d, 's-doing')
    await d.completeTask({ id })

    await d.uncompleteTask(id)

    expect(stored(id)).toEqual({ statusId: 's-todo', completedAt: null })
  })

  it('completes a task dropped into the done status', async () => {
    const d = setup()
    const id = await newTask(d)

    await d.moveTask({ taskId: id, targetStatusId: 's-done', position: 0 })

    const row = stored(id)
    expect(row?.statusId).toBe('s-done')
    expect(row?.completedAt).not.toBeNull()
  })

  it('completes every task of a bulk completion, status included', async () => {
    const d = setup()
    const a = await newTask(d)
    const b = await newTask(d, 's-doing')

    await d.bulkComplete([a, b])

    for (const id of [a, b]) {
      const row = stored(id)
      expect(row?.statusId).toBe('s-done')
      expect(row?.completedAt).not.toBeNull()
    }
  })

  it('leaves a task with no status completable', async () => {
    const d = setup()
    const created = await d.createTask({ projectId: 'p1', title: 'No status' })
    const id = created.task!.id

    await d.completeTask({ id })

    expect(stored(id)?.completedAt).not.toBeNull()
  })
})
