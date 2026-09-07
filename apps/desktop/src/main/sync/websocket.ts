import WebSocket from 'ws'
import { SYNC_SOCKET_MESSAGE_TYPES } from '@memry/contracts/sync-socket'
import { SyncEventEmitter } from '@memry/sync-client/emitter'
import { z } from 'zod'
import { createLogger } from '../lib/logger'
import { getSharedPinnedAgent, CertificatePinningError } from './certificate-pinning'
import { getSyncVaultHeaders } from './http-client'
import { trackMainEvent } from '../telemetry/track'

const log = createLogger('WebSocket')

const HEARTBEAT_TIMEOUT_MS = 31_000
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 1_000
const RECONNECT_JITTER_MS = 500
const PING_INTERVAL_MS = 25_000
const HTTP_UNAUTHORIZED = 401
const HTTP_UPGRADE_REQUIRED = 426
// Steady state is one listener per event name: the constructor's own 'error'
// logger, plus the SyncEngine's four ('message', 'connected', 'device_revoked',
// 'certificate_pin_failed') attached in start() and removed in stop(). Keeping
// the ceiling at Node's default leaves headroom without hiding an accumulating
// subscriber behind a silent budget. See src/main/sync/emitter-budget.test.ts.
const MAX_WEBSOCKET_MANAGER_LISTENERS = 10

const WebSocketMessageSchema = z.object({
  type: z.enum(SYNC_SOCKET_MESSAGE_TYPES),
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

export class WebSocketManager extends SyncEventEmitter {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldBeConnected = false
  private _connected = false
  private _connectionGeneration = 0
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

  /**
   * Advances once per successful socket open (including the internal
   * reconnects nothing else observes). Read together with `connected` it tells
   * "this is the same socket you saw last time, still up" — so no server
   * broadcast could have been missed in between — apart from "it dropped and
   * came back", which `connected` alone cannot distinguish after the fact.
   */
  get connectionGeneration(): number {
    return this._connectionGeneration
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
      // The only exit from connect() that used to leave nothing armed. The
      // offline branch above schedules a retry, and a socket that gets created
      // hands that job to its own 'close' handler — but a token read that came
      // back empty simply returned, and the reconnect timer that called us has
      // already cleared itself. That latched real-time sync off for the rest of
      // the session, and it latches exactly when it hurts most: /auth/refresh
      // lives on the server this device cannot reach, so an outage that outlasts
      // the access token kills the socket permanently. With no socket there is
      // no `crdt_updated` and no handleWsConnected catch-up, which between them
      // are the only two routes a body-only remote edit has — note bodies never
      // travel in the record change feed.
      //
      // Costs nothing on the wire while it waits: the retry shares the same
      // backoff as every other one, so a token that never returns polls at the
      // 30s ceiling, and each poll is a keychain read. Only a token that is
      // actually near expiry reaches /auth/refresh, and token-manager's own
      // rejection latch and single-flight promise rate-limit that, not us.
      this.scheduleReconnect()
      return
    }

    const wsUrl = this.deps.serverUrl.replace(/^http/, 'ws') + '/sync/ws'
    const vaultHeaders = await getSyncVaultHeaders()

    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-App-Version': this.deps.getAppVersion(),
        ...vaultHeaders
      },
      agent: wsUrl.startsWith('wss://') ? getSharedPinnedAgent() : undefined
    })

    this.ws = ws

    ws.on('open', () => {
      this._connected = true
      this._connectionGeneration++
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
        // warn (not the info line above) so the latch ships to log telemetry;
        // 'version_rejected' has no listener anywhere, so without this event
        // real-time sync dies for the session with no remote trace.
        log.warn('WebSocket closed: server rejected app version — reconnect latched off')
        trackMainEvent('sync_error', {
          surface: 'sync',
          action: 'ws_version_rejected',
          result: 'failed',
          errorCode: 'ws_version_rejected',
          source: 'ws'
        })
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
        // Previously this path had no log line at all.
        log.warn('WebSocket handshake rejected: app version deprecated', { statusCode })
        trackMainEvent('sync_error', {
          surface: 'sync',
          action: 'ws_version_rejected',
          result: 'failed',
          errorCode: 'ws_version_rejected',
          source: 'ws'
        })
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

  /**
   * Push the current access token over the live socket so the server can extend
   * the connection's expiry in place. Called when token-manager refreshes, which
   * happens well before expiry — without it the server drops the socket with
   * WS_TOKEN_EXPIRED and we pay a full reconnect every token lifetime.
   * Best-effort: on failure the socket still expires and reconnects as before.
   */
  async refreshAuth(): Promise<void> {
    if (!this._connected || this.ws?.readyState !== WebSocket.OPEN) return

    try {
      const token = await this.deps.getAccessToken()
      if (!token) return
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
      log.debug('Sent WebSocket auth refresh')
    } catch (err) {
      log.warn('WebSocket auth refresh failed', {
        message: err instanceof Error ? err.message : String(err)
      })
    }
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
      // terminate() on a CONNECTING socket aborts the in-flight handshake, which
      // emits 'error' on the NEXT TICK (ws/lib/websocket.js abortHandshake). By
      // then our listeners are gone, and an EventEmitter with no 'error' listener
      // rethrows -> main-process uncaughtException. Reordering cannot help: the
      // emit is deferred either way. This no-op listener must survive. Keep it.
      this.ws.on('error', () => {})
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
