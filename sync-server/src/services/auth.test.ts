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
  prepare: vi.fn().mockReturnValue(createMockStatement()),
  batch: vi.fn().mockResolvedValue([])
})

// ============================================================================
// jose mock
// ============================================================================

let signTokenClaims: Record<string, unknown>[] = []

vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  SignJWT: class {
    constructor(claims: Record<string, unknown>) {
      signTokenClaims.push(claims)
    }
    setProtectedHeader() {
      return this
    }
    setIssuedAt() {
      return this
    }
    setIssuer() {
      return this
    }
    setAudience() {
      return this
    }
    setExpirationTime() {
      return this
    }
    async sign() {
      return 'mock-jwt-token'
    }
  }
}))

import { issueTokens, rotateRefreshToken, revokeDeviceTokens } from './auth'

// ============================================================================
// Tests: issueTokens
// ============================================================================

describe('issueTokens', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    signTokenClaims = []
  })

  it('should include jti claim in signed tokens', async () => {
    // #when
    await issueTokens(db as unknown as D1Database, 'user-1', 'device-1', 'pem-key')

    // #then
    expect(signTokenClaims).toHaveLength(2)
    for (const claims of signTokenClaims) {
      expect(claims).toHaveProperty('jti')
      expect(typeof claims.jti).toBe('string')
    }
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
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO refresh_tokens'))
    const insertStmt = db.prepare.mock.results.find((r) => r.value?.bind?.mock?.calls?.length)
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
    signTokenClaims = []
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
    // #given - no valid token, no grace-period token
    const selectActiveStmt = createMockStatement()
    selectActiveStmt.first.mockResolvedValue(null)
    const selectRecentlyRotatedStmt = createMockStatement()
    selectRecentlyRotatedStmt.first.mockResolvedValue(null)
    const revokeStmt = createMockStatement()
    db.prepare.mockImplementation((query: string) => {
      if (query.includes('revoked = 0 AND expires_at > ?')) {
        return selectActiveStmt
      }
      if (query.includes('revoked = 1 AND rotated_at IS NOT NULL')) {
        return selectRecentlyRotatedStmt
      }
      if (
        query.includes('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND device_id = ?')
      ) {
        return revokeStmt
      }
      return createMockStatement()
    })

    // #when / #then
    await expect(
      rotateRefreshToken(db as unknown as D1Database, 'bad-token', 'user-1', 'device-1', 'pem-key')
    ).rejects.toThrow(AppError)

    expect(revokeStmt.bind).toHaveBeenCalledWith('user-1', 'device-1')
    expect(revokeStmt.run).toHaveBeenCalled()
  })

  it('should throw with 401 status on invalid token', async () => {
    // #given
    const selectActiveStmt = createMockStatement()
    selectActiveStmt.first.mockResolvedValue(null)
    const selectRecentlyRotatedStmt = createMockStatement()
    selectRecentlyRotatedStmt.first.mockResolvedValue(null)
    db.prepare.mockImplementation((query: string) => {
      if (query.includes('revoked = 0 AND expires_at > ?')) {
        return selectActiveStmt
      }
      if (query.includes('revoked = 1 AND rotated_at IS NOT NULL')) {
        return selectRecentlyRotatedStmt
      }
      return createMockStatement()
    })

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

  it('should retry with fresh tokens when UNIQUE constraint fails during rotation', async () => {
    // #given - valid existing token
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'token-id-1' })
    db.prepare.mockReturnValueOnce(selectStmt)

    db.batch
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: refresh_tokens.token_hash'))
      .mockResolvedValueOnce([])

    // #when
    const result = await rotateRefreshToken(
      db as unknown as D1Database,
      'old-refresh-token',
      'user-1',
      'device-1',
      'pem-key'
    )

    // #then - retried and succeeded on second attempt
    expect(result).toHaveProperty('accessToken')
    expect(result).toHaveProperty('refreshToken')
    expect(db.batch).toHaveBeenCalledTimes(2)
  })

  it('should re-read current active token after UNIQUE collision and retry rotation from that token', async () => {
    // #given - first select returns stale token id, collision then recovers using latest active token id
    const selectExistingStmt = createMockStatement()
    selectExistingStmt.first.mockResolvedValue({ id: 'stale-token-id' })
    const selectLatestActiveStmt = createMockStatement()
    selectLatestActiveStmt.first.mockResolvedValue({ id: 'current-token-id' })

    const updateBindArgs: unknown[][] = []
    db.prepare.mockImplementation((query: string) => {
      if (query.includes('token_hash = ? AND user_id = ? AND device_id = ? AND revoked = 0')) {
        return selectExistingStmt
      }
      if (
        query.includes(
          'WHERE user_id = ? AND device_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1'
        )
      ) {
        return selectLatestActiveStmt
      }
      if (query.includes('UPDATE refresh_tokens SET revoked = 1, rotated_at = ? WHERE id = ?')) {
        const stmt = createMockStatement()
        stmt.bind.mockImplementation((...args: unknown[]) => {
          updateBindArgs.push(args)
          return stmt
        })
        return stmt
      }
      return createMockStatement()
    })

    db.batch
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: refresh_tokens.user_id, refresh_tokens.device_id'))
      .mockResolvedValueOnce([])

    // #when
    const result = await rotateRefreshToken(
      db as unknown as D1Database,
      'old-refresh-token',
      'user-1',
      'device-1',
      'pem-key'
    )

    // #then - second rotation attempt revokes the current active token id
    expect(result).toHaveProperty('accessToken')
    expect(result).toHaveProperty('refreshToken')
    expect(db.batch).toHaveBeenCalledTimes(2)
    expect(updateBindArgs).toHaveLength(2)
    expect(updateBindArgs[0][1]).toBe('stale-token-id')
    expect(updateBindArgs[1][1]).toBe('current-token-id')
  })

  it('should throw AUTH_TOKEN_ROTATION_FAILED when all retry attempts exhausted', async () => {
    // #given - valid existing token, all batch attempts fail
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'token-id-1' })
    db.prepare.mockReturnValueOnce(selectStmt)

    const uniqueError = new Error('UNIQUE constraint failed: refresh_tokens.token_hash')
    db.batch
      .mockRejectedValueOnce(uniqueError)
      .mockRejectedValueOnce(uniqueError)
      .mockRejectedValueOnce(uniqueError)

    // #when / #then
    try {
      await rotateRefreshToken(
        db as unknown as D1Database,
        'old-refresh-token',
        'user-1',
        'device-1',
        'pem-key'
      )
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_TOKEN_ROTATION_FAILED)
      expect((e as AppError).statusCode).toBe(500)
    }
    expect(db.batch).toHaveBeenCalledTimes(3)
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
