import { describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import {
  getBatchUpdates,
  getSnapshot,
  getUpdates,
  pruneUpdatesBeforeSnapshot,
  storeSnapshot,
  storeUpdates
} from './crdt'

interface FakeUpdateRow {
  id: string
  user_id: string
  vault_id: string
  note_id: string
  update_data: ArrayBuffer
  sequence_num: number
  signer_device_id: string
  created_at: number
  client_platform: string | null
  client_version: string | null
}

interface FakeSnapshotRow {
  id: string
  user_id: string
  vault_id: string
  note_id: string
  blob_key: string
  sequence_num: number
  size_bytes: number
  signer_device_id: string
  created_at: number
  revision: string
  client_platform: string | null
  client_version: string | null
}

interface PreparedCall {
  sql: string
  bindings: unknown[]
}

function createD1Database(): D1Database {
  const updates: FakeUpdateRow[] = []
  const snapshots = new Map<string, FakeSnapshotRow>()

  const snapshotKey = (userId: string, vaultId: string, noteId: string): string =>
    `${userId}:${vaultId}:${noteId}`
  const getUpdateMax = (userId: string, vaultId: string, noteId: string): number =>
    updates
      .filter((row) => row.user_id === userId && row.vault_id === vaultId && row.note_id === noteId)
      .reduce((max, row) => Math.max(max, row.sequence_num), 0)
  const getSnapshotMax = (userId: string, vaultId: string, noteId: string): number =>
    snapshots.get(snapshotKey(userId, vaultId, noteId))?.sequence_num ?? 0
  const getCombinedMax = (userId: string, vaultId: string, noteId: string): number =>
    Math.max(getUpdateMax(userId, vaultId, noteId), getSnapshotMax(userId, vaultId, noteId))

  const db = {
    prepare(sql: string) {
      let params: unknown[] = []

      const prepared = {
        bind(...nextParams: unknown[]) {
          // D1 refuses a query with more than 100 bound parameters and answers
          // the whole request with an error. A double that accepts any number of
          // them is the reason a 100-note batch pull could ship green here and
          // 500 against a real database.
          if (nextParams.length > 100) {
            throw new Error('D1_ERROR: too many SQL variables')
          }
          params = nextParams
          return prepared
        },
        async first<T>() {
          if (sql.startsWith('SELECT COALESCE(MAX(sequence_num), 0) as max_seq')) {
            const maxSeq =
              sql.includes('crdt_snapshots') && sql.includes('UNION ALL')
                ? getCombinedMax(params[0] as string, params[1] as string, params[2] as string)
                : getUpdateMax(params[0] as string, params[1] as string, params[2] as string)
            return { max_seq: maxSeq } as T
          }

          if (sql.startsWith('SELECT sequence_num, size_bytes FROM crdt_snapshots')) {
            const row = snapshots.get(
              snapshotKey(params[0] as string, params[1] as string, params[2] as string)
            )
            if (!row) return null
            return { sequence_num: row.sequence_num, size_bytes: row.size_bytes } as T
          }

          if (sql.startsWith('SELECT sequence_num FROM crdt_snapshots')) {
            const row = snapshots.get(
              snapshotKey(params[0] as string, params[1] as string, params[2] as string)
            )
            if (!row) return null
            return { sequence_num: row.sequence_num } as T
          }

          if (sql.startsWith('SELECT id, blob_key, sequence_num, signer_device_id')) {
            const row = snapshots.get(
              snapshotKey(params[0] as string, params[1] as string, params[2] as string)
            )
            if (!row) return null
            return {
              id: row.id,
              blob_key: row.blob_key,
              sequence_num: row.sequence_num,
              signer_device_id: row.signer_device_id,
              created_at: row.created_at,
              size_bytes: row.size_bytes,
              revision: row.revision
            } as T
          }

          if (sql.includes('SUM(length(update_data))')) {
            const totalBytes = updates
              .filter(
                (row) =>
                  row.user_id === params[0] &&
                  row.vault_id === params[1] &&
                  row.note_id === params[2] &&
                  row.sequence_num <= (params[3] as number)
              )
              .reduce((sum, row) => sum + row.update_data.byteLength, 0)
            return { total_bytes: totalBytes } as T
          }

          return null
        },
        async all<T>() {
          if (sql.startsWith('INSERT INTO crdt_updates')) {
            // storeUpdates sends these through db.batch, whose statements run
            // sequentially inside one transaction — which this double models by
            // executing each insert synchronously, so statement N's MAX sees
            // statement N-1's row. Bindings are positional and this double
            // reads them by index, so the insert's own column list and the
            // subquery's offsets have to be kept in step with crdt.ts by hand.
            // Attribution added two columns to the SELECT list, pushing the
            // subquery's (user, vault, note) triple from 7-9 to 9-11.
            const nextSequence =
              sql.includes('crdt_snapshots') && sql.includes('UNION ALL')
                ? getCombinedMax(params[9] as string, params[10] as string, params[11] as string) +
                  1
                : getUpdateMax(params[9] as string, params[10] as string, params[11] as string) + 1

            updates.push({
              id: params[0] as string,
              user_id: params[1] as string,
              vault_id: params[2] as string,
              note_id: params[3] as string,
              update_data: params[4] as ArrayBuffer,
              sequence_num: nextSequence,
              signer_device_id: params[5] as string,
              created_at: params[6] as number,
              client_platform: (params[7] as string | null) ?? null,
              client_version: (params[8] as string | null) ?? null
            })

            return { results: [{ sequence_num: nextSequence }] as T[] }
          }

          if (
            sql.startsWith(
              'SELECT id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates'
            )
          ) {
            const rows = updates
              .filter(
                (row) =>
                  row.user_id === params[0] &&
                  row.vault_id === params[1] &&
                  row.note_id === params[2] &&
                  row.sequence_num > (params[3] as number)
              )
              .sort((a, b) => a.sequence_num - b.sequence_num)
              .slice(0, params[4] as number)

            return { results: rows as T[] }
          }

          if (sql.startsWith('SELECT id, note_id, sequence_num, revision')) {
            const [userId, vaultId, ...noteIds] = params as string[]
            const rows = noteIds
              .map((noteId) => snapshots.get(snapshotKey(userId, vaultId, noteId)))
              .filter((row): row is FakeSnapshotRow => row !== undefined)
            return { results: rows as T[] }
          }

          return { results: [] as T[] }
        },
        async run() {
          if (sql.startsWith('INSERT INTO crdt_snapshots')) {
            const key = snapshotKey(params[1] as string, params[2] as string, params[3] as string)
            const incoming: FakeSnapshotRow = {
              id: params[0] as string,
              user_id: params[1] as string,
              vault_id: params[2] as string,
              note_id: params[3] as string,
              blob_key: params[4] as string,
              sequence_num: params[5] as number,
              size_bytes: params[6] as number,
              signer_device_id: params[7] as string,
              created_at: params[8] as number,
              revision: params[9] as string,
              client_platform: (params[10] as string | null) ?? null,
              client_version: (params[11] as string | null) ?? null
            }

            const existing = snapshots.get(key)
            if (!existing) {
              snapshots.set(key, incoming)
              return { meta: { changes: 1 } }
            }

            // On conflict SQLite applies ONLY the columns named in DO UPDATE SET,
            // and `id` is deliberately not one of them. Modelling the clause
            // rather than overwriting the whole row is what lets the revision-bump
            // assertion actually fail: a SET clause that forgets `revision` leaves
            // the stored one behind, which is the failure this token exists to
            // prevent.
            const setClause = sql.slice(sql.indexOf('DO UPDATE SET'))
            const updated: FakeSnapshotRow = { ...existing }
            const target = updated as unknown as Record<string, unknown>
            const source = incoming as unknown as Record<string, unknown>
            for (const column of [
              'blob_key',
              'sequence_num',
              'size_bytes',
              'signer_device_id',
              'created_at',
              'revision',
              'client_platform',
              'client_version'
            ]) {
              if (setClause.includes(`${column} = excluded.${column}`)) {
                target[column] = source[column]
              }
            }
            snapshots.set(key, updated)
            return { meta: { changes: 1 } }
          }

          if (sql.startsWith('DELETE FROM crdt_updates')) {
            const before = updates.length
            const remaining = updates.filter(
              (row) =>
                !(
                  row.user_id === params[0] &&
                  row.vault_id === params[1] &&
                  row.note_id === params[2] &&
                  row.sequence_num <= (params[3] as number)
                )
            )
            updates.splice(0, updates.length, ...remaining)
            return { meta: { changes: before - updates.length } }
          }

          if (sql.includes('UPDATE users') && sql.includes('storage_used')) {
            return { meta: { changes: 1 } }
          }

          return { meta: { changes: 0 } }
        }
      }

      return prepared as unknown as D1PreparedStatement
    }
  }

  return {
    ...db,
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.all()))
    }
  } as unknown as D1Database
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

  it('returns null when a snapshot row or object is missing', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()

    await expect(getSnapshot(db, storage, 'user-1', 'vault-1', 'note-1')).resolves.toBeNull()

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-a', bytes('snapshot-a'))

    const missingStorage = { get: async () => null } as unknown as R2Bucket
    await expect(getSnapshot(db, missingStorage, 'user-1', 'vault-1', 'note-1')).resolves.toBeNull()
  })

  it('does not prune updates when no snapshot exists', async () => {
    const db = createD1Database()

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-a', [bytes('a1')])

    await expect(pruneUpdatesBeforeSnapshot(db, 'user-1', 'vault-1', 'note-1')).resolves.toBe(0)
  })
})

describe('CRDT storage accounting', () => {
  it('increments storage usage by the actual stored update bytes', async () => {
    const { db, statements } = createRecordingDatabase({
      first: (sql) => (sql.includes('INSERT INTO crdt_updates') ? { sequence_num: 1 } : null)
    })

    await storeUpdates(db, 'user-1', 'vault-1', 'note-1', 'device-1', [
      new Uint8Array([1, 2]).buffer,
      new Uint8Array([3]).buffer
    ])

    const usageUpdate = statements.find((entry) => entry.sql.includes('UPDATE users'))
    expect(usageUpdate?.bindings).toEqual([3, expect.any(Number), 'user-1', 3, expect.any(Number)])
  })

  it('adjusts storage usage by the snapshot replacement delta', async () => {
    const { db, statements } = createRecordingDatabase({
      first: (sql) => {
        if (sql.includes('COALESCE(MAX(sequence_num)')) return { max_seq: 4 }
        if (sql.includes('FROM crdt_snapshots')) {
          return { sequence_num: 2, size_bytes: 3 }
        }
        return null
      }
    })
    const storage = { put: vi.fn().mockResolvedValue({ etag: 'etag-1' }) } as unknown as R2Bucket
    const snapshot = new Uint8Array(10).buffer

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-1', snapshot)

    expect(storage.put).toHaveBeenCalledWith('user-1/vaults/vault-1/crdt/note-1/snapshot', snapshot)
    const usageUpdate = statements.find((entry) => entry.sql.includes('UPDATE users'))
    expect(usageUpdate?.bindings).toEqual([7, expect.any(Number), 'user-1', 7, expect.any(Number)])
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
        if (stmt.sql.includes('INSERT INTO crdt_updates')) {
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
