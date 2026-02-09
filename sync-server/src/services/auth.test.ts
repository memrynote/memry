import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

// ============================================================================
// D1 mock
// ============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: [] })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockDb = () => ({
  prepare: vi.fn().mockReturnValue(createMockStatement())
})

// ============================================================================
// jose mock
// ============================================================================

vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  SignJWT: vi.fn().mockImplementation(() => {
    const builder = {
      setProtectedHeader: vi.fn().mockReturnThis(),
      setIssuedAt: vi.fn().mockReturnThis(),
      setIssuer: vi.fn().mockReturnThis(),
      setAudience: vi.fn().mockReturnThis(),
      setExpirationTime: vi.fn().mockReturnThis(),
      sign: vi.fn().mockResolvedValue('mock-jwt-token')
    }
    return builder
  })
}))

import { issueTokens, rotateRefreshToken, revokeDeviceTokens } from './auth'

// ============================================================================
// Tests: issueTokens
// ============================================================================

describe('issueTokens', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should return accessToken and refreshToken', async () => {
    // #when
    const result = await issueTokens(db as unknown as D1Database, 'user-1', 'device-1', 'pem-key')

    // #then
    expect(result).toHaveProperty('accessToken')
    expect(result).toHaveProperty('refreshToken')
    expect(typeof result.accessToken).toBe('string')
    expect(typeof result.refreshToken).toBe('string')
  })

  it('should persist the refresh token hash to the database', async () => {
    // #when
    await issueTokens(db as unknown as D1Database, 'user-1', 'device-1', 'pem-key')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO refresh_tokens')
    )
    const insertStmt = db.prepare.mock.results.find((r) =>
      r.value?.bind?.mock?.calls?.length
    )
    expect(insertStmt).toBeDefined()
  })

  it('should use the provided userId and deviceId', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })

    // #when
    await issueTokens(db as unknown as D1Database, 'user-42', 'dev-99', 'pem-key')

    // #then
    const insertStmt = stmts[0]
    const bindArgs = insertStmt.bind.mock.calls[0]
    expect(bindArgs[1]).toBe('user-42')
    expect(bindArgs[2]).toBe('dev-99')
  })
})

// ============================================================================
// Tests: rotateRefreshToken
// ============================================================================

describe('rotateRefreshToken', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
  })

  it('should revoke old token and issue new tokens when valid', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })
    // The SELECT statement returns an existing token
    stmts[0] = createMockStatement()
    stmts[0].bind.mockReturnValue(stmts[0])
    stmts[0].first.mockResolvedValue({ id: 'token-id-1' })
    db.prepare.mockReturnValueOnce(stmts[0])

    // #when
    const result = await rotateRefreshToken(
      db as unknown as D1Database,
      'old-refresh-token',
      'user-1',
      'device-1',
      'pem-key'
    )

    // #then
    expect(result).toHaveProperty('accessToken')
    expect(result).toHaveProperty('refreshToken')
  })

  it('should throw and revoke all device tokens when old token is invalid', async () => {
    // #given - SELECT returns null (no matching token)
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const revokeStmt = createMockStatement()

    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(revokeStmt)

    // #when / #then
    await expect(
      rotateRefreshToken(
        db as unknown as D1Database,
        'bad-token',
        'user-1',
        'device-1',
        'pem-key'
      )
    ).rejects.toThrow(AppError)

    expect(revokeStmt.bind).toHaveBeenCalledWith('user-1', 'device-1')
    expect(revokeStmt.run).toHaveBeenCalled()
  })

  it('should throw with 401 status on invalid token', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    const revokeStmt = createMockStatement()

    db.prepare
      .mockReturnValueOnce(selectStmt)
      .mockReturnValueOnce(revokeStmt)

    // #when / #then
    try {
      await rotateRefreshToken(
        db as unknown as D1Database,
        'bad-token',
        'user-1',
        'device-1',
        'pem-key'
      )
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).statusCode).toBe(401)
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    }
  })
})

// ============================================================================
// Tests: revokeDeviceTokens
// ============================================================================

describe('revokeDeviceTokens', () => {
  it('should update all non-revoked tokens for the device', async () => {
    // #given
    const db = createMockDb()
    const stmt = createMockStatement()
    db.prepare.mockReturnValue(stmt)

    // #when
    await revokeDeviceTokens(db as unknown as D1Database, 'device-42')

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE refresh_tokens SET revoked = 1')
    )
    expect(stmt.bind).toHaveBeenCalledWith('device-42')
    expect(stmt.run).toHaveBeenCalled()
  })
})
