import { describe, expect, it } from 'vitest'

import {
  getSnapshot,
  getUpdates,
  pruneUpdatesBeforeSnapshot,
  storeSnapshot,
  storeUpdates
} from './crdt'

interface FakeUpdateRow {
  id: string
  user_id: string
  note_id: string
  update_data: ArrayBuffer
  sequence_num: number
  signer_device_id: string
  created_at: number
}

interface FakeSnapshotRow {
  id: string
  user_id: string
  note_id: string
  blob_key: string
  sequence_num: number
  size_bytes: number
  signer_device_id: string
  created_at: number
}

function createD1Database(): D1Database {
  const updates: FakeUpdateRow[] = []
  const snapshots = new Map<string, FakeSnapshotRow>()

  const snapshotKey = (userId: string, noteId: string): string => `${userId}:${noteId}`
  const getUpdateMax = (userId: string, noteId: string): number =>
    updates
      .filter((row) => row.user_id === userId && row.note_id === noteId)
      .reduce((max, row) => Math.max(max, row.sequence_num), 0)
  const getSnapshotMax = (userId: string, noteId: string): number =>
    snapshots.get(snapshotKey(userId, noteId))?.sequence_num ?? 0
  const getCombinedMax = (userId: string, noteId: string): number =>
    Math.max(getUpdateMax(userId, noteId), getSnapshotMax(userId, noteId))

  return {
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
                ? getCombinedMax(params[6] as string, params[7] as string) + 1
                : getUpdateMax(params[6] as string, params[7] as string) + 1

            updates.push({
              id: params[0] as string,
              user_id: params[1] as string,
              note_id: params[2] as string,
              update_data: params[3] as ArrayBuffer,
              sequence_num: nextSequence,
              signer_device_id: params[4] as string,
              created_at: params[5] as number
            })

            return { sequence_num: nextSequence } as T
          }

          if (sql.startsWith('SELECT COALESCE(MAX(sequence_num), 0) as max_seq')) {
            const maxSeq =
              sql.includes('crdt_snapshots') && sql.includes('UNION ALL')
                ? getCombinedMax(params[0] as string, params[1] as string)
                : getUpdateMax(params[0] as string, params[1] as string)
            return { max_seq: maxSeq } as T
          }

          if (sql.startsWith('SELECT sequence_num FROM crdt_snapshots')) {
            const row = snapshots.get(snapshotKey(params[0] as string, params[1] as string))
            if (!row) return null
            return { sequence_num: row.sequence_num } as T
          }

          if (sql.startsWith('SELECT blob_key, sequence_num, signer_device_id FROM crdt_snapshots')) {
            const row = snapshots.get(snapshotKey(params[0] as string, params[1] as string))
            if (!row) return null
            return {
              blob_key: row.blob_key,
              sequence_num: row.sequence_num,
              signer_device_id: row.signer_device_id
            } as T
          }

          return null
        },
        async all<T>() {
          if (
            sql.startsWith(
              'SELECT id, user_id, note_id, update_data, sequence_num, signer_device_id, created_at FROM crdt_updates'
            )
          ) {
            const rows = updates
              .filter(
                (row) =>
                  row.user_id === params[0] &&
                  row.note_id === params[1] &&
                  row.sequence_num > (params[2] as number)
              )
              .sort((a, b) => a.sequence_num - b.sequence_num)
              .slice(0, params[3] as number)

            return { results: rows as T[] }
          }

          return { results: [] as T[] }
        },
        async run() {
          if (sql.startsWith('INSERT INTO crdt_snapshots')) {
            const row: FakeSnapshotRow = {
              id: params[0] as string,
              user_id: params[1] as string,
              note_id: params[2] as string,
              blob_key: params[3] as string,
              sequence_num: params[4] as number,
              size_bytes: params[5] as number,
              signer_device_id: params[6] as string,
              created_at: params[7] as number
            }
            snapshots.set(snapshotKey(row.user_id, row.note_id), row)
            return { meta: { changes: 1 } }
          }

          if (sql.startsWith('DELETE FROM crdt_updates')) {
            const before = updates.length
            const remaining = updates.filter(
              (row) =>
                !(
                  row.user_id === params[0] &&
                  row.note_id === params[1] &&
                  row.sequence_num <= (params[2] as number)
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
  } as unknown as D1Database
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
  return Uint8Array.from(Buffer.from(value, 'utf8')).buffer
}

describe('CRDT service sequencing', () => {
  it('keeps later offline updates above the existing snapshot watermark', async () => {
    const db = createD1Database()
    const storage = createMemoryBucket()

    const initialSequences = await storeUpdates(db, 'user-1', 'note-1', 'device-a', [
      bytes('a1'),
      bytes('a2')
    ])
    expect(initialSequences).toEqual([1, 2])

    const firstSnapshot = await storeSnapshot(
      db,
      storage,
      'user-1',
      'note-1',
      'device-a',
      bytes('snapshot-a')
    )
    expect(firstSnapshot.sequenceNum).toBe(2)
    expect(await pruneUpdatesBeforeSnapshot(db, 'user-1', 'note-1')).toBe(2)

    const laterSequences = await storeUpdates(db, 'user-1', 'note-1', 'device-b', [
      bytes('b1'),
      bytes('b2')
    ])
    expect(laterSequences).toEqual([3, 4])

    const replacementSnapshot = await storeSnapshot(
      db,
      storage,
      'user-1',
      'note-1',
      'device-b',
      bytes('snapshot-b')
    )
    expect(replacementSnapshot.sequenceNum).toBe(2)
    expect(await pruneUpdatesBeforeSnapshot(db, 'user-1', 'note-1')).toBe(0)

    const snapshot = await getSnapshot(db, storage, 'user-1', 'note-1')
    expect(snapshot?.sequenceNum).toBe(2)

    const pulled = await getUpdates(db, 'user-1', 'note-1', 2, 10)
    expect(pulled.updates.map((update) => update.sequence_num)).toEqual([3, 4])
  })
})
