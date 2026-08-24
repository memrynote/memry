import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDatabase,
  cleanupTestDatabase,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { initSettingsSyncManager, resetSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { SyncQueueManager } from '@memry/sync-client/queue'

describe('settings sync — inbox group', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    resetSettingsSyncManager()
    cleanupTestDatabase(testDb)
  })

  it('merges a remote inbox time change (new client → new client)', () => {
    const mgr = initSettingsSyncManager({
      db: asSyncDb(testDb.db),
      queue: new SyncQueueManager(asClientDb(testDb.db)),
      getDeviceId: () => 'B'
    })
    mgr.mergeRemote({
      settings: { inbox: { reviewReminderTime: '07:00', reviewReminderEnabled: true } },
      fieldClocks: {
        'inbox.reviewReminderTime': { A: 1 },
        'inbox.reviewReminderEnabled': { A: 1 }
      }
    })
    expect(mgr.getSettings().inbox?.reviewReminderTime).toBe('07:00')
  })

  it('does NOT clobber a local inbox value when an old client omits it (#16)', () => {
    const mgr = initSettingsSyncManager({
      db: asSyncDb(testDb.db),
      queue: new SyncQueueManager(asClientDb(testDb.db)),
      getDeviceId: () => 'B'
    })
    // Local device set its own time.
    mgr.updateField('inbox.reviewReminderTime', '06:30', 'B')
    // Old client re-emits: has the clock, but its schema stripped the value.
    mgr.mergeRemote({
      settings: {},
      fieldClocks: { 'inbox.reviewReminderTime': { B: 1 } }
    })
    expect(mgr.getSettings().inbox?.reviewReminderTime).toBe('06:30')
  })
})
