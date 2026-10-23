import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import { TaskSyncPayloadSchema, type TaskSyncPayload } from '@memry/contracts/sync-payloads'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  TEST_PROJECT,
  TEST_STATUSES,
  makeCtx,
  makeTaskPayload
} from '@tests/utils/fixtures/sync-item-handlers'
import { taskHandler } from './task-handler'

let testDb: TestDatabaseResult
let ctx: ApplyContext

beforeEach(() => {
  testDb = createTestDataDb()
  ctx = makeCtx(testDb)
  testDb.db.insert(projects).values(TEST_PROJECT).run()
  testDb.db
    .insert(statuses)
    .values([...TEST_STATUSES])
    .run()
})

afterEach(() => testDb.close())

function apply(data: Partial<TaskSyncPayload>, clock: VectorClock): string {
  const parsed = TaskSyncPayloadSchema.parse(makeTaskPayload(data))
  return taskHandler.applyUpsert(ctx, 'task-1', parsed, clock)
}

function storedDuration(): number | null | undefined {
  return testDb.db
    .select({ durationMinutes: tasks.durationMinutes })
    .from(tasks)
    .where(eq(tasks.id, 'task-1'))
    .get()?.durationMinutes
}

function pushed(): Record<string, unknown> {
  const db = testDb.db as unknown as DrizzleDb
  return JSON.parse(taskHandler.buildPushPayload(db, 'task-1', 'device-a', 'update')!) as Record<
    string,
    unknown
  >
}

describe('task durationMinutes over sync', () => {
  it('stores a pulled duration on insert and pushes it back', () => {
    expect(apply({ dueTime: '09:00', durationMinutes: 45 }, { 'device-b': 1 })).toBe('applied')

    expect(storedDuration()).toBe(45)
    expect(pushed()).toMatchObject({ dueTime: '09:00', durationMinutes: 45 })
  })

  it('takes a newer duration and a cleared one on update', () => {
    apply({ dueTime: '09:00', durationMinutes: 45 }, { 'device-b': 1 })

    expect(apply({ dueTime: '09:00', durationMinutes: 90 }, { 'device-b': 2 })).toBe('applied')
    expect(storedDuration()).toBe(90)

    expect(apply({ dueTime: null, durationMinutes: null }, { 'device-b': 3 })).toBe('applied')
    expect(storedDuration()).toBeNull()
    expect(pushed()).toMatchObject({ dueTime: null, durationMinutes: null })
  })
})
