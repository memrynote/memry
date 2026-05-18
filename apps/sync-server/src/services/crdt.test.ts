import { describe, expect, it, vi } from 'vitest'

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
          params = nextParams
          return prepared
        },
        async first<T>() {
          if (sql.startsWith('INSERT INTO crdt_updates')) {
            const nextSequence =
              sql.includes('crdt_snapshots') && sql.includes('UNION ALL')
                ? getCombinedMax(params[7] as string, params[8] as string, params[9] as string) + 1
                : getUpdateMax(params[7] as string, params[8] as string, params[9] as string) + 1

            updates.push({
              id: params[0] as string,
              user_id: params[1] as string,
              vault_id: params[2] as string,
              note_id: params[3] as string,
              update_data: params[4] as ArrayBuffer,
              sequence_num: nextSequence,
              signer_device_id: params[5] as string,
              created_at: params[6] as number
            })

            return { sequence_num: nextSequence } as T
          }

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

          if (
            sql.startsWith('SELECT blob_key, sequence_num, signer_device_id FROM crdt_snapshots')
          ) {
            const row = snapshots.get(
              snapshotKey(params[0] as string, params[1] as string, params[2] as string)
            )
            if (!row) return null
            return {
              blob_key: row.blob_key,
              sequence_num: row.sequence_num,
              signer_device_id: row.signer_device_id
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

          return { results: [] as T[] }
        },
        async run() {
          if (sql.startsWith('INSERT INTO crdt_snapshots')) {
            const row: FakeSnapshotRow = {
              id: params[0] as string,
              user_id: params[1] as string,
              vault_id: params[2] as string,
              note_id: params[3] as string,
              blob_key: params[4] as string,
              sequence_num: params[5] as number,
              size_bytes: params[6] as number,
              signer_device_id: params[7] as string,
              created_at: params[8] as number
            }
            snapshots.set(snapshotKey(row.user_id, row.vault_id, row.note_id), row)
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
    })
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
      return null as unknown as R2Object
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

    expect(result['note-1'].hasMore).toBe(true)
    expect(result['note-1'].updates.map((update) => update.sequence_num)).toEqual([1, 2])
    expect(result['note-2'].hasMore).toBe(false)
    expect(result['note-2'].updates.map((update) => update.sequence_num)).toEqual([1])
  })

  it('returns an empty batch result when no notes are requested', async () => {
    const db = createD1Database()

    await expect(getBatchUpdates(db, 'user-1', 'vault-1', [], 10)).resolves.toEqual({})
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
    expect(usageUpdate?.bindings).toEqual([3, expect.any(Number), 'user-1'])
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
    const storage = { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket
    const snapshot = new Uint8Array(10).buffer

    await storeSnapshot(db, storage, 'user-1', 'vault-1', 'note-1', 'device-1', snapshot)

    expect(storage.put).toHaveBeenCalledWith('user-1/vaults/vault-1/crdt/note-1/snapshot', snapshot)
    const usageUpdate = statements.find((entry) => entry.sql.includes('UPDATE users'))
    expect(usageUpdate?.bindings).toEqual([7, expect.any(Number), 'user-1'])
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
    expect(usageUpdate?.sql).toContain('MAX(0, storage_used - ?)')
    expect(usageUpdate?.bindings).toEqual([8, expect.any(Number), 'user-1'])
  })
})
