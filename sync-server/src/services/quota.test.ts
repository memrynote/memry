import { describe, it, expect, vi, beforeEach } from 'vitest'

import { checkQuota } from './quota'

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null)
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockDb = () => ({
  prepare: vi.fn().mockReturnValue(createMockStatement())
})

describe('checkQuota', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should not throw when user is under quota', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({ storage_used: 500, storage_limit: 1000 })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 100)).resolves.toBeUndefined()
  })

  it('should throw 413 when user exceeds quota', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({ storage_used: 900, storage_limit: 1000 })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 200)).rejects.toThrow()
    try {
      await checkQuota(db as unknown as D1Database, 'user-1', 200)
    } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(413)
      expect((e as { code: string }).code).toBe('STORAGE_QUOTA_EXCEEDED')
    }
  })

  it('should throw 413 when additional bytes exactly exceed limit', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({ storage_used: 1000, storage_limit: 1000 })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 1)).rejects.toThrow()
  })

  it('should not throw when exactly at limit', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({ storage_used: 500, storage_limit: 1000 })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 500)).resolves.toBeUndefined()
  })

  it('should throw 404 when user not found', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue(null)
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'nonexistent', 100)).rejects.toThrow()
    try {
      await checkQuota(db as unknown as D1Database, 'nonexistent', 100)
    } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(404)
    }
  })
})
