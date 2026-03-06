import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SyncStateManager, type NodeEmit } from './sync-state-manager'
import { SYNC_STATE_KEYS, CLOCK_SKEW_THRESHOLD_SECONDS } from './sync-context'
import type { SyncContext } from './sync-context'
import type { SyncStatusValue } from '@memry/contracts/ipc-sync-ops'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { syncHistory } from '@memry/db-schema/schema/sync-history'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

function createCtx(testDb: TestDatabaseResult): SyncContext {
  return {
    deps: {
      db: testDb.db,
      emitToRenderer: vi.fn(),
      network: { online: true },
      queue: { getPendingCount: vi.fn().mockReturnValue(0) }
    },
    state: 'idle' as SyncStatusValue,
    syncing: false,
    abortController: null,
    offlineSince: null,
    lastError: undefined,
    lastErrorInfo: undefined
  } as unknown as SyncContext
}

describe('SyncStateManager', () => {
  let testDb: TestDatabaseResult
  let ctx: SyncContext
  let nodeEmit: NodeEmit
  let mgr: SyncStateManager

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = createCtx(testDb)
    nodeEmit = vi.fn().mockReturnValue(true)
    mgr = new SyncStateManager(ctx, nodeEmit)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('#given idle state #when setState called', () => {
    it('#then ctx.state reflects the new value', () => {
      // #when
      mgr.setState('syncing')

      // #then
      expect(ctx.state).toBe('syncing')
    })
  })

  describe('#given non-offline state #when setState to offline', () => {
    it('#then offlineSince is set to a timestamp', () => {
      // #given
      const before = Date.now()

      // #when
      mgr.setState('offline')

      // #then
      expect(ctx.offlineSince).toBeGreaterThanOrEqual(before)
      expect(ctx.offlineSince).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('#given offline state #when setState to syncing', () => {
    it('#then offlineSince is cleared', () => {
      // #given
      mgr.setState('offline')
      expect(ctx.offlineSince).not.toBeNull()

      // #when
      mgr.setState('syncing')

      // #then
      expect(ctx.offlineSince).toBeNull()
    })
  })

  describe('#given state transition #when setState called', () => {
    it('#then emits status event via nodeEmit', () => {
      // #when
      mgr.setState('syncing')

      // #then
      expect(nodeEmit).toHaveBeenCalledWith(
        'status-changed',
        expect.objectContaining({ status: 'syncing' })
      )
    })
  })

  describe('#given SYNC_PAUSED is true in DB #when isPaused called', () => {
    it('#then returns true', () => {
      // #given
      mgr.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'true')

      // #when / #then
      expect(mgr.isPaused()).toBe(true)
    })
  })

  describe('#given no SYNC_PAUSED key in DB #when isPaused called', () => {
    it('#then returns false', () => {
      // #when / #then
      expect(mgr.isPaused()).toBe(false)
    })
  })

  describe('#given a key-value pair #when getStateValue/setStateValue roundtrip', () => {
    it('#then persists and retrieves the value from DB', () => {
      // #when
      mgr.setStateValue('testKey', 'testValue')

      // #then
      expect(mgr.getStateValue('testKey')).toBe('testValue')
    })
  })

  describe('#given lastSyncAt stored in DB #when getLastSyncAt called', () => {
    it('#then returns the numeric timestamp', () => {
      // #given
      const ts = 1700000000000
      mgr.setStateValue(SYNC_STATE_KEYS.LAST_SYNC_AT, String(ts))

      // #when
      const result = mgr.getLastSyncAt()

      // #then
      expect(result).toBe(ts)
    })
  })

  describe('#given empty DB #when updateLastSyncAt called', () => {
    it('#then writes current time retrievable via getLastSyncAt', () => {
      // #given
      const before = Date.now()

      // #when
      mgr.updateLastSyncAt()

      // #then
      const stored = mgr.getLastSyncAt()
      expect(stored).toBeGreaterThanOrEqual(before)
      expect(stored).toBeLessThanOrEqual(Date.now())
    })
  })

  describe('#given a push operation #when recordHistory called', () => {
    it('#then emits sync_history row and nodeEmit is not required', () => {
      // #when
      mgr.recordHistory('push', 5, 120, 'batch done')

      // #then
      const rows = testDb.db.select().from(syncHistory).all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: 'push',
        itemCount: 5,
        direction: 'push',
        durationMs: 120,
        details: 'batch done'
      })
    })
  })

  describe('#given item synced #when emitItemSynced called', () => {
    it('#then emits item_synced event to renderer and nodeEmit', () => {
      // #when
      mgr.emitItemSynced('item-1', 'task', 'push', 'create')

      // #then
      expect(ctx.deps.emitToRenderer).toHaveBeenCalledWith(EVENT_CHANNELS.ITEM_SYNCED, {
        itemId: 'item-1',
        type: 'task',
        operation: 'push',
        itemOperation: 'create'
      })
      expect(nodeEmit).toHaveBeenCalledWith('item-synced', {
        itemId: 'item-1',
        type: 'task',
        operation: 'push',
        itemOperation: 'create'
      })
    })
  })

  describe('#given server time exceeding threshold #when checkClockSkew called', () => {
    it('#then pauses sync and emits clock skew warning', () => {
      // #given
      const localSeconds = Math.floor(Date.now() / 1000)
      const skewedServer = localSeconds + CLOCK_SKEW_THRESHOLD_SECONDS + 100

      // #when
      mgr.checkClockSkew(skewedServer)

      // #then
      expect(mgr.isPaused()).toBe(true)
      expect(ctx.deps.emitToRenderer).toHaveBeenCalledWith(
        EVENT_CHANNELS.CLOCK_SKEW_WARNING,
        expect.objectContaining({
          serverTime: skewedServer,
          skewSeconds: expect.any(Number)
        })
      )
    })
  })
})
