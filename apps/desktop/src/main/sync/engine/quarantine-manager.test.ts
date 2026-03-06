import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { QuarantineManager } from './quarantine-manager'
import { QUARANTINE_MAX_ATTEMPTS, SYNC_STATE_KEYS } from './sync-context'
import type { SyncContext } from './sync-context'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'

function createMockCtx(testDb: TestDatabaseResult): SyncContext {
  return {
    deps: {
      db: testDb.db,
      emitToRenderer: vi.fn()
    }
  } as unknown as SyncContext
}

describe('QuarantineManager', () => {
  let testDb: TestDatabaseResult
  let ctx: SyncContext
  let manager: QuarantineManager

  beforeEach(() => {
    testDb = createTestDataDb()
    ctx = createMockCtx(testDb)
    manager = new QuarantineManager(ctx)
  })

  afterEach(() => {
    testDb.close()
  })

  describe('quarantineItem', () => {
    it('#given fresh manager #when quarantineItem called #then item is tracked with attemptCount 1', () => {
      // #given — fresh manager (setup)

      // #when
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #then
      const items = manager.getQuarantinedItems()
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        itemId: 'item-1',
        itemType: 'task',
        signerDeviceId: 'device-a',
        attemptCount: 1,
        lastError: 'bad sig',
        permanent: false
      })
    })

    it('#given item already quarantined #when quarantineItem called again #then attemptCount increments', () => {
      // #given
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #when
      manager.quarantineItem('item-1', 'task', 'device-a', 'still bad')

      // #then
      const items = manager.getQuarantinedItems()
      expect(items[0].attemptCount).toBe(2)
    })

    it('#given item below max attempts #when quarantined #then emits non-permanent warning', () => {
      // #when
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #then
      expect(ctx.deps.emitToRenderer).toHaveBeenCalledWith(
        EVENT_CHANNELS.SECURITY_WARNING,
        expect.objectContaining({ permanent: false, attemptCount: 1 })
      )
    })

    it('#given item reaches max attempts #when quarantined #then emits permanent warning', () => {
      // #given
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS - 1; i++) {
        manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')
      }

      // #when
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #then
      const lastCall = vi.mocked(ctx.deps.emitToRenderer).mock.calls.at(-1)!
      expect(lastCall[1]).toMatchObject({ permanent: true, attemptCount: QUARANTINE_MAX_ATTEMPTS })
    })

    it('#given item reaches max attempts #when quarantined #then state persisted to DB', () => {
      // #when
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')
      }

      // #then
      const rows = testDb.db
        .select()
        .from(syncState)
        .where(eq(syncState.key, SYNC_STATE_KEYS.QUARANTINED_ITEMS))
        .all()
      expect(rows).toHaveLength(1)
      const parsed = JSON.parse(rows[0].value)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].itemId).toBe('item-1')
    })
  })

  describe('isQuarantined', () => {
    it('#given item at max attempts #when isQuarantined called #then returns true', () => {
      // #given
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')
      }

      // #then
      expect(manager.isQuarantined('item-1')).toBe(true)
    })

    it('#given item below max attempts #when isQuarantined called #then returns false', () => {
      // #given
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #then
      expect(manager.isQuarantined('item-1')).toBe(false)
    })

    it('#given unknown itemId #when isQuarantined called #then returns false', () => {
      expect(manager.isQuarantined('nonexistent')).toBe(false)
    })
  })

  describe('getQuarantinedItems', () => {
    it('#given multiple quarantined items #when getQuarantinedItems called #then returns all with permanent flag', () => {
      // #given
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('perm-1', 'task', 'device-a', 'bad')
      }
      manager.quarantineItem('temp-1', 'note', 'device-b', 'meh')

      // #when
      const items = manager.getQuarantinedItems()

      // #then
      expect(items).toHaveLength(2)
      const perm = items.find((i) => i.itemId === 'perm-1')!
      const temp = items.find((i) => i.itemId === 'temp-1')!
      expect(perm.permanent).toBe(true)
      expect(temp.permanent).toBe(false)
    })
  })

  describe('loadState', () => {
    it('#given persisted quarantine in DB #when loadState called #then restores entries', () => {
      // #given — persist directly to DB
      const entries = [
        {
          itemId: 'restored-1',
          itemType: 'task',
          signerDeviceId: 'device-x',
          failedAt: Date.now(),
          attemptCount: QUARANTINE_MAX_ATTEMPTS,
          lastError: 'persisted error'
        }
      ]
      testDb.db
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.QUARANTINED_ITEMS,
          value: JSON.stringify(entries),
          updatedAt: new Date()
        })
        .run()

      // #when
      const fresh = new QuarantineManager(ctx)
      fresh.loadState()

      // #then
      expect(fresh.isQuarantined('restored-1')).toBe(true)
      expect(fresh.getQuarantinedItems()).toHaveLength(1)
    })

    it('#given no persisted state in DB #when loadState called #then quarantine remains empty', () => {
      // #when
      manager.loadState()

      // #then
      expect(manager.getQuarantinedItems()).toHaveLength(0)
    })
  })

  describe('persistState (via quarantineItem reaching max)', () => {
    it('#given permanent item persisted #when new manager loads #then survives round-trip', () => {
      // #given — quarantine to max so persistState fires
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('round-trip', 'project', 'device-z', 'err')
      }

      // #when
      const fresh = new QuarantineManager(ctx)
      fresh.loadState()

      // #then
      expect(fresh.isQuarantined('round-trip')).toBe(true)
      expect(fresh.getQuarantinedItems()[0].lastError).toBe('err')
    })
  })

  describe('clear', () => {
    it('#given quarantined items exist #when clear called #then all items removed', () => {
      // #given
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')
      manager.quarantineItem('item-2', 'note', 'device-b', 'bad sig')

      // #when
      manager.clear()

      // #then
      expect(manager.getQuarantinedItems()).toHaveLength(0)
      expect(manager.isQuarantined('item-1')).toBe(false)
    })
  })
})
