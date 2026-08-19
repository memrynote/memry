import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import * as schema from '@memry/db-schema/data-schema'

const mockFetch = vi.fn()
const mockGetDatabase = vi.fn()

vi.stubEnv('SYNC_SERVER_URL', 'http://localhost:8787')

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => mockFetch(...args)
  }
}))

vi.mock('../database', () => ({
  getDatabase: () => mockGetDatabase()
}))

// ../agent/storage/vault-id is deliberately NOT mocked: the vault-identity
// cache lives inside getOrCreateVaultUuid, so a stubbed module would assert
// nothing about whether the header path actually stops re-reading SQLite — or
// whether it observes an in-place adoption. These run against a real handle.

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
  pushCrdtFullUpdate,
  SyncServerError,
  NetworkError,
  RateLimitError,
  parseRetryAfterHeader
} from './http-client'
import { MAX_CRDT_UPDATE_PAYLOAD_CHARS } from './crdt-payload'
import { resetVaultUuidCache } from '../agent/storage/vault-id'

/** A real data.db handle carrying the vault_metadata singleton. */
const createVaultDb = (vaultUuid: string) => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  sqlite
    .prepare(
      `INSERT INTO vault_metadata (id, vault_uuid, created_at, updated_at)
       VALUES ('singleton', ?, 0, 0)`
    )
    .run(vaultUuid)
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

/** Rewrite the singleton in place, the way adoptVaultLocally does. */
const rewriteVaultUuid = (sqlite: Database.Database, vaultUuid: string): void => {
  sqlite.prepare(`UPDATE vault_metadata SET vault_uuid = ? WHERE id = 'singleton'`).run(vaultUuid)
}

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

const lastRequestHeaders = (): Record<string, string> => {
  const calls = mockFetch.mock.calls
  return calls[calls.length - 1][1].headers as Record<string, string>
}

describe('http-client', () => {
  let vault: ReturnType<typeof createVaultDb>

  beforeEach(() => {
    vi.clearAllMocks()
    // The vault identity is cached per DataDb handle for the process lifetime,
    // so without this a test could read a previous test's cached value.
    resetVaultUuidCache()
    vault = createVaultDb('vault-1')
    mockGetDatabase.mockReturnValue(vault.db)
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

    it('strips a trailing slash from SYNC_SERVER_URL before appending the path', async () => {
      // #given a slash-terminated env value. http-client used to interpolate it
      // verbatim, producing `http://localhost:8787//api/users` — Cloudflare
      // Workers routes the doubled slash as a different path, so every sync
      // request 404'd instead of reaching its handler.
      const original = process.env.SYNC_SERVER_URL
      process.env.SYNC_SERVER_URL = 'http://localhost:8787/'
      mockFetch.mockResolvedValue(createJsonResponse({}))

      try {
        // #when
        await syncFetch('GET', '/api/users')

        // #then
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:8787/api/users',
          expect.objectContaining({ method: 'GET' })
        )
      } finally {
        if (original === undefined) delete process.env.SYNC_SERVER_URL
        else process.env.SYNC_SERVER_URL = original
      }
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

    it('passes an abort signal to fetch', async () => {
      // #given
      mockFetch.mockResolvedValue(createJsonResponse({ ok: true }))

      // #when
      await syncFetch('GET', '/sync/changes')

      // #then
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/sync/changes'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    })

    it('aborts a hung request after the timeout and throws a timed-out NetworkError', async () => {
      // #given a request that never resolves on its own
      mockFetch.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
      )

      // #when / #then
      await expect(
        syncFetch('GET', '/sync/changes', undefined, undefined, undefined, 25)
      ).rejects.toMatchObject({
        name: 'NetworkError',
        // The i18n mock above echoes keys, so this pins the timeout branch to
        // its own message rather than the generic unreachable one.
        message: 'errors:sync.requestTimedOut'
      })
    })
  })

  describe('pushCrdtFullUpdate', () => {
    it('sends the doc state to the non-pruning endpoint', async () => {
      // #given a full document state that must reach the server WITHOUT the
      // server deleting anything: only /sync/crdt/snapshot runs
      // pruneUpdatesBeforeSnapshot (apps/sync-server/src/routes/sync.ts).
      mockFetch.mockResolvedValue(createJsonResponse({ ok: true }))

      // #when
      await pushCrdtFullUpdate('note-1', new Uint8Array([1, 2, 3]), 'token-1')

      // #then the URL is the load-bearing assertion here. Sending these same
      // bytes one path over deletes every crdt_updates row at or below the
      // stored watermark, including one this device could not verify and
      // therefore could not have included.
      const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }]
      expect(url).toContain('/sync/crdt/updates')
      expect(url).not.toContain('/sync/crdt/snapshot')
      expect(JSON.parse(init.body)).toEqual({
        noteId: 'note-1',
        updates: [Buffer.from([1, 2, 3]).toString('base64')]
      })
    })

    it('refuses a state too large for a D1 row instead of silently falling back', async () => {
      // #given the incremental route stores each update as a D1 blob, so it has
      // a ceiling the snapshot's R2 object does not
      mockFetch.mockResolvedValue(createJsonResponse({ ok: true }))
      const tooBig = new Uint8Array(MAX_CRDT_UPDATE_PAYLOAD_CHARS)

      // #when / #then throwing stalls this one note — its content is already
      // durable in the local CRDT store — where a snapshot fallback would
      // destroy the peer payload the caller is protecting.
      await expect(pushCrdtFullUpdate('note-1', tooBig, 'token-1')).rejects.toThrow(
        'CRDT state too large'
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('vault identity header', () => {
    it('resolves the vault uuid once and reuses it across authenticated requests', async () => {
      // #given the vault uuid is a session-stable SQLite row that used to be
      // re-read (drizzle query build + statement) on every request
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #when the row changes underneath with no invalidation — an observable
      // stand-in for "did this request re-run the SELECT?"
      rewriteVaultUuid(vault.sqlite, 'not-read-again')
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #then no request re-read the row, and every one still carries the identity
      expect(mockFetch).toHaveBeenCalledTimes(3)
      for (const call of mockFetch.mock.calls) {
        expect((call[1].headers as Record<string, string>)['X-Memry-Vault-Id']).toBe('vault-1')
      }
    })

    it('re-resolves when the vault handle is replaced by a vault switch', async () => {
      // #given a request against the first vault
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #when openVault installs a new DataDb instance for a different vault
      mockGetDatabase.mockReturnValue(createVaultDb('vault-2').db)
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #then the new vault's identity is used, not the cached one
      expect(lastRequestHeaders()['X-Memry-Vault-Id']).toBe('vault-2')
    })

    it('re-resolves after an in-place adoption invalidates the cache', async () => {
      // #given a request before adoption
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')
      expect(lastRequestHeaders()['X-Memry-Vault-Id']).toBe('vault-1')

      // #when adoptVaultLocally rewrites the uuid on the SAME handle and
      // invalidates the cache
      rewriteVaultUuid(vault.sqlite, 'adopted-vault')
      resetVaultUuidCache()
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #then registration and every later request bind to the adopted vault
      expect(lastRequestHeaders()['X-Memry-Vault-Id']).toBe('adopted-vault')
    })

    it('does not cache a miss while no vault is open', async () => {
      // #given getDatabase() throws until a vault is opened
      mockFetch.mockResolvedValue(createJsonResponse({ success: true }))
      mockGetDatabase.mockImplementation(() => {
        throw new Error('Database not initialized')
      })

      // #when
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')

      // #then no identity header, and nothing poisoned for the next attempt
      expect(lastRequestHeaders()['X-Memry-Vault-Id']).toBeUndefined()

      mockGetDatabase.mockReturnValue(vault.db)
      await syncFetch('GET', '/sync/changes', undefined, 'token-1')
      expect(lastRequestHeaders()['X-Memry-Vault-Id']).toBe('vault-1')
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
