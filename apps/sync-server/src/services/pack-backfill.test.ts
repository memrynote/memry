import { beforeEach, describe, expect, it } from 'vitest'

import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { createMemoryQueue, runBackfillTick } from '../__tests__/pack-queue-memory'
import {
  BACKFILL_HOP_DELAY_SECONDS,
  BACKFILL_MAX_HOPS,
  BACKFILL_MESSAGES_PER_TICK,
  runBackfillMessage,
  runPackBackfill
} from './pack-backfill'
import { handlePackQueueMessage } from './pack-consumer'
import { PACK_MIN_FILL_ROWS } from './pack-sizing'

/**
 * The pack backfill fan-out (#1839, #5278): the cron enqueues bounded
 * per-vault messages and builds nothing in-line; each consumer message builds
 * within its own budget and chains while backlog remains.
 */

let harness: SqliteD1
let storage: R2Bucket

const seedUser = (userId: string): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, ? || '@example.com', 'otp', 1, 1)
       ON CONFLICT (id) DO NOTHING`
    )
    .run(userId, userId)
}

// Snapshots: the ordering key for this kind is created_at epoch seconds.
const seedVaultWithSnapshots = (
  userId: string,
  vaultId: string,
  count: number,
  createdAtBase = 0
): void => {
  seedUser(userId)
  for (let i = 1; i <= count; i++) {
    const noteId = `n-${i}`
    const blobKey = `${userId}/vaults/${vaultId}/crdt/${noteId}/snapshot`
    const bytes = new TextEncoder().encode(JSON.stringify({ n: `${userId}-${i}` }))
    void storage.put(blobKey, bytes.slice().buffer)
    harness.raw
      .prepare(
        `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'device-1', ?, ?)`
      )
      .run(
        `${userId}-${vaultId}-s${i}`,
        userId,
        vaultId,
        noteId,
        blobKey,
        bytes.byteLength,
        createdAtBase + i,
        `rev-${noteId}-1`
      )
  }
}

// Fresh update rows (created now), so only the row count makes them fill-ready.
// Cursors are unique per user, as the route allocates them.
const seedUpdates = (userId: string, vaultId: string, count: number, cursorBase = 0): void => {
  seedUser(userId)
  const insert = harness.raw.prepare(
    `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, server_cursor)
     VALUES (?, ?, ?, ?, ?, ?, 'device-1', ?, ?)`
  )
  const now = Math.floor(Date.now() / 1000)
  harness.raw.transaction(() => {
    for (let i = 1; i <= count; i++) {
      insert.run(
        `${userId}-${vaultId}-u${i}`,
        userId,
        vaultId,
        `note-${i % 97}`,
        Buffer.from([i % 256, 1]),
        i,
        now,
        cursorBase + i
      )
    }
  })()
}

const count = (sql: string, ...bind: unknown[]): number =>
  (harness.raw.prepare(sql).get(...bind) as { c: number }).c

const pendingUpdates = (userId: string, vaultId: string): number =>
  count(
    `SELECT COUNT(*) c FROM crdt_updates u
     WHERE u.user_id = ? AND u.vault_id = ? AND u.server_cursor > COALESCE((SELECT last_sort_value
       FROM pack_watermarks w WHERE w.user_id = u.user_id AND w.vault_id = u.vault_id
       AND w.item_kind = 'crdt_update'), 0)`,
    userId,
    vaultId
  )

const updatePacks = (userId: string, vaultId: string) =>
  harness.raw
    .prepare(
      `SELECT min_cursor, max_cursor, item_count FROM pack_index
       WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_update' ORDER BY min_cursor`
    )
    .all(userId, vaultId) as Array<{ min_cursor: number; max_cursor: number; item_count: number }>

const expectDisjoint = (packs: ReturnType<typeof updatePacks>): void => {
  for (let i = 1; i < packs.length; i++) {
    expect(packs[i].min_cursor).toBeGreaterThan(packs[i - 1].max_cursor)
  }
}

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
})

describe('runPackBackfill (the cron tick)', () => {
  it('enqueues one backfill message per vault and kind and builds nothing in-line', async () => {
    seedVaultWithSnapshots('u-a', 'default', 3)
    seedVaultWithSnapshots('u-b', 'default', 2)
    seedUpdates('u-a', 'default', PACK_MIN_FILL_ROWS)
    const queue = createMemoryQueue()

    expect(await runPackBackfill(harness.db, storage, queue)).toEqual({ enqueued: 3 })

    expect(count('SELECT COUNT(*) c FROM pack_index')).toBe(0)
    expect(count('SELECT COUNT(*) c FROM pack_watermarks')).toBe(0)
    expect(queue.sent).toEqual(
      expect.arrayContaining([
        {
          body: { userId: 'u-a', vaultId: 'default', backfill: { kind: 'crdt_snapshot', hop: 0 } }
        },
        {
          body: { userId: 'u-b', vaultId: 'default', backfill: { kind: 'crdt_snapshot', hop: 0 } }
        },
        { body: { userId: 'u-a', vaultId: 'default', backfill: { kind: 'crdt_update', hop: 0 } } }
      ])
    )
  })

  it('enqueues no update backlog below the minimum fill', async () => {
    seedUpdates('u-a', 'default', PACK_MIN_FILL_ROWS - 1)
    const queue = createMemoryQueue()

    expect(await runPackBackfill(harness.db, storage, queue)).toEqual({ enqueued: 0 })
  })

  it('bounds the fan-out per tick', async () => {
    for (let i = 0; i <= BACKFILL_MESSAGES_PER_TICK; i++) {
      seedVaultWithSnapshots(`u-${i}`, 'default', 1, i * 10)
    }
    const queue = createMemoryQueue()

    expect(await runPackBackfill(harness.db, storage, queue)).toEqual({
      enqueued: BACKFILL_MESSAGES_PER_TICK
    })
    expect(queue.sent).toHaveLength(BACKFILL_MESSAGES_PER_TICK)
  })

  it('builds nothing without a queue binding', async () => {
    seedVaultWithSnapshots('u-a', 'default', 3)

    expect(await runPackBackfill(harness.db, storage, undefined)).toEqual({ enqueued: 0 })
    expect(count('SELECT COUNT(*) c FROM pack_index')).toBe(0)
  })
})

describe('backfill messages (#5278)', () => {
  it('drains a large crdt_update backlog to under the fill in a bounded number of messages', async () => {
    seedUpdates('u-big', 'default', 4 * PACK_MAX_ENTRIES + 100)

    const tick = await runBackfillTick(harness.db, storage)

    // Three builds per message: 3, then 1 and only the tail is left.
    expect(tick.enqueued).toBe(1)
    expect(tick.messages).toHaveLength(2)
    expect(tick.messages.slice(1).every((m) => m.delaySeconds === BACKFILL_HOP_DELAY_SECONDS)).toBe(
      true
    )
    const packs = updatePacks('u-big', 'default')
    expect(packs).toHaveLength(4)
    expectDisjoint(packs)
    expect(packs.reduce((sum, pack) => sum + pack.item_count, 0)).toBe(4 * PACK_MAX_ENTRIES)
    expect(pendingUpdates('u-big', 'default')).toBe(100)
    expect(pendingUpdates('u-big', 'default')).toBeLessThan(PACK_MIN_FILL_ROWS)

    // Drained: the next tick has nothing to enqueue.
    expect((await runBackfillTick(harness.db, storage)).enqueued).toBe(0)
  }, 60_000)

  it('drains two vaults in one tick', async () => {
    seedUpdates('u-one', 'default', PACK_MAX_ENTRIES + 10)
    seedUpdates('u-two', 'work', PACK_MAX_ENTRIES + 20)

    const tick = await runBackfillTick(harness.db, storage)

    expect(tick.enqueued).toBe(2)
    expect(updatePacks('u-one', 'default')).toHaveLength(1)
    expect(updatePacks('u-two', 'work')).toHaveLength(1)
    expect(pendingUpdates('u-one', 'default')).toBe(10)
    expect(pendingUpdates('u-two', 'work')).toBe(20)
  }, 60_000)

  it('a redelivered or duplicate message builds no second pack for a range', async () => {
    seedUpdates('u-dup', 'default', 4 * PACK_MAX_ENTRIES + 10)
    const queue = createMemoryQueue()
    const env = { DB: harness.db, STORAGE: storage, PACK_QUEUE: queue }
    const first = { userId: 'u-dup', vaultId: 'default', backfill: { kind: 'crdt_update', hop: 0 } }

    // The same message delivered twice back to back, then the whole chain.
    await handlePackQueueMessage(env, first)
    await handlePackQueueMessage(env, first)
    for (let i = 0; i < queue.sent.length; i++)
      await handlePackQueueMessage(env, queue.sent[i].body)
    const packs = updatePacks('u-dup', 'default')
    expect(packs).toHaveLength(4)
    expectDisjoint(packs)

    // Every message delivered again once drained: nothing built, nothing enqueued.
    const sent = queue.sent.length
    for (const body of [first, ...queue.sent.map((m) => m.body)]) {
      await handlePackQueueMessage(env, body)
    }
    expect(updatePacks('u-dup', 'default')).toEqual(packs)
    expect(queue.sent).toHaveLength(sent)
  }, 60_000)

  it('ends the chain at the hop bound with work left', async () => {
    seedUpdates('u-long', 'default', 4 * PACK_MAX_ENTRIES)
    const queue = createMemoryQueue()

    const result = await runBackfillMessage(
      harness.db,
      storage,
      queue,
      { userId: 'u-long', vaultId: 'default' },
      { kind: 'crdt_update', hop: BACKFILL_MAX_HOPS - 1 }
    )

    expect(result).toMatchObject({ packsBuilt: 3, drained: false, continued: false })
    expect(queue.sent).toHaveLength(0)
    // The next tick resumes it.
    await runBackfillTick(harness.db, storage)
    expect(updatePacks('u-long', 'default')).toHaveLength(4)
  }, 60_000)

  it('a failing vault fails its own message only', async () => {
    seedVaultWithSnapshots('u-broken', 'default', 1)
    seedVaultWithSnapshots('u-fine', 'default', 1)
    const brokenStorage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string) => {
            if (key.includes('u-broken')) throw new Error('simulated r2 failure')
            return target.get(key)
          }
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards to the target with the original receiver
        return Reflect.get(target, prop, receiver)
      }
    })
    const queue = createMemoryQueue()
    const env = { DB: harness.db, STORAGE: brokenStorage, PACK_QUEUE: queue }
    await runPackBackfill(harness.db, brokenStorage, queue)
    const [broken, fine] = ['u-broken', 'u-fine'].map(
      (user) => queue.sent.find((m) => m.body.userId === user)!.body
    )

    await expect(handlePackQueueMessage(env, broken)).rejects.toThrow('simulated r2 failure')
    await handlePackQueueMessage(env, fine)

    expect(count("SELECT COUNT(*) c FROM pack_index WHERE user_id = 'u-fine'")).toBe(1)
    expect(count("SELECT COUNT(*) c FROM pack_index WHERE user_id = 'u-broken'")).toBe(0)
    expect(count("SELECT COUNT(*) c FROM pack_watermarks WHERE user_id = 'u-broken'")).toBe(0)
  })

  it('packs the snapshot tail of deleted notes alongside the live vault', async () => {
    // A deleted note's body row packs while it exists (protocol 08 §8.10).
    for (let i = 1; i <= 3; i++) {
      const userId = `u-dead${i}`
      seedVaultWithSnapshots(userId, 'default', 1, i * 100)
      harness.raw
        .prepare(
          `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, crypto_version, operation, server_cursor, signer_device_id, signature, clock, created_at, updated_at, deleted_at)
           VALUES (?, ?, 'default', 'note', 'n-1', '', 0, 'h', 1, 1, 'delete', 1, NULL, 'sig', NULL, 1, 1, 5)`
        )
        .run(`${userId}-row`, userId)
    }
    seedVaultWithSnapshots('u-live', 'default', 1, 5000)

    await runBackfillTick(harness.db, storage)

    const packed = harness.raw
      .prepare(
        "SELECT DISTINCT user_id FROM pack_index WHERE item_kind = 'crdt_snapshot' ORDER BY user_id"
      )
      .all() as Array<{ user_id: string }>
    expect(packed.map((row) => row.user_id)).toEqual(['u-dead1', 'u-dead2', 'u-dead3', 'u-live'])
  })
})
