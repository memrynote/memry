import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CRDT_SNAPSHOT_NOT_COVERED } from '@memry/contracts/sync-api'
import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { errorHandler, ErrorCodes } from '../lib/errors'
import { generateCrdtKey } from '../services/blob'
import {
  getBatchUpdates,
  getSnapshot,
  getUpdates,
  pruneUpdatesBeforeSnapshot,
  storeSnapshot,
  storeSnapshotBatch,
  type SnapshotClaim
} from '../services/crdt'
import type { AppContext, Bindings } from '../types'

/**
 * #2299: a snapshot push may claim `coversThrough`, the feed cursor through
 * which the pushed state holds every note_body row. The server then prunes by
 * cursor, moves the watermark only over what it pruned, and records the claim
 * on the row. From then on the pruned rows exist only inside that snapshot, so
 * the upsert refuses every write that does not cover them. These tests assert
 * what the stored snapshot holds, not only its watermark.
 */

const USER_ID = 'user-covers-through'
const VAULT_ID = 'default'
const DEVICE_ID = 'device-pusher'
const PEER_ID = 'device-peer'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', USER_ID)
    c.set('deviceId', DEVICE_ID)
    await next()
  }
}))

const { sync } = await import('../routes/sync')

let harness: SqliteD1
let storage: R2Bucket

const now = (): number => Math.floor(Date.now() / 1000)

const bytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value)
  const copy = new Uint8Array(encoded.byteLength)
  copy.set(encoded)
  return copy.buffer
}

/** An update row at an exact sequence and cursor; `null` is a pre-0011 row. */
const insertUpdate = (noteId: string, sequenceNum: number, cursor: number | null): void => {
  harness.raw
    .prepare(
      `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at, server_cursor)
       VALUES (?, ?, ?, ?, x'0102', ?, ?, 1, ?)`
    )
    .run(`${noteId}-u${sequenceNum}`, USER_ID, VAULT_ID, noteId, sequenceNum, PEER_ID, cursor)
}

/** Makes the next reserved cursor `value + 1`, above the rows inserted by hand. */
const setCursorSequence = (value: number): void => {
  harness.raw
    .prepare(
      `INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET current_cursor = excluded.current_cursor`
    )
    .run(USER_ID, value)
}

const remainingSequences = (noteId: string): number[] =>
  (
    harness.raw
      .prepare(
        'SELECT sequence_num FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ? ORDER BY sequence_num'
      )
      .all(USER_ID, VAULT_ID, noteId) as Array<{ sequence_num: number }>
  ).map((row) => row.sequence_num)

interface Row {
  sequence_num: number
  server_cursor: number | null
  revision: string
  covers_through: number | null
  blob_key: string
  signer_device_id: string
}

const snapshotRow = (noteId: string): Row | undefined =>
  harness.raw
    .prepare(
      'SELECT sequence_num, server_cursor, revision, covers_through, blob_key, signer_device_id FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
    )
    .get(USER_ID, VAULT_ID, noteId) as Row | undefined

/** What a reader downloads for the note: the bytes the row points at. */
const storedBody = async (noteId: string): Promise<string | null> => {
  const snapshot = await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, noteId)
  return snapshot ? new TextDecoder().decode(snapshot.snapshotData) : null
}

const objectExists = async (key: string): Promise<boolean> => (await storage.get(key)) !== null

const storageUsed = (): number =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used

const claim = (coversThrough: number, baseRevision?: string): SnapshotClaim => ({
  coversThrough,
  baseRevision
})

const push = (
  noteId: string,
  body: string,
  snapshotClaim?: SnapshotClaim,
  signer = DEVICE_ID,
  bucket = storage
): Promise<{ sequenceNum: number; revision: string }> =>
  storeSnapshot(
    harness.db,
    bucket,
    USER_ID,
    VAULT_ID,
    noteId,
    signer,
    bytes(body),
    null,
    snapshotClaim
  )

/** An unclaimed push and its separate pre-#2299 prune, as the route runs it. */
const pushUnclaimed = async (
  noteId: string,
  body: string,
  signer = DEVICE_ID
): Promise<{ sequenceNum: number; revision: string }> => {
  const stored = await push(noteId, body, undefined, signer)
  await pruneUpdatesBeforeSnapshot(harness.db, USER_ID, VAULT_ID, noteId)
  return stored
}

/** An R2 bucket whose next `put` waits for `release()`. */
const gatedBucket = (): { bucket: R2Bucket; blocked: () => boolean; release: () => void } => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = true
  let waiting = false
  const put = storage.put.bind(storage)
  const bucket = Object.create(storage) as R2Bucket
  bucket.put = (async (key: string, value: ArrayBuffer) => {
    if (armed) {
      armed = false
      waiting = true
      await gate
    }
    return put(key, value)
  }) as R2Bucket['put']
  return { bucket, blocked: () => waiting, release }
}

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'covers-through@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
})

afterEach(() => {
  harness.close()
})

describe('a claimed push prunes by cursor (#2299)', () => {
  it('prunes the updates at or below coversThrough = 50 and leaves the update at cursor 51', async () => {
    insertUpdate('note-1', 1, 48)
    insertUpdate('note-1', 2, 49)
    insertUpdate('note-1', 3, 50)
    insertUpdate('note-1', 4, 51)
    setCursorSequence(51)

    const stored = await push('note-1', 'state-through-50', claim(50))

    expect(remainingSequences('note-1')).toEqual([4])
    expect(stored.sequenceNum).toBe(3)
    expect(snapshotRow('note-1')).toMatchObject({ sequence_num: 3, covers_through: 50 })
    expect(await storedBody('note-1')).toBe('state-through-50')
  })

  it("keeps today's rule without the field: the first snapshot takes the whole log", async () => {
    insertUpdate('note-1', 1, 48)
    insertUpdate('note-1', 2, 51)
    setCursorSequence(51)

    const stored = await pushUnclaimed('note-1', 'state')

    expect(stored.sequenceNum).toBe(2)
    expect(remainingSequences('note-1')).toEqual([])
    expect(snapshotRow('note-1')?.covers_through).toBeNull()
  })

  it("keeps today's rule without the field: a second snapshot keeps the pinned watermark", async () => {
    insertUpdate('note-1', 1, 10)
    setCursorSequence(10)
    await pushUnclaimed('note-1', 'first')
    insertUpdate('note-1', 2, 20)
    insertUpdate('note-1', 3, 21)
    setCursorSequence(21)

    const stored = await pushUnclaimed('note-1', 'second', PEER_ID)

    expect(stored.sequenceNum).toBe(1)
    expect(remainingSequences('note-1')).toEqual([2, 3])
    expect(await storedBody('note-1')).toBe('second')
  })

  it('never prunes a NULL-cursor row and stops the watermark below it', async () => {
    insertUpdate('note-1', 1, 10)
    insertUpdate('note-1', 2, null)
    insertUpdate('note-1', 3, 12)
    setCursorSequence(12)

    const stored = await push('note-1', 'state', claim(50))

    expect(stored.sequenceNum).toBe(1)
    expect(remainingSequences('note-1')).toEqual([2, 3])
  })

  it('prunes nothing when the lowest row has no cursor', async () => {
    insertUpdate('note-1', 1, null)
    insertUpdate('note-1', 2, 10)
    setCursorSequence(10)

    const stored = await push('note-1', 'state', claim(50))

    expect(stored.sequenceNum).toBe(0)
    expect(remainingSequences('note-1')).toEqual([1, 2])
  })

  it('moves the watermark so a §7.8 client past the old one re-fetches the snapshot', async () => {
    insertUpdate('note-1', 1, 10)
    insertUpdate('note-1', 2, 11)
    setCursorSequence(11)
    await pushUnclaimed('note-1', 'old-rule', PEER_ID)
    insertUpdate('note-1', 3, 20)
    insertUpdate('note-1', 4, 21)
    insertUpdate('note-1', 5, 22)
    insertUpdate('note-1', 6, 23)
    setCursorSequence(23)

    const stored = await push('note-1', 'covers-22', claim(22))
    expect(stored.sequenceNum).toBe(5)

    const batch = await getBatchUpdates(
      harness.db,
      USER_ID,
      VAULT_ID,
      [{ noteId: 'note-1', since: 4 }],
      100
    )
    expect(batch.snapshotMeta['note-1'].sequenceNum).toBeGreaterThan(4)
    const incrementals = await getUpdates(harness.db, USER_ID, VAULT_ID, 'note-1', 4)
    expect(incrementals.updates.map((update) => update.sequence_num)).toEqual([6])
    expect(await storedBody('note-1')).toBe('covers-22')
  })
})

describe('the claimed snapshot is never replaced by one that does not cover it (#2299)', () => {
  /** A covered row: the update at cursor 22 exists only inside `covers-22`. */
  const coveredNote = async (): Promise<void> => {
    insertUpdate('note-1', 1, 10)
    insertUpdate('note-1', 2, 11)
    setCursorSequence(11)
    await pushUnclaimed('note-1', 'old-rule', PEER_ID)
    insertUpdate('note-1', 3, 20)
    insertUpdate('note-1', 4, 21)
    insertUpdate('note-1', 5, 22)
    setCursorSequence(22)
  }

  // review A-3/B-1 rewrite of the concurrent old-rule test
  it('refuses an unclaimed push that raced a claimed one, and the covering blob stays', async () => {
    await coveredNote()
    const { bucket, blocked, release } = gatedBucket()

    const stale = push('note-1', 'old-client', undefined, PEER_ID, bucket)
    await vi.waitFor(() => expect(blocked()).toBe(true))
    await push('note-1', 'covers-22', claim(22))
    release()

    await expect(stale).rejects.toMatchObject({ code: CRDT_SNAPSHOT_NOT_COVERED, statusCode: 409 })
    expect(snapshotRow('note-1')?.sequence_num).toBe(5)
    expect(await storedBody('note-1')).toBe('covers-22')
    expect(remainingSequences('note-1')).toEqual([])
  })

  it('refuses an unclaimed push onto a claimed row, with nothing written', async () => {
    await coveredNote()
    await push('note-1', 'covers-22', claim(22))
    const before = snapshotRow('note-1')
    const usedBefore = storageUsed()

    await expect(push('note-1', 'old-client-state', undefined, PEER_ID)).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      statusCode: 409
    })

    expect(snapshotRow('note-1')).toEqual(before)
    expect(await storedBody('note-1')).toBe('covers-22')
    expect(storageUsed()).toBe(usedBefore)
  })

  // #2299 review round 2 (A-1, B-M1): a device id is no proof of state
  it('refuses an older encode of the same device with the 409, not a no-op', async () => {
    await coveredNote()
    const newer = await push('note-1', 'covers-22', claim(22))

    await expect(push('note-1', 'covers-10', claim(10))).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      statusCode: 409,
      blockingCursor: snapshotRow('note-1')?.server_cursor
    })
    expect(await storedBody('note-1')).toBe('covers-22')
    expect(snapshotRow('note-1')).toMatchObject({ covers_through: 22, revision: newer.revision })
  })

  // #2299 review round 2 (A-1, B-H1)
  it('refuses an equal-cursor stale own encode after a base-arm write took a peer pruning snapshot', async () => {
    setCursorSequence(40)
    const own = await push('note-1', 'own-at-40', claim(40))
    insertUpdate('note-1', 1, 55)
    insertUpdate('note-1', 2, 60)
    setCursorSequence(65)
    const peer = await push('note-1', 'peer-with-55-60', claim(65), PEER_ID)
    expect(remainingSequences('note-1')).toEqual([])

    // S2: this device merged the peer snapshot (base arm) with its feed at 50.
    await push('note-1', 'own-with-peer-rows', claim(50, peer.revision))
    expect(snapshotRow('note-1')?.covers_through).toBe(65)

    // S1: the stale encode from before, retried with its old base.
    await expect(
      push('note-1', 'own-without-peer-rows', claim(50, own.revision))
    ).rejects.toMatchObject({ code: CRDT_SNAPSHOT_NOT_COVERED, statusCode: 409 })
    expect(await storedBody('note-1')).toBe('own-with-peer-rows')
  })

  // #2299 review round 2 (A-1): a lost response resends committed bytes
  it('refuses a lost-response retry of committed bytes, and the next push passes by baseRevision', async () => {
    setCursorSequence(40)
    const base = await push('note-1', 'base', claim(40))
    setCursorSequence(50)
    const committed = await push('note-1', 'edit', claim(50, base.revision))

    await expect(push('note-1', 'edit', claim(50, base.revision))).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      blockingCursor: snapshotRow('note-1')?.server_cursor
    })

    await push('note-1', 'after-pull', claim(50, committed.revision))
    expect(await storedBody('note-1')).toBe('after-pull')
  })

  // #2299 review round 2 (A-5): a restored data dir keeps its device id
  it('refuses a restored device whose own stored snapshot covers more', async () => {
    setCursorSequence(70)
    await push('note-1', 'pre-restore-covers-70', claim(70))

    await expect(push('note-1', 'restored-at-50', claim(50))).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED
    })
    expect(await storedBody('note-1')).toBe('pre-restore-covers-70')
  })

  it('refuses a peer snapshot above the claim, prunes nothing, and names the blocking cursor', async () => {
    insertUpdate('note-1', 1, 45)
    setCursorSequence(60)
    const peer = await push('note-1', 'peer-state', claim(60), PEER_ID)
    insertUpdate('note-1', 2, 62)
    const usedBefore = storageUsed()

    const attempt = push('note-1', 'pusher-state', claim(50))

    await expect(attempt).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      statusCode: 409,
      blockingCursor: 61
    })
    expect(snapshotRow('note-1')?.revision).toBe(peer.revision)
    expect(await storedBody('note-1')).toBe('peer-state')
    expect(remainingSequences('note-1')).toEqual([2])
    expect(storageUsed()).toBe(usedBefore)
  })

  it('prunes only when its upsert applied', async () => {
    // An unclaimed peer snapshot pinned at 0, then rows the refused push covers.
    setCursorSequence(10)
    await pushUnclaimed('note-1', 'peer-first', PEER_ID)
    insertUpdate('note-1', 1, 20)
    insertUpdate('note-1', 2, 30)
    setCursorSequence(60)
    await pushUnclaimed('note-1', 'peer-second', PEER_ID)

    await expect(push('note-1', 'pusher', claim(50))).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      blockingCursor: 61
    })

    expect(remainingSequences('note-1')).toEqual([1, 2])
    expect(await storedBody('note-1')).toBe('peer-second')
  })

  it('lets a push through when its baseRevision still names the stored snapshot', async () => {
    setCursorSequence(60)
    const peer = await push('note-1', 'peer-state', claim(60), PEER_ID)

    await push('note-1', 'merged-peer-state', claim(50, peer.revision))

    expect(await storedBody('note-1')).toBe('merged-peer-state')
    await expect(
      push('note-1', 'stale-base', claim(50, peer.revision), PEER_ID)
    ).rejects.toMatchObject({ code: CRDT_SNAPSHOT_NOT_COVERED })
  })

  it('lets a peer replace a claimed snapshot once its feed has passed that snapshot', async () => {
    setCursorSequence(60)
    await push('note-1', 'pusher-state', claim(60))
    const row = snapshotRow('note-1') as Row

    await push('note-1', 'peer-after-reading', claim(row.server_cursor as number), PEER_ID)

    expect(await storedBody('note-1')).toBe('peer-after-reading')
  })

  it('treats a legacy snapshot (no cursor, no claim) as replaceable', async () => {
    await push('note-1', 'legacy-peer', undefined, PEER_ID)
    harness.raw.prepare('UPDATE crdt_snapshots SET server_cursor = NULL').run()

    await push('note-1', 'pusher', claim(50))

    expect(await storedBody('note-1')).toBe('pusher')
  })

  it('never lets the loser of two concurrent claimed pushes become the stored blob', async () => {
    insertUpdate('note-1', 1, 40)
    setCursorSequence(40)
    await push('note-1', 'base', claim(40), PEER_ID)
    insertUpdate('note-1', 2, 55)
    setCursorSequence(60)
    const { bucket, blocked, release } = gatedBucket()

    // B read the feed through 50, A through 60; both see the base snapshot.
    const loser = push('note-1', 'b-without-55', claim(50), 'device-b', bucket)
    await vi.waitFor(() => expect(blocked()).toBe(true))
    await push('note-1', 'a-with-55', claim(60), 'device-a')
    release()

    await expect(loser).rejects.toMatchObject({ code: CRDT_SNAPSHOT_NOT_COVERED })
    expect(await storedBody('note-1')).toBe('a-with-55')
    expect(snapshotRow('note-1')?.signer_device_id).toBe('device-a')
    expect(remainingSequences('note-1')).toEqual([])
  })
})

describe('snapshot objects (#2299)', () => {
  it('replaces a legacy fixed-key object with a per-write key and deletes the old object', async () => {
    const fixed = generateCrdtKey(USER_ID, 'note-1', VAULT_ID)
    await push('note-1', 'legacy', undefined, PEER_ID)
    harness.raw.prepare('UPDATE crdt_snapshots SET blob_key = ?').run(fixed)
    await storage.put(fixed, bytes('legacy'))
    const first = snapshotRow('note-1')?.blob_key as string

    const stored = await push('note-1', 'next', claim(10))

    const row = snapshotRow('note-1') as Row
    expect(row.blob_key).toBe(`${fixed}/${stored.revision}`)
    expect(await objectExists(fixed)).toBe(false)
    expect(await objectExists(first)).toBe(false)
    expect(await storedBody('note-1')).toBe('next')
  })

  it('deletes the replaced object after each write and the object of a refused write', async () => {
    const first = await push('note-1', 'one', claim(10))
    const firstKey = snapshotRow('note-1')?.blob_key as string
    expect(firstKey.endsWith(first.revision)).toBe(true)

    await push('note-1', 'two', claim(10))
    const secondKey = snapshotRow('note-1')?.blob_key as string
    expect(await objectExists(firstKey)).toBe(false)
    expect(await objectExists(secondKey)).toBe(true)

    setCursorSequence(100)
    await push('note-1', 'peer', claim(100), PEER_ID)
    const put = vi.spyOn(storage, 'put')
    await expect(push('note-1', 'refused', claim(50))).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED
    })
    const refusedKey = put.mock.calls[0][0] as string
    expect(await objectExists(refusedKey)).toBe(false)
  })

  // #2299 review round 2 (A-2, B-L2): a legacy retry costs a D1 read only
  it('refuses an unclaimed push onto a claimed row before any R2 put', async () => {
    setCursorSequence(10)
    await push('note-1', 'claimed', claim(10))
    const put = vi.spyOn(storage, 'put')

    await expect(push('note-1', 'legacy-client', undefined, PEER_ID)).rejects.toMatchObject({
      code: CRDT_SNAPSHOT_NOT_COVERED,
      statusCode: 409,
      blockingCursor: snapshotRow('note-1')?.server_cursor
    })
    expect(put).not.toHaveBeenCalled()
  })

  /** Makes the next D1 batch that changes note-1's row throw after it committed. */
  const throwAfterCommit = (): void => {
    const batch = harness.db.batch.bind(harness.db)
    const before = snapshotRow('note-1')?.revision
    let armed = true
    harness.db.batch = (async (statements: D1PreparedStatement[]) => {
      const result = await batch(statements)
      if (armed && snapshotRow('note-1')?.revision !== before) {
        armed = false
        throw new Error('D1_ERROR: Network connection lost')
      }
      return result
    }) as D1Database['batch']
  }

  // #2299 review round 2 (A-3, B-M3)
  it('answers success and keeps the object when the batch committed and then threw', async () => {
    insertUpdate('note-1', 1, 40)
    setCursorSequence(40)
    await push('note-1', 'first', claim(40))
    const previousKey = snapshotRow('note-1')?.blob_key as string
    insertUpdate('note-1', 2, 50)
    setCursorSequence(50)
    throwAfterCommit()

    const stored = await push('note-1', 'second', claim(50))

    expect(snapshotRow('note-1')).toMatchObject({ revision: stored.revision })
    expect(remainingSequences('note-1')).toEqual([])
    expect(await storedBody('note-1')).toBe('second')
    // The replaced object's key is unknown after an ambiguous commit: an orphan.
    expect(await objectExists(previousKey)).toBe(true)
  })

  it('deletes the object of a write whose batch threw without committing', async () => {
    const put = vi.spyOn(storage, 'put')
    const batch = harness.db.batch.bind(harness.db)
    let calls = 0
    harness.db.batch = (async (statements: D1PreparedStatement[]) => {
      calls += 1
      // Stage 1 metadata, then the covered watermark, then the commit.
      if (calls === 3) throw new Error('D1_ERROR: Network connection lost')
      return batch(statements)
    }) as D1Database['batch']

    await expect(push('note-1', 'lost', claim(10))).rejects.toThrow('Network connection lost')

    expect(snapshotRow('note-1')).toBeUndefined()
    expect(await objectExists(put.mock.calls[0][0] as string)).toBe(false)
  })

  it('deletes nothing when the batch threw and the re-read failed too', async () => {
    const put = vi.spyOn(storage, 'put')
    const batch = harness.db.batch.bind(harness.db)
    let calls = 0
    harness.db.batch = (async (statements: D1PreparedStatement[]) => {
      calls += 1
      if (calls >= 3) throw new Error('D1_ERROR: Network connection lost')
      return batch(statements)
    }) as D1Database['batch']

    await expect(push('note-1', 'unknown', claim(10))).rejects.toThrow('Network connection lost')

    expect(await objectExists(put.mock.calls[0][0] as string)).toBe(true)
  })
})

describe('a reader racing the replace (#2299 review round 2, A-4, B-L1)', () => {
  it('fetches the new object when the row moved under it', async () => {
    const first = await push('note-1', 'first', claim(10))
    const firstKey = snapshotRow('note-1')?.blob_key as string
    const get = storage.get.bind(storage)
    let raced = false
    storage.get = (async (key: string) => {
      if (key === firstKey && !raced) {
        raced = true
        await push('note-1', 'second', claim(10, first.revision))
      }
      return get(key)
    }) as R2Bucket['get']

    const snapshot = await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-1')

    expect(raced).toBe(true)
    expect(new TextDecoder().decode(snapshot?.snapshotData)).toBe('second')
    expect(snapshot?.revision).toBe(snapshotRow('note-1')?.revision)
  })

  it('answers a retryable 503, never no snapshot, when the row still names a missing object', async () => {
    await push('note-1', 'first', claim(10))
    await storage.delete(snapshotRow('note-1')?.blob_key as string)

    await expect(
      getSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-1')
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, 'note-2')).toBeNull()
  })
})

describe('storeSnapshotBatch (#2299)', () => {
  it('applies the claim and the refusals per note', async () => {
    insertUpdate('note-covered', 1, 50)
    insertUpdate('note-covered', 2, 51)
    insertUpdate('note-plain', 1, 52)
    setCursorSequence(60)
    await push('note-unseen', 'peer-state', claim(60), PEER_ID)
    await push('note-own', 'own-newer', claim(60))

    const outcomes = await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note-covered', snapshotData: bytes('a'), claim: claim(50) },
      { noteId: 'note-plain', snapshotData: bytes('b') },
      { noteId: 'note-unseen', snapshotData: bytes('c'), claim: claim(50) },
      { noteId: 'note-own', snapshotData: bytes('own-older'), claim: claim(40) }
    ])

    expect(outcomes).toEqual([
      // #2420: an applied write names its row's cursor; the older encode wrote none.
      {
        noteId: 'note-covered',
        accepted: true,
        sequenceNum: 1,
        revision: expect.any(String),
        cursor: 63
      },
      {
        noteId: 'note-plain',
        accepted: true,
        sequenceNum: 1,
        revision: expect.any(String),
        cursor: 64
      },
      {
        noteId: 'note-unseen',
        accepted: false,
        reason: CRDT_SNAPSHOT_NOT_COVERED,
        blockingCursor: 61
      },
      {
        noteId: 'note-own',
        accepted: false,
        reason: CRDT_SNAPSHOT_NOT_COVERED,
        blockingCursor: snapshotRow('note-own')?.server_cursor
      }
    ])
    expect(remainingSequences('note-covered')).toEqual([2])
    expect(await storedBody('note-unseen')).toBe('peer-state')
    expect(await storedBody('note-own')).toBe('own-newer')
  })
})

describe('the snapshot routes carry the claim (#2299)', () => {
  let env: Bindings

  const buildApp = (): Hono<AppContext> => {
    const app = new Hono<AppContext>()
    app.onError(errorHandler)
    app.route('/sync', sync)
    return app
  }

  const request = async (path: string, init: RequestInit): Promise<Response> =>
    await buildApp().request(
      path,
      init,
      env as unknown as Record<string, unknown>,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined
      } as unknown as ExecutionContext
    )

  const post = (path: string, body: unknown): Promise<Response> =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

  const b64 = (value: string): string => Buffer.from(value).toString('base64')

  beforeEach(() => {
    harness.raw
      .prepare(
        `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
         VALUES (?, ?, 'Desktop', 'desktop', '1.0.0', 'key', ?, ?)`
      )
      .run(DEVICE_ID, USER_ID, now(), now())
    harness.raw
      .prepare(
        `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run('vault-row', USER_ID, VAULT_ID, now(), now())
    setDesktopFloor('1.0.0')
    env = {
      DB: harness.db,
      STORAGE: storage,
      ENVIRONMENT: 'development',
      CRDT_CLAIM_MIN_DESKTOP_VERSION: '1.0.0',
      USER_SYNC_STATE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) })
      },
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => Response.json({ count: 1, windowStart: now() })
        })
      }
    } as unknown as Bindings
  })

  const setDesktopFloor = (floor: string | null): void => {
    harness.raw
      .prepare(
        `INSERT INTO client_policies (platform, min_write_version, writes_enabled, updated_at)
         VALUES ('desktop', ?, 1, ?)
         ON CONFLICT (platform) DO UPDATE SET min_write_version = excluded.min_write_version`
      )
      .run(floor, now())
  }

  /** A claimed push onto rows at cursors 50 and 51, and what it left. */
  const claimedPushOutcome = async (): Promise<unknown> => {
    insertUpdate('note-1', 1, 50)
    insertUpdate('note-1', 2, 51)
    setCursorSequence(51)
    const res = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('state'),
      coversThrough: 50
    })
    return {
      status: res.status,
      sequenceNum: ((await res.json()) as { sequenceNum: number }).sequenceNum,
      remaining: remainingSequences('note-1'),
      coversThrough: snapshotRow('note-1')?.covers_through
    }
  }

  const legacyOutcome = { status: 200, sequenceNum: 2, remaining: [], coversThrough: null }

  // #2299 review round 2 (A-2, B-L2): claims stay dormant until old desktops cannot write
  it('treats a claim as an unclaimed push while the env var is unset', async () => {
    env = { ...env, CRDT_CLAIM_MIN_DESKTOP_VERSION: undefined }
    expect(await claimedPushOutcome()).toEqual(legacyOutcome)
  })

  it('treats a claim as an unclaimed push while the desktop floor is below the env var', async () => {
    env = { ...env, CRDT_CLAIM_MIN_DESKTOP_VERSION: '2.0.0' }
    setDesktopFloor('1.9.9')
    expect(await claimedPushOutcome()).toEqual(legacyOutcome)
  })

  it('treats a claim as an unclaimed push while no desktop floor is set', async () => {
    setDesktopFloor(null)
    expect(await claimedPushOutcome()).toEqual(legacyOutcome)
  })

  it('honours the claim once the desktop floor is at or above the env var', async () => {
    env = { ...env, CRDT_CLAIM_MIN_DESKTOP_VERSION: '2.0.0' }
    setDesktopFloor('2.0.1')
    expect(await claimedPushOutcome()).toEqual({
      status: 200,
      sequenceNum: 1,
      remaining: [2],
      coversThrough: 50
    })
  })

  it('treats batch claims as unclaimed pushes while the gate is closed', async () => {
    env = { ...env, CRDT_CLAIM_MIN_DESKTOP_VERSION: undefined }
    insertUpdate('note-1', 1, 50)
    insertUpdate('note-1', 2, 51)
    setCursorSequence(51)

    const res = await post('/sync/crdt/snapshot/batch', {
      snapshots: [{ noteId: 'note-1', snapshot: b64('y'), coversThrough: 50 }]
    })

    expect(res.status).toBe(200)
    expect(remainingSequences('note-1')).toEqual([])
    expect(snapshotRow('note-1')?.covers_through).toBeNull()
  })

  // #2299 review round 2 (A-4, B-L1)
  it('answers 503 for a snapshot row whose object is missing', async () => {
    await push('note-1', 'state', claim(10))
    await storage.delete(snapshotRow('note-1')?.blob_key as string)

    const res = await request('/sync/crdt/snapshot/note-1', { method: 'GET' })

    expect(res.status).toBe(503)
  })

  it('prunes by coversThrough on POST /sync/crdt/snapshot', async () => {
    insertUpdate('note-1', 1, 50)
    insertUpdate('note-1', 2, 51)
    setCursorSequence(51)

    const res = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('state'),
      coversThrough: 50
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sequenceNum: 1, revision: expect.any(String) })
    expect(remainingSequences('note-1')).toEqual([2])
  })

  it('answers 409 with the blocking cursor, and accepts the same push with its baseRevision', async () => {
    setCursorSequence(60)
    const peer = await push('note-1', 'peer-state', claim(60), PEER_ID)

    const refused = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('state'),
      coversThrough: 50
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: { code: CRDT_SNAPSHOT_NOT_COVERED, blockingCursor: 61 }
    })

    const accepted = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('state'),
      coversThrough: 50,
      baseRevision: peer.revision
    })
    expect(accepted.status).toBe(200)
    expect(await storedBody('note-1')).toBe('state')
  })

  it('rejects a malformed claim per entry in a batch and stores the rest', async () => {
    insertUpdate('note-good', 1, 50)
    insertUpdate('note-good', 2, 51)
    setCursorSequence(51)

    const res = await post('/sync/crdt/snapshot/batch', {
      snapshots: [
        { noteId: 'note-bad', snapshot: b64('x'), coversThrough: -1 },
        { noteId: 'note-bad-base', snapshot: b64('x'), coversThrough: 5, baseRevision: 7 },
        { noteId: 'note-good', snapshot: b64('y'), coversThrough: 50 }
      ]
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([
      { noteId: 'note-bad', accepted: false, reason: ErrorCodes.VALIDATION_ERROR },
      { noteId: 'note-bad-base', accepted: false, reason: ErrorCodes.VALIDATION_ERROR },
      { noteId: 'note-good', accepted: true, sequenceNum: 1, revision: expect.any(String) }
    ])
    expect(snapshotRow('note-bad')).toBeUndefined()
    expect(remainingSequences('note-good')).toEqual([2])
  })

  it('advertises the snapshot on the single-note update pull', async () => {
    insertUpdate('note-1', 1, 50)
    insertUpdate('note-1', 2, 51)
    setCursorSequence(51)
    const stored = await push('note-1', 'state', claim(50))

    const res = await request('/sync/crdt/updates?note_id=note-1&since=0', { method: 'GET' })
    const none = await request('/sync/crdt/updates?note_id=note-2&since=0', { method: 'GET' })

    expect(await res.json()).toMatchObject({
      updates: [{ sequenceNum: 2 }],
      snapshotMeta: { sequenceNum: 1, revision: stored.revision, signerDeviceId: DEVICE_ID }
    })
    expect(await none.json()).toMatchObject({ updates: [], snapshotMeta: null })
  })
})
