import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskHandler } from './task-handler'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import type { ApplyContext } from '@memry/sync-client/item-handlers/types'
import {
  TEST_PROJECT,
  TEST_STATUSES,
  makeCtx,
  makeTaskPayload
} from '@tests/utils/fixtures/sync-item-handlers'

// #837: a pulled task whose FK parent is gone used to raise SQLite's anonymous
// `FOREIGN KEY constraint failed`, which named neither the constraint nor the
// missing id — so the pull coordinator could only defer, then drop the item.
describe('taskHandler missing FK parents (#837)', () => {
  let testDb: TestDatabaseResult
  let ctx: ApplyContext

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = makeCtx(testDb)
    testDb.db.insert(projects).values(TEST_PROJECT).run()
    testDb.db.insert(statuses).values(TEST_STATUSES).run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('names the missing project instead of throwing a bare FK error on insert', () => {
    try {
      taskHandler.applyUpsert(ctx, 'orphan-1', makeTaskPayload({ projectId: 'deleted-project' }), {
        'device-B': 1
      })
      expect.unreachable('expected a MissingSyncParentError')
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSyncParentError)
      const parent = err as MissingSyncParentError
      expect(parent.parentType).toBe('project')
      expect(parent.parentId).toBe('deleted-project')
      expect(parent.childId).toBe('orphan-1')
    }
  })

  it('names the missing project when updating an existing task', () => {
    taskHandler.applyUpsert(ctx, 'task-1', makeTaskPayload({}), { 'device-B': 1 })

    expect(() =>
      taskHandler.applyUpsert(ctx, 'task-1', makeTaskPayload({ projectId: 'deleted-project' }), {
        'device-B': 2
      })
    ).toThrow(MissingSyncParentError)
  })

  // status_id is FK-bound ON DELETE SET NULL, so null is the schema's own
  // answer for a dangling status — a project update that reconciles statuses
  // away must not make every later task pull unwritable.
  it('clears a dangling statusId instead of failing the apply', () => {
    const result = taskHandler.applyUpsert(
      ctx,
      'task-2',
      makeTaskPayload({ statusId: 'deleted-status' }),
      { 'device-B': 1 }
    )

    expect(result).toBe('applied')
    const row = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-2')).get()
    expect(row?.statusId).toBeNull()
  })

  it('keeps a statusId that still resolves', () => {
    taskHandler.applyUpsert(ctx, 'task-3', makeTaskPayload({ statusId: TEST_STATUSES[0].id }), {
      'device-B': 1
    })

    const row = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-3')).get()
    expect(row?.statusId).toBe(TEST_STATUSES[0].id)
  })
})
