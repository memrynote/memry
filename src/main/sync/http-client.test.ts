import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args)
  }
}))

import {
  syncFetch,
  postToServer,
  getFromServer,
  deleteFromServer,
  SyncServerError,
  NetworkError,
  RateLimitError
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

    it('throws NetworkError on connection failure', async () => {
      // #given
      mockFetch.mockRejectedValue(new TypeError('fetch failed'))

      // #when / #then
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow(NetworkError)
      await expect(syncFetch('GET', '/api/test')).rejects.toThrow(
        'Unable to connect to sync server'
      )
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
})
