/**
 * T031: JWT Validation Middleware Tests
 */

import { describe, it, expect, vi } from 'vitest'
import { getAuth, getOptionalAuth, requireDevice } from '../../../src/middleware/auth'
import { unauthorized, invalidToken } from '../../../src/lib/errors'

describe('Auth Middleware Helpers', () => {
  describe('getAuth', () => {
    it('should return auth context when present', () => {
      const mockAuth = {
        userId: 'user-123',
        deviceId: 'device-456',
        tokenIssuedAt: Date.now(),
        tokenExpiresAt: Date.now() + 3600000
      }
      const mockC = { get: vi.fn().mockReturnValue(mockAuth) } as any

      expect(getAuth(mockC)).toBe(mockAuth)
    })

    it('should throw unauthorized when auth context missing', () => {
      const mockC = { get: vi.fn().mockReturnValue(undefined) } as any

      expect(() => getAuth(mockC)).toThrow(unauthorized('Not authenticated'))
    })
  })

  describe('getOptionalAuth', () => {
    it('should return auth context when present', () => {
      const mockAuth = {
        userId: 'user-123',
        deviceId: 'device-456',
        tokenIssuedAt: Date.now(),
        tokenExpiresAt: Date.now() + 3600000
      }
      const mockC = { get: vi.fn().mockReturnValue(mockAuth) } as any

      expect(getOptionalAuth(mockC)).toBe(mockAuth)
    })

    it('should return null when auth context missing', () => {
      const mockC = { get: vi.fn().mockReturnValue(undefined) } as any

      expect(getOptionalAuth(mockC)).toBeNull()
    })
  })

  describe('requireDevice', () => {
    it('should not throw when device IDs match', () => {
      const mockAuth = {
        userId: 'user-123',
        deviceId: 'device-456',
        tokenIssuedAt: Date.now(),
        tokenExpiresAt: Date.now() + 3600000
      }
      const mockC = { get: vi.fn().mockReturnValue(mockAuth) } as any

      expect(() => requireDevice(mockC, 'device-456')).not.toThrow()
    })

    it('should throw when device IDs do not match', () => {
      const mockAuth = {
        userId: 'user-123',
        deviceId: 'device-456',
        tokenIssuedAt: Date.now(),
        tokenExpiresAt: Date.now() + 3600000
      }
      const mockC = { get: vi.fn().mockReturnValue(mockAuth) } as any

      expect(() => requireDevice(mockC, 'device-789')).toThrow(
        invalidToken('Token device ID does not match required device')
      )
    })
  })
})
