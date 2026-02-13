import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { SettingsSyncPayload } from '@shared/contracts/settings-sync'
import { SyncQueueManager } from './queue'
import { SettingsSyncManager, resetSettingsSyncManager } from './settings-sync'

describe('SettingsSyncManager', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let manager: SettingsSyncManager

  beforeEach(() => {
    testDb = createTestDataDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue = new SyncQueueManager(testDb.db as any)
    manager = new SettingsSyncManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: testDb.db as any,
      queue,
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetSettingsSyncManager()
    testDb.close()
  })

  describe('#given empty settings #when updateField called', () => {
    it('#then stores the value and increments field clock', () => {
      // #when
      manager.updateField('general.theme', 'dark', 'device-A')

      // #then
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'dark' } })
      expect(payload.fieldClocks['general.theme']).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given existing field #when updateField called again', () => {
    it('#then updates value and increments clock tick', () => {
      manager.updateField('general.theme', 'dark', 'device-A')
      manager.updateField('general.theme', 'light', 'device-A')

      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'light' } })
      expect(payload.fieldClocks['general.theme']).toEqual({ 'device-A': 2 })
    })
  })

  describe('#given updateField called #when queue checked', () => {
    it('#then enqueues a settings sync item', () => {
      manager.updateField('tasks.defaultPriority', 2, 'device-A')

      const [item] = queue.dequeue(1)
      expect(item.type).toBe('settings')
      expect(item.itemId).toBe('synced_settings')
      expect(item.operation).toBe('update')

      const payload = JSON.parse(item.payload)
      expect(payload.settings.tasks.defaultPriority).toBe(2)
    })
  })

  describe('#given remote is ahead #when mergeRemote called', () => {
    it('#then takes the remote values', () => {
      // #given — local has older clock
      manager.updateField('general.theme', 'dark', 'device-A')

      // #when — remote clock is ahead
      const remote: SettingsSyncPayload = {
        settings: { general: { theme: 'light' } },
        fieldClocks: { 'general.theme': { 'device-A': 5 } }
      }
      manager.mergeRemote(remote, 'device-B')

      // #then
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'light' } })
      expect(payload.fieldClocks['general.theme']).toEqual({ 'device-A': 5 })
    })
  })

  describe('#given local is ahead #when mergeRemote called', () => {
    it('#then keeps the local values', () => {
      // #given — local has higher clock
      manager.updateField('general.theme', 'dark', 'device-A')
      manager.updateField('general.theme', 'darker', 'device-A')

      // #when — remote is behind
      const remote: SettingsSyncPayload = {
        settings: { general: { theme: 'light' } },
        fieldClocks: { 'general.theme': { 'device-A': 1 } }
      }
      manager.mergeRemote(remote, 'device-B')

      // #then
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'darker' } })
    })
  })

  describe('#given concurrent field edits on different fields #when mergeRemote called', () => {
    it('#then merges both fields correctly', () => {
      // #given — local edited theme, remote edited language
      manager.updateField('general.theme', 'dark', 'device-A')

      const remote: SettingsSyncPayload = {
        settings: { general: { language: 'tr' } },
        fieldClocks: { 'general.language': { 'device-B': 1 } }
      }

      // #when
      manager.mergeRemote(remote, 'device-B')

      // #then — both fields present
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'dark', language: 'tr' } })
    })
  })

  describe('#given concurrent edits on same field #when mergeRemote called', () => {
    it('#then uses last-write-wins (higher max tick wins)', () => {
      // #given — local: device-A:1, remote: device-B:2 (higher tick)
      manager.updateField('general.theme', 'dark', 'device-A')

      const remote: SettingsSyncPayload = {
        settings: { general: { theme: 'light' } },
        fieldClocks: { 'general.theme': { 'device-B': 2 } }
      }

      // #when
      manager.mergeRemote(remote, 'device-B')

      // #then remote wins (tick 2 > tick 1), clocks merged
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'light' } })
      expect(payload.fieldClocks['general.theme']).toEqual({ 'device-A': 1, 'device-B': 2 })
    })
  })

  describe('#given concurrent edits where local tick is higher #when mergeRemote called', () => {
    it('#then keeps local value but merges clocks', () => {
      // #given — local: device-A:3, remote: device-B:1 (lower tick)
      manager.updateField('general.theme', 'dark', 'device-A')
      manager.updateField('general.theme', 'darker', 'device-A')
      manager.updateField('general.theme', 'darkest', 'device-A')

      const remote: SettingsSyncPayload = {
        settings: { general: { theme: 'light' } },
        fieldClocks: { 'general.theme': { 'device-B': 1 } }
      }

      // #when
      manager.mergeRemote(remote, 'device-B')

      // #then local wins (tick 3 > tick 1), clocks merged
      const payload = manager.getPayload()
      expect(payload.settings).toEqual({ general: { theme: 'darkest' } })
      expect(payload.fieldClocks['general.theme']).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given no settings stored #when getSettings called', () => {
    it('#then returns empty object', () => {
      expect(manager.getSettings()).toEqual({})
    })
  })

  describe('#given settings stored #when getPayload called', () => {
    it('#then returns settings with field clocks', () => {
      manager.updateField('sync.autoSync', true, 'device-A')

      const payload = manager.getPayload()
      expect(payload).toEqual({
        settings: { sync: { autoSync: true } },
        fieldClocks: { 'sync.autoSync': { 'device-A': 1 } }
      })
    })
  })
})
