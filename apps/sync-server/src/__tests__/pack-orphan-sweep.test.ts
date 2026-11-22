import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { cleanupOrphanedPackObjects, PACK_ORPHAN_MIN_AGE_MS } from '../services/cleanup'
import { storeUpdatesWithCursor } from '../services/crdt'
import { compactOneRange } from '../services/pack-compaction'
import { PACK_SETTLE_SECONDS } from '../services/pack-sizing'

/**
 * REVIEW-5260: a pack key is unique per build, so a build that fails between
 * its object PUT and its commit batch leaves an object no `pack_index` row
 * lists. The cleanup cron deletes such an object once it is an hour old.
 * Real compaction, SQL and schema over an in-memory R2.
 */

const USER_ID = 'user-orphan-sweep'
const VAULT_ID = 'default'
const SCOPE = { userId: USER_ID, vaultId: VAULT_ID }
const PACKS = `${USER_ID}/vaults/${VAULT_ID}/packs/`

let harness: SqliteD1
let storage: R2Bucket

const now = () => Math.floor(Date.now() / 1000)
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

const writeUpdate = (noteId: string) =>
  storeUpdatesWithCursor(harness.db, USER_ID, VAULT_ID, noteId, 'device-1', [
    new Uint8Array([1, 2]).buffer
  ])

const packObjects = async (): Promise<string[]> =>
  (await storage.list({ prefix: PACKS })).objects.map((object) => object.key)

const listedKeys = (): string[] =>
  (harness.raw.prepare('SELECT pack_key FROM pack_index').all() as Array<{ pack_key: string }>)
    .map((row) => row.pack_key)
    .toSorted()

/** One update build whose commit batch fails after its object PUT, then one that succeeds. */
const failedThenBuilt = async (): Promise<void> => {
  await writeUpdate('note-a')
  advance((PACK_SETTLE_SECONDS + 1) * 1000)
  // D1 goes away for the listing batch and its cleanup (REVIEW-5277 P3), as a
  // Worker that dies after the PUT: the object is neither listed nor recorded.
  const failing = vi.spyOn(harness.db, 'batch').mockImplementationOnce(async () => {
    throw new Error('D1 unavailable')
  })
  const prepare = harness.db.prepare.bind(harness.db)
  const cleanup = vi.spyOn(harness.db, 'prepare').mockImplementation((sql) => {
    if (sql.includes('pack_replaced_objects')) throw new Error('D1 unavailable')
    return prepare(sql)
  })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await expect(compactOneRange(harness.db, storage, SCOPE, 'crdt_update')).rejects.toThrow(
    'D1 unavailable'
  )
  failing.mockRestore()
  cleanup.mockRestore()
  logged.mockRestore()
  expect((await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')).built).toBe(true)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, 'orphan-sweep@example.com', 1, 'otp', 0, ?, ?, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('orphan pack object sweep (REVIEW-5260)', () => {
  // VERIFY-5260 R5
  it('deletes the object of a failed build once it is an hour old and keeps the listed one', async () => {
    await failedThenBuilt()
    expect(await packObjects()).toHaveLength(2)

    advance(PACK_ORPHAN_MIN_AGE_MS + 1000)
    expect(await cleanupOrphanedPackObjects(harness.db, storage)).toBe(1)

    expect(await packObjects()).toEqual(listedKeys())
    expect(listedKeys()).toHaveLength(1)
  })

  it('never deletes an object a pack_index row lists, however old', async () => {
    await writeUpdate('note-a')
    advance((PACK_SETTLE_SECONDS + 1) * 1000)
    await compactOneRange(harness.db, storage, SCOPE, 'crdt_update')
    advance(30 * 24 * 60 * 60 * 1000)

    expect(await cleanupOrphanedPackObjects(harness.db, storage)).toBe(0)

    expect(await packObjects()).toEqual(listedKeys())
    expect(listedKeys()).toHaveLength(1)
  })

  it('keeps an orphan younger than an hour: its build may still be committing', async () => {
    await failedThenBuilt()
    advance(PACK_ORPHAN_MIN_AGE_MS - 60_000)

    expect(await cleanupOrphanedPackObjects(harness.db, storage)).toBe(0)

    expect(await packObjects()).toHaveLength(2)
  })

  it('resumes across ticks inside a vault and across vaults', async () => {
    const vaults = ['v1', 'v2', 'v3']
    for (const vaultId of vaults) {
      harness.raw
        .prepare(
          `INSERT INTO pack_watermarks (user_id, vault_id, item_kind, last_sort_value, last_sort_tiebreak, updated_at)
           VALUES (?, ?, 'record', 0, '', ?)`
        )
        .run(USER_ID, vaultId, now())
      for (let i = 0; i < 200; i++) {
        await storage.put(`${USER_ID}/vaults/${vaultId}/packs/record/${i}.pack`, new ArrayBuffer(1))
      }
    }
    advance(PACK_ORPHAN_MIN_AGE_MS + 1000)

    const perTick: number[] = []
    for (let tick = 0; tick < 3; tick++)
      perTick.push(await cleanupOrphanedPackObjects(harness.db, storage))

    // 5 pages of 90 per tick: v1 in 3 pages and v2's first 2, then v2's last
    // page and all of v3. A cursor that skipped keys left behind by the
    // deletes would leave orphans for a later pass.
    expect(perTick).toEqual([380, 220, 0])
    expect((await storage.list()).objects).toHaveLength(0)
    expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM pack_orphan_sweep').get()).toEqual({
      n: 0
    })
  })
})
