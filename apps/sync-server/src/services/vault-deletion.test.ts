import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteVaultData, vaultExistsForUser } from './vault-deletion'

interface FakeStmt {
  _sql: string
  _args: unknown[]
  bind: (...args: unknown[]) => FakeStmt
  first: () => Promise<unknown>
  run: () => Promise<{ meta: { changes: number } }>
}

const makeDb = (opts: { exists?: boolean; sums?: Record<string, number> } = {}) => {
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
