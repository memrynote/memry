import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { z } from 'zod'
import { createLogger } from '../lib/logger'
import { createPinnedAgent, CertificatePinningError } from './certificate-pinning'

const log = createLogger('WebSocket')

const HEARTBEAT_TIMEOUT_MS = 31_000
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 1_000
const RECONNECT_JITTER_MS = 500
const PING_INTERVAL_MS = 25_000
const HTTP_UNAUTHORIZED = 401
const HTTP_UPGRADE_REQUIRED = 426
const MAX_WEBSOCKET_MANAGER_LISTENERS = 50

const WebSocketMessageSchema = z.object({
  type: z.enum([
    'changes_available',
    'crdt_updated',
    'heartbeat',
    'error',
    'linking_request',
    'linking_approved'
  ]),
  payload: z.record(z.string(), z.unknown()).optional()
})

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>

export const CLOSE_CODE_DEVICE_REVOKED = 4004
export const CLOSE_CODE_VERSION_INCOMPATIBLE = 4009

export interface WebSocketManagerDeps {
  getAccessToken: () => Promise<string | null>
  getAppVersion: () => string
  isOnline: () => boolean
  serverUrl: string
}

export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldBeConnected = false
  private _connected = false
  private authFailed = false
  private versionRejected = false
  private certPinFailed = false
  private deps: WebSocketManagerDeps

  constructor(deps: WebSocketManagerDeps) {
    super()
    this.setMaxListeners(MAX_WEBSOCKET_MANAGER_LISTENERS)
    this.deps = deps
    this.on('error', (err: Error) => {
      log.warn('WebSocket error event', { message: err.message })
    })
  }

  get connected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    if (this.certPinFailed) {
      log.warn('Connect blocked: certificate pin failure requires app restart')
      return
    }

    this.shouldBeConnected = true
    this.authFailed = false
    this.versionRejected = false

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
      return
    }

    const wsUrl = this.deps.serverUrl.replace(/^http/, 'ws') + '/sync/ws'

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-App-Version': this.deps.getAppVersion()
      },
      agent: wsUrl.startsWith('wss://') ? createPinnedAgent() : undefined
    })

    this.ws = ws

    ws.on('open', () => {
      this._connected = true
      this.reconnectAttempt = 0
      this.resetHeartbeat()
      this.startPing()
      log.info('WebSocket connected', { url: wsUrl })
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
        if (text === 'pong') return
        const result = WebSocketMessageSchema.safeParse(JSON.parse(text))
        if (!result.success) {
          this.emit('error', new Error('Invalid WebSocket message format'))
          return
        }
        log.debug('WebSocket message received', { type: result.data.type })
        this.emit('message', result.data)
      } catch {
        this.emit('error', new Error('Failed to parse WebSocket message'))
      }
    })

    ws.on('ping', () => {
      this.resetHeartbeat()
    })

    ws.on('close', (code: number, reason: Buffer) => {
      log.info('WebSocket disconnected', { code, reason: reason.toString() })
      if (code === CLOSE_CODE_DEVICE_REVOKED) {
        this.cleanup()
        this.shouldBeConnected = false
        this.emit('device_revoked')
        return
      }
      if (code === CLOSE_CODE_VERSION_INCOMPATIBLE) {
        this.versionRejected = true
        this.cleanup()
        this.emit('version_rejected', reason.toString())
        return
      }
      this.cleanup()
      this.emit('disconnected')
      if (this.shouldBeConnected) {
        this.scheduleReconnect()
      }
    })

    ws.on('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode
      if (statusCode === HTTP_UNAUTHORIZED) {
        this.authFailed = true
        log.warn('WebSocket auth rejected during handshake', { statusCode })
      }

      if (statusCode === HTTP_UPGRADE_REQUIRED) {
        this.versionRejected = true
        const reason = response.statusMessage || `HTTP ${statusCode}`
        this.emit('version_rejected', reason)
      }
    })

    ws.on('error', (err: Error) => {
      log.warn('WebSocket error', { message: err.message })
      if (err instanceof CertificatePinningError) {
        this.certPinFailed = true
        this.shouldBeConnected = false
        log.error('SECURITY: Certificate pin verification failed', {
          actualHash: err.actualHash,
          expectedCount: err.expectedHashes.length
        })
        this.cleanup()
        this.emit('certificate_pin_failed', {
          hostname: err.message,
          actualHash: err.actualHash,
          expectedHashes: err.expectedHashes
        })
        return
      }
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
    this.stopPing()
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate()
      }
      this.ws = null
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping')
      }
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
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
    if (!this.shouldBeConnected || this.authFailed || this.versionRejected || this.certPinFailed)
      return
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
