import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRetrieveKey = vi.fn()
const mockStoreKey = vi.fn()
vi.mock('../crypto', () => ({
  retrieveKey: (...args: unknown[]) => mockRetrieveKey(...args),
  storeKey: (...args: unknown[]) => mockStoreKey(...args)
}))

const mockPostToServer = vi.fn()
vi.mock('./http-client', () => ({
  postToServer: (...args: unknown[]) => mockPostToServer(...args),
  SyncServerError: class SyncServerError extends Error {
    statusCode: number
    constructor(msg: string, statusCode: number) {
      super(msg)
      this.statusCode = statusCode
      this.name = 'SyncServerError'
    }
  }
}))

const mockDecodeJwt = vi.fn()
vi.mock('jose', () => ({
  decodeJwt: (...args: unknown[]) => mockDecodeJwt(...args)
}))

const mockGetAllWindows = vi.fn().mockReturnValue([])
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows()
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'
import {
  getValidAccessToken,
  isTokenExpired,
  retrieveToken,
  storeToken,
  extractJtiFromToken,
  scheduleTokenRefresh,
  cancelTokenRefresh,
  refreshAccessToken,
  resetTokenManagerState,
  setOnTokenRefreshed
} from './token-manager'

function encodeToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'none' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.sig`
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

describe('token-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetTokenManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('isTokenExpired', () => {
    it('returns false for token with exp far in future', () => {
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() + 3600 })
      expect(isTokenExpired('valid-token')).toBe(false)
    })

    it('returns true for token with exp in the past', () => {
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() - 100 })
      expect(isTokenExpired('expired-token')).toBe(true)
    })

    it('returns true for token within 60s safety margin', () => {
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() + 30 })
      expect(isTokenExpired('near-expiry-token')).toBe(true)
    })

    it('returns true when token has no exp claim', () => {
      mockDecodeJwt.mockReturnValue({ sub: 'user-1' })
      expect(isTokenExpired('no-exp-token')).toBe(true)
    })

    it('returns true when decodeJwt throws', () => {
      mockDecodeJwt.mockImplementation(() => {
        throw new Error('malformed')
      })
      expect(isTokenExpired('garbage')).toBe(true)
    })
  })

  describe('retrieveToken / storeToken', () => {
    it('retrieves and decodes a stored token', async () => {
      mockRetrieveKey.mockResolvedValue(new TextEncoder().encode('my-token'))
      const result = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
      expect(result).toBe('my-token')
    })

    it('returns null when no key is found', async () => {
      mockRetrieveKey.mockResolvedValue(null)
      const result = await retrieveToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN)
      expect(result).toBeNull()
    })

    it('encodes and stores a token', async () => {
      await storeToken(KEYCHAIN_ENTRIES.ACCESS_TOKEN, 'my-token')
      expect(mockStoreKey).toHaveBeenCalledWith(
        KEYCHAIN_ENTRIES.ACCESS_TOKEN,
        new TextEncoder().encode('my-token')
      )
    })
  })

  describe('extractJtiFromToken', () => {
    it('extracts jti from token payload', () => {
      mockDecodeJwt.mockReturnValue({ jti: 'abc-123' })
      expect(extractJtiFromToken('token')).toBe('abc-123')
    })

    it('throws when jti is missing', () => {
      mockDecodeJwt.mockReturnValue({ sub: 'user-1' })
      expect(() => extractJtiFromToken('token')).toThrow('Token missing jti claim')
    })
  })

  describe('getValidAccessToken', () => {
    it('returns token as-is when not expired', async () => {
      // #given
      const token = encodeToken({ exp: nowSeconds() + 3600 })
      mockRetrieveKey.mockResolvedValue(new TextEncoder().encode(token))
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() + 3600 })

      // #when
      const result = await getValidAccessToken()

      // #then
      expect(result).toBe(token)
      expect(mockPostToServer).not.toHaveBeenCalled()
    })

    it('returns null when no token in keychain', async () => {
      mockRetrieveKey.mockResolvedValue(null)

      const result = await getValidAccessToken()

      expect(result).toBeNull()
      expect(mockPostToServer).not.toHaveBeenCalled()
    })

    it('triggers refresh when token is expired and returns fresh token', async () => {
      // #given
      const expiredToken = encodeToken({ exp: nowSeconds() - 100 })
      const freshToken = encodeToken({ exp: nowSeconds() + 900 })

      let callCount = 0
      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'access-token') {
          callCount++
          const t = callCount <= 1 ? expiredToken : freshToken
          return Promise.resolve(new TextEncoder().encode(t))
        }
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })

      mockDecodeJwt.mockImplementation((token: string) => {
        if (token === expiredToken) return { exp: nowSeconds() - 100 }
        return { exp: nowSeconds() + 900 }
      })

      mockPostToServer.mockResolvedValue({
        accessToken: freshToken,
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #when
      const result = await getValidAccessToken()

      // #then
      expect(mockPostToServer).toHaveBeenCalledWith('/auth/refresh', {
        refreshToken: 'refresh-tok'
      })
      expect(result).toBe(freshToken)
    })

    it('returns null when refresh fails with 401', async () => {
      // #given
      const expiredToken = encodeToken({ exp: nowSeconds() - 100 })
      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'access-token') {
          return Promise.resolve(new TextEncoder().encode(expiredToken))
        }
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() - 100 })

      const { SyncServerError } = await import('./http-client')
      mockPostToServer.mockRejectedValue(new SyncServerError('Unauthorized', 401))

      const mockWin = { webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([mockWin])

      // #when
      const result = await getValidAccessToken()

      // #then
      expect(result).toBeNull()
      expect(mockWin.webContents.send).toHaveBeenCalled()
    })

    it('deduplicates concurrent refresh calls', async () => {
      // #given
      const expiredToken = encodeToken({ exp: nowSeconds() - 100 })
      const freshToken = encodeToken({ exp: nowSeconds() + 900 })

      let callCount = 0
      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'access-token') {
          callCount++
          const t = callCount <= 2 ? expiredToken : freshToken
          return Promise.resolve(new TextEncoder().encode(t))
        }
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })

      mockDecodeJwt.mockImplementation((token: string) => {
        if (token === expiredToken) return { exp: nowSeconds() - 100 }
        return { exp: nowSeconds() + 900 }
      })

      mockPostToServer.mockResolvedValue({
        accessToken: freshToken,
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #when
      const [r1, r2] = await Promise.all([getValidAccessToken(), getValidAccessToken()])

      // #then
      expect(mockPostToServer).toHaveBeenCalledTimes(1)
      expect(r1).toBe(freshToken)
      expect(r2).toBe(freshToken)
    })
  })

  describe('refresh-token rejection latch', () => {
    /** Access token permanently expired + refresh token the server always rejects. */
    function givenDeadRefreshToken(): { win: { webContents: { send: ReturnType<typeof vi.fn> } } } {
      const expiredToken = encodeToken({ exp: nowSeconds() - 100 })
      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'access-token') {
          return Promise.resolve(new TextEncoder().encode(expiredToken))
        }
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('dead-refresh-tok'))
        }
        return Promise.resolve(null)
      })
      mockDecodeJwt.mockReturnValue({ exp: nowSeconds() - 100 })
      const win = { webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([win])
      return { win }
    }

    async function rejectWith401(): Promise<void> {
      const { SyncServerError } = await import('./http-client')
      mockPostToServer.mockRejectedValue(new SyncServerError('Invalid refresh token', 401))
    }

    it('does not re-hit /auth/refresh while the backoff window is open', async () => {
      // #given a dead refresh token and many callers demanding a token
      givenDeadRefreshToken()
      await rejectWith401()

      // #when
      await getValidAccessToken()
      await getValidAccessToken()
      await getValidAccessToken()

      // #then only the first attempt reached the network
      expect(mockPostToServer).toHaveBeenCalledTimes(1)
    })

    it('goes terminal after 3 rejections and never calls the server again', async () => {
      // #given
      const { win } = givenDeadRefreshToken()
      await rejectWith401()

      // #when three rejections, each after its backoff window elapses
      await getValidAccessToken()
      await vi.advanceTimersByTimeAsync(61_000)
      await getValidAccessToken()
      await vi.advanceTimersByTimeAsync(301_000)
      await getValidAccessToken()

      // #then
      expect(mockPostToServer).toHaveBeenCalledTimes(3)
      expect(win.webContents.send).toHaveBeenCalledWith('auth:session-expired', {
        reason: 'refresh_rejected'
      })

      // #and the latch is permanent — no further requests, ever
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      await getValidAccessToken()
      await getValidAccessToken()
      expect(mockPostToServer).toHaveBeenCalledTimes(3)
    })

    it('does not schedule a fallback retry after a rejection', async () => {
      // #given a live session whose refresh token is then rejected
      givenDeadRefreshToken()
      await rejectWith401()
      scheduleTokenRefresh(900)

      // #when the scheduled refresh fires and is rejected
      await vi.advanceTimersByTimeAsync(631_000)

      // #then the fallback-retry timer must not add another attempt
      expect(mockPostToServer).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(900_000)
      expect(mockPostToServer).toHaveBeenCalledTimes(1)
    })

    it('clears the latch when a new session is established', async () => {
      // #given a session that went terminal
      givenDeadRefreshToken()
      await rejectWith401()
      await getValidAccessToken()
      await vi.advanceTimersByTimeAsync(61_000)
      await getValidAccessToken()
      await vi.advanceTimersByTimeAsync(301_000)
      await getValidAccessToken()
      expect(mockPostToServer).toHaveBeenCalledTimes(3)

      // #when the user signs in again (sign-in schedules the next refresh)
      scheduleTokenRefresh(900)
      mockPostToServer.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #then refresh works again
      await refreshAccessToken()
      expect(mockPostToServer).toHaveBeenCalledTimes(4)
    })

    it('resets the rejection count after a successful refresh', async () => {
      // #given one rejection
      givenDeadRefreshToken()
      await rejectWith401()
      await refreshAccessToken()

      // #when the next attempt succeeds
      await vi.advanceTimersByTimeAsync(61_000)
      mockPostToServer.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900
      })
      await refreshAccessToken()

      // #then a later rejection starts from a clean slate (short backoff, not terminal)
      await rejectWith401()
      await refreshAccessToken()
      await vi.advanceTimersByTimeAsync(61_000)
      await refreshAccessToken()
      expect(mockPostToServer).toHaveBeenCalledTimes(4)
    })
  })

  describe('scheduleTokenRefresh / cancelTokenRefresh', () => {
    it('schedules a refresh that fires within the jitter window', async () => {
      // #given
      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })

      mockPostToServer.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #when
      scheduleTokenRefresh(900)

      // jitter range: 0.5*900=450s to 0.7*900=630s, advance past max
      await vi.advanceTimersByTimeAsync(631_000)

      // #then
      expect(mockPostToServer).toHaveBeenCalled()
    })

    it('cancelTokenRefresh prevents scheduled refresh from firing', async () => {
      scheduleTokenRefresh(900)
      cancelTokenRefresh()

      await vi.advanceTimersByTimeAsync(900_000)

      expect(mockPostToServer).not.toHaveBeenCalled()
    })
  })

  describe('setOnTokenRefreshed', () => {
    it('calls the callback after successful refresh', async () => {
      // #given
      const callback = vi.fn()
      setOnTokenRefreshed(callback)

      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })

      mockPostToServer.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #when
      await refreshAccessToken()

      // #then
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('detaches the previous callback when passed null', async () => {
      // #given a sync runtime that installed a callback and was then stopped
      const callback = vi.fn()
      setOnTokenRefreshed(callback)
      setOnTokenRefreshed(null)

      mockRetrieveKey.mockImplementation((entry) => {
        if (entry.account === 'refresh-token') {
          return Promise.resolve(new TextEncoder().encode('refresh-tok'))
        }
        return Promise.resolve(null)
      })

      mockPostToServer.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 900
      })

      // #when
      await expect(refreshAccessToken()).resolves.toBe(true)

      // #then the refresh still succeeds, it just no longer calls into the
      // torn-down runtime the closure captured.
      expect(callback).not.toHaveBeenCalled()
    })
  })
})
