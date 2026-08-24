import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { templates } from '@memry/db-schema/schema/templates'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  initTemplateSyncService,
  getTemplateSyncService,
  resetTemplateSyncService
} from '@memry/sync-client/template-sync'

describe('TemplateSyncService', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    testDb.db
      .insert(templates)
      .values({
        id: 'tpl-1',
        name: 'Standup',
        content: 'v1',
        tags: [],
        properties: [],
        createdAt: '2026-07-16T00:00:00.000Z',
        modifiedAt: '2026-07-16T00:00:00.000Z'
      })
      .run()
  })

  afterEach(() => {
    resetTemplateSyncService()
    testDb.close()
  })

  it('enqueues a create and bumps the row clock', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    const service = initTemplateSyncService({
      queue,
      db: testDb.db as never,
      getDeviceId: () => 'device-a'
    })

    service.enqueueCreate('tpl-1')

    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({ type: 'template', itemId: 'tpl-1', operation: 'create' })
    expect(
      testDb.db.select().from(templates).where(eq(templates.id, 'tpl-1')).get()?.clock
    ).toEqual({ 'device-a': 1 })
  })

  it('exposes the singleton and clears it on reset', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    initTemplateSyncService({ queue, db: testDb.db as never, getDeviceId: () => 'device-a' })
    expect(getTemplateSyncService()).not.toBeNull()

    resetTemplateSyncService()
    expect(getTemplateSyncService()).toBeNull()
  })
})
