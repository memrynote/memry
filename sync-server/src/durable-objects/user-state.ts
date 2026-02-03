/**
 * T090, T091, T092: UserSyncState Durable Object
 *
 * Manages real-time WebSocket connections for cross-device sync.
 * Each instance handles all connected devices for a single user.
 * Uses WebSocket Hibernation API for cost efficiency.
 *
 * Note: DurableObject and DurableObjectState types are ambient globals
 * from @cloudflare/workers-types (configured in tsconfig.json).
 */

type ClientMessage = { type: 'ping' } | { type: 'subscribe'; itemTypes?: string[] }

type ServerMessage =
  | { type: 'pong' }
  | { type: 'connected'; deviceId: string }
  | { type: 'changes'; cursor: number; count: number }
  | { type: 'crdt'; noteIds: string[] }
  | { type: 'error'; code: string; message: string }

interface ConnectionMeta {
  deviceId: string
  connectedAt: number
  subscribedTypes?: string[]
}

interface BroadcastRequest {
  type: 'changes' | 'crdt'
  cursor?: number
  count?: number
  noteIds?: string[]
  excludeDeviceId?: string
}

export class UserSyncState implements DurableObject {
  private state: DurableObjectState

  constructor(state: DurableObjectState, env: unknown) {
    void env
    this.state = state
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
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const deviceId = url.searchParams.get('deviceId')
    if (!deviceId) {
      return new Response(JSON.stringify({ error: 'Missing deviceId parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    const meta: ConnectionMeta = {
      deviceId,
      connectedAt: Date.now()
    }

    this.state.acceptWebSocket(server, [deviceId])

    // Connection metadata is stored in durable storage (not transiently) because
    // the WebSocket Hibernation API may evict and recreate the DO. When waking
    // from hibernation, the DO needs to restore device mappings for broadcast filtering.
    await this.state.storage.put(`connection:${deviceId}`, meta)

    const connectedMessage: ServerMessage = {
      type: 'connected',
      deviceId
    }
    server.send(JSON.stringify(connectedMessage))

    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    if (!this.isValidBroadcastRequest(body)) {
      return new Response(
        JSON.stringify({
          error:
            'Invalid broadcast payload: requires type ("changes" or "crdt") with appropriate fields'
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    const { type, excludeDeviceId } = body

    let message: ServerMessage
    if (type === 'changes') {
      message = {
        type: 'changes',
        cursor: body.cursor!,
        count: body.count!
      }
    } else {
      message = {
        type: 'crdt',
        noteIds: body.noteIds!
      }
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
      headers: { 'Content-Type': 'application/json' }
    })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return

    let parsed: ClientMessage
    try {
      parsed = JSON.parse(message) as ClientMessage
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

  private isValidBroadcastRequest(body: unknown): body is BroadcastRequest {
    if (typeof body !== 'object' || body === null) return false
    const obj = body as Record<string, unknown>

    if (obj.type === 'changes') {
      return typeof obj.cursor === 'number' && typeof obj.count === 'number'
    }

    if (obj.type === 'crdt') {
      return Array.isArray(obj.noteIds) && obj.noteIds.every((id) => typeof id === 'string')
    }

    return false
  }
}
