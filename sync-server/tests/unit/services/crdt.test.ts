import { describe, it, expect, vi } from 'vitest'
import { getCrdtUpdates, getLatestUpdateSequence, storeCrdtUpdates } from '../../../src/services/crdt'

type UpdateRow = {
  noteId: string
  sequenceNum: number
  updateData: Uint8Array
  signature: Uint8Array
  signerDeviceId: string
  createdAt: number
}

function createMockCrdtDb(options?: { snapshotSequence?: number; updateSequence?: number }) {
  const snapshotSequence = options?.snapshotSequence ?? 0
  let maxUpdateSequence = options?.updateSequence ?? 0
  const insertedRows: UpdateRow[] = []

  const db = {
    prepare: vi.fn((sql: string) => {
      let boundArgs: unknown[] = []
      const statement = {
        bind: vi.fn((...args: unknown[]) => {
          boundArgs = args
          return statement
        }),
        first: vi.fn(async () => {
          if (sql.includes('FROM crdt_updates') && sql.includes('MAX(sequence_num)')) {
            return { max_seq: maxUpdateSequence }
          }
          if (sql.includes('FROM crdt_snapshots')) {
            return snapshotSequence > 0 ? { sequence_num: snapshotSequence } : null
          }
          return null
        }),
        all: vi.fn(async () => {
          if (sql.includes('FROM sync_items')) {
            const noteIds = boundArgs.slice(1) as string[]
            return { results: noteIds.map((noteId) => ({ item_id: noteId })) }
          }
          return { results: [] }
        }),
        run: vi.fn(async () => {
          if (sql.includes('INSERT INTO crdt_updates')) {
            const sequenceNum = boundArgs[4] as number
            maxUpdateSequence = Math.max(maxUpdateSequence, sequenceNum)
            insertedRows.push({
              noteId: boundArgs[2] as string,
              updateData: boundArgs[3] as Uint8Array,
              sequenceNum,
              signerDeviceId: boundArgs[5] as string,
              signature: boundArgs[6] as Uint8Array,
              createdAt: boundArgs[7] as number
            })
          }
          return { meta: { changes: 1 } }
        })
      }
      return statement
    })
  }

  return { db, insertedRows }
}

describe('CRDT service sequence handling', () => {
  it('stores post-snapshot updates with sequence numbers after snapshot sequence', async () => {
    const { db, insertedRows } = createMockCrdtDb({ snapshotSequence: 1 })

    const updates = [
      {
        noteId: 'note-1',
        updateData: 'AQ==',
        signature: 'AQ==',
        signerDeviceId: 'device-a'
      },
      {
        noteId: 'note-1',
        updateData: 'Ag==',
        signature: 'Ag==',
        signerDeviceId: 'device-a'
      }
    ]

    const result = await storeCrdtUpdates(db as any, 'user-1', updates)

    expect(result.rejected).toEqual([])
    expect(result.accepted.map((item) => item.sequenceNum)).toEqual([2, 3])
    expect(insertedRows.map((row) => row.sequenceNum)).toEqual([2, 3])
  })

  it('reports latest sequence as max(snapshot sequence, updates sequence)', async () => {
    const { db } = createMockCrdtDb({ snapshotSequence: 5, updateSequence: 2 })

    const latest = await getLatestUpdateSequence(db as any, 'user-1', 'note-1')

    expect(latest).toBe(5)
  })

  it('repairs legacy post-snapshot sequence collisions and returns recoverable updates', async () => {
    const rows = [
      {
        id: 'legacy-1',
        update_data: Uint8Array.from([1, 2, 3]),
        sequence_num: 1,
        signer_device_id: 'device-a',
        signature: Uint8Array.from([9, 9, 9]),
        created_at: 2000
      },
      {
        id: 'update-2',
        update_data: Uint8Array.from([4, 5, 6]),
        sequence_num: 2,
        signer_device_id: 'device-a',
        signature: Uint8Array.from([8, 8, 8]),
        created_at: 3000
      }
    ]

    const db = {
      prepare: vi.fn((sql: string) => {
        let boundArgs: unknown[] = []
        const statement = {
          bind: vi.fn((...args: unknown[]) => {
            boundArgs = args
            return statement
          }),
          first: vi.fn(async () => {
            if (sql.includes('FROM crdt_snapshots') && sql.includes('sequence_num, created_at')) {
              return { sequence_num: 1, created_at: 1000 }
            }
            if (sql.includes('FROM crdt_updates') && sql.includes('sequence_num = ?')) {
              const sequence = boundArgs[2] as number
              const createdAfter = boundArgs[3] as number
              const legacy = rows.find(
                (row) => row.sequence_num === sequence && row.created_at > createdAfter
              )
              return legacy ? { id: legacy.id } : null
            }
            if (sql.includes('FROM crdt_updates') && sql.includes('MAX(sequence_num)')) {
              return { max_seq: Math.max(...rows.map((row) => row.sequence_num)) }
            }
            if (sql.includes('FROM crdt_snapshots') && sql.includes('SELECT sequence_num')) {
              return { sequence_num: 1 }
            }
            return null
          }),
          all: vi.fn(async () => {
            if (sql.includes('FROM crdt_updates')) {
              const since = boundArgs[2] as number
              return {
                results: rows
                  .filter((row) => row.sequence_num > since)
                  .sort((a, b) => a.sequence_num - b.sequence_num)
                  .map((row) => ({
                    update_data: row.update_data,
                    sequence_num: row.sequence_num,
                    signer_device_id: row.signer_device_id,
                    signature: row.signature,
                    created_at: row.created_at
                  }))
              }
            }
            return { results: [] }
          }),
          run: vi.fn(async () => {
            if (sql.includes('UPDATE crdt_updates SET sequence_num = ? WHERE id = ?')) {
              const newSequence = boundArgs[0] as number
              const id = boundArgs[1] as string
              const target = rows.find((row) => row.id === id)
              if (target) {
                target.sequence_num = newSequence
              }
            }
            return { meta: { changes: 1 } }
          })
        }
        return statement
      })
    }

    // Simulate a client that already advanced to sinceSequence=2 and missed the legacy seq=1 update.
    const result = await getCrdtUpdates(db as any, 'user-1', 'note-1', 2, 50)

    expect(result.updates.map((row) => row.sequenceNum)).toEqual([3])
    expect(result.latestSequence).toBe(3)
    expect(result.hasMore).toBe(false)
  })
})
