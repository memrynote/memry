import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { setupTestDb } from '@tests/utils/engine-mocks'
import type { DataDb } from '../database'
import { reconcileCrdtStoreEpoch } from './crdt-store-epoch'
import { NOTE_BODY_LEGACY_SWEEP_DONE, SYNC_STATE_KEYS } from './engine/sync-context'

vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2299 review A-7/B-3: a snapshot claim says "the docs hold every body at or
 * below LAST_CURSOR". A CRDT store quarantined, created fresh for an existing
 * vault, or older than its data DB keeps the cursor and loses what the docs
 * merged, so a store without the marker withholds claims until a vault sweep.
 */

/** One y-leveldb store's meta keys; a quarantined store is a new one. */
const store = () => {
  const meta = new Map<string, unknown>()
  return {
    getMeta: vi.fn(async (doc: string, key: string) => meta.get(`${doc}:${key}`)),
    setMeta: vi.fn(async (doc: string, key: string, value: unknown) => {
      meta.set(`${doc}:${key}`, value)
    })
  }
}

const state = (db: DataDb, key: string): string | undefined =>
  db.select().from(syncState).where(eq(syncState.key, key)).all()[0]?.value

const seedSweptVault = (db: DataDb): void => {
  for (const [key, value] of [
    [SYNC_STATE_KEYS.LAST_CURSOR, '500'],
    [SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP, NOTE_BODY_LEGACY_SWEEP_DONE],
    [SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '0']
  ] as const) {
    db.insert(syncState)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run()
  }
}

describe('reconcileCrdtStoreEpoch (#2299)', () => {
  const { getDb } = setupTestDb()

  it('withholds claims and raises the debt for a store without the marker', async () => {
    const db = getDb().db as unknown as DataDb
    seedSweptVault(db)
    const fresh = store()

    await expect(reconcileCrdtStoreEpoch(fresh, db)).resolves.toBe(true)

    expect(state(db, SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
    expect(state(db, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBe('1')
    expect(state(db, SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  it('leaves a marked store and its vault state alone on the next open', async () => {
    const db = getDb().db as unknown as DataDb
    const kept = store()
    await reconcileCrdtStoreEpoch(kept, db)
    seedSweptVault(db)

    await expect(reconcileCrdtStoreEpoch(kept, db)).resolves.toBe(false)

    expect(state(db, SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBe(NOTE_BODY_LEGACY_SWEEP_DONE)
  })

  it('treats a quarantined store, replaced by a fresh one, as unmarked', async () => {
    const db = getDb().db as unknown as DataDb
    await reconcileCrdtStoreEpoch(store(), db)
    seedSweptVault(db)

    await expect(reconcileCrdtStoreEpoch(store(), db)).resolves.toBe(true)

    expect(state(db, SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
  })

  // #2299 review round 2 (B-M2): the stores are backed up and restored apart
  it('writes one random epoch to both the store and the data DB', async () => {
    const db = getDb().db as unknown as DataDb
    const first = store()
    await reconcileCrdtStoreEpoch(first, db)
    const epoch = state(db, SYNC_STATE_KEYS.CRDT_STORE_EPOCH)

    expect(epoch).toMatch(/^[0-9a-f-]{36}$/)
    expect(await first.getMeta('__memry_crdt_store__', 'syncEpoch')).toBe(epoch)

    await reconcileCrdtStoreEpoch(store(), db)
    expect(state(db, SYNC_STATE_KEYS.CRDT_STORE_EPOCH)).not.toBe(epoch)
  })

  it('resets a store restored from an older point than the data DB', async () => {
    const db = getDb().db as unknown as DataDb
    const kept = store()
    await reconcileCrdtStoreEpoch(kept, db)
    const backup = await kept.getMeta('__memry_crdt_store__', 'syncEpoch')
    // The data DB moves on to a later epoch (another reset), the store is restored.
    await reconcileCrdtStoreEpoch(store(), db)
    await kept.setMeta('__memry_crdt_store__', 'syncEpoch', backup)
    seedSweptVault(db)

    await expect(reconcileCrdtStoreEpoch(kept, db)).resolves.toBe(true)

    expect(state(db, SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
    expect(state(db, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)).toBe('1')
    expect(await kept.getMeta('__memry_crdt_store__', 'syncEpoch')).toBe(
      state(db, SYNC_STATE_KEYS.CRDT_STORE_EPOCH)
    )
  })

  it('resets a marked store opened against a data DB with no epoch', async () => {
    const db = getDb().db as unknown as DataDb
    const kept = store()
    await reconcileCrdtStoreEpoch(kept, db)
    db.delete(syncState).where(eq(syncState.key, SYNC_STATE_KEYS.CRDT_STORE_EPOCH)).run()
    seedSweptVault(db)

    await expect(reconcileCrdtStoreEpoch(kept, db)).resolves.toBe(true)

    expect(state(db, SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)).toBeUndefined()
  })

  it('writes the marker only after the vault state, so a failed write retries', async () => {
    const db = getDb().db as unknown as DataDb
    const failing = store()
    const broken = Object.create(db) as DataDb
    broken.transaction = () => {
      throw new Error('data DB closed')
    }

    await expect(reconcileCrdtStoreEpoch(failing, broken)).rejects.toThrow('data DB closed')

    expect(failing.setMeta).not.toHaveBeenCalled()
  })
})
