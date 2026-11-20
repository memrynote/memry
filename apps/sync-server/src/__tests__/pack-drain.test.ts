import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { createMemoryQueue } from './pack-queue-memory'
import { BACKFILL_MAX_HOPS } from '../services/pack-backfill'
import { handlePackQueueMessage } from '../services/pack-consumer'
import { reportBootstrapCoverage } from '../services/pack-coverage'
import type { PackKindName } from '../services/pack-format'
import type { PackCompactionMessageBody } from '../services/pack-queue'
import { PACK_MIN_FILL_ROWS } from '../services/pack-sizing'

/**
 * How fast a bootstrap's backfill chains drain a vault (#5230 Do 3, Do 4):
 * real SQL, selection, builds, rollups and chain hops over an in-memory R2,
 * with every D1 and R2 call counted, so the message count and the
 * subrequests per message are the ones a Worker spends.
 */

let harness: SqliteD1
let storage: R2Bucket
let calls = 0

const now = () => Math.floor(Date.now() / 1000)

/** D1 and R2 that count each round trip: a statement run, a batch, an object call. */
const counted = () => {
  const db = harness.db
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    const bind = statement.bind.bind(statement)
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values)
      for (const method of ['all', 'first', 'run', 'raw'] as const) {
        const call = bound[method].bind(bound) as (...args: unknown[]) => unknown
        ;(bound as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          calls++
          return call(...args)
        }
      }
      return bound
    }
    return statement
  })
  const batch = db.batch.bind(db)
  vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
    calls++
    return batch(statements)
  })
  for (const method of ['get', 'put', 'head', 'delete', 'list'] as const) {
    const call = storage[method].bind(storage) as (...args: unknown[]) => unknown
    vi.spyOn(storage, method).mockImplementation(((...args: unknown[]) => {
      calls++
      return call(...args)
    }) as never)
  }
}

let cursor = 0

/**
 * A vault as a desktop seeds it: per note one record, one snapshot and
 * `updatesPerNote` updates, pushed at 20 notes a second, all younger than the
 * settle time, so only the row count makes a window fill-ready.
 */
const seedVault = (userId: string, vaultId: string, notes: number, updatesPerNote = 1): void => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, auth_method, created_at, updated_at)
       VALUES (?, ? || '@example.com', 'otp', 1, 1) ON CONFLICT (id) DO NOTHING`
    )
    .run(userId, userId)
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES ('device-1', ?, 'seeder', 'desktop', '1.0.0', 'pk', 1, 1) ON CONFLICT (id) DO NOTHING`
    )
    .run(userId)
  const record = harness.raw.prepare(
    `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes,
       content_hash, version, crypto_version, operation, signature, signer_device_id,
       server_cursor, created_at, updated_at)
     VALUES (?, ?, ?, 'note', ?, ?, ?, ?, 1, 1, 'create', 'sig', 'device-1', ?, ?, ?)`
  )
  const snapshot = harness.raw.prepare(
    `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes,
       signer_device_id, created_at, revision)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'device-1', ?, ?)`
  )
  const update = harness.raw.prepare(
    `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num,
       signer_device_id, created_at, server_cursor)
     VALUES (?, ?, ?, ?, ?, ?, 'device-1', ?, ?)`
  )
  const base = now() - Math.ceil(notes / 20)
  const blobs: Array<[string, Uint8Array]> = []
  harness.raw.transaction(() => {
    for (let i = 0; i < notes; i++) {
      const noteId = `${vaultId}-n${i}`
      const at = base + Math.floor(i / 20)
      const payload = new TextEncoder().encode(JSON.stringify({ noteId, body: 'x'.repeat(1500) }))
      const recordKey = `${userId}/vaults/${vaultId}/items/note/${noteId}`
      const hash = createHash('sha256').update(payload).digest('hex')
      record.run(
        `${vaultId}-r${i}`,
        userId,
        vaultId,
        noteId,
        recordKey,
        payload.byteLength,
        hash,
        ++cursor,
        at,
        at
      )
      blobs.push([recordKey, payload])
      const snapshotKey = `${userId}/vaults/${vaultId}/crdt/${noteId}/snapshot`
      snapshot.run(`${vaultId}-s${i}`, userId, vaultId, noteId, snapshotKey, 800, at, `rev-${i}`)
      blobs.push([snapshotKey, new Uint8Array(800).fill(i % 256)])
      for (let u = 0; u < updatesPerNote; u++) {
        update.run(
          `${vaultId}-u${i}-${u}`,
          userId,
          vaultId,
          noteId,
          Buffer.alloc(120, u),
          u + 1,
          at,
          ++cursor
        )
      }
    }
  })()
  for (const [key, bytes] of blobs) void storage.put(key, bytes.slice().buffer)
}

const count = (sql: string, ...bind: unknown[]): number =>
  (harness.raw.prepare(sql).get(...bind) as { c: number }).c

const SOURCES: Record<PackKindName, { table: string; sort: string }> = {
  record: { table: 'sync_items', sort: 'server_cursor' },
  crdt_snapshot: { table: 'crdt_snapshots', sort: 'created_at' },
  crdt_update: { table: 'crdt_updates', sort: 'server_cursor' }
}

/** Rows of a kind above its watermark: what no pack holds yet. */
const backlog = (vaultId: string, kind: PackKindName): number => {
  const { table, sort } = SOURCES[kind]
  return count(
    `SELECT COUNT(*) c FROM ${table} s WHERE s.vault_id = ? AND s.${sort} > COALESCE((SELECT last_sort_value
       FROM pack_watermarks w WHERE w.user_id = s.user_id AND w.vault_id = s.vault_id AND w.item_kind = ?), 0)`,
    vaultId,
    kind
  )
}

/** Record rows above the newest record pack's cover_through: what a client takes item by item. */
const uncoveredRecords = (vaultId: string): number =>
  count(
    `SELECT COUNT(*) c FROM sync_items s WHERE s.vault_id = ? AND s.server_cursor > COALESCE((SELECT covered_through
       FROM pack_watermarks w WHERE w.user_id = s.user_id AND w.vault_id = s.vault_id AND w.item_kind = 'record'), 0)`,
    vaultId
  )

const packs = (vaultId: string, kind: PackKindName): number =>
  count('SELECT COUNT(*) c FROM pack_index WHERE vault_id = ? AND item_kind = ?', vaultId, kind)

interface Delivery {
  body: PackCompactionMessageBody
  subrequests: number
}

/**
 * The backfill consumer at max_concurrency 1: delivers every message in send
 * order, each chain hop after the messages already queued, as Queues does for
 * a delayed message, and counts each message's subrequests.
 */
const drain = async (
  queue: ReturnType<typeof createMemoryQueue>,
  after?: (delivery: Delivery) => void
): Promise<Delivery[]> => {
  const deliveries: Delivery[] = []
  for (let i = 0; i < queue.sent.length; i++) {
    const before = calls
    await handlePackQueueMessage(
      { DB: harness.db, STORAGE: storage, PACK_BACKFILL_QUEUE: queue },
      queue.sent[i].body
    )
    const delivery = { body: queue.sent[i].body, subrequests: calls - before }
    deliveries.push(delivery)
    after?.(delivery)
  }
  return deliveries
}

const open = (queue: ReturnType<typeof createMemoryQueue>, userId: string, vaultId: string) =>
  reportBootstrapCoverage({ DB: harness.db, PACK_BACKFILL_QUEUE: queue }, { userId, vaultId })

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  calls = 0
  cursor = 0
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

describe('the drain of a bootstrap-seen vault (#5230)', () => {
  it('one bootstrap open covers a 2,000-note vault to under the minimum fill in 7 messages', async () => {
    // #given: 2,000 notes pushed in the last two minutes, nothing packed
    seedVault('u-1', 'v-2k', 2000)
    counted()
    const queue = createMemoryQueue()

    // #when: a fresh device opens a bootstrap, and the backfill consumer drains
    const report = await open(queue, 'u-1', 'v-2k')
    const deliveries = await drain(queue)

    // #then: every kind's chain started at that open
    expect(report.map(({ kind, enqueued }) => [kind, enqueued])).toEqual([
      ['crdt_snapshot', true],
      ['record', true],
      ['crdt_update', true]
    ])
    const perKind = (kind: PackKindName) =>
      deliveries.filter((delivery) => delivery.body.backfill?.kind === kind).length
    // Three builds of 256 per message: 2,000 rows are 7 full packs and a
    // 208-row tail below the fill, so 3 messages a kind, the last one ending
    // its chain. Updates fit one pack of up to 4,096 entries.
    expect({
      record: perKind('record'),
      snapshot: perKind('crdt_snapshot'),
      update: perKind('crdt_update')
    }).toEqual({ record: 3, snapshot: 3, update: 1 })
    expect(deliveries).toHaveLength(7)
    expect(
      Math.max(...deliveries.map((delivery) => delivery.body.backfill?.hop ?? 0))
    ).toBeLessThan(BACKFILL_MAX_HOPS)
    // Within the 1,000 subrequests compaction plans each invocation around.
    expect(Math.max(...deliveries.map((delivery) => delivery.subrequests))).toBeLessThan(1000)

    // Every kind is packed but for a young tail under the minimum fill, which
    // the client takes item by item until it settles.
    for (const kind of ['record', 'crdt_snapshot', 'crdt_update'] as const) {
      expect(backlog('v-2k', kind)).toBeLessThan(PACK_MIN_FILL_ROWS)
    }
    expect(uncoveredRecords('v-2k')).toBe(2000 - 7 * 256)
    expect(packs('v-2k', 'record')).toBeGreaterThan(0)
  }, 120_000)

  it("a second vault's compaction drains while a large vault's chains are still building", async () => {
    // #given: a 10,000-note vault whose chains a bootstrap started, then a
    // 600-note vault opened right after
    seedVault('u-big', 'v-big', 10_000)
    seedVault('u-small', 'v-small', 600)
    counted()
    const queue = createMemoryQueue()
    await open(queue, 'u-big', 'v-big')
    await open(queue, 'u-small', 'v-small')

    // #when: the consumer drains both, recording the large vault's backlog
    // each time a small-vault message finishes
    const bigBacklogWhenSmallRan: number[] = []
    const deliveries = await drain(queue, (delivery) => {
      if (delivery.body.vaultId === 'v-small')
        bigBacklogWhenSmallRan.push(backlog('v-big', 'record'))
    })

    // #then: the small vault drained while the large one still had full windows
    // left, because each message builds one invocation's budget and its next
    // hop queues behind the messages already waiting
    const smallDone = deliveries.findLastIndex((delivery) => delivery.body.vaultId === 'v-small')
    const bigDone = deliveries.findLastIndex((delivery) => delivery.body.vaultId === 'v-big')
    expect(deliveries.filter((delivery) => delivery.body.vaultId === 'v-small')).toHaveLength(3)
    expect(smallDone).toBeLessThan(bigDone)
    expect(bigBacklogWhenSmallRan.at(-1)).toBeGreaterThan(PACK_MIN_FILL_ROWS)
    for (const kind of ['record', 'crdt_snapshot', 'crdt_update'] as const) {
      expect(backlog('v-small', kind)).toBeLessThan(PACK_MIN_FILL_ROWS)
      expect(backlog('v-big', kind)).toBeLessThan(PACK_MIN_FILL_ROWS)
    }
    expect(Math.max(...deliveries.map((delivery) => delivery.subrequests))).toBeLessThan(1000)
  }, 300_000)
})
