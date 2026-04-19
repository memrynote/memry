import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockWebSocket } from '../__mocks__/cloudflare-workers'
import { ErrorCodes } from '../lib/errors'
import { isVersionBelow } from './user-sync-state'

const hoisted = vi.hoisted(() => ({
  verifyAccessTokenMock: vi.fn(async () => ({
    userId: 'user-1',
    deviceId: 'device-1',
    exp: Math.floor(Date.now() / 1000) + 900
  }))
}))

vi.mock('../lib/jwt-verify', () => ({
  verifyAccessToken: hoisted.verifyAccessTokenMock
}))

import { UserSyncState } from './user-sync-state'

function createMockDB(revoked_at: number | null = null, revokedDeviceIds: string[] = []) {
  return {
    prepare: () => ({
      bind: (..._args: unknown[]) => ({
        first: async () => ({ revoked_at }),
        all: async () => ({ results: revokedDeviceIds.map((id) => ({ id })) })
      })
    })
  }
}

function createDO(
  dbOverride?: ReturnType<typeof createMockDB>,
  envOverrides?: Record<string, string>
) {
  const env = {
    JWT_PUBLIC_KEY: 'test-pem',
    DB: dbOverride ?? createMockDB(),
    MIN_APP_VERSION: '1.0.0',
    ...envOverrides
  }
  return new UserSyncState({} as DurableObjectState, env as never)
}

function getCtx(doObj: UserSyncState) {
  return (doObj as unknown as { ctx: UserSyncState['ctx'] }).ctx
}

function connectRequest(token = 'valid-token', appVersion = '1.0.0'): Request {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Upgrade: 'websocket'
  }
  if (appVersion) headers['X-App-Version'] = appVersion
  return new Request('https://do.internal/connect', { headers })
}

function broadcastRequest(excludeDeviceId: string, cursor: number): Request {
  return new Request('https://do.internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ excludeDeviceId, cursor })
  })
}

describe('UserSyncState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.verifyAccessTokenMock.mockResolvedValue({
      userId: 'user-1',
      deviceId: 'device-1',
      exp: Math.floor(Date.now() / 1000) + 900
    })
  })

  describe('/connect', () => {
    it('returns 101 with valid token and accepts WebSocket', async () => {
      // #given
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(connectRequest())

      // #then
      expect(res.status).toBe(101)
      expect((res as unknown as { webSocket: unknown }).webSocket).toBeDefined()
    })

    it('returns 401 for missing Authorization header', async () => {
      // #given
      const doObj = createDO()
      const req = new Request('https://do.internal/connect')

      // #when
      const res = await doObj.fetch(req)

      // #then
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe(ErrorCodes.AUTH_INVALID_TOKEN)
    })

    it('returns 401 for invalid token', async () => {
      // #given
      hoisted.verifyAccessTokenMock.mockRejectedValue(new Error('invalid'))
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(connectRequest('bad-token'))

      // #then
      expect(res.status).toBe(401)
    })

    it('returns 403 when device is revoked', async () => {
      // #given
      const doObj = createDO(createMockDB(1700000000))

      // #when
      const res = await doObj.fetch(connectRequest())

      // #then
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe(ErrorCodes.AUTH_DEVICE_REVOKED)
    })

    it('returns 403 when device not found in DB', async () => {
      // #given
      const db = {
        prepare: () => ({
          bind: () => ({ first: async () => null, all: async () => ({ results: [] }) })
        })
      }
      const doObj = createDO(db as unknown as ReturnType<typeof createMockDB>)

      // #when
      const res = await doObj.fetch(connectRequest())

      // #then
      expect(res.status).toBe(403)
    })

    it('closes existing connection for same device on reconnect', async () => {
      // #given
      const doObj = createDO()
      await doObj.fetch(connectRequest())

      const ctx = getCtx(doObj)
      const existingSockets = ctx.getWebSockets('device:device-1')
      expect(existingSockets.length).toBe(1)
      const firstSocket = existingSockets[0] as unknown as MockWebSocket

      // #when
      await doObj.fetch(connectRequest())

      // #then
      expect(firstSocket.closeCalled).toBe(true)
      expect(firstSocket.closeCode).toBe(4001)
    })
  })

  describe('/broadcast', () => {
    it('sends changes_available to all except excluded device', async () => {
      // #given
      const doObj = createDO()

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-1',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('token-1'))

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-2',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('token-2'))

      // #when
      const res = await doObj.fetch(broadcastRequest('device-1', 42))
      const body = (await res.json()) as { sent: number }

      // #then
      expect(body.sent).toBe(1)

      const ctx = getCtx(doObj)
      const device2Sockets = ctx.getWebSockets('device:device-2')
      const ws2 = device2Sockets[0] as unknown as MockWebSocket
      expect(ws2.sentMessages).toContainEqual(
        JSON.stringify({ type: 'changes_available', payload: { cursor: 42 } })
      )

      const device1Sockets = ctx.getWebSockets('device:device-1')
      const ws1 = device1Sockets[0] as unknown as MockWebSocket
      const changesMessages = ws1.sentMessages.filter((m) => m.includes('changes_available'))
      expect(changesMessages).toHaveLength(0)
    })

    it('returns sent: 0 when no connections exist', async () => {
      // #given
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(broadcastRequest('device-1', 10))
      const body = (await res.json()) as { sent: number }

      // #then
      expect(body.sent).toBe(0)
    })

    it('carries sourceId through to payload for calendar push fan-out', async () => {
      // #given a single connected socket for the user
      const doObj = createDO()
      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-1',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('token-1'))

      // #when a broadcast carries type + sourceId but no cursor/noteId
      const res = await doObj.fetch(
        new Request('https://do.internal/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            excludeDeviceId: 'device-none',
            type: 'calendar_changes_available',
            sourceId: 'google-calendar:abc'
          })
        })
      )
      const body = (await res.json()) as { sent: number }

      // #then the connected socket receives a calendar_changes_available with sourceId
      expect(body.sent).toBe(1)
      const ctx = getCtx(doObj)
      const sockets = ctx.getWebSockets('device:device-1')
      const ws = sockets[0] as unknown as MockWebSocket
      expect(ws.sentMessages).toContainEqual(
        JSON.stringify({
          type: 'calendar_changes_available',
          payload: { sourceId: 'google-calendar:abc' }
        })
      )
    })
  })

  describe('webSocketMessage (rate limiting)', () => {
    it('closes connection after exceeding rate limit', async () => {
      // #given
      const doObj = createDO()
      await doObj.fetch(connectRequest())

      const ctx = getCtx(doObj)
      const sockets = ctx.getWebSockets('device:device-1')
      const ws = sockets[0] as unknown as WebSocket

      // #when - send 101 messages (limit is 100)
      for (let i = 0; i <= 100; i++) {
        doObj.webSocketMessage(ws)
      }

      // #then
      const mockWs = ws as unknown as MockWebSocket
      expect(mockWs.closeCalled).toBe(true)
      expect(mockWs.closeCode).toBe(4008)

      const errorMsg = mockWs.sentMessages.find((m) => m.includes(ErrorCodes.WS_RATE_LIMITED))
      expect(errorMsg).toBeDefined()
    })
  })

  describe('alarm', () => {
    it('closes expired token connections and keeps valid ones', async () => {
      // #given
      const doObj = createDO()

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-expired',
        exp: Math.floor(Date.now() / 1000) - 60
      })
      await doObj.fetch(connectRequest('expired-token'))

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-valid',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('valid-token'))

      // #when
      await doObj.alarm()

      // #then
      const ctx = getCtx(doObj)
      const expiredSockets = ctx.getWebSockets('device:device-expired')
      const expiredWs = expiredSockets[0] as unknown as MockWebSocket
      expect(expiredWs.closeCalled).toBe(true)
      expect(expiredWs.closeCode).toBe(4003)

      const validSockets = ctx.getWebSockets('device:device-valid')
      const validWs = validSockets[0] as unknown as MockWebSocket
      expect(validWs.closeCalled).toBe(false)
    })

    it('reschedules alarm when valid connections remain', async () => {
      // #given
      const doObj = createDO()
      await doObj.fetch(connectRequest())

      // #when
      await doObj.alarm()

      // #then
      const ctx = getCtx(doObj)
      const alarm = await ctx.storage.getAlarm()
      expect(alarm).not.toBeNull()
    })

    it('closes sockets for revoked devices as fallback (S-M3)', async () => {
      // #given — device connects OK, then gets revoked in DB without /revoke-device call
      const doObj = createDO(createMockDB(null, ['device-1']))
      await doObj.fetch(connectRequest())

      const ctx = getCtx(doObj)
      const sockets = ctx.getWebSockets('device:device-1')
      const ws = sockets[0] as unknown as MockWebSocket

      // #when — alarm fires, fallback revocation check runs
      await doObj.alarm()

      // #then
      expect(ws.closeCalled).toBe(true)
      expect(ws.closeCode).toBe(4004)
      const revokedMsg = ws.sentMessages.find((m) => m.includes(ErrorCodes.AUTH_DEVICE_REVOKED))
      expect(revokedMsg).toBeDefined()
    })

    it('keeps non-revoked sockets open during alarm revocation check', async () => {
      // #given — two devices: one revoked, one clean
      const doObj = createDO(createMockDB(null, ['device-revoked']))

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-revoked',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('token-a'))

      hoisted.verifyAccessTokenMock.mockResolvedValueOnce({
        userId: 'user-1',
        deviceId: 'device-clean',
        exp: Math.floor(Date.now() / 1000) + 900
      })
      await doObj.fetch(connectRequest('token-b'))

      const ctx = getCtx(doObj)
      const revokedWs = ctx.getWebSockets('device:device-revoked')[0] as unknown as MockWebSocket
      const cleanWs = ctx.getWebSockets('device:device-clean')[0] as unknown as MockWebSocket

      // #when
      await doObj.alarm()

      // #then
      expect(revokedWs.closeCalled).toBe(true)
      expect(revokedWs.closeCode).toBe(4004)
      expect(cleanWs.closeCalled).toBe(false)
    })
  })

  describe('/revoke-device', () => {
    function revokeDeviceRequest(deviceId: string): Request {
      return new Request('https://do.internal/revoke-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId })
      })
    }

    it('immediately closes WebSocket for revoked device', async () => {
      // #given
      const doObj = createDO()
      await doObj.fetch(connectRequest())

      const ctx = getCtx(doObj)
      const sockets = ctx.getWebSockets('device:device-1')
      const ws = sockets[0] as unknown as MockWebSocket

      // #when
      const res = await doObj.fetch(revokeDeviceRequest('device-1'))
      const body = (await res.json()) as { closed: number }

      // #then
      expect(body.closed).toBe(1)
      expect(ws.closeCalled).toBe(true)
      expect(ws.closeCode).toBe(4004)
      const revokedMsg = ws.sentMessages.find((m) => m.includes(ErrorCodes.AUTH_DEVICE_REVOKED))
      expect(revokedMsg).toBeDefined()
    })

    it('returns closed: 0 when device has no active connection', async () => {
      // #given
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(revokeDeviceRequest('nonexistent-device'))
      const body = (await res.json()) as { closed: number }

      // #then
      expect(body.closed).toBe(0)
    })
  })

  describe('/connect — version validation (T237)', () => {
    it('returns 426 when X-App-Version header missing (T237e)', async () => {
      // #given
      const doObj = createDO()
      const req = new Request('https://do.internal/connect', {
        headers: { Authorization: 'Bearer valid-token', Upgrade: 'websocket' }
      })

      // #when
      const res = await doObj.fetch(req)

      // #then
      expect(res.status).toBe(426)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe(ErrorCodes.SYNC_VERSION_INCOMPATIBLE)
    })

    it('returns 426 when version below minimum (T237f)', async () => {
      // #given
      const doObj = createDO(undefined, { MIN_APP_VERSION: '2.0.0' })

      // #when
      const res = await doObj.fetch(connectRequest('valid-token', '1.9.9'))

      // #then
      expect(res.status).toBe(426)
      const body = (await res.json()) as { error: { code: string; minVersion?: string } }
      expect(body.error.code).toBe(ErrorCodes.SYNC_VERSION_INCOMPATIBLE)
      expect(body.error.minVersion).toBe('2.0.0')
    })

    it('accepts connection when version equals minimum (T237g)', async () => {
      // #given
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(connectRequest('valid-token', '1.0.0'))

      // #then
      expect(res.status).toBe(101)
    })

    it('accepts connection when version above minimum (T237h)', async () => {
      // #given
      const doObj = createDO()

      // #when
      const res = await doObj.fetch(connectRequest('valid-token', '2.5.3'))

      // #then
      expect(res.status).toBe(101)
    })
  })

  describe('isVersionBelow (T237i)', () => {
    it('returns true when major is lower', () => {
      expect(isVersionBelow('1.0.0', '2.0.0')).toBe(true)
    })

    it('returns true when minor is lower', () => {
      expect(isVersionBelow('1.1.0', '1.2.0')).toBe(true)
    })

    it('returns true when patch is lower', () => {
      expect(isVersionBelow('1.0.1', '1.0.2')).toBe(true)
    })

    it('returns false when versions are equal', () => {
      expect(isVersionBelow('1.0.0', '1.0.0')).toBe(false)
    })

    it('returns false when version is above minimum', () => {
      expect(isVersionBelow('2.0.0', '1.0.0')).toBe(false)
    })

    it('handles two-segment versions', () => {
      expect(isVersionBelow('1.0', '1.1')).toBe(true)
      expect(isVersionBelow('1.1', '1.0')).toBe(false)
    })
  })

  it('returns 404 for unknown paths', async () => {
    // #given
    const doObj = createDO()

    // #when
    const res = await doObj.fetch(new Request('https://do.internal/unknown'))

    // #then
    expect(res.status).toBe(404)
  })
})
