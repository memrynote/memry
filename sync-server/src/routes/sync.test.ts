import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes, errorHandler } from '../lib/errors'
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
  processPushItem: vi.fn().mockResolvedValue({ accepted: true, serverCursor: 1 }),
  pullItems: vi.fn().mockResolvedValue([]),
  getItem: vi.fn().mockResolvedValue({
    itemId: '550e8400-e29b-41d4-a716-446655440000',
    type: 'note',
    version: 1,
    payload: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
    serverCursor: 1
  }),
  updateDeviceCursor: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/device', () => ({
  updateDevice: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    await next()
  })
}))

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn().mockReturnValue(
    vi.fn().mockImplementation(async (_c: any, next: any) => {
      await next()
    })
  )
}))

vi.mock('../services/quota', () => ({
  checkQuota: vi.fn().mockResolvedValue(undefined)
}))

import { sync } from './sync'
import {
  getSyncStatus,
  getManifest,
  getChanges,
  processPushItem,
  pullItems,
  getItem,
  updateDeviceCursor
} from '../services/sync'
import { authMiddleware } from '../middleware/auth'
import { updateDevice } from '../services/device'

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
      expect(getSyncStatus).toHaveBeenCalledWith(env.DB, 'user-1', 'device-1')
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

    it('should pass userId to getManifest', async () => {
      // #when
      await app.request('/sync/manifest', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getManifest).toHaveBeenCalledWith(env.DB, 'user-1')
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
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 5, 10)
    })

    it('should default cursor to 0 when omitted', async () => {
      // #when
      await app.request('/sync/changes', { method: 'GET' }, env, executionCtx)

      // #then
      expect(getChanges).toHaveBeenCalledWith(env.DB, 'user-1', 0, undefined)
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
      expect(updateDeviceCursor).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', 5)
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
      vi.mocked(processPushItem).mockResolvedValueOnce({
        accepted: false,
        reason: 'VERSION_CONFLICT'
      })
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
      expect(updateDeviceCursor).toHaveBeenCalledWith(env.DB, 'device-1', 'user-1', 1)
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
      vi.mocked(processPushItem).mockResolvedValueOnce({
        accepted: false,
        reason: 'VERSION_CONFLICT'
      })
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
      expect(pullItems).toHaveBeenCalledWith(env.DB, env.STORAGE, 'user-1', [VALID_UUID])
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
      expect(getItem).toHaveBeenCalledWith(env.DB, env.STORAGE, 'user-1', VALID_UUID)
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
})
