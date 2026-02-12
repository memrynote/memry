import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockWebSocket } from '../__mocks__/cloudflare-workers'
import { ErrorCodes } from '../lib/errors'

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

function createDO() {
  const env = { JWT_PUBLIC_KEY: 'test-pem' }
  return new UserSyncState({} as DurableObjectState, env as never)
}

function getCtx(doObj: UserSyncState) {
  return (doObj as unknown as { ctx: UserSyncState['ctx'] }).ctx
}

function connectRequest(token = 'valid-token'): Request {
  return new Request('https://do.internal/connect', {
    headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' }
  })
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
