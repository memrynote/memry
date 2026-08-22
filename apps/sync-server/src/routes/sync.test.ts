import { Hono } from 'hono'
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { deviceIdentifier, type RateLimitOptions } from '../middleware/rate-limit'
import type { AppContext } from '../types'

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('../services/sync', () => ({
  getSyncStatus: vi.fn().mockResolvedValue({
    connected: true,
    pendingItems: 0,
    serverTime: 1000
  }),
  getManifest: vi.fn().mockResolvedValue({
    items: [],
    serverTime: 1000
  }),
  getChanges: vi.fn().mockResolvedValue({
    items: [],
    deleted: [],
    hasMore: false,
    nextCursor: 0
  }),
  processRecordPushBatch: vi.fn().mockResolvedValue({
    accepted: ['550e8400-e29b-41d4-a716-446655440000'],
    rejected: [],
    serverTime: 1000,
    maxCursor: 1,
    outcomes: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'note',
        accepted: true,
        serverCursor: 1
      }
    ]
  }),
  pullItems: vi.fn().mockResolvedValue([]),
  getItem: vi.fn().mockResolvedValue({
    itemId: '550e8400-e29b-41d4-a716-446655440000',
    type: 'note',
    version: 1,
    payload: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
    serverCursor: 1
  }),
  updateDeviceCursor: vi.fn().mockResolvedValue(undefined),
  listUserVaults: vi.fn().mockResolvedValue([
    { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000, encryptedName: 'enc-a', nameNonce: 'n-a' },
    { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000, encryptedName: null, nameNonce: null }
  ]),
  setVaultName: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/entitlements', () => ({
  getSyncEntitlement: vi
    .fn()
    .mockResolvedValue({ plan: 'pro', status: 'active', expires_at: null }),
  isPaidSyncEntitlementActive: vi.fn().mockReturnValue(true),
  ensureSyncVaultAllowed: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/vault-deletion', () => ({
  vaultExistsForUser: vi.fn().mockResolvedValue(true),
  deleteVaultData: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/crdt', () => ({
  storeUpdates: vi.fn().mockResolvedValue([1]),
  getUpdates: vi.fn().mockResolvedValue({ updates: [], hasMore: false }),
  getBatchUpdates: vi.fn().mockResolvedValue({}),
  storeSnapshot: vi.fn().mockResolvedValue({ sequenceNum: 0 }),
  getSnapshot: vi.fn().mockResolvedValue(null),
  pruneUpdatesBeforeSnapshot: vi.fn().mockResolvedValue(0)
}))

vi.mock('../services/device', () => ({
  updateDevice: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    c.set('vaultId', 'vault-1')
    await next()
  })
}))

vi.mock('../middleware/paid-sync', () => ({
  paidSyncMiddleware: vi.fn().mockImplementation(async (_c: any, next: any) => {
    await next()
  })
}))

// Records what each limiter was built with. The array is plain state, so it
// survives the vi.clearAllMocks() below — the limiters are created once, at
// module load, long before any test runs.
const { rateLimiterOptions } = vi.hoisted(() => ({
  rateLimiterOptions: [] as RateLimitOptions[]
}))

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>()
  return {
    ...actual,
    createRateLimiter: vi.fn().mockImplementation((options: RateLimitOptions) => {
      rateLimiterOptions.push(options)
      return vi.fn().mockImplementation(async (_c: any, next: any) => {
        await next()
      })
    })
  }
})

vi.mock('../services/storage', () => ({
  getStorageBreakdown: vi.fn().mockResolvedValue({
    usedBytes: 10,
    quotaBytes: 100,
    remainingBytes: 90
  })
}))

import { sync } from './sync'
import {
  getSyncStatus,
  getManifest,
  getChanges,
  processRecordPushBatch,
  pullItems,
  getItem,
  updateDeviceCursor,
  listUserVaults,
  setVaultName
} from '../services/sync'
import { ensureSyncVaultAllowed, isPaidSyncEntitlementActive } from '../services/entitlements'
import { paidSyncMiddleware } from '../middleware/paid-sync'
import { deleteVaultData, vaultExistsForUser } from '../services/vault-deletion'
import {
  storeUpdates,
  getUpdates,
  getBatchUpdates,
  storeSnapshot,
  getSnapshot,
  pruneUpdatesBeforeSnapshot
} from '../services/crdt'
import { authMiddleware } from '../middleware/auth'
import { updateDevice } from '../services/device'
import { getStorageBreakdown } from '../services/storage'

// ============================================================================
// Helpers
// ============================================================================

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}

const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(Response.json({ sent: 0 }))
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value)
  const copy = new Uint8Array(encoded.byteLength)
  copy.set(encoded)
  return copy.buffer
}

const createEnv = () => ({
  DB: {} as D1Database,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {
    idFromName: vi.fn().mockReturnValue('do-id-1'),
    get: vi.fn().mockReturnValue(mockDoStub)
  } as unknown as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'pk',
  JWT_PRIVATE_KEY: 'sk',
  RESEND_API_KEY: 'rk',
  GOOGLE_CLIENT_ID: 'gc',
  GOOGLE_CLIENT_SECRET: 'gs',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  RECOVERY_DUMMY_SECRET: 'mock-dummy-secret'
})

const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {}
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

const jsonPost = (path: string, body: unknown) => ({
  method: 'POST' as const,
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' }
})

const makePushItem = (overrides: Record<string, unknown> = {}) => ({
  id: VALID_UUID,
  type: 'note',
  operation: 'create',
  encryptedKey: 'ek',
  keyNonce: 'kn',
  encryptedData: 'ed',
  dataNonce: 'dn',
  signature: 'sig',
  signerDeviceId: 'device-1',
  clock: { 'device-1': 1 },
  ...overrides
})

const makePushBatchResult = (
  overrides: Partial<Awaited<ReturnType<typeof processRecordPushBatch>>> = {}
) => ({
  accepted: [VALID_UUID],
  rejected: [],
  serverTime: 1000,
  maxCursor: 1,
  outcomes: [
    {
      id: VALID_UUID,
      type: 'note' as const,
      accepted: true,
      serverCursor: 1
    }
  ],
  ...overrides
})

// ============================================================================
// Tests
// ============================================================================

describe('sync routes', () => {
  let app: ReturnType<typeof createApp>
  let env: ReturnType<typeof createEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    mockDoStub.fetch.mockResolvedValue(Response.json({ sent: 0 }))
    app = createApp()
    env = createEnv()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ==========================================================================
  // Auth middleware wiring
  // ==========================================================================

  describe('auth enforcement', () => {
    it('should invoke authMiddleware on every request', async () => {
      // #when
      await app.request('/sync/status', { method: 'GET' }, env, executionCtx)

      // #then
      expect(authMiddleware).toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // GET /sync/status
  // ==========================================================================

  describe('GET /sync/status', () => {
    it('should return 200 with sync status', async () => {
      // #when
      const res = await app.request('/sync/status', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ connected: true, pendingItems: 0, serverTime: 1000 })
    })

    it('should pass userId and deviceId to getSyncStatus', async () => {
      // #when
      await app.request('/sync/status', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getSyncStatus).toHaveBeenCalledWith(env.DB, 'user-1', 'device-1', 'vault-1')
    })
  })

  describe('GET /sync/ws and /sync/storage', () => {
    it('requires a websocket upgrade header before forwarding to the durable object', async () => {
      const res = await app.request(
        'http://localhost/sync/ws',
        { method: 'GET' },
        env,
        executionCtx
      )

      expect(res.status).toBe(426)
      expect(mockDoStub.fetch).not.toHaveBeenCalled()
    })

    it('forwards websocket upgrade requests to the user sync durable object', async () => {
      mockDoStub.fetch.mockResolvedValueOnce(Response.json({ connected: true }))

      const res = await app.request(
        'http://localhost/sync/ws',
        { method: 'GET', headers: { Upgrade: 'websocket' } },
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ connected: true })
      expect(env.USER_SYNC_STATE.idFromName).toHaveBeenCalledWith('user-1')
      expect(mockDoStub.fetch).toHaveBeenCalledWith(expect.any(Request))
    })

    it('returns storage usage for the authenticated user', async () => {
      const res = await app.request('/sync/storage', { method: 'GET' }, env, executionCtx)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ usedBytes: 10, quotaBytes: 100, remainingBytes: 90 })
      expect(getStorageBreakdown).toHaveBeenCalledWith(env.DB, 'user-1')
    })
  })

  // ==========================================================================
  // GET /sync/vaults
  // ==========================================================================

  describe('GET /sync/vaults', () => {
    it('lists the user vaults with item counts and created dates', async () => {
      const res = await app.request('/sync/vaults', { method: 'GET' }, env, executionCtx)

      expect(res.status).toBe(200)
      const body = (await res.json()) as { vaults: unknown }
      expect(body.vaults).toEqual([
        {
          vaultUuid: 'v-a',
          itemCount: 367,
          createdAt: 1000,
          encryptedName: 'enc-a',
          nameNonce: 'n-a'
        },
        { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000, encryptedName: null, nameNonce: null }
      ])
      expect(listUserVaults).toHaveBeenCalledWith(env.DB, 'user-1')
    })
  })

  // ==========================================================================
  // POST /sync/vaults
  // ==========================================================================

  describe('POST /sync/vaults', () => {
    const postVault = (body: unknown) =>
      app.request(
        '/sync/vaults',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        },
        env,
        executionCtx
      )

    it('registers a vault and stores its encrypted name', async () => {
      const res = await postVault({
        vaultUuid: 'vault-new',
        encryptedName: 'enc-name',
        nameNonce: 'nonce'
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(ensureSyncVaultAllowed).toHaveBeenCalledWith(
        env.DB,
        'user-1',
        'vault-new',
        expect.objectContaining({ plan: 'pro' })
      )
      expect(setVaultName).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-new', 'enc-name', 'nonce')
    })

    it('rejects invalid payloads with 400', async () => {
      const res = await postVault({})

      expect(res.status).toBe(400)
      expect(setVaultName).not.toHaveBeenCalled()
    })

    it('returns 402 when the user has no active paid sync entitlement', async () => {
      vi.mocked(isPaidSyncEntitlementActive).mockReturnValueOnce(false)

      const res = await postVault({
        vaultUuid: 'vault-new',
        encryptedName: 'enc-name',
        nameNonce: 'nonce'
      })

      expect(res.status).toBe(402)
      expect(ensureSyncVaultAllowed).not.toHaveBeenCalled()
      expect(setVaultName).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // DELETE /sync/vaults/:vaultId
  // ==========================================================================

  describe('DELETE /sync/vaults/:vaultId', () => {
    beforeEach(() => {
      vi.mocked(vaultExistsForUser).mockResolvedValue(true)
      vi.mocked(deleteVaultData).mockResolvedValue(undefined)
    })

    it('purges the vault and returns success', async () => {
      const res = await app.request('/sync/vaults/vault-a', { method: 'DELETE' }, env, executionCtx)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(deleteVaultData).toHaveBeenCalledWith(env.DB, env.STORAGE, 'user-1', 'vault-a')
    })

    it('checks ownership scoped to the caller', async () => {
      await app.request('/sync/vaults/vault-a', { method: 'DELETE' }, env, executionCtx)

      expect(vaultExistsForUser).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-a')
    })

    it('404s and purges nothing when the caller does not own the vault', async () => {
      vi.mocked(vaultExistsForUser).mockResolvedValue(false)

      const res = await app.request(
        '/sync/vaults/someone-elses',
        { method: 'DELETE' },
        env,
        executionCtx
      )

      expect(res.status).toBe(404)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.SYNC_VAULT_NOT_FOUND)
      expect(deleteVaultData).not.toHaveBeenCalled()
    })

    it('400s on a malformed vault id', async () => {
      const res = await app.request(
        '/sync/vaults/not%20a%20valid%20id!',
        { method: 'DELETE' },
        env,
        executionCtx
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
      expect(deleteVaultData).not.toHaveBeenCalled()
    })

    // REGRESSION — the sharpest edge in this feature.
    // paidSyncMiddleware runs ensureSyncVaultAllowed, which UPSERTS. If this route
    // ever registers below that middleware, the vault is re-created mid-request
    // and delete silently becomes a no-op that still returns 200.
    //
    // Assert on `paidSyncMiddleware` itself, not on `ensureSyncVaultAllowed`.
    // `../middleware/paid-sync` is module-mocked as a bare passthrough (see the
    // vi.mock above) that never calls the real ensureSyncVaultAllowed, so
    // `expect(ensureSyncVaultAllowed).not.toHaveBeenCalled()` would be true
    // unconditionally — it can't detect the route moving below the middleware.
    // `paidSyncMiddleware` is the thing Hono actually invokes based on
    // registration order, so only an assertion on that mock can fail when the
    // route regresses. Do not "simplify" this back to ensureSyncVaultAllowed.
    it('does not run ensureSyncVaultAllowed (would resurrect the vault)', async () => {
      await app.request(
        '/sync/vaults/vault-a',
        { method: 'DELETE', headers: { 'X-Memry-Vault-Id': 'vault-a' } },
        env,
        executionCtx
      )

      expect(
        paidSyncMiddleware,
        'DELETE must register above paidSyncMiddleware'
      ).not.toHaveBeenCalled()
      expect(
        ensureSyncVaultAllowed,
        'DELETE must register above paidSyncMiddleware'
      ).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // GET /sync/manifest
  // ==========================================================================

  describe('GET /sync/manifest', () => {
    it('should return 200 with manifest', async () => {
      // #when
      const res = await app.request('/sync/manifest', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ items: [], serverTime: 1000 })
    })

    it('should pass userId and negotiated types to getManifest', async () => {
      // #when
      await app.request('/sync/manifest', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getManifest).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-1', [
        ...LEGACY_RECORD_SYNC_ITEM_TYPES
      ])
    })
  })

  // ==========================================================================
  // GET /sync/changes
  // ==========================================================================

  describe('GET /sync/changes', () => {
    it('should return 200 with changes', async () => {
      // #when
      const res = await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ items: [], deleted: [], hasMore: false, nextCursor: 0 })
    })

    it('should forward cursor and limit query params', async () => {
      // #when
      await app.request('/sync/changes?cursor=5&limit=10', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 5, 10, 'vault-1', [
        ...LEGACY_RECORD_SYNC_ITEM_TYPES
      ])
    })

    it('should default cursor to 0 when omitted', async () => {
      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
        ...LEGACY_RECORD_SYNC_ITEM_TYPES
      ])
    })

    it('should return 400 for non-numeric cursor', async () => {
      // #when
      const res = await app.request(
        '/sync/changes?cursor=abc',
        { method: 'GET' },
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.SYNC_INVALID_CURSOR)
    })

    it('should return 400 for negative cursor', async () => {
      // #when
      const res = await app.request('/sync/changes?cursor=-1', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.SYNC_INVALID_CURSOR)
    })

    it('should return 400 for invalid limit', async () => {
      // #when
      const res = await app.request('/sync/changes?limit=0', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should update device cursor when changes contain items', async () => {
      // #given
      vi.mocked(getChanges).mockResolvedValueOnce({
        items: [{ id: VALID_UUID, type: 'note', version: 1, modifiedAt: 1000, size: 100 }],
        deleted: [],
        hasMore: false,
        nextCursor: 5
      })

      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(updateDeviceCursor).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', 5, 'vault-1')
    })

    it('should not update device cursor when no changes', async () => {
      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(updateDeviceCursor).not.toHaveBeenCalled()
    })

    it('should update device last_sync_at when changes contain items', async () => {
      // #given
      vi.mocked(getChanges).mockResolvedValueOnce({
        items: [{ id: VALID_UUID, type: 'note', version: 1, modifiedAt: 1000, size: 100 }],
        deleted: [],
        hasMore: false,
        nextCursor: 5
      })

      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(updateDevice).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', {
        last_sync_at: expect.any(Number)
      })
    })

    it('should not update device last_sync_at when no changes', async () => {
      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(updateDevice).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // POST /sync/push
  // ==========================================================================

  describe('POST /sync/push', () => {
    it('should return 200 with accepted and rejected arrays', async () => {
      // #given
      const body = { items: [makePushItem()] }

      // #when
      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
      const json = (await res.json()) as { accepted: string[]; rejected: unknown[] }
      expect(json.accepted).toEqual([VALID_UUID])
      expect(json.rejected).toEqual([])
      expect(json).toHaveProperty('serverTime')
    })

    it('should collect rejected items with reasons', async () => {
      // #given
      vi.mocked(processRecordPushBatch).mockResolvedValueOnce(
        makePushBatchResult({
          accepted: [],
          rejected: [{ id: VALID_UUID, reason: 'VERSION_CONFLICT' }],
          maxCursor: 0,
          outcomes: [
            {
              id: VALID_UUID,
              type: 'note',
              accepted: false,
              reason: 'VERSION_CONFLICT'
            }
          ]
        })
      )
      const body = { items: [makePushItem()] }

      // #when
      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        accepted: string[]
        rejected: Array<{ id: string; reason: string }>
      }
      expect(json.accepted).toEqual([])
      expect(json.rejected).toEqual([{ id: VALID_UUID, reason: 'VERSION_CONFLICT' }])
    })

    it('should update device cursor when items are accepted', async () => {
      // #given
      const body = { items: [makePushItem()] }

      // #when
      await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(updateDeviceCursor).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', 1, 'vault-1')
    })

    it('should return 400 for empty items array', async () => {
      // #given
      const body = { items: [] }

      // #when
      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should return 500 for unparseable JSON body', async () => {
      // #when
      const res = await app.request(
        'http://localhost/sync/push',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-json'
        },
        env
      )

      // #then - SyntaxError from c.req.json() is not an AppError, falls through to 500
      expect(res.status).toBe(500)
    })

    it('should update device last_sync_at when items accepted', async () => {
      // #given
      const body = { items: [makePushItem()] }

      // #when
      await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(updateDevice).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', {
        last_sync_at: expect.any(Number)
      })
    })

    it('should not update device last_sync_at when all items rejected', async () => {
      // #given
      vi.mocked(processRecordPushBatch).mockResolvedValueOnce(
        makePushBatchResult({
          accepted: [],
          rejected: [{ id: VALID_UUID, reason: 'VERSION_CONFLICT' }],
          maxCursor: 0,
          outcomes: [
            {
              id: VALID_UUID,
              type: 'note',
              accepted: false,
              reason: 'VERSION_CONFLICT'
            }
          ]
        })
      )
      const body = { items: [makePushItem()] }

      // #when
      await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(updateDevice).not.toHaveBeenCalled()
    })

    it('should accept non-UUID item IDs when payload otherwise validates', async () => {
      // #given
      vi.mocked(processRecordPushBatch).mockResolvedValueOnce(
        makePushBatchResult({
          accepted: ['not-a-uuid'],
          outcomes: [
            {
              id: 'not-a-uuid',
              type: 'note',
              accepted: true,
              serverCursor: 1
            }
          ]
        })
      )
      const body = { items: [makePushItem({ id: 'not-a-uuid' })] }

      // #when
      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual(
        expect.objectContaining({
          accepted: ['not-a-uuid'],
          rejected: []
        })
      )
    })

    it('should pass the parsed record batch to processRecordPushBatch', async () => {
      const body = { items: [makePushItem()] }

      await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      expect(processRecordPushBatch).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        'device-1',
        [makePushItem()],
        'vault-1',
        // Attribution: no x-memry-client header on these requests, so the
        // handler passes null and the row is written unattributed.
        null
      )
    })

    it('should return 400 for unsupported record transport item types', async () => {
      const body = {
        items: [makePushItem({ type: 'attachment', clock: undefined })]
      }

      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
      expect(processRecordPushBatch).not.toHaveBeenCalled()
    })

    it('should return 400 when a clock-required record item omits clock metadata', async () => {
      const body = {
        items: [makePushItem({ type: 'task', clock: undefined })]
      }

      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
      expect(processRecordPushBatch).not.toHaveBeenCalled()
    })

    it('should allow settings pushes without top-level clock metadata', async () => {
      const body = {
        items: [makePushItem({ type: 'settings', clock: undefined })]
      }

      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', body),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(processRecordPushBatch).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        'device-1',
        [makePushItem({ type: 'settings', clock: undefined })],
        'vault-1',
        null
      )
    })

    it('logs and returns quota errors thrown while processing a record push', async () => {
      vi.mocked(processRecordPushBatch).mockRejectedValueOnce(
        new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
      )

      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', { items: [makePushItem()] }),
        env,
        executionCtx
      )

      expect(res.status).toBe(413)
      expect(updateDeviceCursor).not.toHaveBeenCalled()
      expect(updateDevice).not.toHaveBeenCalled()
    })

    it('captures background broadcast failures without failing the push response', async () => {
      mockDoStub.fetch.mockRejectedValueOnce(new Error(`broadcast failed ${VALID_UUID}`))
      const scheduled: Promise<unknown>[] = []
      const localExecutionCtx = {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          scheduled.push(promise)
        }),
        passThroughOnException: vi.fn(),
        props: {}
      }
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      const localEnv = {
        ...env,
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com'
      }

      const res = await app.request(
        'http://localhost/sync/push',
        jsonPost('/sync/push', { items: [makePushItem()] }),
        localEnv,
        localExecutionCtx
      )
      await scheduled[0]

      expect(res.status).toBe(200)
      const captureCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
      expect(captureCall).toBeDefined()
      const point = JSON.parse((captureCall![1] as RequestInit).body as string).batch[0] as {
        event: string
        distinct_id: string
        properties: Record<string, unknown>
      }
      expect(point.event).toBe('server_error_seen') // event name
      expect(point.distinct_id).toBe('memry_server_development')
      expect(point.properties.action).toBe('record_push_broadcast_failed') // action
      expect(point.properties.source).toBe('UserSyncState') // source
      expect(point.properties.error_code).toBe('WAIT_UNTIL_REJECTED') // error_code
      expect(point.properties.path).toBe('/sync/push') // path
      expect(JSON.stringify(point)).not.toContain(VALID_UUID)
    })
  })

  // ==========================================================================
  // POST /sync/pull
  // ==========================================================================

  describe('POST /sync/pull', () => {
    it('should return 200 with items array', async () => {
      // #given
      const body = { itemIds: [VALID_UUID] }

      // #when
      const res = await app.request(
        'http://localhost/sync/pull',
        jsonPost('/sync/pull', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ items: [] })
    })

    it('should pass userId and itemIds to pullItems', async () => {
      // #given
      const body = { itemIds: [VALID_UUID] }

      // #when
      await app.request(
        'http://localhost/sync/pull',
        jsonPost('/sync/pull', body),
        env,
        executionCtx
      )

      // #then
      expect(pullItems).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        [VALID_UUID],
        'vault-1',
        [...LEGACY_RECORD_SYNC_ITEM_TYPES]
      )
    })

    it('should return 400 for empty itemIds', async () => {
      // #given
      const body = { itemIds: [] }

      // #when
      const res = await app.request(
        'http://localhost/sync/pull',
        jsonPost('/sync/pull', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('should accept non-UUID item IDs (nanoid format)', async () => {
      // #given
      const body = { itemIds: ['V1StGXR8_Z5jdHi6B-myT'] }

      // #when
      const res = await app.request(
        'http://localhost/sync/pull',
        jsonPost('/sync/pull', body),
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
    })
  })

  // ==========================================================================
  // GET /sync/items/:id
  // ==========================================================================

  describe('GET /sync/items/:id', () => {
    it('should return 200 with item data', async () => {
      // #when
      const res = await app.request(
        `/sync/items/${VALID_UUID}`,
        { method: 'GET' },
        env,
        executionCtx
      )

      // #then
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        itemId: VALID_UUID,
        type: 'note',
        version: 1,
        payload: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
        serverCursor: 1
      })
    })

    it('should pass userId and itemId to getItem', async () => {
      // #when
      await app.request(`/sync/items/${VALID_UUID}`, { method: 'GET' }, env, executionCtx)

      // #then
      expect(getItem).toHaveBeenCalledWith(env.DB, env.STORAGE, 'user-1', VALID_UUID, 'vault-1')
    })

    it('should return 400 for non-UUID id', async () => {
      // #when
      const res = await app.request('/sync/items/not-a-uuid', { method: 'GET' }, env, executionCtx)

      // #then
      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })
  })

  describe('record transport aliases', () => {
    it('supports /sync/records/push while keeping legacy /sync/push intact', async () => {
      const body = { items: [makePushItem()] }

      const res = await app.request(
        'http://localhost/sync/records/push',
        jsonPost('/sync/records/push', body),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(processRecordPushBatch).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        'device-1',
        [makePushItem()],
        'vault-1',
        // Attribution: no x-memry-client header on these requests, so the
        // handler passes null and the row is written unattributed.
        null
      )
    })

    it('supports /sync/records/pull', async () => {
      const body = { itemIds: [VALID_UUID] }

      const res = await app.request(
        'http://localhost/sync/records/pull',
        jsonPost('/sync/records/pull', body),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(pullItems).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        [VALID_UUID],
        'vault-1',
        [...LEGACY_RECORD_SYNC_ITEM_TYPES]
      )
    })
  })

  describe('CRDT transport separation', () => {
    it('routes /sync/crdt/updates through CRDT services instead of record push', async () => {
      const payload = { noteId: 'note_1', updates: [btoa('hello')] }

      const res = await app.request(
        'http://localhost/sync/crdt/updates',
        jsonPost('/sync/crdt/updates', payload),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(storeUpdates).toHaveBeenCalledTimes(1)
      expect(processRecordPushBatch).not.toHaveBeenCalled()
    })

    it('returns 400 for invalid CRDT update payloads', async () => {
      const res = await app.request(
        'http://localhost/sync/crdt/updates',
        jsonPost('/sync/crdt/updates', { noteId: 'bad note id!', updates: [] }),
        env,
        executionCtx
      )

      expect(res.status).toBe(400)
      const json = (await res.json()) as { error: { code: string } }
      expect(json.error.code).toBe(ErrorCodes.VALIDATION_ERROR)
    })

    it('returns encoded CRDT updates and caps oversized limits at 500', async () => {
      vi.mocked(getUpdates).mockResolvedValueOnce({
        updates: [
          {
            id: 'update-7',
            user_id: 'user-1',
            vault_id: 'vault-1',
            note_id: 'note_1',
            sequence_num: 7,
            update_data: bytes('hello'),
            signer_device_id: 'device-2',
            created_at: 111
          }
        ],
        hasMore: true
      })

      const res = await app.request(
        'http://localhost/sync/crdt/updates?note_id=note_1&since=3&limit=999',
        { method: 'GET' },
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        updates: [
          {
            sequenceNum: 7,
            data: btoa('hello'),
            signerDeviceId: 'device-2',
            createdAt: 111
          }
        ],
        hasMore: true
      })
      expect(getUpdates).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-1', 'note_1', 3, 500)
    })

    it('validates CRDT update query params', async () => {
      let res = await app.request(
        'http://localhost/sync/crdt/updates',
        { method: 'GET' },
        env,
        executionCtx
      )
      expect(res.status).toBe(400)

      res = await app.request(
        'http://localhost/sync/crdt/updates?note_id=note_1&since=-1',
        { method: 'GET' },
        env,
        executionCtx
      )
      expect(res.status).toBe(400)

      res = await app.request(
        'http://localhost/sync/crdt/updates?note_id=note_1&limit=0',
        { method: 'GET' },
        env,
        executionCtx
      )
      expect(res.status).toBe(400)
    })

    it('returns encoded batch CRDT updates', async () => {
      vi.mocked(getBatchUpdates).mockResolvedValueOnce({
        notes: {
          note_1: {
            updates: [
              {
                id: 'update-8',
                user_id: 'user-1',
                vault_id: 'vault-1',
                note_id: 'note_1',
                sequence_num: 8,
                update_data: bytes('batch'),
                signer_device_id: 'device-2',
                created_at: 222
              }
            ],
            hasMore: false
          }
        },
        snapshotMeta: {
          note_1: { sequenceNum: 4, revision: 'rev-1', signerDeviceId: 'device-2' }
        }
      })

      const res = await app.request(
        'http://localhost/sync/crdt/updates/batch',
        jsonPost('/sync/crdt/updates/batch', {
          notes: [{ noteId: 'note_1', since: 4 }],
          limit: 10
        }),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        notes: {
          note_1: {
            updates: [
              {
                sequenceNum: 8,
                data: btoa('batch'),
                signerDeviceId: 'device-2',
                createdAt: 222
              }
            ],
            hasMore: false
          }
        },
        // Additive top-level key. A client that gets no `snapshotMeta` at all is
        // talking to a server that predates it; a note absent from a present map
        // has no server snapshot.
        snapshotMeta: {
          note_1: { sequenceNum: 4, revision: 'rev-1', signerDeviceId: 'device-2' }
        }
      })
      expect(getBatchUpdates).toHaveBeenCalledWith(
        env.DB,
        'user-1',
        'vault-1',
        [{ noteId: 'note_1', since: 4 }],
        10
      )
    })

    it('rejects duplicate note ids in CRDT batch pulls', async () => {
      const res = await app.request(
        'http://localhost/sync/crdt/updates/batch',
        jsonPost('/sync/crdt/updates/batch', {
          notes: [
            { noteId: 'note_1', since: 0 },
            { noteId: 'note_1', since: 1 }
          ],
          limit: 10
        }),
        env,
        executionCtx
      )

      expect(res.status).toBe(400)
      expect(getBatchUpdates).not.toHaveBeenCalled()
    })

    it('stores CRDT snapshots and prunes prior updates', async () => {
      vi.mocked(storeSnapshot).mockResolvedValueOnce({ sequenceNum: 12 })

      const res = await app.request(
        'http://localhost/sync/crdt/snapshot',
        jsonPost('/sync/crdt/snapshot', {
          noteId: 'note_1',
          snapshot: btoa('snapshot')
        }),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sequenceNum: 12 })
      expect(storeSnapshot).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        'vault-1',
        'note_1',
        'device-1',
        expect.any(ArrayBuffer),
        null
      )
      expect(pruneUpdatesBeforeSnapshot).toHaveBeenCalledWith(env.DB, 'user-1', 'vault-1', 'note_1')
    })

    // A snapshot is the only shape edits made while signed out can leave in, so a
    // stored-but-unannounced snapshot is invisible on every peer until the next
    // vault sweep — up to 15 minutes.
    it('broadcasts crdt_updated to the other devices after a snapshot push', async () => {
      vi.mocked(storeSnapshot).mockResolvedValueOnce({ sequenceNum: 12 })

      const res = await app.request(
        'http://localhost/sync/crdt/snapshot',
        jsonPost('/sync/crdt/snapshot', { noteId: 'note_1', snapshot: btoa('snapshot') }),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(mockDoStub.fetch).toHaveBeenCalledTimes(1)
      const broadcast = mockDoStub.fetch.mock.calls[0][0] as Request
      expect(new URL(broadcast.url).pathname).toBe('/broadcast')
      expect(broadcast.method).toBe('POST')
      expect(await broadcast.json()).toEqual({
        excludeDeviceId: 'device-1',
        vaultId: 'vault-1',
        type: 'crdt_updated',
        noteId: 'note_1'
      })
    })

    // A peer told early can pull while the pre-snapshot updates are still being
    // removed, so the broadcast must trail both writes.
    it('broadcasts only after the snapshot is stored and prior updates are pruned', async () => {
      const order: string[] = []
      vi.mocked(storeSnapshot).mockImplementationOnce(async () => {
        order.push('store')
        return { sequenceNum: 12 }
      })
      vi.mocked(pruneUpdatesBeforeSnapshot).mockImplementationOnce(async () => {
        order.push('prune')
        return 0
      })
      mockDoStub.fetch.mockImplementationOnce(async () => {
        order.push('broadcast')
        return Response.json({ sent: 1 })
      })

      const res = await app.request(
        'http://localhost/sync/crdt/snapshot',
        jsonPost('/sync/crdt/snapshot', { noteId: 'note_1', snapshot: btoa('snapshot') }),
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(order).toEqual(['store', 'prune', 'broadcast'])
    })

    it('captures a failed snapshot broadcast without failing the push response', async () => {
      vi.mocked(storeSnapshot).mockResolvedValueOnce({ sequenceNum: 12 })
      mockDoStub.fetch.mockRejectedValueOnce(new Error('broadcast failed'))
      const scheduled: Promise<unknown>[] = []
      const localExecutionCtx = {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          scheduled.push(promise)
        }),
        passThroughOnException: vi.fn(),
        props: {}
      }
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      const localEnv = {
        ...env,
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com'
      }

      const res = await app.request(
        'http://localhost/sync/crdt/snapshot',
        jsonPost('/sync/crdt/snapshot', { noteId: 'note_1', snapshot: btoa('snapshot') }),
        localEnv,
        localExecutionCtx
      )
      await scheduled[0]

      // The snapshot is already durable; a broadcast failure must not ask the
      // client to push it again.
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sequenceNum: 12 })
      const captureCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
      expect(captureCall).toBeDefined()
      const point = JSON.parse((captureCall![1] as RequestInit).body as string).batch[0] as {
        event: string
        properties: Record<string, unknown>
      }
      expect(point.event).toBe('server_error_seen')
      expect(point.properties.action).toBe('crdt_snapshot_broadcast_failed')
      expect(point.properties.source).toBe('UserSyncState')
      expect(point.properties.error_code).toBe('WAIT_UNTIL_REJECTED')
      expect(point.properties.path).toBe('/sync/crdt/snapshot')
    })

    it('logs and returns quota errors for CRDT update and snapshot writes', async () => {
      vi.mocked(storeUpdates).mockRejectedValueOnce(
        new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
      )

      let res = await app.request(
        'http://localhost/sync/crdt/updates',
        jsonPost('/sync/crdt/updates', { noteId: 'note_1', updates: [btoa('hello')] }),
        env,
        executionCtx
      )
      expect(res.status).toBe(413)
      expect(storeUpdates).toHaveBeenCalled()

      vi.mocked(storeSnapshot).mockRejectedValueOnce(
        new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
      )

      res = await app.request(
        'http://localhost/sync/crdt/snapshot',
        jsonPost('/sync/crdt/snapshot', { noteId: 'note_1', snapshot: btoa('snapshot') }),
        env,
        executionCtx
      )
      expect(res.status).toBe(413)
      expect(storeSnapshot).toHaveBeenCalled()
    })

    it('returns null when no CRDT snapshot exists', async () => {
      vi.mocked(getSnapshot).mockResolvedValueOnce(null)

      const res = await app.request(
        'http://localhost/sync/crdt/snapshot/note_1',
        { method: 'GET' },
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        snapshot: null,
        sequenceNum: 0,
        signerDeviceId: null,
        revision: null
      })
    })

    it('returns encoded CRDT snapshots and validates snapshot ids', async () => {
      vi.mocked(getSnapshot).mockResolvedValueOnce({
        snapshotData: bytes('snapshot'),
        sequenceNum: 20,
        signerDeviceId: 'device-2',
        revision: 'rev-1'
      })

      let res = await app.request(
        'http://localhost/sync/crdt/snapshot/note_1',
        { method: 'GET' },
        env,
        executionCtx
      )

      expect(res.status).toBe(200)
      // The revision the client just merged, so the next batch pull can tell it
      // this baseline is still current.
      expect(await res.json()).toEqual({
        snapshot: btoa('snapshot'),
        sequenceNum: 20,
        signerDeviceId: 'device-2',
        revision: 'rev-1'
      })

      res = await app.request(
        'http://localhost/sync/crdt/snapshot/bad%20note',
        { method: 'GET' },
        env,
        executionCtx
      )
      expect(res.status).toBe(400)
    })
  })

  // ==========================================================================
  // Sync-type negotiation
  // ==========================================================================

  describe('sync-type negotiation', () => {
    // A client that predates negotiation sends no header. It must never be
    // served a type its z.enum would reject — that drops a whole pull page.
    it('serves the frozen legacy list to a header-less client', async () => {
      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
        ...LEGACY_RECORD_SYNC_ITEM_TYPES
      ])
    })

    it('narrows to the declared types when the header is sent', async () => {
      // #when
      await app.request(
        '/sync/changes',
        { method: 'GET', headers: { 'X-Memry-Sync-Types': 'note,task' } },
        env,
        executionCtx
      )

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', [
        'note',
        'task'
      ])
    })

    it('passes negotiated types to pullItems', async () => {
      // #when
      await app.request(
        '/sync/pull',
        {
          ...jsonPost('/sync/pull', { itemIds: [VALID_UUID] }),
          headers: { 'Content-Type': 'application/json', 'X-Memry-Sync-Types': 'note' }
        },
        env,
        executionCtx
      )

      // #then
      expect(pullItems).toHaveBeenCalledWith(
        env.DB,
        env.STORAGE,
        'user-1',
        [VALID_UUID],
        'vault-1',
        ['note']
      )
    })

    it('applies negotiation on the /sync/records/* mount too', async () => {
      // #when
      await app.request(
        '/sync/records/changes',
        { method: 'GET', headers: { 'X-Memry-Sync-Types': 'note' } },
        env,
        executionCtx
      )

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined, 'vault-1', ['note'])
    })
  })
})

// ============================================================================
// CRDT rate limit wiring
//
// The limiter itself is mocked out in this file, so its behaviour is covered in
// middleware/rate-limit.test.ts. What is asserted here is the wiring: which
// bucket key each CRDT route was built with, and how big the pull budget is.
// ============================================================================

describe('CRDT rate limit wiring', () => {
  const optionsFor = (keyPrefix: string) =>
    rateLimiterOptions.find((o) => o.keyPrefix === keyPrefix)

  it('keys every CRDT limiter by device, not by account', () => {
    // #then — a second device on one account is normal use, not contention
    for (const keyPrefix of ['crdt_push', 'crdt_pull', 'crdt_batch_pull']) {
      expect(optionsFor(keyPrefix)?.identifier).toBe(deviceIdentifier)
    }
  })

  it('gives the CRDT pull budget room for a whole-vault body sweep', () => {
    // #then — two GETs per note, so ~242 requests for a 121-note vault
    expect(optionsFor('crdt_pull')).toMatchObject({ maxRequests: 600, windowSeconds: 60 })
  })

  it('leaves the non-CRDT limiters keyed by the default user/IP chain', () => {
    // #then — out of scope for this change
    expect(optionsFor('sync_pull')?.identifier).toBeUndefined()
    expect(optionsFor('sync_push')?.identifier).toBeUndefined()
  })
})
