import { describe, it, expect, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { TasksDomainPublisher } from '@memry/domain-tasks'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
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

describe('task duration', () => {
  let t: TestDatabaseResult
  afterEach(() => {
    t?.close()
  })

  function setup() {
    t = createTestDataDb()
    t.db.insert(projects).values({ id: 'p1', name: 'P1', color: '#000', position: 0 }).run()
    return createDesktopTasksDomain(t.db as never, noopPublisher(), generateId)
  }

  function stored(id: string) {
    return t.db
      .select({ dueTime: tasks.dueTime, durationMinutes: tasks.durationMinutes })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get()
  }

  it('persists a duration set with a due time', async () => {
    const d = setup()
    const created = await d.createTask({ projectId: 'p1', title: 'Block', dueDate: '2026-03-02' })
    const id = created.task!.id

    await d.updateTask({ id, dueTime: '09:00', durationMinutes: 90 })

    expect(stored(id)).toEqual({ dueTime: '09:00', durationMinutes: 90 })
  })

  it('clears the duration when the due time is cleared', async () => {
    const d = setup()
    const created = await d.createTask({
      projectId: 'p1',
      title: 'Block',
      dueDate: '2026-03-02',
      dueTime: '09:00',
      durationMinutes: 30
    })
    const id = created.task!.id
    expect(stored(id)).toEqual({ dueTime: '09:00', durationMinutes: 30 })

    await d.updateTask({ id, dueTime: null })

    expect(stored(id)).toEqual({ dueTime: null, durationMinutes: null })
  })

  it('keeps the duration on an edit that leaves the due time alone', async () => {
    const d = setup()
    const created = await d.createTask({
      projectId: 'p1',
      title: 'Block',
      dueDate: '2026-03-02',
      dueTime: '09:00',
      durationMinutes: 30
    })
    const id = created.task!.id

    await d.updateTask({ id, title: 'Renamed' })

    expect(stored(id)).toEqual({ dueTime: '09:00', durationMinutes: 30 })
  })

  it('copies the duration onto a duplicate', async () => {
    const d = setup()
    const created = await d.createTask({
      projectId: 'p1',
      title: 'Block',
      dueDate: '2026-03-02',
      dueTime: '09:00',
      durationMinutes: 30
    })

    const copy = await d.duplicateTask(created.task!.id)

    expect(stored(copy.task!.id)).toEqual({ dueTime: '09:00', durationMinutes: 30 })
  })
})
