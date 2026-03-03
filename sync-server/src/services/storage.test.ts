import { describe, it, expect, vi } from 'vitest'

import { getStorageBreakdown } from './storage'

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

function createMockStatement(overrides?: Partial<MockStatement>): MockStatement {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

function createSqlMatchingDb(stmtMap: Record<string, MockStatement>) {
  return {
    prepare: vi.fn((sql: string) => {
      for (const [pattern, stmt] of Object.entries(stmtMap)) {
        if (sql.includes(pattern)) return stmt
      }
      return createMockStatement()
    })
  }
}

function defaultStmts(overrides?: {
  user?: MockStatement
  categories?: MockStatement
  crdt?: MockStatement
}) {
  const user =
    overrides?.user ??
    createMockStatement({
      first: vi.fn().mockResolvedValue({ storage_used: 5000, storage_limit: 100_000 })
    } as Partial<MockStatement>)

  const categories =
    overrides?.categories ??
    createMockStatement({
      all: vi.fn().mockResolvedValue({ results: [] })
    } as Partial<MockStatement>)

  const crdt =
    overrides?.crdt ??
    createMockStatement({
      first: vi.fn().mockResolvedValue({ total_bytes: 0 })
    } as Partial<MockStatement>)

  return createSqlMatchingDb({
    'FROM users': user,
    'FROM sync_items': categories,
    'FROM crdt_snapshots': crdt
  })
}

describe('getStorageBreakdown', () => {
  it('should map mixed item types to correct categories', async () => {
    // #given
    const db = defaultStmts({
      categories: createMockStatement({
        all: vi.fn().mockResolvedValue({
          results: [
            { item_type: 'note', total_bytes: 1000 },
            { item_type: 'journal', total_bytes: 500 },
            { item_type: 'attachment', total_bytes: 2000 },
            { item_type: 'task', total_bytes: 300 },
            { item_type: 'project', total_bytes: 200 }
          ]
        })
      } as Partial<MockStatement>),
      crdt: createMockStatement({
        first: vi.fn().mockResolvedValue({ total_bytes: 800 })
      } as Partial<MockStatement>)
    })

    // #when
    const result = await getStorageBreakdown(db as unknown as D1Database, 'user-1')

    // #then
    expect(result.used).toBe(5000)
    expect(result.limit).toBe(100_000)
    expect(result.breakdown.notes).toBe(1500)
    expect(result.breakdown.attachments).toBe(2000)
    expect(result.breakdown.crdt).toBe(800)
    expect(result.breakdown.other).toBe(500)
  })

  it('should return all zeros when user has no items', async () => {
    // #given
    const db = defaultStmts()

    // #when
    const result = await getStorageBreakdown(db as unknown as D1Database, 'user-1')

    // #then
    expect(result.used).toBe(5000)
    expect(result.limit).toBe(100_000)
    expect(result.breakdown).toEqual({ notes: 0, attachments: 0, crdt: 0, other: 0 })
  })

  it('should throw 404 when user not found', async () => {
    // #given
    const db = defaultStmts({
      user: createMockStatement()
    })

    // #when / #then
    try {
      await getStorageBreakdown(db as unknown as D1Database, 'ghost')
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(404)
      expect((e as { code: string }).code).toBe('NOT_FOUND')
    }
  })

  it('should include crdt snapshots in crdt category', async () => {
    // #given
    const db = defaultStmts({
      crdt: createMockStatement({
        first: vi.fn().mockResolvedValue({ total_bytes: 4200 })
      } as Partial<MockStatement>)
    })

    // #when
    const result = await getStorageBreakdown(db as unknown as D1Database, 'user-1')

    // #then
    expect(result.breakdown.crdt).toBe(4200)
  })

  it('should exclude deleted items via SQL WHERE clause', async () => {
    // #given
    const db = defaultStmts()

    // #when
    await getStorageBreakdown(db as unknown as D1Database, 'user-1')

    // #then
    const syncItemsCall = db.prepare.mock.calls.find(
      (c: string[]) => typeof c[0] === 'string' && c[0].includes('sync_items')
    )
    expect(syncItemsCall).toBeDefined()
    expect(syncItemsCall![0]).toContain('deleted_at IS NULL')
  })
})
