import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { setSetting } from '../database/queries/settings'
import { seedFeaturesSyncedSettings } from './features-settings-sync'

describe('seedFeaturesSyncedSettings', () => {
  let db: TestDataDb
  let sync: SettingsSyncManager

  beforeEach(() => {
    db = createTestDataDb()
    sync = new SettingsSyncManager({
      db: db as unknown as DrizzleDb,
      queue: { enqueue: vi.fn() } as unknown as SyncQueueManager,
      getDeviceId: () => 'desktop-a'
    })
  })

  it('pushes a stored non-default flag so an existing install reaches its other devices', () => {
    setSetting(db, 'features', JSON.stringify({ journal: false, graph: true, home: true }))

    expect(seedFeaturesSyncedSettings(db, sync)).toBe(1)

    expect(sync.getSettings().features).toEqual({ journal: false })
    expect(Object.keys(sync.getPayload().fieldClocks)).toEqual(['features.journal'])
  })

  it('leaves a flag another device already synced to the merge', () => {
    sync.mergeRemote({
      settings: { features: { journal: true } },
      fieldClocks: { 'features.journal': { 'device-b': 1 } }
    })
    setSetting(db, 'features', JSON.stringify({ journal: false, tasks: false }))

    expect(seedFeaturesSyncedSettings(db, sync)).toBe(1)

    expect(sync.getSettings().features).toEqual({ journal: true, tasks: false })
  })

  it('pushes nothing for a missing or unreadable row', () => {
    expect(seedFeaturesSyncedSettings(db, sync)).toBe(0)

    setSetting(db, 'features', '{not json')
    expect(seedFeaturesSyncedSettings(db, sync)).toBe(0)
    expect(sync.getSettings().features).toBeUndefined()
  })
})
