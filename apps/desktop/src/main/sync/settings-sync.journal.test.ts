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

describe('settings sync — journal weekday templates', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
  })

  afterEach(() => {
    resetSettingsSyncManager()
    cleanupTestDatabase(testDb)
  })

  const manager = (deviceId: string) =>
    initSettingsSyncManager({
      db: asSyncDb(testDb.db),
      queue: new SyncQueueManager(asClientDb(testDb.db)),
      getDeviceId: () => deviceId
    })

  it('keeps both edits when two devices change different days concurrently', () => {
    const mgr = manager('B')
    // This device set Tuesday; the other device set Monday, neither having seen
    // the other. With a single clock for the whole map one of these would be
    // dropped with no conflict to observe.
    mgr.updateField('journal.weekdayTemplates.2', 'weekly-review', 'B')

    mgr.mergeRemote({
      settings: { journal: { weekdayTemplates: { '1': 'daily-standup' } } },
      fieldClocks: { 'journal.weekdayTemplates.1': { A: 1 } }
    })

    expect(mgr.getSettings().journal?.weekdayTemplates).toEqual({
      '1': 'daily-standup',
      '2': 'weekly-review'
    })
  })

  it('lets a remote change to the same day win on a newer clock', () => {
    const mgr = manager('B')
    mgr.updateField('journal.weekdayTemplates.1', 'morning-pages', 'B')

    mgr.mergeRemote({
      settings: { journal: { weekdayTemplates: { '1': 'daily-standup' } } },
      fieldClocks: { 'journal.weekdayTemplates.1': { B: 1, A: 4 } }
    })

    expect(mgr.getSettings().journal?.weekdayTemplates).toEqual({ '1': 'daily-standup' })
  })

  it('propagates a cleared day as an explicit null', () => {
    const mgr = manager('B')
    mgr.updateField('journal.weekdayTemplates.1', 'morning-pages', 'B')

    mgr.mergeRemote({
      settings: { journal: { weekdayTemplates: { '1': null } } },
      fieldClocks: { 'journal.weekdayTemplates.1': { B: 1, A: 9 } }
    })

    expect(mgr.getSettings().journal?.weekdayTemplates).toEqual({ '1': null })
  })

  it('does not clobber a local day when an older client omits the group', () => {
    const mgr = manager('B')
    mgr.updateField('journal.weekdayTemplates.1', 'daily-standup', 'B')

    // An app version that predates the journal group strips it from the payload
    // while still echoing back the field clock it saw.
    mgr.mergeRemote({
      settings: {},
      fieldClocks: { 'journal.weekdayTemplates.1': { B: 1 } }
    })

    expect(mgr.getSettings().journal?.weekdayTemplates).toEqual({ '1': 'daily-standup' })
  })

  it('carries the default template so the fallback matches across devices', () => {
    const mgr = manager('B')
    mgr.mergeRemote({
      settings: { journal: { defaultTemplate: 'morning-pages' } },
      fieldClocks: { 'journal.defaultTemplate': { A: 1 } }
    })

    expect(mgr.getSettings().journal?.defaultTemplate).toBe('morning-pages')
  })
})
