import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteVaultData, vaultExistsForUser } from './vault-deletion'

interface FakeStmt {
  _sql: string
  _args: unknown[]
  bind: (...args: unknown[]) => FakeStmt
  first: () => Promise<unknown>
  all: () => Promise<{ results: unknown[] }>
  run: () => Promise<{ meta: { changes: number } }>
}

interface OpenSessionRow {
  total_size: number
  uploaded_chunks: string
}

const makeDb = (
  opts: {
    exists?: boolean
    sums?: Record<string, number>
    sessions?: OpenSessionRow[]
  } = {}
) => {
  const statements: FakeStmt[] = []
  return {
    statements,
    prepare: vi.fn((sql: string) => {
      const stmt: FakeStmt = {
        _sql: sql,
        _args: [],
        bind(...args: unknown[]) {
          stmt._args = args
          return stmt
        },
        async first() {
          if (sql.includes('SELECT vault_id FROM sync_vaults')) {
            return opts.exists ? { vault_id: stmt._args[1] } : null
          }
          const table = Object.keys(opts.sums ?? {}).find((t) => sql.includes(t))
          return { total: table ? opts.sums![table] : 0 }
        },
        async all() {
          if (sql.includes('FROM upload_sessions')) {
            return { results: opts.sessions ?? [] }
          }
          return { results: [] }
        },
        async run() {
          return { meta: { changes: 1 } }
        }
      }
      statements.push(stmt)
      return stmt
    }),
    batch: vi.fn().mockResolvedValue([])
  }
}

const batchOf = (db: ReturnType<typeof makeDb>): FakeStmt[] => db.batch.mock.calls[0][0]

const makeBucket = () => ({
  list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
  delete: vi.fn().mockResolvedValue(undefined)
})

describe('vaultExistsForUser', () => {
  it('scopes the lookup by user and vault', async () => {
    const db = makeDb({ exists: true })

    await expect(vaultExistsForUser(db as unknown as D1Database, 'u1', 'v1')).resolves.toBe(true)

    expect(db.statements[0]._sql).toContain('WHERE user_id = ? AND vault_id = ?')
    expect(db.statements[0]._args).toEqual(['u1', 'v1'])
  })

  it('returns false for a vault the user does not own', async () => {
    const db = makeDb({ exists: false })
    await expect(vaultExistsForUser(db as unknown as D1Database, 'u1', 'v1')).resolves.toBe(false)
  })
})

describe('deleteVaultData', () => {
  let db: ReturnType<typeof makeDb>
  let bucket: ReturnType<typeof makeBucket>

  beforeEach(async () => {
    vi.clearAllMocks()
    db = makeDb({ sums: { sync_items: 100, crdt_snapshots: 20, crdt_updates: 5, blob_chunks: 75 } })
    bucket = makeBucket()
    await deleteVaultData(db as unknown as D1Database, bucket as unknown as R2Bucket, 'u1', 'v1')
  })

  it('purges R2 under the vault prefix', () => {
    expect(bucket.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'u1/vaults/v1/' }))
  })

  it('deletes every vault-scoped table, each scoped to user + vault', () => {
    const tables = [
      'crdt_updates',
      'crdt_snapshots',
      'upload_sessions',
      'blob_chunks',
      'device_sync_state',
      'sync_items',
      'sync_vaults'
    ]
    for (const table of tables) {
      const stmt = batchOf(db).find((s) => s._sql.includes(`DELETE FROM ${table}`))
      expect(stmt, `missing DELETE for ${table}`).toBeDefined()
      expect(stmt!._sql).toContain('WHERE user_id = ? AND vault_id = ?')
      expect(stmt!._args).toEqual(['u1', 'v1'])
    }
  })

  it('nulls the devices vault_id rather than deleting device rows', () => {
    const stmt = batchOf(db).find((s) => s._sql.includes('UPDATE devices'))
    expect(stmt).toBeDefined()
    expect(stmt!._sql).toContain('SET vault_id = NULL')
    expect(batchOf(db).find((s) => s._sql.includes('DELETE FROM devices'))).toBeUndefined()
  })

  it('never deletes server_cursor_sequence (per-user, shared across vaults)', () => {
    expect(batchOf(db).find((s) => s._sql.includes('server_cursor_sequence'))).toBeUndefined()
  })

  it('decrements storage_used by the summed bytes, floored at zero', () => {
    const stmt = batchOf(db).find((s) => s._sql.includes('UPDATE users'))
    expect(stmt).toBeDefined()
    expect(stmt!._sql).toContain('MAX(0, storage_used + ?)')
    expect(stmt!._args[0]).toBe(-200) // 100 + 20 + 5 + 75
  })
})

describe('deleteVaultData with open upload sessions', () => {
  // Base sum from sync_items + crdt_snapshots + crdt_updates + blob_chunks,
  // matching the existing 'decrements storage_used' test above.
  const BASE = 100 + 20 + 5 + 75

  const decrementFor = async (sessions: OpenSessionRow[]): Promise<number> => {
    const db = makeDb({
      sums: { sync_items: 100, crdt_snapshots: 20, crdt_updates: 5, blob_chunks: 75 },
      sessions
    })
    const bucket = makeBucket()
    await deleteVaultData(db as unknown as D1Database, bucket as unknown as R2Bucket, 'u1', 'v1')
    const stmt = batchOf(db).find((s) => s._sql.includes('UPDATE users'))
    return stmt!._args[0] as number
  }

  it('releases total_size minus landed bytes for a partially-uploaded session', async () => {
    // Landed chunk (b: 400) is already counted in the blob_chunks sum above,
    // so only the unlanded remainder (1000 - 400 = 600) should be released.
    const decrement = await decrementFor([
      { total_size: 1000, uploaded_chunks: JSON.stringify([{ i: 0, h: 'a', b: 400 }]) }
    ])
    expect(decrement).toBe(-(BASE + 600))
  })

  it('releases the full total_size when no chunks have landed', async () => {
    const decrement = await decrementFor([{ total_size: 500, uploaded_chunks: '[]' }])
    expect(decrement).toBe(-(BASE + 500))
  })

  it('releases the full total_size when uploaded_chunks is malformed', async () => {
    // A negative byte count makes getUploadedByteTotal return null. The
    // reservation is real regardless of whether we can parse the chunk
    // list, so this must fall back to the full total_size, not zero.
    const decrement = await decrementFor([
      { total_size: 300, uploaded_chunks: JSON.stringify([{ i: 0, h: 'a', b: -1 }]) }
    ])
    expect(decrement).toBe(-(BASE + 300))
  })

  it('releases the full total_size when uploaded_chunks is not JSON at all', async () => {
    // The sibling case above passes valid JSON with a bad byte count, which
    // only exercises getUploadedByteTotal's null fallback. This one never
    // parses, so it takes readUploadedChunks' `ok: false` branch instead.
    //
    // The invariant under test is that a corrupt column must not abort the
    // deletion: the failure mode is a user permanently unable to delete their
    // vault. Asserting the numeric release keeps the fallback honest at the
    // same time — the reservation is real whether or not the chunk list can be
    // read, so the whole total_size comes back rather than zero.
    const decrement = await decrementFor([{ total_size: 700, uploaded_chunks: 'not json' }])
    expect(decrement).toBe(-(BASE + 700))
  })

  it('releases the full total_size when uploaded_chunks parses to a non-array', async () => {
    const decrement = await decrementFor([{ total_size: 900, uploaded_chunks: '{"i":0}' }])
    expect(decrement).toBe(-(BASE + 900))
  })
})

describe('deleteVaultData ordering', () => {
  // R2 first, so a mid-flight failure leaves retryable rows rather than
  // orphaned, unreachable objects.
  it('purges R2 before the D1 batch', async () => {
    const order: string[] = []
    const db = makeDb()
    db.batch = vi.fn(async () => {
      order.push('d1')
      return []
    })
    const bucket = {
      list: vi.fn(async () => {
        order.push('r2')
        return { objects: [], truncated: false }
      }),
      delete: vi.fn().mockResolvedValue(undefined)
    }

    await deleteVaultData(db as unknown as D1Database, bucket as unknown as R2Bucket, 'u1', 'v1')

    expect(order).toEqual(['r2', 'd1'])
  })
})
