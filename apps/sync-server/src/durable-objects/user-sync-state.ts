import { DurableObject } from 'cloudflare:workers'

import { ErrorCodes } from '../lib/errors'
import { verifyAccessToken } from '../lib/jwt-verify'
import type { Bindings } from '../types'

interface WsAttachment {
  deviceId: string
  tokenExp: number
  connectedAt: number
  rateLimitWindow: number
  rateLimitCount: number
}

const RATE_LIMIT_MAX = 100
const RATE_LIMIT_WINDOW_SECONDS = 10
const ALARM_INTERVAL_MS = 60_000
const CLOSE_CODE_REPLACED = 4001
const CLOSE_CODE_TOKEN_EXPIRED = 4003
const CLOSE_CODE_DEVICE_REVOKED = 4004
const CLOSE_CODE_RATE_LIMITED = 4008
const CLOSE_CODE_VERSION_INCOMPATIBLE = 4009

export function isVersionBelow(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const [aMaj, aMin = 0, aPat = 0] = parse(version)
  const [bMaj, bMin = 0, bPat = 0] = parse(minimum)
  if (aMaj !== bMaj) return aMaj < bMaj
  if (aMin !== bMin) return aMin < bMin
  return aPat < bPat
}

export class UserSyncState extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/connect':
        return this.handleConnect(request)
      case '/broadcast':
        return this.handleBroadcast(request)
      case '/revoke-device':
        return this.handleRevokeDevice(request)
      case '/notify-linking':
        return this.handleNotifyLinking(request)
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  private async handleConnect(request: Request): Promise<Response> {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return Response.json(
        { error: { code: ErrorCodes.AUTH_INVALID_TOKEN, message: 'Missing token' } },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    let claims: { userId: string; deviceId: string; exp: number }
    try {
      claims = await verifyAccessToken(token, this.env.JWT_PUBLIC_KEY)
    } catch {
      return Response.json(
        { error: { code: ErrorCodes.AUTH_INVALID_TOKEN, message: 'Invalid token' } },
        { status: 401 }
      )
    }

    const appVersion = request.headers.get('X-App-Version')
    if (!appVersion) {
      return Response.json(
        {
          error: {
            code: ErrorCodes.SYNC_VERSION_INCOMPATIBLE,
            message: 'App version header required'
          }
        },
        { status: 426 }
      )
    }
    if (isVersionBelow(appVersion, this.env.MIN_APP_VERSION)) {
      return Response.json(
        {
          error: {
            code: ErrorCodes.SYNC_VERSION_INCOMPATIBLE,
            message: 'App update required',
            minVersion: this.env.MIN_APP_VERSION
          }
        },
        { status: 426 }
      )
    }

    const device = await this.env.DB.prepare(
      'SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?'
    )
      .bind(claims.deviceId, claims.userId)
      .first<{ revoked_at: number | null }>()

    if (!device || device.revoked_at) {
      return Response.json(
        { error: { code: ErrorCodes.AUTH_DEVICE_REVOKED, message: 'Device revoked' } },
        { status: 403 }
      )
    }

    const tag = `device:${claims.deviceId}`
    const existingSockets = this.ctx.getWebSockets(tag)
    for (const existing of existingSockets) {
      existing.close(CLOSE_CODE_REPLACED, 'Replaced by new connection')
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    const attachment: WsAttachment = {
      deviceId: claims.deviceId,
      tokenExp: claims.exp,
      connectedAt: Math.floor(Date.now() / 1000),
      rateLimitWindow: 0,
      rateLimitCount: 0
    }

    this.ctx.acceptWebSocket(server, [tag])
    server.serializeAttachment(attachment)

    await this.scheduleAlarm()

    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const body: {
      excludeDeviceId: string
      cursor?: number
      type?: string
      noteId?: string
      sourceId?: string
    } = await request.json()

    const allSockets = this.ctx.getWebSockets()
    let sent = 0

    const msgType = body.type ?? 'changes_available'
    const payload: Record<string, unknown> = {}
    if (body.cursor !== undefined) payload.cursor = body.cursor
    if (body.noteId) payload.noteId = body.noteId
    if (body.sourceId) payload.sourceId = body.sourceId

    const message = JSON.stringify({ type: msgType, payload })

    for (const ws of allSockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null
      if (attachment?.deviceId === body.excludeDeviceId) continue

      try {
        ws.send(message)
        sent++
      } catch {
        // socket may have closed between getWebSockets and send
      }
    }

    return Response.json({ sent })
  }

  private async handleRevokeDevice(request: Request): Promise<Response> {
    const body: { deviceId: string } = await request.json()

    const tag = `device:${body.deviceId}`
    const sockets = this.ctx.getWebSockets(tag)
    let closed = 0

    for (const ws of sockets) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { code: ErrorCodes.AUTH_DEVICE_REVOKED, message: 'Device has been revoked' }
          })
        )
        ws.close(CLOSE_CODE_DEVICE_REVOKED, 'Device revoked')
        closed++
      } catch {
        // socket may already be closed
      }
    }

    return Response.json({ closed })
  }

  private async handleNotifyLinking(request: Request): Promise<Response> {
    const body: {
      type: string
      targetDeviceId: string
      payload: Record<string, unknown>
    } = await request.json()

    const tag = `device:${body.targetDeviceId}`
    const sockets = this.ctx.getWebSockets(tag)

    const message = JSON.stringify({
      type: body.type,
      payload: body.payload
    })

    let sent = 0
    for (const ws of sockets) {
      try {
        ws.send(message)
        sent++
      } catch {
        // socket may have closed
      }
    }

    return Response.json({ sent })
  }

  webSocketMessage(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as WsAttachment | null
    if (!attachment) {
      ws.close(1011, 'Missing attachment')
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS)

    if (attachment.rateLimitWindow !== windowStart) {
      attachment.rateLimitWindow = windowStart
      attachment.rateLimitCount = 1
    } else {
      attachment.rateLimitCount++
    }

    ws.serializeAttachment(attachment)

    if (attachment.rateLimitCount > RATE_LIMIT_MAX) {
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { code: ErrorCodes.WS_RATE_LIMITED, message: 'Rate limit exceeded' }
        })
      )
      ws.close(CLOSE_CODE_RATE_LIMITED, 'Rate limit exceeded')
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'WebSocket error')
    } catch {
      // already closed
    }
  }

  /**
   * Periodic check (every 60s) providing two layers of connection cleanup:
   * 1. Token expiry — closes sockets whose JWT has expired (primary timer)
   * 2. Revocation fallback — batch-queries D1 for revoked devices among active sockets.
   *    The primary revocation path is /revoke-device which closes sockets instantly;
   *    this alarm catch is defense-in-depth if that call failed (max 60s window).
   */

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const allSockets = this.ctx.getWebSockets()
    const activeSockets: WebSocket[] = []

    for (const ws of allSockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null
      if (!attachment) continue

      if (attachment.tokenExp <= now) {
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              payload: { code: ErrorCodes.WS_TOKEN_EXPIRED, message: 'Token expired, reconnect' }
            })
          )
        } catch {
          // Socket already closed
        }
        try {
          ws.close(CLOSE_CODE_TOKEN_EXPIRED, 'Token expired')
        } catch {
          // Already closed
        }
      } else {
        activeSockets.push(ws)
      }
    }

    // Defense-in-depth: re-check revocation for remaining sockets.
    // Primary path (/revoke-device) closes instantly; this is a fallback
    // if that call failed (network hiccup, DO unavailable).
    let remaining = activeSockets.length
    const deviceIds = [
      ...new Set(
        activeSockets
          .map((ws) => {
            const att = ws.deserializeAttachment() as WsAttachment | null
            return att?.deviceId
          })
          .filter((id): id is string => Boolean(id))
      )
    ]

    if (deviceIds.length > 0) {
      try {
        const placeholders = deviceIds.map(() => '?').join(',')
        const { results } = await this.env.DB.prepare(
          `SELECT id FROM devices WHERE id IN (${placeholders}) AND revoked_at IS NOT NULL`
        )
          .bind(...deviceIds)
          .all<{ id: string }>()

        const revokedIds = new Set(results.map((r) => r.id))
        for (const ws of activeSockets) {
          const att = ws.deserializeAttachment() as WsAttachment | null
          if (att && revokedIds.has(att.deviceId)) {
            try {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  payload: {
                    code: ErrorCodes.AUTH_DEVICE_REVOKED,
                    message: 'Device has been revoked'
                  }
                })
              )
            } catch {
              // already closed
            }
            try {
              ws.close(CLOSE_CODE_DEVICE_REVOKED, 'Device revoked')
            } catch {
              // already closed
            }
            remaining--
          }
        }
      } catch {
        // D1 query failed; will retry on next alarm cycle
      }
    }

    if (remaining > 0) {
      await this.scheduleAlarm()
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null) return
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }
}
