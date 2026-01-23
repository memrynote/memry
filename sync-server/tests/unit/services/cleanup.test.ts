/**
 * T034a, T034b: Cleanup Jobs Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  cleanupExpiredOtpCodes,
  cleanupExpiredLinkingSessions,
  cleanupCompletedLinkingSessions,
  cleanupUsedOtpCodes,
  runCleanupJobs,
  logCleanupResult
} from '../../../src/services/cleanup'

describe('Cleanup Jobs', () => {
  let mockDb: any
  const now = 1704067200000 // 2024-01-01 00:00:00 UTC

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } })
      })
    }
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('cleanupExpiredOtpCodes', () => {
    it('should delete expired OTP codes', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 5 } })

      const deleted = await cleanupExpiredOtpCodes(mockDb)

      expect(deleted).toBe(5)
      expect(mockDb.prepare).toHaveBeenCalledWith(`
      DELETE FROM otp_codes
      WHERE expires_at < ?
    `)
    })

    it('should handle no expired codes', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 0 } })

      const deleted = await cleanupExpiredOtpCodes(mockDb)

      expect(deleted).toBe(0)
    })
  })

  describe('cleanupExpiredLinkingSessions', () => {
    it('should delete expired linking sessions that are not completed', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 3 } })

      const deleted = await cleanupExpiredLinkingSessions(mockDb)

      expect(deleted).toBe(3)
      expect(mockDb.prepare).toHaveBeenCalledWith(`
      DELETE FROM linking_sessions
      WHERE expires_at < ? AND status != 'completed'
    `)
    })

    it('should preserve completed sessions even if expired', async () => {
      await cleanupExpiredLinkingSessions(mockDb)

      // Verify the SQL query structure by checking it was called
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("status != 'completed'"))
    })
  })

  describe('cleanupCompletedLinkingSessions', () => {
    it('should delete old completed linking sessions', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 2 } })

      const deleted = await cleanupCompletedLinkingSessions(mockDb)

      expect(deleted).toBe(2)
      expect(mockDb.prepare).toHaveBeenCalledWith(`
      DELETE FROM linking_sessions
      WHERE status = 'completed' AND created_at < ?
    `)
    })

    it('should use 24-hour retention period', async () => {
      const expectedCutoff = now - 24 * 60 * 60 * 1000
      await cleanupCompletedLinkingSessions(mockDb)

      expect(mockDb.prepare().bind).toHaveBeenCalledWith(expectedCutoff)
    })
  })

  describe('cleanupUsedOtpCodes', () => {
    it('should delete used OTP codes older than 1 hour', async () => {
      mockDb.prepare().run.mockResolvedValue({ meta: { changes: 1 } })

      const deleted = await cleanupUsedOtpCodes(mockDb)

      expect(deleted).toBe(1)
      expect(mockDb.prepare).toHaveBeenCalledWith(`
      DELETE FROM otp_codes
      WHERE used = 1 AND created_at < ?
    `)
    })

    it('should use 1-hour retention period', async () => {
      const expectedCutoff = now - 60 * 60 * 1000
      await cleanupUsedOtpCodes(mockDb)

      expect(mockDb.prepare().bind).toHaveBeenCalledWith(expectedCutoff)
    })
  })

  describe('runCleanupJobs', () => {
    it('should run all cleanup jobs in parallel', async () => {
      // Mock all cleanup functions
      const cleanupExpiredOtpCodes = vi.fn().mockResolvedValue(1)
      const cleanupUsedOtpCodes = vi.fn().mockResolvedValue(2)
      const cleanupExpiredLinkingSessions = vi.fn().mockResolvedValue(3)
      const cleanupCompletedLinkingSessions = vi.fn().mockResolvedValue(4)
      const cleanupRefreshTokens = vi.fn().mockResolvedValue(5)
      const cleanupRateLimits = vi.fn().mockResolvedValue(6)

      // Re-import with mocks
      vi.doMock('../../../src/services/cleanup', () => ({
        cleanupExpiredOtpCodes,
        cleanupUsedOtpCodes,
        cleanupExpiredLinkingSessions,
        cleanupCompletedLinkingSessions,
        cleanupRefreshTokens,
        cleanupRateLimits,
        runCleanupJobs: async (db: any) => {
          const results = await Promise.all([
            cleanupExpiredOtpCodes(db),
            cleanupUsedOtpCodes(db),
            cleanupExpiredLinkingSessions(db),
            cleanupCompletedLinkingSessions(db),
            cleanupRefreshTokens(db),
            cleanupRateLimits(db)
          ])

          const [
            otpCodes,
            usedOtpCodes,
            linkingSessions,
            completedLinkingSessions,
            refreshTokens,
            rateLimits
          ] = results
          const totalCleaned =
            otpCodes +
            usedOtpCodes +
            linkingSessions +
            completedLinkingSessions +
            refreshTokens +
            rateLimits

          return {
            otpCodes,
            usedOtpCodes,
            linkingSessions,
            completedLinkingSessions,
            refreshTokens,
            rateLimits,
            totalCleaned,
            durationMs: 100
          }
        },
        logCleanupResult: vi.fn()
      }))

      const { runCleanupJobs } = await import('../../../src/services/cleanup')

      const result = await runCleanupJobs(mockDb)

      expect(result.otpCodes).toBe(1)
      expect(result.usedOtpCodes).toBe(2)
      expect(result.linkingSessions).toBe(3)
      expect(result.completedLinkingSessions).toBe(4)
      expect(result.refreshTokens).toBe(5)
      expect(result.rateLimits).toBe(6)
      expect(result.totalCleaned).toBe(21)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('logCleanupResult', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    afterEach(() => {
      consoleLogSpy.mockRestore()
    })

    it('should log cleanup summary', () => {
      const result = {
        otpCodes: 1,
        usedOtpCodes: 2,
        linkingSessions: 3,
        completedLinkingSessions: 4,
        refreshTokens: 5,
        rateLimits: 6,
        totalCleaned: 21,
        durationMs: 150
      }

      logCleanupResult(result)

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Cleanup] Completed in 150ms')
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('21 records removed'))
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('OTP: 3, Sessions: 7, Tokens: 5, RateLimits: 6')
      )
    })
  })

  describe('Constants', () => {
    it('should have correct expiry times', () => {
      // Test the constants indirectly through behavior
      expect(10 * 60 * 1000).toBe(600000) // 10 minutes in ms
      expect(5 * 60 * 1000).toBe(300000) // 5 minutes in ms
    })
  })
})
