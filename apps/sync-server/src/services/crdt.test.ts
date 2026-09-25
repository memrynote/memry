import { describe, expect, it, vi } from 'vitest'

import { createSqliteD1 } from '../__tests__/d1-sqlite'
import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import {
  getBatchUpdates,
  getSnapshot,
  getUpdates,
  pruneUpdatesBeforeSnapshot,
  storeSnapshot,
  storeUpdates
} from './crdt'

/**
 * The real SQLite D1 harness with the users these tests push as. It replaced a
 * hand-written double (#2299): the snapshot write is a conditional upsert in a
 * batch, and a double that matches SQL prefixes cannot model `WHERE` on
 * `ON CONFLICT` or `changes()`.
 */
function createD1Database(): D1Database {
  const harness = createSqliteD1()
  for (const userId of ['user-1']) {
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, ?, 1, 'otp', 0, 0, 1, 1)`
      )
      .run(userId, `${userId}@example.com`)
    harness.raw
      .prepare(
        `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
         VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, 1)`
      )
      .run(userId, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024)
  }
  return harness.db
}

interface PreparedCall {
  sql: string
  bindings: unknown[]
}

function createRecordingDatabase(options: {
  first?: (sql: string, bindings: unknown[]) => unknown
  changes?: (sql: string) => number
}) {
  const statements: PreparedCall[] = []

  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        sql,
        bindings: [] as unknown[],
        bind: vi.fn((...args: unknown[]) => {
          stmt.bindings = args
          statements.push({ sql, bindings: args })
          return stmt
        }),
        first: vi.fn(async () => options.first?.(sql, stmt.bindings) ?? null),
        run: vi.fn(async () => ({ meta: { changes: options.changes?.(sql) ?? 1 } }))
      }
      return stmt
    }),
    batch: vi.fn(async (batched: Array<{ sql: string; bindings: unknown[] }>) =>
      batched.map((stmt) => ({
        results: [options.first?.(stmt.sql, stmt.bindings)].filter((row) => row != null)
      }))
    )
  }

  return { db: db as unknown as D1Database, statements }
}

function createMemoryBucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>()

  return {
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      objects.set(key, bytes.slice())
      // Real R2 resolves to an R2Object; returning null here would look like a
      // failed upload to putBlob.
      return { key, etag: `etag-${objects.size}` } as unknown as R2Object
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
    async get(key: string) {
      const bytes = objects.get(key)
      if (!bytes) return null
      return {
        async arrayBuffer() {
          return bytes.slice().buffer
        }
      } as unknown as R2ObjectBody
    }
  } as unknown as R2Bucket
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value)
  const copy = new Uint8Array(encoded.byteLength)
  copy.set(encoded)
  return copy.buffer
}

describe('CRDT service sequencing', () => {
  it('keeps later offline updates above the existing snapshot watermark', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()

    const initialSequences = await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [
      bytes('a1'),
      bytes('a2')
    ])
    expect(initialSequences).toEqual([1, 2])

    const firstSnapshot = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-a',
      bytes('snapshot-a')
    )
    expect(firstSnapshot.sequenceNum).toBe(2)
    expect(await pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).toBe(2)

    const laterSequences = await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-b', [
      bytes('b1'),
      bytes('b2')
    ])
    expect(laterSequences).toEqual([3, 4])

    const replacementSnapshot = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-b',
      bytes('snapshot-b')
    )
    expect(replacementSnapshot.sequenceNum).toBe(2)
    expect(await pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).toBe(0)

    const snapshot = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')
    expect(snapshot?.sequenceNum).toBe(2)

    const pulled = await getUpdates(db, 'user-1', 'vault-1', 'note-1', 2, 10)
    expect(pulled.updates.map((update) => update.sequence_num)).toEqual([3, 4])
  })

  it('reports hasMore when a note has more updates than the requested limit', async () => {
    const db = createD1Database()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [
      bytes('a1'),
      bytes('a2'),
      bytes('a3')
    ])

    const pulled = await getUpdates(db, 'user-1', 'vault-1', 'note-1', 0, 2)

    expect(pulled.hasMore).toBe(true)
    expect(pulled.updates.map((update) => update.sequence_num)).toEqual([1, 2])
  })

  it('keeps same note ids isolated across vaults', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()

    await expect(
      storeUpdates(db, 'user-1', 'vault-a', 'note-1', 'device-a', [bytes('a1')])
    ).resolves.toEqual([1])
    await expect(
      storeUpdates(db, 'user-1', 'vault-b', 'note-1', 'device-a', [bytes('b1')])
    ).resolves.toEqual([1])

    await storeSnapshot(db, storage, 'user-1', 'vault-a', 'note-1', 'device-a', bytes('snap-a'))
    await storeSnapshot(db, storage, 'user-1', 'vault-b', 'note-1', 'device-a', bytes('snap-b'))

    const snapshotA = await getSnapshot(db, storage, 'user-1', 'vault-a', 'note-1')
    const snapshotB = await getSnapshot(db, storage, 'user-1', 'vault-b', 'note-1')

    expect(new TextDecoder().decode(snapshotA!.snapshotData)).toBe('snap-a')
    expect(new TextDecoder().decode(snapshotB!.snapshotData)).toBe('snap-b')
  })

  it('gets batch updates per note and preserves hasMore per note', async () => {
    const db = createD1Database()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [
      bytes('a1'),
      bytes('a2'),
      bytes('a3')
    ])
    await storeUpdates(db, 'user-1', 'vault-1', 'note-2', 'device-a', [bytes('b1')])

    const result = await getBatchUpdates(
      db,
      'user-1',
      'vault-1',
      [
        { noteId: 'note-1', since: 0 },
        { noteId: 'note-2', since: 0 }
      ],
      2
    )

    expect(result.notes['note-1'].hasMore).toBe(true)
    expect(result.notes['note-1'].updates.map((update) => update.sequence_num)).toEqual([1, 2])
    expect(result.notes['note-2'].hasMore).toBe(false)
    expect(result.notes['note-2'].updates.map((update) => update.sequence_num)).toEqual([1])
  })

  // The batch pull accepts 100 notes, and a fresh install is the one caller that
  // actually sends full chunks. A single metadata statement for all of them bound
  // 102 parameters, over D1's ceiling, and took the entire pull down with a 500 —
  // so the devices with no bodies yet were the only ones that could not get them.
  it('pulls a full 100-note batch without exceeding the D1 bind-parameter ceiling', async () => {
    // #given a full chunk of notes, one of which has a snapshot and updates
    const db = createD1Database()
    const storage = createMemoryBucket()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-42', 'device-a', [bytes('a1')])
    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-99', 'device-a', bytes('snap'))

    const notes = Array.from({ length: 100 }, (_, i) => ({ noteId: `note-${i}`, since: 0 }))

    // #when the whole chunk is pulled in one request
    const result = await getBatchUpdates(db, 'user-1', 'vault-1', notes, 10)

    // #then every note is answered, and the metadata split across statements is
    // still collected as one map
    expect(Object.keys(result.notes)).toHaveLength(100)
    expect(result.notes['note-42'].updates.map((update) => update.sequence_num)).toEqual([1])
    const snapshot = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-99')
    expect(result.snapshotMeta['note-99']).toEqual({
      sequenceNum: snapshot!.sequenceNum,
      revision: snapshot!.revision,
      signerDeviceId: 'device-a'
    })
    expect(result.snapshotMeta['note-42']).toBeUndefined()
  })

  it('returns an empty batch result when no notes are requested', async () => {
    const db = createD1Database()

    await expect(getBatchUpdates(db, 'user-1', 'vault-1', [], 10)).resolves.toEqual({
      notes: {},
      snapshotMeta: {}
    })
  })

  it('assigns a revision on the first snapshot for a note', async () => {
    // #given
    const db = createD1Database()
    const storage = createMemoryBucket()

    // #when
    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snap-a'))

    // #then a real token, not the '' the column defaults to and not the legacy fallback
    const snapshot = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')
    expect(snapshot?.revision).toEqual(expect.any(String))
    expect(snapshot?.revision).not.toBe('')
    expect(snapshot?.revision.startsWith('legacy:')).toBe(false)
  })

  // #2187. A pusher that cannot see the revision it just wrote has to leave its
  // local `server_revision` undefined until the next pull.
  it('returns to the pusher the revision it stored, on insert and on replace', async () => {
    // #given
    const db = createD1Database()
    const storage = createMemoryBucket()

    // #when the note is snapshotted for the first time
    const inserted = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-a',
      bytes('snap-a')
    )

    // #then the returned token is the one the row carries
    expect(inserted.revision).not.toBe('')
    expect((await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1'))?.revision).toBe(
      inserted.revision
    )

    // #when the same note is snapshotted again through the ON CONFLICT path
    const replaced = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-b',
      bytes('snap-b')
    )

    // #then the response follows the row rather than repeating the first token
    expect(replaced.revision).not.toBe(inserted.revision)
    expect((await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1'))?.revision).toBe(
      replaced.revision
    )
  })

  // FM1. A revision that fails to move when the blob does is the whole design's
  // central risk: the client skips a snapshot it needed and keeps a stale body
  // forever. The replacement path is where it goes wrong, because the row already
  // exists and `sequence_num` is deliberately PINNED across it — so the revision
  // is the only thing left that can say "this changed".
  it('assigns a NEW revision when a snapshot is replaced, even though the sequence stays pinned', async () => {
    // #given a note with a snapshot already stored
    const db = createD1Database()
    const storage = createMemoryBucket()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [bytes('a1')])
    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snap-a'))
    const first = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')

    // #when the blob is replaced through the ON CONFLICT path
    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-b', bytes('snap-b'))
    const second = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')

    // #then the revision moved
    expect(second?.revision).not.toBe(first?.revision)
    expect(second?.revision).not.toBe('')

    // #and the sequence number did NOT, which is exactly why it cannot be the token
    expect(second?.sequenceNum).toBe(first?.sequenceNum)
    expect(new TextDecoder().decode(second!.snapshotData)).toBe('snap-b')
  })

  it('advertises on the batch pull the same revision the snapshot read returns', async () => {
    // #given two notes with snapshots and a third with none
    const db = createD1Database()
    const storage = createMemoryBucket()

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snap-1'))
    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-2', 'device-b', bytes('snap-2'))

    // #when the batch pull names all three
    const result = await getBatchUpdates(
      db,
      'user-1',
      'vault-1',
      [
        { noteId: 'note-1', since: 0 },
        { noteId: 'note-2', since: 0 },
        { noteId: 'note-3', since: 0 }
      ],
      10
    )

    // #then the metadata matches the per-note read a client would otherwise make
    const snapshot1 = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')
    expect(result.snapshotMeta['note-1']).toEqual({
      sequenceNum: snapshot1!.sequenceNum,
      revision: snapshot1!.revision,
      signerDeviceId: 'device-a'
    })
    expect(result.snapshotMeta['note-2'].signerDeviceId).toBe('device-b')

    // #and a note the server has no snapshot for is simply absent
    expect(result.snapshotMeta['note-3']).toBeUndefined()
    expect(result.notes['note-3']).toEqual({ updates: [], hasMore: false })
  })

  // Rows written before the column existed carry '' — the migration deliberately
  // does not backfill. Both read paths must coalesce to the SAME string, or a
  // client comparing what it merged from the GET against what the batch
  // advertises would re-download every legacy snapshot forever.
  it('coalesces a pre-migration row to the same legacy revision on both read paths', async () => {
    // #given a row the old server wrote, so revision is the column default
    const legacyRow = {
      id: 'snap-legacy',
      note_id: 'note-1',
      blob_key: 'user-1/vaults/vault-1/crdt/note-1/snapshot',
      sequence_num: 7,
      signer_device_id: 'device-a',
      created_at: 1_700_000_000,
      size_bytes: 42,
      revision: ''
    }
    const db = {
      prepare(sql: string) {
        const prepared = {
          bind: () => prepared,
          async first() {
            return sql.startsWith('SELECT id, blob_key, sequence_num, signer_device_id')
              ? legacyRow
              : null
          },
          async all() {
            return {
              results: sql.startsWith('SELECT id, note_id, sequence_num, revision')
                ? [legacyRow]
                : []
            }
          }
        }
        return prepared as unknown as D1PreparedStatement
      },
      async batch(statements: D1PreparedStatement[]) {
        return Promise.all(statements.map((statement) => statement.all()))
      }
    } as unknown as D1Database

    const storage = createMemoryBucket()
    await storage.put(legacyRow.blob_key, bytes('legacy'))

    // #when both paths read it
    const snapshot = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')
    const batch = await getBatchUpdates(
      db,
      'user-1',
      'vault-1',
      [{ noteId: 'note-1', since: 0 }],
      10
    )

    // #then the token is derived from the row and is identical across them
    expect(snapshot?.revision).toBe('legacy:snap-legacy:1700000000:42')
    expect(batch.snapshotMeta['note-1'].revision).toBe(snapshot?.revision)
  })

  // #2299 review round 2: a missing object for an existing row is a 503
  it('returns null when a snapshot row is missing, and a retryable 503 when its object is', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()

    await expect(getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')).resolves.toBeNull()

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snapshot-a'))

    const missingStorage = { get: async () => null } as unknown as R2Bucket
    await expect(
      getSnapshot(db, missingStorage, 'user-1', 'vault-1', 'note-1')
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('does not prune updates when no snapshot exists', async () => {
    const db = createD1Database()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [bytes('a1')])

    await expect(pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).resolves.toBe(0)
  })
})

describe('CRDT storage accounting', () => {
  it('increments storage usage by the actual stored update bytes', async () => {
    // Each SELECT after an insert answers the row that insert just wrote.
    let insertedId: unknown
    const { db, statements } = createRecordingDatabase({
      first: (sql, bindings) => {
        if (sql.includes('INTO crdt_updates')) insertedId = bindings[0]
        if (sql.startsWith('SELECT id, sequence_num FROM crdt_updates')) {
          return { id: insertedId, sequence_num: 1 }
        }
        return null
      }
    })

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-1', [
      new Uint8Array([1, 2]).buffer,
      new Uint8Array([3]).buffer
    ])

    const usageUpdate = statements.find((entry) => entry.sql.includes('UPDATE users'))
    expect(usageUpdate?.bindings).toEqual([3, expect.any(Number), 'user-1', 3, expect.any(Number)])
  })

  it('adjusts storage usage by the snapshot replacement delta', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()
    const used = async (): Promise<number> =>
      (await db
        .prepare('SELECT storage_used FROM users WHERE id = ?')
        .bind('user-1')
        .first<number>('storage_used')) as number

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-1', bytes('abc'))
    expect(await used()).toBe(3)
    const replaced = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-1',
      new Uint8Array(10).buffer
    )

    expect(await used()).toBe(10)
    // #2299: every write has its own object, named by its revision.
    const stored = await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')
    expect(stored?.snapshotData.byteLength).toBe(10)
    expect(replaced.revision).toBe(stored?.revision)
  })

  it('subtracts pruned update bytes from storage usage', async () => {
    const { db, statements } = createRecordingDatabase({
      first: (sql) => {
        if (sql.includes('SELECT sequence_num FROM crdt_snapshots')) return { sequence_num: 5 }
        if (sql.includes('SUM(length(update_data))')) return { total_bytes: 8 }
        return null
      },
      changes: (sql) => (sql.includes('DELETE FROM crdt_updates') ? 2 : 1)
    })

    await expect(pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).resolves.toBe(2)

    const usageUpdate = statements.find((entry) => entry.sql.includes('UPDATE users'))
    expect(usageUpdate?.sql).toContain('MAX(0, storage_used + ?)')
    expect(usageUpdate?.bindings).toEqual([-8, expect.any(Number), 'user-1'])
  })
})

// ============================================================================
// Tests: CRDT failure handling
//
// Production evidence: a ~5 minute R2 incident produced 24x UNHANDLED_ERROR
// 500s on POST /sync/crdt/snapshot, because the CRDT path called storage.put
// directly instead of going through putBlob. Transient infra looked like an app
// crash and polluted the unhandled-error signal.
// ============================================================================

const R2_TRANSIENT_MESSAGE = 'put: Please look at https://www.cloudflarestatus.com for issues'
const D1_OUTAGE_MESSAGE = 'D1_ERROR: Network connection lost.'

/**
 * D1 fake whose storage-accounting writes can be made to fail independently,
 * so we can model the "refund during a D1 outage" case.
 */
function createAccountingDatabase(options: { failRefund?: boolean; failInsert?: boolean }) {
  const runSql: string[] = []

  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        sql,
        bind: vi.fn(() => stmt),
        first: vi.fn(async () => {
          if (sql.includes('COALESCE(MAX(sequence_num)')) return { max_seq: 0 }
          return null
        }),
        run: vi.fn(async () => {
          runSql.push(sql)
          // The refund is itself a D1 write; during an outage it fails too.
          if (options.failRefund && sql.includes('MAX(0, storage_used + ?)')) {
            throw new Error('D1_ERROR: internal error')
          }
          return { meta: { changes: 1 } }
        })
      }
      return stmt
    }),
    batch: vi.fn(async (batched: Array<{ sql: string }>) =>
      batched.map((stmt) => {
        if (stmt.sql.includes('INTO crdt_updates')) {
          // A D1 batch is one transaction: an outage fails it whole.
          if (options.failInsert) throw new Error(D1_OUTAGE_MESSAGE)
          return { results: [{ sequence_num: 1 }] }
        }
        return { results: [] }
      })
    )
  }

  return { db: db as unknown as D1Database, runSql }
}

const createFailingBucket = (message: string): R2Bucket =>
  ({ put: vi.fn().mockRejectedValue(new Error(message)) }) as unknown as R2Bucket

describe('CRDT snapshot failure handling', () => {
  it('retries a transient R2 put failure and still records the snapshot', async () => {
    // #given R2 fails once then recovers, as in the Cloudflare incident
    const db = createD1Database()
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error(R2_TRANSIENT_MESSAGE))
      .mockResolvedValueOnce({ etag: 'etag-1' })
    const storage = {
      put,
      get: async () => ({ arrayBuffer: async () => bytes('snapshot-a') })
    } as unknown as R2Bucket

    // #when
    const result = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-a',
      bytes('snapshot-a')
    )

    // #then the transient blip is absorbed and the D1 row is written
    expect(put).toHaveBeenCalledTimes(2)
    expect(result.sequenceNum).toBe(0)
    expect(await getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')).not.toBeNull()
  })

  it('surfaces a typed STORAGE_UPLOAD_FAILED that the error handler reports as handled', async () => {
    // #given R2 is persistently failing
    const db = createD1Database()
    const storage = createFailingBucket(R2_TRANSIENT_MESSAGE)

    // #when
    const error = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-a',
      bytes('snapshot-a')
    ).catch((e: unknown) => e)

    // #then a raw R2 Error would be logged as UNHANDLED_ERROR by the error handler
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(ErrorCodes.STORAGE_UPLOAD_FAILED)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const json = vi.fn(
      (payload: unknown, init: unknown) =>
        new Response(JSON.stringify(payload), init as ResponseInit)
    )
    const response = errorHandler(
      error as Error,
      { json } as unknown as Parameters<typeof errorHandler>[1]
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { code: ErrorCodes.STORAGE_UPLOAD_FAILED }
    })
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('UNHANDLED_ERROR'))
    consoleSpy.mockRestore()
  })

  it('writes no snapshot row when the R2 put fails, so nothing can be pruned', async () => {
    // #given updates exist and the snapshot put fails
    const db = createD1Database()
    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [bytes('a1'), bytes('a2')])
    const storage = createFailingBucket(R2_TRANSIENT_MESSAGE)

    // #when
    await expect(
      storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snapshot-a'))
    ).rejects.toThrow(AppError)

    // #then no orphan row, and the authoritative update log is untouched
    await expect(getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')).resolves.toBeNull()
    await expect(pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).resolves.toBe(0)
    const remaining = await getUpdates(db, 'user-1', 'vault-1', 'note-1', 0, 10)
    expect(remaining.updates).toHaveLength(2)
  })

  it('propagates the original put failure when the quota refund also fails', async () => {
    // #given R2 is down AND D1 is down, so the refund write fails too
    const { db } = createAccountingDatabase({ failRefund: true })
    const storage = createFailingBucket(R2_TRANSIENT_MESSAGE)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // #when
    const error = await storeSnapshot(
      db,
      storage,
      'user-1',
      'vault-1',
      'note-1',
      'device-a',
      bytes('snapshot-a')
    ).catch((e: unknown) => e)

    // #then the refund failure must not replace the real cause
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(ErrorCodes.STORAGE_UPLOAD_FAILED)
    expect((error as Error).message).not.toContain('internal error')
    // #and the leaked reservation is visible in the logs
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('storage refund failed'))
    consoleSpy.mockRestore()
  })

  it('propagates the original update failure when the quota refund also fails', async () => {
    // #given the insert fails and the refund write fails too
    const { db } = createAccountingDatabase({ failInsert: true, failRefund: true })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // #when
    const error = await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [
      bytes('a1')
    ]).catch((e: unknown) => e)

    // #then
    expect((error as Error).message).toBe(D1_OUTAGE_MESSAGE)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('storage refund failed'))
    consoleSpy.mockRestore()
  })
})
