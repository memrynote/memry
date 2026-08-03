import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'

const mockFetch = vi.fn()
const mockDb = { name: 'db' }
const mockGetDatabase = vi.fn()
const mockGetOrCreateVaultUuid = vi.fn()

vi.stubEnv('SYNC_SERVER_URL', 'http://localhost:8787')

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args)
  }
}))

vi.mock('../database', () => ({
  getDatabase: () => mockGetDatabase()
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: (...args: unknown[]) => mockGetOrCreateVaultUuid(...args)
}))

// NetworkError copy resolves through the main-process i18n singleton, which only
// exists after setMainI18n() during app boot. Echo the key back so the assertion
// pins the chosen message, not one locale's wording.
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

import {
  syncFetch,
  postToServer,
  getFromServer,
  deleteFromServer,
  SyncServerError,
  NetworkError,
  RateLimitError,
  parseRetryAfterHeader
} from './http-client'

const createJsonResponse = (
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response => {
  const responseHeaders = new Headers({ 'Content-Type': 'application/json', ...headers })
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: () => Promise.resolve(body)
  } as unknown as Response
}

describe('http-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDatabase.mockReturnValue(mockDb)
    mockGetOrCreateVaultUuid.mockReturnValue('vault-1')
  })

  describe('syncFetch', () => {
    it('makes a successful GET request', async () => {
      // #given
      const responseData = { users: [] }
      mockFetch.mockResolvedValue(createJsonResponse(responseData))

      // #when
      const result = await syncFetch('GET', '/api/users')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/users'),
        expect.objectContaining({ method: 'GET' })
      )
      expect(result).toEqual(responseData)
    })

    it('makes a POST request with body', async () => {
      // #given
      const requestBody = { email: 'test@example.com' }
      const responseData = { success: true }
      mockFetch.mockResolvedValue(createJsonResponse(responseData))

      // #when
      const result = await syncFetch('POST', '/auth/otp/request', requestBody)

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/otp/request'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(requestBody)
        })
      )
      expect(result).toEqual(responseData)
    })

    it('includes authorization header when token provided', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await syncFetch('GET', '/api/me', undefined, 'my-token-123')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token-123'
          })
        })
      )
    })

    it('includes the active vault identity when token provided', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await syncFetch('GET', '/sync/changes', undefined, 'my-token-123')

      // #then
      expect(mockGetOrCreateVaultUuid).toHaveBeenCalledWith(mockDb)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Memry-Vault-Id': 'vault-1'
          })
        })
      )
    })

    it('declares the supported record sync types when token provided', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await syncFetch('GET', '/sync/changes', undefined, 'my-token-123')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(',')
          })
        })
      )
    })

    it('does not declare sync types on unauthenticated calls', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await syncFetch('GET', '/api/users')

      // #then
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>
      expect(headers['X-Memry-Sync-Types']).toBeUndefined()
    })

    it('throws NetworkError on connection failure', async () => {
      // #given
      mockFetch.mockRejectedValue(new TypeError('fetch failed'))

      // #when / #then
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow(NetworkError)
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow('errors:sync.serverUnreachable')
    })

    it('throws RateLimitError on 429 response', async () => {
      // #given
      mockFetch.mockResolvedValue(
        createJsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '60' })
      )

      // #when / #then
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow(RateLimitError)
    })

    it('throws SyncServerError on 4xx/5xx with error body', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ error: 'Invalid email format' }, 400))

      // #when / #then
      await expect(syncFetch('POST', '/auth/otp/request', {})).rejects.toThrow(SyncServerError)
      mockFetch.mockResolvedValue(createJsonResponse({ error: 'Invalid email format' }, 400))
      await expect(syncFetch('POST', '/auth/otp/request', {})).rejects.toThrow(
        'Invalid email format'
      )
    })

    it('throws SyncServerError on 500 with message body', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ message: 'Internal server error' }, 500))

      // #when / #then
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow('Internal server error')
    })

    it('preserves structured server error codes for sync classification', async () => {
      // #given
      mockFetch.mockResolvedValue(
        createJsonResponse(
          { error: { code: 'AUTH_DEVICE_REVOKED', message: 'Device has been revoked' } },
          403
        )
      )

      // #when / #then
      await expect(syncFetch('GET', '/sync/changes')).rejects.toMatchObject({
        statusCode: 403,
        serverError: 'AUTH_DEVICE_REVOKED: Device has been revoked'
      })
    })
  })

  describe('convenience functions', () => {
    it('postToServer calls syncFetch with POST', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await postToServer('/auth/otp/request', { email: 'test@example.com' })

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/otp/request'),
        expect.objectContaining({ method: 'POST' })
      )
    })

    it('getFromServer calls syncFetch with GET', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ devices: [] }))

      // #when
      await getFromServer('/api/devices', 'token-123')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/devices'),
        expect.objectContaining({ method: 'GET' })
      )
    })

    it('deleteFromServer calls syncFetch with DELETE', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))

      // #when
      await deleteFromServer('/api/devices/dev-1', 'token-123')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/devices/dev-1'),
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('parseRetryAfterHeader', () => {
    it('#given numeric seconds #then returns seconds', () => {
      expect(parseRetryAfterHeader('60')).toBe(60)
    })

    it('#given zero seconds #then returns 0', () => {
      expect(parseRetryAfterHeader('0')).toBe(0)
    })

    it('#given null #then returns undefined', () => {
      expect(parseRetryAfterHeader(null)).toBeUndefined()
    })

    it('#given HTTP-date in the future #then returns positive seconds', () => {
      const futureDate = new Date(Date.now() + 120_000).toUTCString()
      const result = parseRetryAfterHeader(futureDate)!
      expect(result).toBeGreaterThan(100)
      expect(result).toBeLessThanOrEqual(120)
    })

    it('#given HTTP-date in the past #then returns 0', () => {
      const pastDate = new Date(Date.now() - 60_000).toUTCString()
      expect(parseRetryAfterHeader(pastDate)).toBe(0)
    })

    it('#given invalid string #then returns undefined', () => {
      expect(parseRetryAfterHeader('not-a-number-or-date')).toBeUndefined()
    })
  })

  describe('RateLimitError', () => {
    it('#given retryAfter in seconds #then retryAfterMs is seconds * 1000', () => {
      const err = new RateLimitError(30)
      expect(err.retryAfterMs).toBe(30_000)
    })

    it('#given no retryAfter #then retryAfterMs defaults to 60000', () => {
      const err = new RateLimitError()
      expect(err.retryAfterMs).toBe(60_000)
    })

    it('#given very large retryAfter #then caps at 300 seconds', () => {
      const err = new RateLimitError(999_999)
      expect(err.retryAfterMs).toBe(300_000)
    })

    it('#given 429 response with HTTP-date Retry-After #then uses parsed value', async () => {
      // #given
      const futureDate = new Date(Date.now() + 30_000).toUTCString()
      mockFetch.mockResolvedValue(
        createJsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': futureDate })
      )

      // #when / #then
      try {
        await syncFetch('GET', '/api/test')
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError)
        const rle = err as RateLimitError
        expect(rle.retryAfter).toBeGreaterThan(25)
        expect(rle.retryAfter).toBeLessThanOrEqual(30)
      }
    })
  })
})
