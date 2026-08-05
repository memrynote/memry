import { describe, expect, it, vi } from 'vitest'
import { SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import {
  BASE_RATE_LIMIT_BACKOFF_MS,
  CORRUPT_ITEM_COOLDOWN_MS,
  MAX_PUSH_ITERATIONS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  PULL_PAGE_LIMIT,
  PUSH_BATCH_SIZE,
  QUARANTINE_ENTRY_TTL_MS,
  QUARANTINE_MAX_ATTEMPTS,
  SYNC_STATE_KEYS,
  YIELD_EVERY_N_ITEMS,
  itemRefKey,
  yieldToEventLoop
} from './sync-context'

// sync-context.ts is mostly type declarations, which carry no runtime
// behaviour worth asserting. What IS runtime, and what the coordinators all
// depend on, is: the (type, id) key function, the persisted state key strings
// (a data contract with every already-installed copy of the app), the
// relationships between the tuning constants, and the event-loop yield.

describe('itemRefKey', () => {
  describe('#given the same id used by different item types #when keyed', () => {
    it('#then the keys differ', () => {
      // 2026-07-18 incident: ids are NOT unique across types (project 'inbox'
      // vs tag 'inbox', folder_config ids are folder paths). An id-only key
      // made two unrelated items share one piece of sync bookkeeping.
      expect(itemRefKey('project', 'inbox')).not.toBe(itemRefKey('tag_definition', 'inbox'))
      expect(itemRefKey('note', 'inbox')).not.toBe(itemRefKey('journal', 'inbox'))
    })
  })

  describe('#given every known sync item type #when keyed with one shared id', () => {
    it('#then every key is unique', () => {
      const keys = SYNC_ITEM_TYPES.map((type) => itemRefKey(type, 'shared-id'))

      expect(new Set(keys).size).toBe(SYNC_ITEM_TYPES.length)
    })

    it('#then no item type contains the separator, so the key stays unambiguous', () => {
      // ids can legitimately contain ':' (folder_config ids are folder paths).
      // The key only stays injective while no TYPE contains ':'.
      for (const type of SYNC_ITEM_TYPES) {
        expect(type).not.toContain(':')
      }
    })
  })

  describe('#given ids that contain the separator #when keyed', () => {
    it('#then distinct ids still produce distinct keys', () => {
      expect(itemRefKey('folder_config', 'Work/Q3: plans')).toBe('folder_config:Work/Q3: plans')
      expect(itemRefKey('folder_config', 'a:b')).not.toBe(itemRefKey('folder_config', 'a:c'))
    })
  })

  describe('#given the same (type, id) #when keyed twice', () => {
    it('#then the key is stable', () => {
      expect(itemRefKey('task', 't-1')).toBe(itemRefKey('task', 't-1'))
    })
  })
})

describe('SYNC_STATE_KEYS', () => {
  describe('#given an existing install #when the app upgrades', () => {
    it('#then the persisted key strings are unchanged', () => {
      // These are literal primary keys in the sync_state table of every
      // shipped install. Renaming one orphans its row: a lost cursor forces a
      // full re-pull, a lost quarantine list re-processes poisoned items.
      expect(SYNC_STATE_KEYS).toEqual({
        LAST_CURSOR: 'lastCursor',
        LAST_SYNC_AT: 'lastSyncAt',
        SYNC_PAUSED: 'syncPaused',
        INITIAL_SEED_DONE: 'initialSeedDone',
        QUARANTINED_ITEMS: 'quarantinedItems',
        LAST_MANIFEST_CHECK_AT: 'lastManifestCheckAt'
      })
    })

    it('#then no two logical keys collide on the same row', () => {
      const values = Object.values(SYNC_STATE_KEYS)

      expect(new Set(values).size).toBe(values.length)
    })
  })
})

describe('sync tuning constants', () => {
  describe('#given the rate limit backoff #when it escalates', () => {
    it('#then the base is below the ceiling', () => {
      // base >= max would clamp the very first retry to the ceiling and turn
      // exponential backoff into a flat 5-minute stall.
      expect(BASE_RATE_LIMIT_BACKOFF_MS).toBeGreaterThan(0)
      expect(BASE_RATE_LIMIT_BACKOFF_MS).toBeLessThan(MAX_RATE_LIMIT_BACKOFF_MS)
    })
  })

  describe('#given a quarantined item #when its cooldown and TTL interact', () => {
    it('#then the entry outlives the retry cooldown', () => {
      // A TTL shorter than the cooldown expires the bookkeeping before the
      // item is eligible again, so it is retried (and re-quarantined) forever.
      expect(QUARANTINE_ENTRY_TTL_MS).toBeGreaterThan(CORRUPT_ITEM_COOLDOWN_MS)
      expect(QUARANTINE_MAX_ATTEMPTS).toBeGreaterThan(0)
    })
  })

  describe('#given a large push backlog #when it is drained in batches', () => {
    it('#then batch size and iteration cap can clear a realistic vault', () => {
      expect(PUSH_BATCH_SIZE).toBeGreaterThan(0)
      expect(MAX_PUSH_ITERATIONS).toBeGreaterThan(1)
      expect(PUSH_BATCH_SIZE * MAX_PUSH_ITERATIONS).toBeGreaterThanOrEqual(1000)
    })
  })

  describe('#given a pull page #when it is applied', () => {
    it('#then the apply loop yields at least once per page', () => {
      // YIELD_EVERY_N_ITEMS >= PULL_PAGE_LIMIT would let a full page block the
      // main process without ever yielding, freezing the UI mid-sync.
      expect(YIELD_EVERY_N_ITEMS).toBeGreaterThan(0)
      expect(YIELD_EVERY_N_ITEMS).toBeLessThan(PULL_PAGE_LIMIT)
    })
  })
})

describe('yieldToEventLoop', () => {
  describe('#given work queued on the event loop #when awaited', () => {
    it('#then it resolves and lets pending callbacks run first', async () => {
      const ran: string[] = []
      setImmediate(() => ran.push('queued-callback'))

      await yieldToEventLoop()

      expect(ran).toEqual(['queued-callback'])
    })

    it('#then it resolves without a value and can be awaited repeatedly', async () => {
      const spy = vi.fn()

      await yieldToEventLoop()
      spy()
      await expect(yieldToEventLoop()).resolves.toBeUndefined()

      expect(spy).toHaveBeenCalledTimes(1)
    })
  })
})
