import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  seedTestData,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { DataDb } from '../../main/database'
import { getCalendarRangeProjection } from './projection'

describe('task projection with a duration', () => {
  let dbResult: TestDatabaseResult
  let indexDbResult: TestDatabaseResult
  let db: TestDb
  let projectId: string

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
    indexDbResult = createTestIndexDb()
    projectId = seedTestData(db).projectId
  })

  afterEach(() => {
    dbResult.close()
    indexDbResult.close()
  })

  function project(id: string) {
    const result = getCalendarRangeProjection(
      db as unknown as DataDb,
      indexDbResult.db,
      {
        startAt: new Date(2026, 3, 14).toISOString(),
        endAt: new Date(2026, 3, 15).toISOString(),
        includeUnselectedSources: false
      },
      []
    )
    return result.items.find((item) => item.sourceId === id)
  }

  function insertTask(id: string, dueTime: string | null, durationMinutes: number | null) {
    db.insert(tasks)
      .values({ id, projectId, title: id, dueDate: '2026-04-14', dueTime, durationMinutes })
      .run()
  }

  it('ends a timed task with a duration at start plus duration, resizable', () => {
    insertTask('block', '15:30', 45)

    const item = project('block')

    expect(item?.startAt).toBe(new Date(2026, 3, 14, 15, 30).toISOString())
    expect(item?.endAt).toBe(new Date(2026, 3, 14, 16, 15).toISOString())
    expect(item?.editability.canResize).toBe(true)
  })

  it('leaves a timed task without a duration open-ended and not resizable', () => {
    insertTask('point', '15:30', null)

    const item = project('point')

    expect(item?.endAt).toBeNull()
    expect(item?.editability.canResize).toBe(false)
  })

  it('ignores a stray duration on an all-day task', () => {
    insertTask('all-day', null, 45)

    const item = project('all-day')

    expect(item?.isAllDay).toBe(true)
    expect(item?.endAt).toBe(new Date(2026, 3, 15).toISOString())
    expect(item?.editability.canResize).toBe(false)
  })
})
