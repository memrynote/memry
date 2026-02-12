import WebSocket from 'ws'
import { EventEmitter } from 'events'

const HEARTBEAT_TIMEOUT_MS = 31_000
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 1_000
const RECONNECT_JITTER_MS = 500

export interface WebSocketMessage {
  type: 'changes_available' | 'heartbeat' | 'error'
  payload?: Record<string, unknown>
}

export interface WebSocketManagerDeps {
  getAccessToken: () => Promise<string | null>
  isOnline: () => boolean
  serverUrl: string
}

export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldBeConnected = false
  private _connected = false
  private deps: WebSocketManagerDeps

  constructor(deps: WebSocketManagerDeps) {
    super()
    this.deps = deps
  }

  get connected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    this.shouldBeConnected = true

    if (this._connected || this.ws) {
      return
    }

    if (!this.deps.isOnline()) {
      this.scheduleReconnect()
      return
    }

    const token = await this.deps.getAccessToken()
    if (!token) {
      this.emit('error', new Error('No access token available'))
      this.scheduleReconnect()
      return
    }

    const wsUrl = this.deps.serverUrl.replace(/^http/, 'ws') + '/sync/ws'

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` }
    })

    this.ws = ws

    ws.on('open', () => {
      this._connected = true
      this.reconnectAttempt = 0
      this.resetHeartbeat()
      this.emit('connected')
    })

    ws.on('message', (raw: WebSocket.Data) => {
      this.resetHeartbeat()
      try {
        let text: string
        if (typeof raw === 'string') {
          text = raw
        } else if (Buffer.isBuffer(raw)) {
          text = raw.toString('utf-8')
        } else if (raw instanceof ArrayBuffer) {
          text = Buffer.from(raw).toString('utf-8')
        } else {
          text = Buffer.concat(raw).toString('utf-8')
        }
        const parsed = JSON.parse(text) as WebSocketMessage
        this.emit('message', parsed)
      } catch {
        this.emit('error', new Error('Failed to parse WebSocket message'))
      }
    })

    ws.on('ping', () => {
      this.resetHeartbeat()
    })

    ws.on('close', () => {
      this.cleanup()
      this.emit('disconnected')
      if (this.shouldBeConnected) {
        this.scheduleReconnect()
      }
    })

    ws.on('error', (err: Error) => {
      this.emit('error', err)
    })
  }

  disconnect(): void {
    this.shouldBeConnected = false
    this.clearReconnectTimer()
    this.cleanup()
    this.emit('disconnected')
  }

  private cleanup(): void {
    this._connected = false
    this.clearHeartbeat()
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate()
      }
      this.ws = null
    }
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws) {
        this.ws.terminate()
      }
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldBeConnected) return
    this.clearReconnectTimer()

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt) +
        Math.random() * RECONNECT_JITTER_MS,
      MAX_RECONNECT_DELAY_MS
    )

    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldBeConnected && this.deps.isOnline()) {
        void this.connect()
      } else if (this.shouldBeConnected) {
        this.scheduleReconnect()
      }
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
