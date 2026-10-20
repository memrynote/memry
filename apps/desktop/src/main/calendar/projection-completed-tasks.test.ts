import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { DataDb, IndexDb } from '../../main/database'
import { getCalendarRangeProjection } from './projection'

describe('completed tasks in the calendar projection', () => {
  let dbResult: TestDatabaseResult
  let indexDbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    indexDbResult = createTestIndexDb()
    projectId = seedTestData(db).projectId
    db.insert(tasks)
      .values([
        { id: 'open', projectId, title: 'open', dueDate: '2026-04-14', statusId: 'status-todo' },
        {
          id: 'done',
          projectId,
          title: 'done',
          dueDate: '2026-04-14',
          statusId: 'status-done',
          completedAt: '2026-04-13T10:00:00.000Z'
        }
      ])
      .run()
  })

  afterEach(() => {
    dbResult.close()
    indexDbResult.close()
  })

  function taskItems(includeCompletedTasks?: boolean) {
    return getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDbResult.db as unknown as IndexDb,
      {
        startAt: new Date(2026, 3, 14).toISOString(),
        endAt: new Date(2026, 3, 15).toISOString(),
        includeUnselectedSources: false,
        includeCompletedTasks
      },
      []
    ).items.filter((item) => item.sourceType === 'task')
  }

  it('lists open tasks only unless completed tasks are asked for', () => {
    expect(taskItems().map((item) => item.sourceId)).toEqual(['open'])
  })

  it('keeps a completed task, flagged with its project and status, when asked for', () => {
    const items = taskItems(true)
    expect(items.map((item) => item.sourceId).sort()).toEqual(['done', 'open'])
    expect(items.find((item) => item.sourceId === 'done')?.task).toEqual({
      projectId,
      statusId: 'status-done',
      isCompleted: true
    })
    expect(items.find((item) => item.sourceId === 'open')?.task?.isCompleted).toBe(false)
  })
})
