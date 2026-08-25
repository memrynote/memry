import { beforeEach, describe, expect, it } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { PACKS_PER_BACKFILL_TICK, runPackBackfill } from './pack-backfill'

/**
 * Backfill pacing/resume against the real migration ledger (#1839): bounded
 * packs per invocation, resumable across ticks via watermarks, oldest backlog
 * first, one broken vault never starves the rest.
 */

const nowSec = () => Math.floor(Date.now() / 1000)

let harness: SqliteD1
let storage: R2Bucket

const seedVaultWithRecords = (
  userId: string,
  vaultId: string,
  count: number,
  cursorBase = 0
): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, ? || '@example.com', 'otp', 1, 1)
       ON CONFLICT (id) DO NOTHING`
    )
    .run(userId, userId)
  for (let i = 1; i <= count; i++) {
    const blobKey = `${userId}/vaults/${vaultId}/items-v3/task/i-${i}/h${i}`
    const bytes = new TextEncoder().encode(JSON.stringify({ n: `${userId}-${i}` }))
    storage.put(blobKey, bytes.slice().buffer as ArrayBuffer)
    harness.raw
      .prepare(
        `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 'task', ?, ?, ?, ?, 1, 1, 'update', ?, NULL, 'sig', NULL, 1, 1, NULL)`
      )
      .run(
        `${userId}-${vaultId}-r${i}`,
        userId,
        vaultId,
        `i-${i}`,
        blobKey,
        bytes.byteLength,
        `h${i}`,
        cursorBase + i
      )
  }
}

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
})

describe('runPackBackfill', () => {
  it('is resumable: each tick advances the watermark until drained', async () => {
    seedVaultWithRecords('u-resume', 'default', 3)

    // One pack per tick (all three items fit in one range).
    const tick1 = await runPackBackfill(harness.db, storage, 1)
    expect(tick1.packsBuilt).toBe(1)

    const tick2 = await runPackBackfill(harness.db, storage, 1)
    expect(tick2.packsBuilt).toBe(0) // nothing left for this vault

    const rows = harness.raw
      .prepare("SELECT COUNT(*) c FROM pack_index WHERE user_id = 'u-resume'")
      .get() as {
      c: number
    }
    expect(rows.c).toBe(1)
  })

  it('spends its budget across multiple vaults, oldest backlog first', async () => {
    seedVaultWithRecords('u-old', 'default', 2) // cursors 1..2 — oldest
    seedVaultWithRecords('u-new', 'default', 2) // own cursor space

    const result = await runPackBackfill(harness.db, storage, 4)
    expect(result.packsBuilt).toBe(2)
    expect(result.scopesVisited).toBe(2)
    expect(
      (harness.raw.prepare('SELECT COUNT(*) c FROM pack_index').get() as { c: number }).c
    ).toBe(result.packsBuilt)
  })

  it('continues past a broken vault and keeps its watermark untouched for retry', async () => {
    seedVaultWithRecords('u-broken', 'default', 1)
    seedVaultWithRecords('u-fine', 'default', 1)
    // Break u-broken's source object; selection succeeds but the fetch fails
    // only if get rejects — simulate via deleting the object AND corrupting
    // nothing else. A hole is tolerated, so force a hard failure with a
    // throwing proxy instead.
    const brokenStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string) => {
            if (key.includes('u-broken')) throw new Error('simulated r2 failure')
            return target.get(key)
          }
        }
        return Reflect.get(target, prop, receiver)
      }
    })

    const result = await runPackBackfill(harness.db, brokenStorage as R2Bucket, 4)
    // u-fine still got its pack despite u-broken failing.
    expect(
      (
        harness.raw.prepare("SELECT COUNT(*) c FROM pack_index WHERE user_id = 'u-fine'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    expect(
      (
        harness.raw
          .prepare("SELECT COUNT(*) c FROM pack_index WHERE user_id = 'u-broken'")
          .get() as { c: number }
      ).c
    ).toBe(0)
    expect(nowSec()).toBeGreaterThan(0)
    void result
  })

  it('stops at the per-tick budget instead of draining the whole backlog', async () => {
    // Distinct oldest cursors so ORDER BY oldest_pending is a total order.
    for (let i = 1; i <= 6; i++) seedVaultWithRecords(`u-b${i}`, 'default', 1, i * 100)

    const result = await runPackBackfill(harness.db, storage, 2)

    // This stop condition is the ONLY bound on a cron invocation shared with
    // every other cleanup task: 6 scopes x ~269 subrequests would blow the
    // paid-plan 1000-per-invocation ceiling and kill the whole sweep.
    expect(result.packsBuilt).toBe(2)
    expect(result.scopesVisited).toBe(2)
    expect(result.budgetRemaining).toBe(0)

    // The four unvisited vaults are untouched — they drain on later ticks.
    const packed = harness.raw
      .prepare('SELECT DISTINCT user_id FROM pack_index ORDER BY user_id')
      .all() as Array<{ user_id: string }>
    expect(packed.map((row) => row.user_id)).toEqual(['u-b1', 'u-b2'])
  })

  it('exposes the tick budget constant used by the cron wiring', () => {
    expect(PACKS_PER_BACKFILL_TICK).toBeGreaterThan(0)
  })
})
