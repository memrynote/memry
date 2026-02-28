import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

// crypto.subtle.timingSafeEqual is a Workers API not available in Node
beforeAll(() => {
  if (!crypto.subtle.timingSafeEqual) {
    ;(crypto.subtle as Record<string, unknown>).timingSafeEqual = (
      a: ArrayBuffer,
      b: ArrayBuffer
    ): boolean => {
      const viewA = new Uint8Array(a)
      const viewB = new Uint8Array(b)
      if (viewA.length !== viewB.length) return false
      let diff = 0
      for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i]
      return diff === 0
    }
  }
})

import {
  generateOtp,
  hmacOtp,
  constantTimeCompare,
  storeOtp,
  verifyOtp,
  checkEmailRateLimit
} from './otp'

const TEST_HMAC_KEY = 'test-hmac-secret-key'

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
// Tests: generateOtp
// ============================================================================

describe('generateOtp', () => {
  it('should return a 6-digit string', () => {
    // #when
    const otp = generateOtp()

    // #then
    expect(otp).toMatch(/^\d{6}$/)
  })

  it('should pad with leading zeros when random value is small', () => {
    // #given
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      ;(arr as Uint32Array)[0] = 42
      return arr as Uint32Array
    })

    // #when
    const otp = generateOtp()

    // #then
    expect(otp).toBe('000042')

    vi.restoreAllMocks()
  })

  it('should wrap values exceeding 999999', () => {
    // #given
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      ;(arr as Uint32Array)[0] = 1_000_001
      return arr as Uint32Array
    })

    // #when
    const otp = generateOtp()

    // #then
    expect(otp).toBe('000001')

    vi.restoreAllMocks()
  })

  it('should produce "000000" when random value is exactly 0', () => {
    // #given
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      ;(arr as Uint32Array)[0] = 0
      return arr as Uint32Array
    })

    // #when
    const otp = generateOtp()

    // #then
    expect(otp).toBe('000000')

    vi.restoreAllMocks()
  })
})

// ============================================================================
// Tests: hmacOtp
// ============================================================================

describe('hmacOtp', () => {
  it('should return a 64-character hex string', async () => {
    // #when
    const hash = await hmacOtp('123456', TEST_HMAC_KEY)

    // #then
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('should produce deterministic output for the same input and key', async () => {
    // #when
    const hash1 = await hmacOtp('999999', TEST_HMAC_KEY)
    const hash2 = await hmacOtp('999999', TEST_HMAC_KEY)

    // #then
    expect(hash1).toBe(hash2)
  })

  it('should produce different hashes for different inputs', async () => {
    // #when
    const hash1 = await hmacOtp('111111', TEST_HMAC_KEY)
    const hash2 = await hmacOtp('222222', TEST_HMAC_KEY)

    // #then
    expect(hash1).not.toBe(hash2)
  })

  it('should produce different hashes for the same code with different keys', async () => {
    // #when
    const hash1 = await hmacOtp('123456', 'key-alpha')
    const hash2 = await hmacOtp('123456', 'key-beta')

    // #then
    expect(hash1).not.toBe(hash2)
  })

  it('should throw INTERNAL_ERROR when the HMAC key is missing', async () => {
    // #when / #then
    await expect(hmacOtp('123456', '')).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR
    })
  })
})

// ============================================================================
// Tests: constantTimeCompare
// ============================================================================

describe('constantTimeCompare', () => {
  it('should return true for identical strings', async () => {
    // #when
    const result = await constantTimeCompare('abc123', 'abc123')

    // #then
    expect(result).toBe(true)
  })

  it('should return false for different strings of equal length', async () => {
    // #when
    const result = await constantTimeCompare('abc123', 'abc456')

    // #then
    expect(result).toBe(false)
  })

  it('should return false for strings of different lengths', async () => {
    // #when
    const result = await constantTimeCompare('short', 'much-longer-string')

    // #then
    expect(result).toBe(false)
  })

  it('should return true for empty strings', async () => {
    // #when
    const result = await constantTimeCompare('', '')

    // #then
    expect(result).toBe(true)
  })
})

// ============================================================================
// Tests: storeOtp
// ============================================================================

describe('storeOtp', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('should invalidate previous OTPs for the same email', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })

    // #when
    await storeOtp(db as unknown as D1Database, 'user@example.com', '123456', TEST_HMAC_KEY)

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE otp_codes SET used = 1')
    )
    expect(stmts[0].bind).toHaveBeenCalledWith('user@example.com')
    expect(stmts[0].run).toHaveBeenCalled()
  })

  it('should insert a new OTP record with hashed code', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })

    // #when
    await storeOtp(db as unknown as D1Database, 'user@example.com', '123456', TEST_HMAC_KEY)

    // #then
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO otp_codes'))
    const insertStmt = stmts[1]
    expect(insertStmt.bind).toHaveBeenCalled()
    expect(insertStmt.run).toHaveBeenCalled()
  })

  it('should return an id and expiresAt timestamp 600 seconds in the future', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })

    // #when
    const result = await storeOtp(
      db as unknown as D1Database,
      'user@example.com',
      '123456',
      TEST_HMAC_KEY
    )

    // #then
    const nowSeconds = Math.floor(1_700_000_000_000 / 1000)
    expect(result.id).toBeDefined()
    expect(result.expiresAt).toBe(nowSeconds + 600)
  })

  it('should bind the correct email, hash, expiry, and timestamp', async () => {
    // #given
    const stmts: MockStatement[] = []
    db.prepare.mockImplementation(() => {
      const s = createMockStatement()
      stmts.push(s)
      return s
    })
    const expectedHash = await hmacOtp('654321', TEST_HMAC_KEY)
    const nowSeconds = Math.floor(1_700_000_000_000 / 1000)

    // #when
    await storeOtp(db as unknown as D1Database, 'test@test.com', '654321', TEST_HMAC_KEY)

    // #then
    const insertArgs = stmts[1].bind.mock.calls[0]
    expect(insertArgs[1]).toBe('test@test.com')
    expect(insertArgs[2]).toBe(expectedHash)
    expect(insertArgs[3]).toBe(nowSeconds + 600)
    expect(insertArgs[4]).toBe(nowSeconds)
  })
})

// ============================================================================
// Tests: verifyOtp
// ============================================================================

describe('verifyOtp', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('should mark the OTP as used when code matches', async () => {
    // #given
    const code = '123456'
    const codeHash = await hmacOtp(code, TEST_HMAC_KEY)
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'otp-1', code_hash: codeHash, attempts: 0 })

    const updateStmt = createMockStatement()

    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(updateStmt)

    // #when
    await verifyOtp(db as unknown as D1Database, 'user@example.com', code, TEST_HMAC_KEY)

    // #then
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE otp_codes SET used = 1')
    )
    expect(updateStmt.bind).toHaveBeenCalledWith('otp-1')
    expect(updateStmt.run).toHaveBeenCalled()
  })

  it('should throw AUTH_OTP_EXPIRED when no matching record exists', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when / #then
    try {
      await verifyOtp(db as unknown as D1Database, 'user@example.com', '123456', TEST_HMAC_KEY)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_OTP_EXPIRED)
      expect((e as AppError).statusCode).toBe(401)
    }
  })

  it('should throw AUTH_OTP_MAX_ATTEMPTS when attempts >= 5', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'otp-1', code_hash: 'somehash', attempts: 5 })
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when / #then
    try {
      await verifyOtp(db as unknown as D1Database, 'user@example.com', '123456', TEST_HMAC_KEY)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_OTP_MAX_ATTEMPTS)
      expect((e as AppError).statusCode).toBe(401)
    }
  })

  it('should increment attempts and throw AUTH_INVALID_OTP on wrong code', async () => {
    // #given
    const correctHash = await hmacOtp('999999', TEST_HMAC_KEY)
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'otp-1', code_hash: correctHash, attempts: 0 })

    const incrementStmt = createMockStatement()

    db.prepare.mockReturnValueOnce(selectStmt).mockReturnValueOnce(incrementStmt)

    // #when / #then
    try {
      await verifyOtp(db as unknown as D1Database, 'user@example.com', '000000', TEST_HMAC_KEY)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCodes.AUTH_INVALID_OTP)
      expect((e as AppError).statusCode).toBe(401)
    }

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE otp_codes SET attempts = attempts + 1')
    )
    expect(incrementStmt.bind).toHaveBeenCalledWith('otp-1')
    expect(incrementStmt.run).toHaveBeenCalled()
  })

  it('should not increment attempts when max attempts already reached', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue({ id: 'otp-1', code_hash: 'somehash', attempts: 7 })
    db.prepare.mockReturnValueOnce(selectStmt)

    // #when
    try {
      await verifyOtp(db as unknown as D1Database, 'user@example.com', '123456', TEST_HMAC_KEY)
    } catch {
      // expected
    }

    // #then
    expect(db.prepare).toHaveBeenCalledTimes(1)
  })

  it('should query with the correct email and current timestamp', async () => {
    // #given
    const selectStmt = createMockStatement()
    selectStmt.first.mockResolvedValue(null)
    db.prepare.mockReturnValueOnce(selectStmt)

    const nowSeconds = Math.floor(1_700_000_000_000 / 1000)

    // #when
    try {
      await verifyOtp(db as unknown as D1Database, 'test@test.com', '123456', TEST_HMAC_KEY)
    } catch {
      // expected
    }

    // #then
    expect(selectStmt.bind).toHaveBeenCalledWith('test@test.com', nowSeconds)
  })
})

// ============================================================================
// Tests: checkEmailRateLimit
// ============================================================================

describe('checkEmailRateLimit', () => {
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    db = createMockDb()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  it('should resolve when request count is within limit', async () => {
    // #given
    db.batch.mockResolvedValue([
      { success: true },
      { results: [{ count: 2, window_start: 1_700_000 }] }
    ])

    // #when / #then
    await expect(
      checkEmailRateLimit(db as unknown as D1Database, 'user@example.com')
    ).resolves.toBeUndefined()
  })

  it('should resolve when count equals MAX_EMAIL_REQUESTS (3)', async () => {
    // #given
    db.batch.mockResolvedValue([
      { success: true },
      { results: [{ count: 3, window_start: 1_700_000 }] }
    ])

    // #when / #then
    await expect(
      checkEmailRateLimit(db as unknown as D1Database, 'user@example.com')
    ).resolves.toBeUndefined()
  })

  it('should throw RATE_LIMITED when count exceeds MAX_EMAIL_REQUESTS', async () => {
    // #given
    db.batch.mockResolvedValue([
      { success: true },
      { results: [{ count: 4, window_start: 1_700_000 }] }
    ])

    // #when / #then
    try {
      await checkEmailRateLimit(db as unknown as D1Database, 'user@example.com')
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(ErrorCodes.RATE_LIMITED)
      expect((e as AppError).statusCode).toBe(429)
    }
  })

  it('should use the correct rate limit key for the email', async () => {
    // #given
    const upsertStmt = createMockStatement()
    const selectStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(upsertStmt).mockReturnValueOnce(selectStmt)
    db.batch.mockResolvedValue([
      { success: true },
      { results: [{ count: 1, window_start: 1_700_000 }] }
    ])

    // #when
    await checkEmailRateLimit(db as unknown as D1Database, 'test@test.com')

    // #then
    expect(upsertStmt.bind).toHaveBeenCalledWith(
      'otp-email:test@test.com',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('should default count to 0 when no row is returned', async () => {
    // #given
    db.batch.mockResolvedValue([{ success: true }, { results: [] }])

    // #when / #then
    await expect(
      checkEmailRateLimit(db as unknown as D1Database, 'user@example.com')
    ).resolves.toBeUndefined()
  })

  it('should pass both upsert and select statements to batch', async () => {
    // #given
    const upsertStmt = createMockStatement()
    const selectStmt = createMockStatement()
    db.prepare.mockReturnValueOnce(upsertStmt).mockReturnValueOnce(selectStmt)
    db.batch.mockResolvedValue([
      { success: true },
      { results: [{ count: 1, window_start: 1_700_000 }] }
    ])

    // #when
    await checkEmailRateLimit(db as unknown as D1Database, 'user@example.com')

    // #then
    expect(db.batch).toHaveBeenCalledWith([upsertStmt, selectStmt])
  })
})
