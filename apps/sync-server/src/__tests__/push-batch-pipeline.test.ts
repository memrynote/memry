import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { CRYPTO_VERSION } from '@memry/contracts/crypto'
import type { PushItemInput, VectorClock } from '@memry/contracts/sync-api'
import { encodeSignaturePayload } from '../lib/cbor'
import { AppError, ErrorCodes } from '../lib/errors'
import { getSnapshot, getUpdates, storeSnapshot, storeUpdates } from '../services/crdt'
import { generateItemBlobKey } from '../services/blob'
import {
  computeContentHash,
  getChanges,
  processRecordPushBatch,
  serializePayload
} from '../services/sync'

/**
 * The batched push pipeline against the REAL migration ledger. The mocked
 * suite in services/sync.test.ts answers whatever it was taught, so a wrong
 * column list, bind order, or batch shape passes there; this file proves the
 * rewrite writes the same rows — cursors, versions, tombstones, storage
 * accounting — the serial per-item loop wrote, which is the old-client compat
 * guarantee (the wire protocol did not change, so identical rows means
 * identical responses).
 */

const USER_ID = 'user-batch'
const DEVICE_A = 'device-batch-a'
const DEVICE_B = 'device-batch-b'
const DEVICE_REVOKED = 'device-batch-revoked'

let harness: SqliteD1
let storage: R2Bucket
const signingKeys = new Map<string, CryptoKey>()

const now = () => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')

const exportRawPublicKey = async (publicKey: CryptoKey): Promise<string> =>
  Buffer.from(
    (await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      publicKey
    )) as ArrayBuffer
  ).toString('base64')

const seedDevice = async (deviceId: string, revoked = false): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKeys.set(deviceId, keyPair.privateKey)

  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, 'desktop', '1.0.0', ?, ?, ?, ?)`
    )
    .run(
      deviceId,
      USER_ID,
      deviceId,
      await exportRawPublicKey(keyPair.publicKey),
      revoked ? now() : null,
      now(),
      now()
    )
}

const seed = async (storageLimit = 50 * 1024 * 1024 * 1024): Promise<void> => {
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'batch@example.com', now(), now())

  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, storageLimit, 100 * 1024 * 1024, now())

  await seedDevice(DEVICE_A)
  await seedDevice(DEVICE_B)
  await seedDevice(DEVICE_REVOKED, true)
}

const buildItem = async (options: {
  id: string
  type?: PushItemInput['type']
  operation?: PushItemInput['operation']
  clock?: VectorClock
  deletedAt?: number
  data?: string
  signerDeviceId?: string
  corruptSignature?: boolean
}): Promise<PushItemInput> => {
  const signerDeviceId = options.signerDeviceId ?? DEVICE_A
  const item = {
    id: options.id,
    type: options.type ?? 'task',
    operation: options.operation ?? 'update',
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(options.data ?? `payload-${options.id}`).toString('base64'),
    dataNonce: b64(24, 0x44),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.deletedAt !== undefined ? { deletedAt: options.deletedAt } : {})
  }

  // Mirrors verifyItemSignature's payload construction exactly.
  const signaturePayload: Record<string, unknown> = {
    id: item.id,
    type: item.type,
    operation: item.operation,
    cryptoVersion: CRYPTO_VERSION,
    encryptedKey: item.encryptedKey,
    keyNonce: item.keyNonce,
    encryptedData: item.encryptedData,
    dataNonce: item.dataNonce,
    ...(options.clock ? { metadata: { clock: options.clock } } : {})
  }
  if (options.deletedAt !== undefined) {
    signaturePayload.deletedAt = options.deletedAt
  }

  const signature = options.corruptSignature
    ? b64(64, 0x66)
    : Buffer.from(
        await crypto.subtle.sign(
          'Ed25519',
          signingKeys.get(signerDeviceId)!,
          encodeSignaturePayload(signaturePayload, 'SYNC_ITEM') as unknown as ArrayBuffer
        )
      ).toString('base64')

  return { ...item, signature, signerDeviceId } as PushItemInput
}

const push = (items: PushItemInput[], deviceId = DEVICE_A) =>
  processRecordPushBatch(harness.db, storage, USER_ID, deviceId, items)

const itemRows = () =>
  harness.raw
    .prepare(
      'SELECT item_id, item_type, version, server_cursor, size_bytes, blob_key, created_at, deleted_at FROM sync_items WHERE user_id = ? ORDER BY server_cursor ASC'
    )
    .all(USER_ID) as Array<Record<string, unknown>>

const storageUsed = () =>
  (
    harness.raw.prepare('SELECT storage_used FROM users WHERE id = ?').get(USER_ID) as {
      storage_used: number
    }
  ).storage_used

const payloadBytes = (item: PushItemInput): number =>
  new TextEncoder().encode(serializePayload(item)).byteLength

beforeEach(async () => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  signingKeys.clear()
  await seed()
})

afterEach(() => {
  harness.close()
})

describe('cursor allocation', () => {
  it('assigns a contiguous strictly monotonic range across a full 100-item batch, in item order', async () => {
    const items = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        buildItem({ id: `item-${String(i).padStart(3, '0')}`, clock: { [DEVICE_A]: 1 } })
      )
    )

    const result = await push(items)

    expect(result.rejected).toEqual([])
    expect(result.accepted).toHaveLength(100)
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1)
    )
    expect(result.maxCursor).toBe(100)

    // The rows agree with the response, in request order.
    expect(itemRows().map((row) => row.item_id)).toEqual(items.map((item) => item.id))

    // One sequence row advanced exactly once per accepted item.
    const sequence = harness.raw
      .prepare('SELECT current_cursor FROM server_cursor_sequence WHERE user_id = ?')
      .get(USER_ID) as { current_cursor: number }
    expect(sequence.current_cursor).toBe(100)

    // Storage accounting equals the stored payload bytes exactly.
    expect(storageUsed()).toBe(items.reduce((sum, item) => sum + payloadBytes(item), 0))
  })

  it('hands two devices disjoint monotonic ranges', async () => {
    const fromA = await push(
      await Promise.all(
        ['a1', 'a2', 'a3'].map((id) => buildItem({ id, clock: { [DEVICE_A]: 1 } }))
      ),
      DEVICE_A
    )
    const fromB = await push(
      await Promise.all(
        ['b1', 'b2', 'b3'].map((id) =>
          buildItem({ id, clock: { [DEVICE_B]: 1 }, signerDeviceId: DEVICE_B })
        )
      ),
      DEVICE_B
    )

    expect(fromA.outcomes.map((outcome) => outcome.serverCursor)).toEqual([1, 2, 3])
    expect(fromB.outcomes.map((outcome) => outcome.serverCursor)).toEqual([4, 5, 6])
  })

  it('never collides or reuses cursors across simultaneously in-flight pushes', async () => {
    const [aItems, bItems] = await Promise.all([
      Promise.all(
        ['ia1', 'ia2', 'ia3', 'ia4'].map((id) => buildItem({ id, clock: { [DEVICE_A]: 1 } }))
      ),
      Promise.all(
        ['ib1', 'ib2', 'ib3'].map((id) =>
          buildItem({ id, clock: { [DEVICE_B]: 1 }, signerDeviceId: DEVICE_B })
        )
      )
    ])

    // The sqlite shim executes synchronously, so this pins the promise-level
    // contract (per-batch monotonicity, disjoint ranges, sequence advanced
    // exactly once per accepted item); true write-write serialization is D1's
    // row lock on server_cursor_sequence, which the single-statement
    // UPDATE ... RETURNING range allocation depends on.
    const [fromA, fromB] = await Promise.all([push(aItems, DEVICE_A), push(bItems, DEVICE_B)])

    expect(fromA.rejected).toEqual([])
    expect(fromB.rejected).toEqual([])

    for (const result of [fromA, fromB]) {
      const cursors = result.outcomes.map((outcome) => outcome.serverCursor as number)
      expect(cursors).toEqual([...cursors].sort((x, y) => x - y))
      expect(result.maxCursor).toBe(Math.max(...cursors))
    }

    const union = [...fromA.outcomes, ...fromB.outcomes].map(
      (outcome) => outcome.serverCursor as number
    )
    expect(new Set(union).size).toBe(7)
    expect(Math.max(...union)).toBe(7)
  })
})

describe('R2 put concurrency bound', () => {
  it('keeps at most 8 puts in flight across a 30-item batch', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const instrumented = {
      ...storage,
      put: async (key: string, value: ArrayBuffer) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        try {
          return await storage.put(key, value)
        } finally {
          inFlight--
        }
      }
    } as unknown as R2Bucket

    const items = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        buildItem({ id: `conc-${String(i).padStart(2, '0')}`, clock: { [DEVICE_A]: 1 } })
      )
    )
    const result = await processRecordPushBatch(harness.db, instrumented, USER_ID, DEVICE_A, items)

    expect(result.rejected).toEqual([])
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(8)
  })
})

describe('old-client compat matrix', () => {
  it('answers a small mixed batch with the exact pre-rewrite response shape and rows', async () => {
    const first = await push([
      await buildItem({ id: 'task-1', operation: 'create', clock: { [DEVICE_A]: 1 } }),
      await buildItem({ id: 'settings-1', type: 'settings' }),
      await buildItem({ id: 'note-1', type: 'note', clock: { [DEVICE_A]: 1 } })
    ])

    expect(Object.keys(first).sort()).toEqual([
      'accepted',
      'maxCursor',
      'outcomes',
      'rejected',
      'serverTime'
    ])
    expect(first.accepted).toEqual(['task-1', 'settings-1', 'note-1'])
    expect(first.rejected).toEqual([])
    expect(first.maxCursor).toBe(3)
    expect(itemRows().map((row) => row.version)).toEqual([1, 1, 1])

    // Update + tombstone, exactly as a shipped client sends them.
    const createdAtBefore = itemRows()[0].created_at
    const second = await push([
      await buildItem({ id: 'task-1', clock: { [DEVICE_A]: 2 }, data: 'task-1-v2' }),
      await buildItem({
        id: 'note-1',
        type: 'note',
        operation: 'delete',
        clock: { [DEVICE_A]: 2 }
      })
    ])
    expect(second.accepted).toEqual(['task-1', 'note-1'])
    expect(second.maxCursor).toBe(5)

    const rows = itemRows()
    const task = rows.find((row) => row.item_id === 'task-1')
    const note = rows.find((row) => row.item_id === 'note-1')
    expect(task?.version).toBe(2)
    expect(task?.created_at).toBe(createdAtBefore)
    expect(note?.version).toBe(2)
    expect(note?.deleted_at).toEqual(expect.any(Number))

    // The change feed pages exactly as before: tombstones under `deleted`,
    // live items in cursor order.
    const changes = await getChanges(harness.db, USER_ID, 0)
    expect(changes.deleted).toEqual(['note-1'])
    expect(changes.items.map((item) => item.id)).toEqual(['settings-1', 'task-1'])
  })

  it('rejects a replayed clock alone, without disturbing batch neighbours', async () => {
    await push([await buildItem({ id: 'task-r', clock: { [DEVICE_A]: 2 } })])

    const result = await push([
      await buildItem({ id: 'task-r', clock: { [DEVICE_A]: 1 }, data: 'stale' }),
      await buildItem({ id: 'task-fresh', clock: { [DEVICE_A]: 1 } })
    ])

    expect(result.accepted).toEqual(['task-fresh'])
    expect(result.rejected).toEqual([{ id: 'task-r', reason: 'SYNC_REPLAY_DETECTED' }])
    // The replayed item's row is untouched.
    expect(itemRows().find((row) => row.item_id === 'task-r')?.version).toBe(1)
  })

  it('rejects per item for signature and device failures while neighbours land', async () => {
    const result = await push([
      await buildItem({ id: 'ok-1', clock: { [DEVICE_A]: 1 } }),
      await buildItem({ id: 'bad-sig', clock: { [DEVICE_A]: 1 }, corruptSignature: true }),
      await buildItem({
        id: 'revoked-signer',
        clock: { [DEVICE_REVOKED]: 1 },
        signerDeviceId: DEVICE_REVOKED
      }),
      await buildItem({ id: 'ok-2', clock: { [DEVICE_A]: 1 } })
    ])

    expect(result.accepted).toEqual(['ok-1', 'ok-2'])
    expect(result.rejected).toEqual([
      { id: 'bad-sig', reason: ErrorCodes.SYNC_INVALID_SIGNATURE },
      { id: 'revoked-signer', reason: ErrorCodes.AUTH_DEVICE_REVOKED }
    ])
    // Cursor gaps from the rejected items are invisible: accepted rows are
    // still strictly monotonic and pullable.
    expect(itemRows().map((row) => row.item_id)).toEqual(['ok-1', 'ok-2'])
  })

  it('throws the whole-batch quota error exactly as the serial code did, writing nothing', async () => {
    harness.close()
    harness = createSqliteD1()
    signingKeys.clear()
    await seed(10)

    const error = await push([await buildItem({ id: 'too-big', clock: { [DEVICE_A]: 1 } })]).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(ErrorCodes.STORAGE_QUOTA_EXCEEDED)
    expect(itemRows()).toEqual([])
    expect(storageUsed()).toBe(0)
  })

  it('replaces a same-batch duplicate identity serially: version 2, latest bytes, old blob gone', async () => {
    const v1 = await buildItem({ id: 'dup-1', clock: { [DEVICE_A]: 1 }, data: 'dup-v1' })
    const v2 = await buildItem({ id: 'dup-1', clock: { [DEVICE_A]: 2 }, data: 'dup-v2-longer' })

    const result = await push([v1, v2])

    expect(result.accepted).toEqual(['dup-1', 'dup-1'])
    expect(result.outcomes.map((outcome) => outcome.serverCursor)).toEqual([1, 2])

    const rows = itemRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].version).toBe(2)
    expect(rows[0].size_bytes).toBe(payloadBytes(v2))
    // The final row's blob holds exactly the bytes the final signature covers.
    const blob = await storage.get(rows[0].blob_key as string)
    expect(Buffer.from(await blob!.arrayBuffer()).toString()).toBe(serializePayload(v2))
    // The replaced wave-1 blob was cleaned up: v1's content-addressed object
    // is gone while v2's remains.
    const v1Hash = await computeContentHash({
      dataNonce: v1.dataNonce,
      encryptedData: v1.encryptedData,
      encryptedKey: v1.encryptedKey,
      keyNonce: v1.keyNonce
    })
    const v1BlobKey = generateItemBlobKey(USER_ID, 'task', 'dup-1', 'default', v1Hash)
    expect(await storage.get(v1BlobKey)).toBeNull()
    expect(rows[0].blob_key).not.toBe(v1BlobKey)
    // Storage accounting settled on the final payload only.
    expect(storageUsed()).toBe(payloadBytes(v2))
  })

  it('shrinks storage accounting when a smaller payload replaces a larger one', async () => {
    const big = await buildItem({ id: 'shrink-1', clock: { [DEVICE_A]: 1 }, data: 'x'.repeat(500) })
    await push([big])
    expect(storageUsed()).toBe(payloadBytes(big))

    const small = await buildItem({ id: 'shrink-1', clock: { [DEVICE_A]: 2 }, data: 'tiny' })
    await push([small])
    expect(storageUsed()).toBe(payloadBytes(small))
  })
})

describe('CRDT storeUpdates batching', () => {
  const updateBytes = (value: string): ArrayBuffer => {
    const encoded = new TextEncoder().encode(value)
    const copy = new Uint8Array(encoded.byteLength)
    copy.set(encoded)
    return copy.buffer
  }

  it('assigns gapless increasing sequence numbers within one batched call', async () => {
    const sequences = await storeUpdates(
      harness.db,
      USER_ID,
      'default',
      'note_1',
      DEVICE_A,
      ['u1', 'u2', 'u3', 'u4', 'u5'].map(updateBytes)
    )

    expect(sequences).toEqual([1, 2, 3, 4, 5])
    expect(storageUsed()).toBe(10)

    const pulled = await getUpdates(harness.db, USER_ID, 'default', 'note_1', 0, 10)
    expect(pulled.updates.map((update) => update.sequence_num)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps sequencing continuous across snapshots and a second device', async () => {
    await storeUpdates(harness.db, USER_ID, 'default', 'note_2', DEVICE_A, [
      updateBytes('a1'),
      updateBytes('a2')
    ])
    await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      'default',
      'note_2',
      DEVICE_A,
      updateBytes('snapshot')
    )

    const later = await storeUpdates(harness.db, USER_ID, 'default', 'note_2', DEVICE_B, [
      updateBytes('b1'),
      updateBytes('b2')
    ])
    expect(later).toEqual([3, 4])

    const snapshot = await getSnapshot(harness.db, storage, USER_ID, 'default', 'note_2')
    expect(snapshot?.sequenceNum).toBe(2)
  })

  it('handles a maximum-size 100-update push in one call', async () => {
    const sequences = await storeUpdates(
      harness.db,
      USER_ID,
      'default',
      'note_3',
      DEVICE_A,
      Array.from({ length: 100 }, (_, i) => updateBytes(`u${i}`))
    )

    expect(sequences).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
  })
})
