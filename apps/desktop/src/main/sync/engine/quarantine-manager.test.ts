import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { QuarantineManager } from './quarantine-manager'
import {
  QUARANTINE_MAX_ATTEMPTS,
  QUARANTINE_ENTRY_TTL_MS,
  MAX_QUARANTINE_ENTRIES,
  SYNC_STATE_KEYS
} from './sync-context'

// The cap tests quarantine tens of thousands of items; the real logger and the
// real telemetry sink would turn that into tens of thousands of log lines and
// events. Nothing in this file asserts on either.
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))
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
      expect(parsed.v).toBe(2)
      expect(parsed.entries).toHaveLength(1)
      expect(parsed.entries[0].itemId).toBe('item-1')
    })
  })

  describe('isQuarantined', () => {
    it('#given item at max attempts #when isQuarantined called #then returns true', () => {
      // #given
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')
      }

      // #then
      expect(manager.isQuarantined('item-1', 'task')).toBe(true)
    })

    it('#given item below max attempts #when isQuarantined called #then returns false', () => {
      // #given
      manager.quarantineItem('item-1', 'task', 'device-a', 'bad sig')

      // #then
      expect(manager.isQuarantined('item-1', 'task')).toBe(false)
    })

    it('#given unknown itemId #when isQuarantined called #then returns false', () => {
      expect(manager.isQuarantined('nonexistent', 'task')).toBe(false)
    })

    it('#given same id quarantined as another type #when isQuarantined called #then types stay independent', () => {
      // Ids repeat across item types (project 'inbox' vs tag 'inbox'); a
      // permanent quarantine on one type must not block the sibling type.
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('inbox', 'tag_definition', 'device-a', 'bad sig')
      }

      expect(manager.isQuarantined('inbox', 'tag_definition')).toBe(true)
      expect(manager.isQuarantined('inbox', 'project')).toBe(false)
    })

    it('#given both types of a colliding id failing #when quarantined #then attempt counts do not alias', () => {
      manager.quarantineItem('inbox', 'project', 'device-a', 'bad sig')
      manager.quarantineItem('inbox', 'tag_definition', 'device-a', 'bad sig')
      manager.quarantineItem('inbox', 'project', 'device-a', 'bad sig')

      const items = manager.getQuarantinedItems()
      expect(items).toHaveLength(2)
      expect(items.find((i) => i.itemType === 'project')?.attemptCount).toBe(2)
      expect(items.find((i) => i.itemType === 'tag_definition')?.attemptCount).toBe(1)
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
          value: JSON.stringify({ v: 2, entries }),
          updatedAt: new Date()
        })
        .run()

      // #when
      const fresh = new QuarantineManager(ctx)
      fresh.loadState()

      // #then
      expect(fresh.isQuarantined('restored-1', 'task')).toBe(true)
      expect(fresh.getQuarantinedItems()).toHaveLength(1)
    })

    it('#given legacy id-keyed (v1 array) persisted state #when loadState called #then it is discarded', () => {
      // v1 entries were id-aliased across types: attemptCount and itemType
      // could belong to the WRONG type, so they must not be trusted.
      const legacy = [
        {
          itemId: 'inbox',
          itemType: 'tag_definition',
          signerDeviceId: 'device-x',
          failedAt: Date.now(),
          attemptCount: QUARANTINE_MAX_ATTEMPTS,
          lastError: 'aliased'
        }
      ]
      testDb.db
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.QUARANTINED_ITEMS,
          value: JSON.stringify(legacy),
          updatedAt: new Date()
        })
        .run()

      const fresh = new QuarantineManager(ctx)
      fresh.loadState()

      expect(fresh.getQuarantinedItems()).toHaveLength(0)
      expect(fresh.isQuarantined('inbox', 'tag_definition')).toBe(false)
    })

    it('#given persisted entry older than the TTL #when loadState called #then entry is dropped', () => {
      const entries = [
        {
          itemId: 'stale-1',
          itemType: 'task',
          signerDeviceId: 'device-x',
          failedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          attemptCount: QUARANTINE_MAX_ATTEMPTS,
          lastError: 'old error'
        }
      ]
      testDb.db
        .insert(syncState)
        .values({
          key: SYNC_STATE_KEYS.QUARANTINED_ITEMS,
          value: JSON.stringify({ v: 2, entries }),
          updatedAt: new Date()
        })
        .run()

      const fresh = new QuarantineManager(ctx)
      fresh.loadState()

      expect(fresh.isQuarantined('stale-1', 'task')).toBe(false)
      expect(fresh.getQuarantinedItems()).toHaveLength(0)
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
      expect(fresh.isQuarantined('round-trip', 'project')).toBe(true)
      expect(fresh.getQuarantinedItems()[0].lastError).toBe('err')
    })
  })

  describe('in-session TTL sweep', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('#given an entry older than the TTL #when another item is quarantined #then the stale entry is dropped', () => {
      // #given
      manager.quarantineItem('stale', 'task', 'device-a', 'bad sig')

      // #when — a session that never restarts crosses the same TTL loadState uses
      vi.advanceTimersByTime(QUARANTINE_ENTRY_TTL_MS + 1)
      manager.quarantineItem('fresh', 'task', 'device-a', 'bad sig')

      // #then
      const ids = manager.getQuarantinedItems().map((i) => i.itemId)
      expect(ids).toEqual(['fresh'])
    })

    it('#given a permanent entry inside the TTL #when another item is quarantined #then it is kept', () => {
      // #given
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('perm', 'task', 'device-a', 'bad sig')
      }

      // #when
      vi.advanceTimersByTime(QUARANTINE_ENTRY_TTL_MS - 1000)
      manager.quarantineItem('fresh', 'task', 'device-a', 'bad sig')

      // #then — still protecting the vault from the bad item
      expect(manager.isQuarantined('perm', 'task')).toBe(true)
    })
  })

  describe('cap enforcement', () => {
    it('#given more non-permanent entries than the cap #when quarantining #then the map stays at the cap', () => {
      // #when
      for (let i = 0; i < MAX_QUARANTINE_ENTRIES + 100; i++) {
        manager.quarantineItem(`item-${i}`, 'task', 'device-a', 'bad sig')
      }

      // #then
      expect(manager.getQuarantinedItems()).toHaveLength(MAX_QUARANTINE_ENTRIES)
    })

    it('#given the cap is exceeded #when evicting #then the coldest entry goes and the newest stays', () => {
      // #given
      for (let i = 0; i < MAX_QUARANTINE_ENTRIES; i++) {
        manager.quarantineItem(`item-${i}`, 'task', 'device-a', 'bad sig')
      }

      // #when
      manager.quarantineItem('newest', 'task', 'device-a', 'bad sig')

      // #then
      const ids = new Set(manager.getQuarantinedItems().map((i) => i.itemId))
      expect(ids.has('item-0')).toBe(false)
      expect(ids.has('item-1')).toBe(true)
      expect(ids.has('newest')).toBe(true)
    })

    it('#given a permanent entry is the coldest #when the cap is exceeded #then it survives and a non-permanent one is evicted', () => {
      // #given — the oldest entry is a permanent quarantine
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('perm', 'task', 'device-a', 'bad sig')
      }
      for (let i = 0; i < MAX_QUARANTINE_ENTRIES; i++) {
        manager.quarantineItem(`item-${i}`, 'task', 'device-a', 'bad sig')
      }

      // #then — the permanent record is never the thing that gets dropped
      expect(manager.isQuarantined('perm', 'task')).toBe(true)
      const ids = new Set(manager.getQuarantinedItems().map((i) => i.itemId))
      expect(ids.has('item-0')).toBe(false)
    })

    it('#given eviction happened #when a new permanent entry persists #then persisted permanents are intact', () => {
      // #given — one permanent entry, then enough traffic to force evictions
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('perm', 'task', 'device-a', 'bad sig')
      }
      for (let i = 0; i < MAX_QUARANTINE_ENTRIES + 100; i++) {
        manager.quarantineItem(`item-${i}`, 'task', 'device-a', 'bad sig')
      }

      // #when — a second permanent entry triggers a re-serialise of the map
      for (let i = 0; i < QUARANTINE_MAX_ATTEMPTS; i++) {
        manager.quarantineItem('perm-2', 'note', 'device-b', 'bad sig')
      }

      // #then — eviction never removed a permanent record from disk
      const fresh = new QuarantineManager(ctx)
      fresh.loadState()
      expect(fresh.isQuarantined('perm', 'task')).toBe(true)
      expect(fresh.isQuarantined('perm-2', 'note')).toBe(true)
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
      expect(manager.isQuarantined('item-1', 'task')).toBe(false)
    })
  })
})
