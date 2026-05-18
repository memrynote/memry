import { describe, it, expect, vi, beforeEach } from 'vitest'

import { adjustStorageUsed, checkQuota, reserveStorage } from './quota'

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
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
    stmt.first.mockResolvedValue({
      storage_used: 500,
      storage_limit: 1000,
      plan: 'plus',
      status: 'active',
      expires_at: null
    })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 100)).resolves.toBeUndefined()
  })

  it('should throw 413 when user exceeds quota', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({
      storage_used: 900,
      storage_limit: 1000,
      plan: 'plus',
      status: 'active',
      expires_at: null
    })
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
    stmt.first.mockResolvedValue({
      storage_used: 1000,
      storage_limit: 1000,
      plan: 'plus',
      status: 'active',
      expires_at: null
    })
    db.prepare.mockReturnValue(stmt)

    // #when / #then
    await expect(checkQuota(db as unknown as D1Database, 'user-1', 1)).rejects.toThrow()
  })

  it('should not throw when exactly at limit', async () => {
    // #given
    const stmt = createMockStatement()
    stmt.first.mockResolvedValue({
      storage_used: 500,
      storage_limit: 1000,
      plan: 'plus',
      status: 'active',
      expires_at: null
    })
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

describe('reserveStorage', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('atomically increments storage when the paid entitlement has room', async () => {
    const stmt = createMockStatement()
    stmt.run.mockResolvedValue({ meta: { changes: 1 } })
    db.prepare.mockReturnValue(stmt)

    await expect(
      reserveStorage(db as unknown as D1Database, 'user-1', 100)
    ).resolves.toBeUndefined()

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'))
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('sync_entitlements'))
    expect(stmt.bind).toHaveBeenCalledWith(
      100,
      expect.any(Number),
      'user-1',
      100,
      expect.any(Number)
    )
  })

  it('throws quota exceeded when the conditional storage reservation does not update a row', async () => {
    const reserveStmt = createMockStatement()
    reserveStmt.run.mockResolvedValue({ meta: { changes: 0 } })
    const entitlementStmt = createMockStatement()
    entitlementStmt.first.mockResolvedValue({
      storage_used: 950,
      storage_limit: 1000,
      plan: 'plus',
      status: 'active',
      expires_at: null
    })
    db.prepare.mockReturnValueOnce(reserveStmt).mockReturnValueOnce(entitlementStmt)

    await expect(reserveStorage(db as unknown as D1Database, 'user-1', 100)).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
      statusCode: 413
    })
  })

  it('releases storage with a floor at zero', async () => {
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    await adjustStorageUsed(db as unknown as D1Database, 'user-1', -50)

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('MAX(0, storage_used + ?)'))
    expect(stmt.bind).toHaveBeenCalledWith(-50, expect.any(Number), 'user-1')
  })
})
