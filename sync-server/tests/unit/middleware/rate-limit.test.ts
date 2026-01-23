/**
 * T032: Rate Limiting Middleware Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  checkRateLimit,
  rateLimitMiddleware,
  incrementOtpAttempts,
  clearOtpAttempts,
  cleanupRateLimits,
  RATE_LIMITS
} from '../../../src/middleware/rate-limit'
import { rateLimited } from '../../../src/lib/errors'

describe('Rate Limiting', () => {
  let mockDb: any

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
      })
    }
    vi.useFakeTimers()
    vi.setSystemTime(1704067200000) // 2024-01-01 00:00:00 UTC
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('checkRateLimit', () => {
    it('should allow request within limit on first call', async () => {
      mockDb.prepare().first.mockResolvedValue(null) // No existing entry

      const result = await checkRateLimit(mockDb, 'test:key', 5, 60000)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(4)
      expect(result.resetAt).toBeGreaterThan(Date.now())
    })

    it('should allow request within limit on subsequent calls', async () => {
      mockDb.prepare().first.mockResolvedValue({
        count: 2,
        window_start: Date.now()
      })

      const result = await checkRateLimit(mockDb, 'test:key', 5, 60000)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(2) // 5 - 2 - 1 = 2
    })

    it('should deny request when limit exceeded', async () => {
      mockDb.prepare().first.mockResolvedValue({
        count: 5,
        window_start: Date.now()
      })

      const result = await checkRateLimit(mockDb, 'test:key', 5, 60000)

      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
    })

    it('should reset window when expired', async () => {
      const expiredTime = Date.now() - 70000 // 70 seconds ago
      mockDb.prepare().first.mockResolvedValue({
        count: 5,
        window_start: expiredTime
      })

      const result = await checkRateLimit(mockDb, 'test:key', 5, 60000)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(4)
    })

    it('should fail open on database error', async () => {
      mockDb.prepare().first.mockRejectedValue(new Error('DB error'))

      const result = await checkRateLimit(mockDb, 'test:key', 5, 60000)

      expect(result.allowed).toBe(true) // Fail open
      expect(result.remaining).toBe(5)
    })
  })

  describe('rateLimitMiddleware', () => {
    it('should allow request and set headers', async () => {
      mockDb.prepare().first.mockResolvedValue(null)

      const mockC = {
        env: { DB: mockDb },
        req: { path: '/test' },
        header: vi.fn(),
        set: vi.fn()
      } as any

      const keyExtractor = vi.fn().mockReturnValue('test-user')
      const middleware = rateLimitMiddleware('otp_request', keyExtractor)

      const next = vi.fn().mockResolvedValue(undefined)
      await middleware(mockC, next)

      expect(keyExtractor).toHaveBeenCalledWith(mockC)
      expect(mockC.header).toHaveBeenCalledWith('X-RateLimit-Limit', '3')
      expect(mockC.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '2')
      expect(next).toHaveBeenCalled()
    })

    it('should reject request when rate limited', async () => {
      mockDb.prepare().first.mockResolvedValue({
        count: 3,
        window_start: Date.now()
      })

      const mockC = {
        env: { DB: mockDb },
        req: { path: '/test' },
        header: vi.fn(),
        set: vi.fn()
      } as any

      const keyExtractor = vi.fn().mockReturnValue('test-user')
      const middleware = rateLimitMiddleware('otp_request', keyExtractor)

      const next = vi.fn()
      await expect(middleware(mockC, next)).rejects.toThrow(rateLimited(600))
      expect(next).not.toHaveBeenCalled()
    })

    it('should throw error for invalid limit type', () => {
      expect(() => {
        rateLimitMiddleware('invalid_type' as any, () => 'test')
      }).toThrow()
    })
  })

  describe('incrementOtpAttempts', () => {
    it('should increment attempts within limit', async () => {
      mockDb.prepare().first.mockResolvedValue({ count: 2 })

      const result = await incrementOtpAttempts(mockDb, 'otp-123')

      expect(result.attempts).toBe(3)
      expect(result.maxExceeded).toBe(false)
    })

    it('should mark max exceeded when limit reached', async () => {
      mockDb.prepare().first.mockResolvedValue({ count: 5 })

      const result = await incrementOtpAttempts(mockDb, 'otp-123')

      expect(result.attempts).toBe(5)
      expect(result.maxExceeded).toBe(true)
    })

    it('should fail open on database error', async () => {
      mockDb.prepare().first.mockRejectedValue(new Error('DB error'))

      const result = await incrementOtpAttempts(mockDb, 'otp-123')

      expect(result.attempts).toBe(0)
      expect(result.maxExceeded).toBe(false)
    })
  })

  describe('clearOtpAttempts', () => {
    it('should clear attempts for OTP', async () => {
      await clearOtpAttempts(mockDb, 'otp-123')

      expect(mockDb.prepare).toHaveBeenCalledWith('DELETE FROM rate_limits WHERE key = ?')
    })
  })

  describe('cleanupRateLimits', () => {
    it('should delete expired entries', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 5 } })

      const deleted = await cleanupRateLimits(mockDb)

      expect(deleted).toBe(5)
      expect(mockDb.prepare).toHaveBeenCalledWith('DELETE FROM rate_limits WHERE window_start < ?')
    })
  })

  describe('RATE_LIMITS configuration', () => {
    it('should have correct OTP request limits', () => {
      expect(RATE_LIMITS.otp_request.requests).toBe(3)
      expect(RATE_LIMITS.otp_request.windowMs).toBe(600000) // 10 minutes
    })

    it('should have correct OTP verify limits', () => {
      expect(RATE_LIMITS.otp_verify.attempts).toBe(5)
    })

    it('should have correct sync limits', () => {
      expect(RATE_LIMITS.sync_push.requests).toBe(100)
      expect(RATE_LIMITS.sync_push.windowMs).toBe(60000) // 1 minute
    })
  })
})
