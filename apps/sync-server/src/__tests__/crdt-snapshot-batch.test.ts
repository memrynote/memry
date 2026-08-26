import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { ErrorCodes } from '../lib/errors'
import { generateCrdtKey } from '../services/blob'
import {
  getSnapshot,
  pruneUpdatesBeforeSnapshot,
  pruneUpdatesBeforeSnapshotBatch,
  storeSnapshot,
  storeSnapshotBatch,
  storeUpdates
} from '../services/crdt'

/**
 * The batched snapshot writer (#1857) against the REAL migration ledger.
 *
 * The hand-written D1 double in services/crdt.test.ts answers whatever it was
 * taught, so a wrong column list, a wrong bind order, or an IN(...) past the
 * bind-parameter ceiling passes there. This file runs the actual SQL against
 * the actual schema, and — because backward compatibility is the whole point —
 * asserts the batch writes rows INDISTINGUISHABLE from the ones the single-note
 * endpoint writes, note for note.
 */

const USER_ID = 'user-snapshot-batch'
const VAULT_ID = 'vault-1'
const DEVICE_ID = 'device-snapshot-batch'

let harness: SqliteD1
let storage: R2Bucket

const now = (): number => Math.floor(Date.now() / 1000)

const bytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value)
  const copy = new Uint8Array(encoded.byteLength)
  copy.set(encoded)
  return copy.buffer
}

const storageUsed = (): number =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used

const snapshotRow = (
  noteId: string
): {
  id: string
  blob_key: string
  sequence_num: number
  size_bytes: number
  signer_device_id: string
  revision: string
  client_platform: string | null
  client_version: string | null
} =>
  harness.raw
    .prepare('SELECT * FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?')
    .get(USER_ID, VAULT_ID, noteId) as never

const updateCount = (noteId: string): number =>
  (
    harness.raw
      .prepare(
        'SELECT COUNT(*) as n FROM crdt_updates WHERE user_id = ? AND vault_id = ? AND note_id = ?'
      )
      .get(USER_ID, VAULT_ID, noteId) as { n: number }
  ).n

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()

  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'snapshot-batch@example.com', now(), now())

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

describe('storeSnapshotBatch', () => {
  it('stores every snapshot and answers one result per input, in request order', async () => {
    // #given three notes the server has never seen
    const inputs = ['note_c', 'note_a', 'note_b'].map((noteId) => ({
      noteId,
      snapshotData: bytes(`body-${noteId}`)
    }))

    // #when
    const outcomes = await storeSnapshotBatch(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      DEVICE_ID,
      inputs,
      { platform: 'desktop', version: '1.2.3' }
    )

    // #then — order is the request's, not the database's
    expect(outcomes).toEqual([
      { noteId: 'note_c', accepted: true, sequenceNum: 0 },
      { noteId: 'note_a', accepted: true, sequenceNum: 0 },
      { noteId: 'note_b', accepted: true, sequenceNum: 0 }
    ])

    for (const { noteId } of inputs) {
      const row = snapshotRow(noteId)
      expect(row.blob_key).toBe(generateCrdtKey(USER_ID, noteId, VAULT_ID))
      expect(row.signer_device_id).toBe(DEVICE_ID)
      expect(row.client_platform).toBe('desktop')
      expect(row.client_version).toBe('1.2.3')

      // The bytes are actually in R2 under the row's key.
      const stored = await getSnapshot(harness.db, storage, USER_ID, VAULT_ID, noteId)
      expect(new TextDecoder().decode(stored!.snapshotData)).toBe(`body-${noteId}`)
    }
  })

  // The single-note path is what every shipped client uses, and it is not going
  // away. A batch that writes a different row for the same input is a data bug
  // the wire contract cannot catch.
  it('writes the same row the single-note path writes for the same input', async () => {
    // #given the same body pushed both ways, on two notes with identical history
    for (const noteId of ['note_single', 'note_batch']) {
      await storeUpdates(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, [bytes('u1')])
    }

    // #when
    await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note_single',
      DEVICE_ID,
      bytes('same-body')
    )
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_batch', snapshotData: bytes('same-body') }
    ])

    // #then — everything but the row identity and the revision (both fresh
    // UUIDs by design) matches column for column
    const single = snapshotRow('note_single')
    const batch = snapshotRow('note_batch')
    expect(batch.sequence_num).toBe(single.sequence_num)
    expect(batch.size_bytes).toBe(single.size_bytes)
    expect(batch.signer_device_id).toBe(single.signer_device_id)
    expect(batch.id).not.toBe(single.id)
    expect(batch.revision).not.toBe(single.revision)
  })

  it('leaves the watermark where it was for a note that already has a snapshot', async () => {
    // #given a note snapshotted at sequence 2, with two newer incrementals
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_old', DEVICE_ID, [
      bytes('u1'),
      bytes('u2')
    ])
    await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note_old',
      DEVICE_ID,
      bytes('first')
    )
    expect(snapshotRow('note_old').sequence_num).toBe(2)
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_old', DEVICE_ID, [
      bytes('u3'),
      bytes('u4')
    ])

    // #given a sibling in the same batch that has updates but no snapshot yet
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_new', DEVICE_ID, [
      bytes('n1'),
      bytes('n2'),
      bytes('n3')
    ])

    // #when both ride in one batch
    const outcomes = await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_old', snapshotData: bytes('second') },
      { noteId: 'note_new', snapshotData: bytes('fresh') }
    ])

    // #then — the existing watermark is preserved so updates 3..4 stay pullable,
    // while the fresh note takes the current max
    expect(outcomes).toEqual([
      { noteId: 'note_old', accepted: true, sequenceNum: 2 },
      { noteId: 'note_new', accepted: true, sequenceNum: 3 }
    ])
    expect(snapshotRow('note_old').sequence_num).toBe(2)
    expect(snapshotRow('note_new').sequence_num).toBe(3)
  })

  // A revision that fails to move when the blob does leaves a client on a stale
  // body forever — the one failure this token exists to prevent.
  it('mints a fresh revision on every write, insert and conflict alike', async () => {
    // #given a first batch
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_r', snapshotData: bytes('v1') }
    ])
    const first = snapshotRow('note_r')

    // #when the SAME bytes are pushed again
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_r', snapshotData: bytes('v1') }
    ])
    const second = snapshotRow('note_r')

    // #then the revision moved, and the row identity did not (ON CONFLICT never
    // rewrites `id`, which is what makes the legacy-revision fallback stable)
    expect(second.revision).not.toBe(first.revision)
    expect(second.id).toBe(first.id)
    expect(second.revision).not.toBe('')
  })

  it('charges storage once for the batch and books shrinks per note', async () => {
    // #given a first batch of two 10-byte bodies
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_s1', snapshotData: bytes('0123456789') },
      { noteId: 'note_s2', snapshotData: bytes('0123456789') }
    ])
    expect(storageUsed()).toBe(20)

    // #when one body grows and the other shrinks
    await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_s1', snapshotData: bytes('0123456789abcde') },
      { noteId: 'note_s2', snapshotData: bytes('012') }
    ])

    // #then the account reflects both deltas exactly (+5, -7)
    expect(storageUsed()).toBe(18)
  })

  it('reports an R2 put failure against its own note and refunds only its bytes', async () => {
    // #given a bucket that refuses exactly one key
    const failingKey = generateCrdtKey(USER_ID, 'note_bad', VAULT_ID)
    const realPut = storage.put.bind(storage) as (
      key: string,
      value: ArrayBuffer
    ) => Promise<R2Object>
    vi.spyOn(storage, 'put').mockImplementation((async (key: string, value: ArrayBuffer) => {
      // "access denied" classifies as terminal, so putBlob does not burn its
      // retry budget on a failure the test means to be permanent.
      if (key === failingKey) throw new Error('access denied')
      return realPut(key, value)
    }) as typeof storage.put)

    // #when it rides in the middle of a healthy batch
    const outcomes = await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_ok1', snapshotData: bytes('0123456789') },
      { noteId: 'note_bad', snapshotData: bytes('0123456789') },
      { noteId: 'note_ok2', snapshotData: bytes('0123456789') }
    ])

    // #then only that note fails, and it fails with a typed reason
    expect(outcomes).toEqual([
      { noteId: 'note_ok1', accepted: true, sequenceNum: 0 },
      { noteId: 'note_bad', accepted: false, reason: ErrorCodes.STORAGE_UNAUTHORIZED },
      { noteId: 'note_ok2', accepted: true, sequenceNum: 0 }
    ])

    // #then the failed put left NO row behind, and its reservation came back
    expect(
      harness.raw
        .prepare('SELECT id FROM crdt_snapshots WHERE user_id = ? AND note_id = ?')
        .get(USER_ID, 'note_bad')
    ).toBeUndefined()
    expect(storageUsed()).toBe(20)
  })

  it('rejects the whole batch with a typed quota error rather than a partial write', async () => {
    // #given an entitlement with almost no room left
    harness.raw
      .prepare('UPDATE sync_entitlements SET storage_limit = ? WHERE user_id = ?')
      .run(5, USER_ID)

    // #when
    const push = storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_q1', snapshotData: bytes('0123456789') },
      { noteId: 'note_q2', snapshotData: bytes('0123456789') }
    ])

    // #then the same typed error the single-note push throws, and nothing landed
    await expect(push).rejects.toMatchObject({ code: ErrorCodes.STORAGE_QUOTA_EXCEEDED })
    expect(
      (
        harness.raw
          .prepare('SELECT COUNT(*) as n FROM crdt_snapshots WHERE user_id = ?')
          .get(USER_ID) as { n: number }
      ).n
    ).toBe(0)
    expect(storageUsed()).toBe(0)
  })

  // D1 rejects any statement past 100 bound parameters with a 500 on the whole
  // request. A full batch is the case that fills a chunk, and it is exactly the
  // bulk-seed case the endpoint exists for.
  it('stays inside the D1 bind-parameter ceiling for a full 50-note batch', async () => {
    // #given the largest batch the route accepts
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      noteId: `note_bulk_${i}`,
      snapshotData: bytes(`body-${i}`)
    }))

    // #when
    const outcomes = await storeSnapshotBatch(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      DEVICE_ID,
      inputs
    )

    // #then
    expect(outcomes.every((outcome) => outcome.accepted)).toBe(true)
    expect(
      (
        harness.raw
          .prepare('SELECT COUNT(*) as n FROM crdt_snapshots WHERE user_id = ?')
          .get(USER_ID) as { n: number }
      ).n
    ).toBe(50)
  })
})

describe('pruneUpdatesBeforeSnapshotBatch', () => {
  it('prunes every note at its own watermark and refunds the freed bytes once', async () => {
    // #given two notes with updates, snapshotted in one batch
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_p1', DEVICE_ID, [
      bytes('aaaa'),
      bytes('bbbb')
    ])
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_p2', DEVICE_ID, [bytes('cccc')])
    const outcomes = await storeSnapshotBatch(harness.db, storage, USER_ID, VAULT_ID, DEVICE_ID, [
      { noteId: 'note_p1', snapshotData: bytes('s1') },
      { noteId: 'note_p2', snapshotData: bytes('s2') }
    ])
    // 4 + 4 + 4 update bytes, then 2 + 2 snapshot bytes
    expect(storageUsed()).toBe(16)

    // #given one update that arrives AFTER the watermark
    await storeUpdates(harness.db, USER_ID, VAULT_ID, 'note_p1', DEVICE_ID, [bytes('dddd')])

    // #when
    const changes = await pruneUpdatesBeforeSnapshotBatch(
      harness.db,
      USER_ID,
      VAULT_ID,
      outcomes
        .filter((outcome) => outcome.accepted === true)
        .map((outcome) => ({ noteId: outcome.noteId, sequenceNum: outcome.sequenceNum }))
    )

    // #then the pre-watermark updates are gone, the newer one survives, and the
    // 12 freed bytes are credited exactly once
    expect(changes).toBe(3)
    expect(updateCount('note_p1')).toBe(1)
    expect(updateCount('note_p2')).toBe(0)
    expect(storageUsed()).toBe(8)
  })

  it('matches the single-note prune note for note', async () => {
    // #given two notes with identical history
    for (const noteId of ['note_x', 'note_y']) {
      await storeUpdates(harness.db, USER_ID, VAULT_ID, noteId, DEVICE_ID, [
        bytes('aaaa'),
        bytes('bbbb')
      ])
      await storeSnapshot(harness.db, storage, USER_ID, VAULT_ID, noteId, DEVICE_ID, bytes('s'))
    }

    // #when one is pruned singly and the other in a batch
    const single = await pruneUpdatesBeforeSnapshot(harness.db, USER_ID, VAULT_ID, 'note_x')
    const batched = await pruneUpdatesBeforeSnapshotBatch(harness.db, USER_ID, VAULT_ID, [
      { noteId: 'note_y', sequenceNum: snapshotRow('note_y').sequence_num }
    ])

    // #then
    expect(batched).toBe(single)
    expect(updateCount('note_x')).toBe(0)
    expect(updateCount('note_y')).toBe(0)
  })

  it('does nothing and touches no storage for an empty note list', async () => {
    // #when
    const changes = await pruneUpdatesBeforeSnapshotBatch(harness.db, USER_ID, VAULT_ID, [])

    // #then
    expect(changes).toBe(0)
    expect(storageUsed()).toBe(0)
  })
})
