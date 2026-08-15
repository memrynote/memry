import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { createTestDataDb, asSyncDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncQueueManager } from './queue'
import {
  initHomePageSyncService,
  getHomePageSyncService,
  resetHomePageSyncService
} from './home-page-sync'

describe('HomePageSyncService', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    testDb.db
      .insert(homePages)
      .values({
        id: 'board-1',
        name: 'Work',
        position: 0,
        widgets: '[]',
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z'
      })
      .run()
  })

  afterEach(() => {
    resetHomePageSyncService()
    testDb.close()
  })

  it('enqueues a create and bumps the row clock', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    const service = initHomePageSyncService({
      queue,
      db: testDb.db as never,
      getDeviceId: () => 'device-a'
    })

    service.enqueueCreate('board-1')

    const [queued] = queue.dequeue(1)
    expect(queued).toMatchObject({ type: 'home_page', itemId: 'board-1', operation: 'create' })
    expect(
      testDb.db.select().from(homePages).where(eq(homePages.id, 'board-1')).get()?.clock
    ).toEqual({ 'device-a': 1 })
  })

  it('exposes the singleton and clears it on reset', () => {
    const queue = new SyncQueueManager(asSyncDb(testDb.db))
    initHomePageSyncService({ queue, db: testDb.db as never, getDeviceId: () => 'device-a' })
    expect(getHomePageSyncService()).not.toBeNull()

    resetHomePageSyncService()
    expect(getHomePageSyncService()).toBeNull()
  })
})
