/**
 * T090, T091, T092: UserSyncState Durable Object
 *
 * Manages real-time WebSocket connections for cross-device sync.
 * Each instance handles all connected devices for a single user.
 * Uses WebSocket Hibernation API for cost efficiency.
 */

import { verifyAccessToken, type JWTPayload } from '../services/auth'

type ClientMessage =
  | { type: 'ping' }
  | { type: 'subscribe'; itemTypes?: string[] }

type ServerMessage =
  | { type: 'pong' }
  | { type: 'connected'; deviceId: string }
  | { type: 'changes'; cursor: number; count: number }
  | { type: 'error'; code: string; message: string }

interface ConnectionMeta {
  deviceId: string
  connectedAt: number
  subscribedTypes?: string[]
}

interface BroadcastRequest {
  type: 'changes'
  cursor: number
  count: number
  excludeDeviceId?: string
}

export class UserSyncState implements DurableObject {
  private state: DurableObjectState
  private env: { JWT_SECRET: string }

  constructor(state: DurableObjectState, env: { JWT_SECRET: string }) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      return this.handleBroadcast(request)
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request)
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const token = url.searchParams.get('token') ?? this.extractBearerToken(request)

    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing authentication token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let payload: JWTPayload
    try {
      payload = await verifyAccessToken(token, this.env.JWT_SECRET)
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    const meta: ConnectionMeta = {
      deviceId: payload.deviceId,
      connectedAt: Date.now(),
    }

    this.state.acceptWebSocket(server, [payload.deviceId])

    await this.state.storage.put(`connection:${payload.deviceId}`, meta)

    const connectedMessage: ServerMessage = {
      type: 'connected',
      deviceId: payload.deviceId,
    }
    server.send(JSON.stringify(connectedMessage))

    return new Response(null, { status: 101, webSocket: client })
  }

  private extractBearerToken(request: Request): string | null {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader) return null
    const match = authHeader.match(/^Bearer\s+(.+)$/i)
    return match ? match[1] : null
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    let body: BroadcastRequest
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { cursor, count, excludeDeviceId } = body

    const message: ServerMessage = {
      type: 'changes',
      cursor,
      count,
    }

    const sockets = this.state.getWebSockets()
    let sentCount = 0

    for (const socket of sockets) {
      const tags = this.state.getTags(socket)
      const deviceId = tags[0]

      if (excludeDeviceId && deviceId === excludeDeviceId) {
        continue
      }

      try {
        socket.send(JSON.stringify(message))
        sentCount++
      } catch {
        // Socket may be closed; hibernation API handles cleanup
      }
    }

    return new Response(JSON.stringify({ sent: sentCount }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return

    let parsed: ClientMessage
    try {
      parsed = JSON.parse(message)
    } catch {
      this.sendError(ws, 'INVALID_MESSAGE', 'Invalid JSON')
      return
    }

    switch (parsed.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage))
        break

      case 'subscribe':
        await this.handleSubscribe(ws, parsed.itemTypes)
        break

      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE', 'Unknown message type')
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    void code
    void reason

    const tags = this.state.getTags(ws)
    const deviceId = tags[0]

    if (deviceId) {
      await this.state.storage.delete(`connection:${deviceId}`)
    }

    ws.close()
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    void error

    const tags = this.state.getTags(ws)
    const deviceId = tags[0]

    if (deviceId) {
      await this.state.storage.delete(`connection:${deviceId}`)
    }

    ws.close()
  }

  private async handleSubscribe(ws: WebSocket, itemTypes?: string[]): Promise<void> {
    const tags = this.state.getTags(ws)
    const deviceId = tags[0]

    if (!deviceId) return

    const meta = await this.state.storage.get<ConnectionMeta>(`connection:${deviceId}`)
    if (meta) {
      meta.subscribedTypes = itemTypes
      await this.state.storage.put(`connection:${deviceId}`, meta)
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    const errorMessage: ServerMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(errorMessage))
  }
}
