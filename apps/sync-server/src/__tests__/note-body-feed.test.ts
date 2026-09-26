import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteBodyChange } from '@memry/contracts/sync-api'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { resolveSyncSubscription, type SyncSubscription } from '../lib/sync-types'
import { closeChangePage } from '../services/change-feed'
import {
  NOTE_BODY_INLINE_MAX_BYTES,
  getSnapshot,
  pruneUpdatesBeforeSnapshot,
  storeSnapshot,
  storeSnapshotBatch,
  storeUpdates
} from '../services/crdt'
import { reserveCursors } from '../services/cursor'
import { getChanges, type ChangesPage } from '../services/sync'

/**
 * #2295: note bodies (crdt_updates, crdt_snapshots) carry a server_cursor from
 * the one per-user sequence and are served through /sync/changes to a client
 * that declares `note_body`. Everything here runs the real SQL against the real
 * migration ledger.
 */

const USER_ID = 'user-feed'
const OTHER_USER = 'user-feed-other'
const VAULT_ID = 'default'
const DEVICE_ID = 'device-feed'

let harness: SqliteD1
let storage: R2Bucket

const WITH_BODIES = resolveSyncSubscription([...RECORD_SYNC_ITEM_TYPES, 'note_body'].join(','))
const RECORDS_ONLY = resolveSyncSubscription(RECORD_SYNC_ITEM_TYPES.join(','))

const bytes = (length: number, fill = 1): ArrayBuffer => new Uint8Array(length).fill(fill).buffer

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  for (const id of [USER_ID, OTHER_USER]) {
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, ?, 1, 'otp', 0, 0, 1, 1)`
      )
      .run(id, `${id}@example.com`)
    harness.raw
      .prepare(
        `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
         VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, 1)`
      )
      .run(id, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024)
  }
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

/** A sync_items row written through the real cursor allocator, one batch per call. */
const writeRecord = async (
  itemId: string,
  options: { deleted?: boolean; userId?: string; type?: string } = {}
): Promise<number> => {
  const userId = options.userId ?? USER_ID
  const cursors = reserveCursors(harness.db, userId, 1)
  const results = await harness.db.batch(
    cursors.batch([
      harness.db
        .prepare(
          `INSERT INTO sync_items (id, user_id, vault_id, item_type, item_id, blob_key, size_bytes, content_hash, version, signature, server_cursor, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'blob', 1, 'hash', 1, 'sig', ${cursors.cursorSql}, ?, 1, 1)
           ON CONFLICT (user_id, vault_id, item_type, item_id)
           DO UPDATE SET server_cursor = excluded.server_cursor, deleted_at = excluded.deleted_at`
        )
        .bind(
          `${userId}:${itemId}`,
          userId,
          VAULT_ID,
          options.type ?? 'task',
          itemId,
          ...cursors.cursorBinds(0),
          options.deleted ? 5 : null
        )
    ])
  )
  return cursors.cursorAt(results, 0)
}

const cursorsOf = (table: 'crdt_updates' | 'crdt_snapshots', noteId?: string): number[] =>
  (
    harness.raw
      .prepare(
        `SELECT server_cursor FROM ${table} WHERE user_id = ? ${noteId ? 'AND note_id = ?' : ''} ORDER BY server_cursor`
      )
      .all(...(noteId ? [USER_ID, noteId] : [USER_ID])) as Array<{ server_cursor: number | null }>
  ).map((row) => row.server_cursor as number)

const currentCursor = (userId = USER_ID): number =>
  (
    harness.raw
      .prepare('SELECT current_cursor FROM server_cursor_sequence WHERE user_id = ?')
      .get(userId) as { current_cursor: number }
  ).current_cursor

const read = (
  cursor: number,
  subscription: SyncSubscription,
  limit?: number,
  userId = USER_ID
): Promise<ChangesPage> => getChanges(harness.db, userId, cursor, limit, VAULT_ID, subscription)

/** Every served row across kinds, in page order, as `kind:id@cursor`. */
const servedCursors = (page: ChangesPage): number[] =>
  [
    ...page.items.map((item) => item.serverCursor as number),
    ...(page.noteBodies ?? []).map((body) => body.cursor)
  ].sort((a, b) => a - b)

describe('cursor allocation on CRDT writes (#2295)', () => {
  it('gives each stored update the next cursors, in batch order, and keeps sequence_num', async () => {
    await writeRecord('task-1')

    const sequences = await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [
      bytes(3),
      bytes(4),
      bytes(5)
    ])

    expect(sequences).toEqual([1, 2, 3])
    expect(cursorsOf('crdt_updates')).toEqual([2, 3, 4])
    const rows = harness.raw
      .prepare('SELECT sequence_num, server_cursor FROM crdt_updates ORDER BY sequence_num')
      .all() as Array<{ sequence_num: number; server_cursor: number }>
    expect(rows.map((row) => row.server_cursor)).toEqual([2, 3, 4])
    expect(currentCursor()).toBe(4)
  })

  it('re-cursors a snapshot on every write while its sequence_num stays pinned', async () => {
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(3)])
    const first = await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note-1',
      DEVICE_ID,
      bytes(10)
    )
    const [firstCursor] = cursorsOf('crdt_snapshots')
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(3)])
    const second = await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note-1',
      DEVICE_ID,
      bytes(12)
    )

    expect(first.sequenceNum).toBe(1)
    expect(second.sequenceNum).toBe(1)
    expect(firstCursor).toBe(2)
    expect(cursorsOf('crdt_snapshots')).toEqual([4])
    expect(currentCursor()).toBe(4)
  })

  it('gives a snapshot batch contiguous cursors in stored order, shrink statements included', async () => {
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note-a', snapshotData: bytes(50) }
    ])
    // note-a shrinks (a storage UPDATE rides in the batch), note-b and note-c are new.
    const outcomes = await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note-a', snapshotData: bytes(5) },
      { noteId: 'note-b', snapshotData: bytes(6) },
      { noteId: 'note-c', snapshotData: bytes(7) }
    ])

    expect(outcomes.every((outcome) => outcome.accepted)).toBe(true)
    const byNote = Object.fromEntries(
      (
        harness.raw
          .prepare('SELECT note_id, server_cursor FROM crdt_snapshots WHERE user_id = ?')
          .all(USER_ID) as Array<{ note_id: string; server_cursor: number }>
      ).map((row) => [row.note_id, row.server_cursor])
    )
    expect(byNote).toEqual({ 'note-a': 2, 'note-b': 3, 'note-c': 4 })
    expect(currentCursor()).toBe(4)
  })
})

describe('/sync/changes negotiation of note bodies (#2295)', () => {
  it('serves no CRDT row and no noteBodies key to a client that did not declare note_body', async () => {
    await writeRecord('task-1')
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(3)])
    await writeRecord('task-2')

    for (const subscription of [RECORDS_ONLY, resolveSyncSubscription(undefined)]) {
      const page = await read(0, subscription)
      expect(Object.keys(page).sort()).toEqual(['deleted', 'hasMore', 'items', 'nextCursor'])
      expect(page.items.map((item) => item.id)).toEqual(['task-1', 'task-2'])
      expect(page.nextCursor).toBe(3)
    }
  })

  it('interleaves records, updates and snapshots in cursor order when note_body is declared', async () => {
    await writeRecord('task-1') // 1
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(3), bytes(4)]) // 2, 3
    await writeRecord('task-2', { deleted: true }) // 4
    const snapshot = await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note-2',
      DEVICE_ID,
      bytes(9)
    ) // 5
    await writeRecord('task-3') // 6

    const page = await read(0, WITH_BODIES)

    expect(page.items.map((item) => [item.id, item.serverCursor])).toEqual([
      ['task-1', 1],
      ['task-3', 6]
    ])
    expect(page.deleted).toEqual(['task-2'])
    expect(page.noteBodies).toEqual([
      {
        op: 'update',
        noteId: 'note-1',
        cursor: 2,
        sequenceNum: 1,
        signerDeviceId: DEVICE_ID,
        createdAt: expect.any(Number),
        size: 3,
        data: Buffer.from(bytes(3)).toString('base64')
      },
      {
        op: 'update',
        noteId: 'note-1',
        cursor: 3,
        sequenceNum: 2,
        signerDeviceId: DEVICE_ID,
        createdAt: expect.any(Number),
        size: 4,
        data: Buffer.from(bytes(4)).toString('base64')
      },
      {
        op: 'snapshot',
        noteId: 'note-2',
        cursor: 5,
        sequenceNum: 0,
        revision: snapshot.revision,
        signerDeviceId: DEVICE_ID,
        createdAt: expect.any(Number),
        size: 9
      }
    ] satisfies NoteBodyChange[])
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBe(6)
  })

  it('ends nextCursor on the last served row across kinds', async () => {
    await writeRecord('task-1')
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(3)])

    const page = await read(0, WITH_BODIES)

    expect(page.nextCursor).toBe(2)
    expect(page.noteBodies?.map((body) => body.cursor)).toEqual([2])
  })

  it('never serves a pre-migration row with a NULL cursor', async () => {
    harness.raw
      .prepare(
        `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at)
         VALUES ('legacy-u', ?, ?, 'note-old', x'0102', 1, ?, 1)`
      )
      .run(USER_ID, VAULT_ID, DEVICE_ID)
    harness.raw
      .prepare(
        `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
         VALUES ('legacy-s', ?, ?, 'note-old', 'k', 1, 2, ?, 1, '')`
      )
      .run(USER_ID, VAULT_ID, DEVICE_ID)
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-new', DEVICE_ID, [bytes(1)])

    const page = await read(0, WITH_BODIES)

    expect(page.noteBodies?.map((body) => body.noteId)).toEqual(['note-new'])
  })

  it('serves bodies alone to a header that declares only note_body', async () => {
    await writeRecord('task-1')
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(1)])

    const page = await read(0, resolveSyncSubscription('note_body'))

    expect(page.items).toEqual([])
    expect(page.deleted).toEqual([])
    expect(page.noteBodies?.map((body) => body.cursor)).toEqual([2])
    expect(page.nextCursor).toBe(2)
  })

  it('answers an empty page with an empty noteBodies array and the same cursor', async () => {
    const page = await read(7, WITH_BODIES)
    expect(page).toEqual({ items: [], deleted: [], hasMore: false, nextCursor: 7, noteBodies: [] })
  })

  it('keeps other users and other vaults out of the feed', async () => {
    await storeUpdates(harness.db, OTHER_USER, VAULT_ID, 'note-x', DEVICE_ID, [bytes(1)])
    await storeUpdates(harness.db, USER_ID, 'vault-2', 'note-y', DEVICE_ID, [bytes(1)])
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-z', DEVICE_ID, [bytes(1)])

    const page = await read(0, WITH_BODIES)

    expect(page.noteBodies?.map((body) => body.noteId)).toEqual(['note-z'])
  })

  it('inlines an update up to the threshold and serves a larger one as a ref without data', async () => {
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [
      bytes(NOTE_BODY_INLINE_MAX_BYTES, 2),
      bytes(NOTE_BODY_INLINE_MAX_BYTES + 1, 3)
    ])

    const [inline, ref] = (await read(0, WITH_BODIES)).noteBodies as Array<
      Extract<NoteBodyChange, { op: 'update' }>
    >

    expect(inline.data).toBe(Buffer.from(bytes(NOTE_BODY_INLINE_MAX_BYTES, 2)).toString('base64'))
    expect(inline.size).toBe(NOTE_BODY_INLINE_MAX_BYTES)
    expect(ref).not.toHaveProperty('data')
    expect(ref.size).toBe(NOTE_BODY_INLINE_MAX_BYTES + 1)
    expect(ref.sequenceNum).toBe(2)
  })

  it('advertises the same snapshot revision the snapshot GET returns, legacy rows included', async () => {
    await storeSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, bytes(4))
    harness.raw.prepare(`UPDATE crdt_snapshots SET revision = ''`).run()

    const [entry] = (await read(0, WITH_BODIES)).noteBodies as Array<
      Extract<NoteBodyChange, { op: 'snapshot' }>
    >
    const fetched = await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-1')

    expect(entry.revision).toMatch(/^legacy:/)
    expect(entry.revision).toBe(fetched?.revision)
  })

  it('clamps a note_body page to 100 rows and keeps the record-only ceiling at 500', async () => {
    await storeUpdates(
      harness.db,
      USER_ID,
      VAULT_ID,
      'note-1',
      DEVICE_ID,
      Array.from({ length: 100 }, () => bytes(1))
    )
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(1)])
    for (let i = 0; i < 3; i++) await writeRecord(`task-${i}`)

    const bodies = await read(0, WITH_BODIES, 500)
    expect(bodies.noteBodies).toHaveLength(100)
    expect(bodies.hasMore).toBe(true)
    expect(bodies.nextCursor).toBe(100)

    const records = await read(0, RECORDS_ONLY, 500)
    expect(records.items).toHaveLength(3)
    expect(records.hasMore).toBe(false)
  })

  it('reads a merged page in ONE batch, never in separate reads', async () => {
    await writeRecord('task-1')
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(1)])
    const batch = vi.spyOn(harness.db, 'batch')
    const prepare = vi.spyOn(harness.db, 'prepare')

    await read(0, WITH_BODIES)

    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toHaveLength(prepare.mock.calls.length)
  })
})

describe('page closure across tables (#2295)', () => {
  it('serves every row exactly once, in cursor order, for every page size', async () => {
    // A seeded interleaving: records, deletes, updates to two notes, snapshot
    // re-writes (which move a snapshot to a newer cursor) and a prune.
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let step = 0; step < 40; step++) {
      const choice = next() % 5
      if (choice === 0) await writeRecord(`task-${next() % 6}`)
      if (choice === 1) await writeRecord(`task-${next() % 6}`, { deleted: true })
      if (choice === 2)
        await storeUpdates(harness.db, USER_ID, VAULT_ID, `note-${next() % 2}`, DEVICE_ID, [
          bytes(1 + (next() % 3))
        ])
      if (choice === 3)
        await storeSnapshot(
          harness.db,
          storage,
          USER_ID,
          VAULT_ID,
          `note-${next() % 2}`,
          DEVICE_ID,
          bytes(4)
        )
      if (choice === 4) await pruneUpdatesBeforeSnapshot(harness.db, USER_ID, VAULT_ID, 'note-0')
    }

    const liveCursors = [
      ...(
        harness.raw
          .prepare('SELECT server_cursor FROM sync_items WHERE user_id = ?')
          .all(USER_ID) as Array<{ server_cursor: number }>
      ).map((row) => row.server_cursor),
      ...cursorsOf('crdt_updates'),
      ...cursorsOf('crdt_snapshots')
    ].sort((a, b) => a - b)

    for (const limit of [1, 2, 3, 4, 5]) {
      const seen: number[] = []
      let cursor = 0
      for (;;) {
        const page = await read(cursor, WITH_BODIES, limit)
        const tombstoneCursors = (
          harness.raw
            .prepare(
              `SELECT server_cursor FROM sync_items WHERE user_id = ? AND deleted_at IS NOT NULL AND server_cursor > ? AND server_cursor <= ?`
            )
            .all(USER_ID, cursor, page.nextCursor) as Array<{ server_cursor: number }>
        ).map((row) => row.server_cursor)
        const served = [...servedCursors(page), ...tombstoneCursors].sort((a, b) => a - b)
        expect(served.length).toBeLessThanOrEqual(limit)
        expect(page.nextCursor).toBeGreaterThanOrEqual(cursor)
        if (served.length > 0) expect(page.nextCursor).toBe(served[served.length - 1])
        seen.push(...served)
        if (!page.hasMore) break
        cursor = page.nextCursor
      }
      expect(seen).toEqual(liveCursors)
    }
  })

  it('delivers a first snapshot above every update it prunes to a reader mid-way', async () => {
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, [bytes(1), bytes(2)]) // 1, 2
    const firstPage = await read(0, WITH_BODIES, 1)
    expect(firstPage.nextCursor).toBe(1)

    await storeSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-1', DEVICE_ID, bytes(8)) // 3
    await pruneUpdatesBeforeSnapshot(harness.db, USER_ID, VAULT_ID, 'note-1')

    const rest = await read(firstPage.nextCursor, WITH_BODIES)
    expect(rest.noteBodies?.map((body) => [body.op, body.cursor])).toEqual([['snapshot', 3]])
  })
})

describe('closeChangePage (#2295)', () => {
  const row = (cursor: number, value: string | null = `v${cursor}`) => ({ cursor, value })

  it('merges slices by cursor and closes the page on the last taken row', () => {
    const page = closeChangePage(
      [
        [row(1), row(4), row(5)],
        [row(2), row(3)]
      ],
      0,
      3
    )
    expect(page).toEqual({ entries: ['v1', 'v2', 'v3'], hasMore: true, nextCursor: 3 })
  })

  it('counts a row it must not serve toward the page and the cursor', () => {
    const page = closeChangePage([[row(1), row(2, null)], [row(3)]], 0, 2)
    expect(page).toEqual({ entries: ['v1'], hasMore: true, nextCursor: 2 })
  })

  it('keeps the cursor where it was on an empty page', () => {
    expect(closeChangePage([[], []], 9, 5)).toEqual({ entries: [], hasMore: false, nextCursor: 9 })
  })
})
