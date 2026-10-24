/**
 * #2854 — deleting a parent task used to remove only its own row, leaving
 * subtasks whose parent_id pointed at a task that no longer exists.
 *
 * Real data DB and the production wiring from `domain.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asClientDb, createTestDataDb, sql } from '@tests/utils/test-db'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import * as taskQueries from '@main/database/queries/tasks'
import type { DataDb } from '../database'
import { createDesktopTasksDomain } from './domain'

vi.mock('../settings/task-settings', () => ({
  getTaskSettings: () => ({ nestedSubtasks: true })
}))

const publisher = {
  taskCreated: vi.fn(),
  taskUpdated: vi.fn(),
  taskDeleted: vi.fn(),
  taskCompleted: vi.fn(),
  taskMoved: vi.fn(),
  taskArchived: vi.fn(),
  taskUnarchived: vi.fn(),
  projectCreated: vi.fn(),
  projectUpdated: vi.fn(),
  projectDeleted: vi.fn()
}

describe('#2854 deleting a parent task', () => {
  let dbResult: TestDatabaseResult
  let clientDb: DataDb

  const seed = (id: string, parentId: string | null) =>
    taskQueries.insertTask(clientDb, {
      id,
      projectId: 'project-1',
      statusId: 'status-todo',
      parentId,
      title: id,
      position: 0
    })

  const remainingIds = (): string[] =>
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- all() returns unknown[]; without the cast row is unknown (TS18046)
    (clientDb.all(sql`SELECT id FROM tasks ORDER BY id`) as Array<{ id: string }>).map(
      (row) => row.id
    )

  beforeEach(() => {
    vi.clearAllMocks()
    dbResult = createTestDataDb()
    clientDb = asClientDb(dbResult.db)
    dbResult.db.run(sql`
      INSERT INTO projects (id, name, color, position, is_inbox)
      VALUES ('project-1', 'Project 1', '#6366f1', 0, 0)
    `)
    dbResult.db.run(sql`
      INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
      VALUES ('status-todo', 'project-1', 'To Do', '#6b7280', 0, 1, 0)
    `)
    seed('root', null)
    seed('child', 'root')
    seed('grandchild', 'child')
    seed('lone', null)
  })

  afterEach(() => {
    dbResult.close()
  })

  it('removes the whole branch and tombstones every task in it', async () => {
    const domain = createDesktopTasksDomain(clientDb, publisher as never, () => 'id')

    const result = await domain.deleteTask('root')

    expect(result.success).toBe(true)
    expect(remainingIds()).toEqual(['lone'])
    expect(
      publisher.taskDeleted.mock.calls
        .map(([payload]) => payload.id)
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['child', 'grandchild', 'root'])
  })

  it('keeps subtasks that were moved out before the delete', async () => {
    const domain = createDesktopTasksDomain(clientDb, publisher as never, () => 'id')
    taskQueries.moveTask(clientDb, 'child', { parentId: null })

    await domain.deleteTask('root')

    expect(remainingIds()).toEqual(['child', 'grandchild', 'lone'])
  })
})
