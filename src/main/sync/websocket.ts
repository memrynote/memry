/**
 * WebSocket Connection Manager
 *
 * Manages the WebSocket connection to the sync server for real-time updates.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Heartbeat every 30s to keep connection alive
 * - Message queue for offline sending
 * - Event handling for sync notifications
 *
 * @module main/sync/websocket
 */

import { EventEmitter } from 'events'
import { calculateNextRetry, MAX_RETRY_ATTEMPTS } from './retry'

// =============================================================================
// Types
// =============================================================================

/** WebSocket connection states */
export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** WebSocket message types from server */
export type ServerMessageType =
  | 'item-synced'
  | 'linking-request'
  | 'linking-approved'
  | 'device-removed'
  | 'pong'
  | 'error'

/** WebSocket message types to server */
export type ClientMessageType = 'ping' | 'subscribe' | 'unsubscribe'

/** Server message payload */
export interface ServerMessage {
  type: ServerMessageType
  payload?: unknown
}

/** Client message payload */
export interface ClientMessage {
  type: ClientMessageType
  payload?: unknown
}

/** Item synced event payload */
export interface ItemSyncedPayload {
  itemId: string
  type: string
  operation: 'create' | 'update' | 'delete'
  deviceId: string
  version: number
}

/** Linking request event payload */
export interface LinkingRequestPayload {
  sessionId: string
  deviceName: string
  devicePlatform: string
  newDevicePublicKey: string
  newDeviceConfirm: string
}

/** Device removed event payload */
export interface DeviceRemovedPayload {
  deviceId: string
  reason: string
}

/** WebSocket manager events */
export interface WebSocketEvents {
  connected: () => void
  disconnected: (reason: string) => void
  reconnecting: (attempt: number) => void
  'item-synced': (payload: ItemSyncedPayload) => void
  'linking-request': (payload: LinkingRequestPayload) => void
  'linking-approved': (sessionId: string) => void
  'device-removed': (payload: DeviceRemovedPayload) => void
  error: (error: Error) => void
}

// =============================================================================
// Constants
// =============================================================================

/** Heartbeat interval (30 seconds) */
const HEARTBEAT_INTERVAL_MS = 30000

/** Heartbeat timeout (10 seconds) */
const HEARTBEAT_TIMEOUT_MS = 10000

/** Maximum reconnect attempts */
const MAX_RECONNECT_ATTEMPTS = MAX_RETRY_ATTEMPTS

// =============================================================================
// WebSocket Manager Class
// =============================================================================

/**
 * WebSocket Connection Manager
 *
 * Manages real-time connection to sync server with auto-reconnect.
 */
export class WebSocketManager extends EventEmitter {
  private _ws: WebSocket | null = null
  private _state: WebSocketState = 'disconnected'
  private _serverUrl: string = ''
  private _userId: string = ''
  private _deviceId: string = ''
  private _token: string = ''

  private _reconnectAttempts: number = 0
  private _reconnectTimer: NodeJS.Timeout | null = null
  private _heartbeatTimer: NodeJS.Timeout | null = null
  private _heartbeatTimeoutTimer: NodeJS.Timeout | null = null

  private _messageQueue: ClientMessage[] = []
  private _isIntentionalClose: boolean = false

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to the WebSocket server.
   *
   * @param serverUrl - WebSocket server URL (wss://...)
   * @param userId - User ID for authentication
   * @param deviceId - Device ID for identification
   * @param token - JWT access token
   */
  connect(serverUrl: string, userId: string, deviceId: string, token: string): void {
    if (this._state === 'connected' || this._state === 'connecting') {
      return
    }

    this._serverUrl = serverUrl
    this._userId = userId
    this._deviceId = deviceId
    this._token = token
    this._isIntentionalClose = false

    this.doConnect()
  }

  /**
   * Disconnect from the WebSocket server.
   */
  disconnect(): void {
    this._isIntentionalClose = true
    this.cleanup()
    this._state = 'disconnected'
    this.emit('disconnected', 'intentional')
  }

  /**
   * Update the access token (e.g., after refresh).
   *
   * @param token - New JWT access token
   */
  updateToken(token: string): void {
    this._token = token
  }

  // ---------------------------------------------------------------------------
  // State Access
  // ---------------------------------------------------------------------------

  /**
   * Get current connection state.
   */
  get state(): WebSocketState {
    return this._state
  }

  /**
   * Check if connected.
   */
  get isConnected(): boolean {
    return this._state === 'connected'
  }

  /**
   * Get current reconnect attempt count.
   */
  get reconnectAttempts(): number {
    return this._reconnectAttempts
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the server.
   *
   * If not connected, message is queued for later.
   *
   * @param message - Message to send
   * @returns True if sent immediately, false if queued
   */
  send(message: ClientMessage): boolean {
    if (this._state !== 'connected' || !this._ws) {
      this._messageQueue.push(message)
      return false
    }

    try {
      this._ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      this._messageQueue.push(message)
      return false
    }
  }

  /**
   * Send a ping to check connection.
   */
  sendPing(): void {
    console.log('[WebSocket] Sending heartbeat ping')
    this.send({ type: 'ping' })
  }

  // ---------------------------------------------------------------------------
  // Internal: Connection
  // ---------------------------------------------------------------------------

  /**
   * Perform the actual WebSocket connection.
   */
  private doConnect(): void {
    this._state = 'connecting'
    console.log('[WebSocket] Connecting to', this._serverUrl)

    try {
      // Build WebSocket URL with auth params
      const url = new URL(this._serverUrl)
      url.searchParams.set('userId', this._userId)
      url.searchParams.set('deviceId', this._deviceId)
      url.searchParams.set('token', this._token)

      // Create WebSocket - use native WebSocket in Node.js or browser
      this._ws = new WebSocket(url.toString())

      this._ws.onopen = this.handleOpen.bind(this)
      this._ws.onclose = this.handleClose.bind(this)
      this._ws.onerror = this.handleError.bind(this)
      this._ws.onmessage = this.handleMessage.bind(this)
    } catch (error) {
      this._state = 'disconnected'
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      this.scheduleReconnect()
    }
  }

  /**
   * Handle WebSocket open event.
   */
  private handleOpen(): void {
    console.log('[WebSocket] Connected successfully')
    this._state = 'connected'
    this._reconnectAttempts = 0

    // Start heartbeat
    this.startHeartbeat()

    // Flush queued messages
    this.flushMessageQueue()

    this.emit('connected')
  }

  /**
   * Handle WebSocket close event.
   */
  private handleClose(event: CloseEvent): void {
    this.cleanup()

    const reason = event.reason || `Code ${event.code}`
    console.log('[WebSocket] Disconnected:', reason)
    this._state = 'disconnected'
    this.emit('disconnected', reason)

    // Attempt reconnect if not intentional close
    if (!this._isIntentionalClose) {
      this.scheduleReconnect()
    }
  }

  /**
   * Handle WebSocket error event.
   */
  private handleError(event: Event): void {
    // Extract error details from the event if available
    const errorEvent = event as ErrorEvent
    const message = errorEvent.message || 'WebSocket connection failed'
    const error = new Error(`WebSocket error: ${message}`)
    console.error('[WebSocket] Error:', message)
    this.emit('error', error)
  }

  /**
   * Handle incoming WebSocket message.
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data as string) as ServerMessage

      switch (message.type) {
        case 'pong':
          this.handlePong()
          break

        case 'item-synced':
          console.log('[WebSocket] Received item-synced:', message.payload)
          this.emit('item-synced', message.payload as ItemSyncedPayload)
          break

        case 'linking-request':
          this.emit('linking-request', message.payload as LinkingRequestPayload)
          break

        case 'linking-approved':
          this.emit('linking-approved', (message.payload as { sessionId: string }).sessionId)
          break

        case 'device-removed':
          this.emit('device-removed', message.payload as DeviceRemovedPayload)
          // Disconnect since device is removed
          this._isIntentionalClose = true
          this.disconnect()
          break

        case 'error':
          this.emit('error', new Error(String(message.payload)))
          break
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error('Failed to parse message'))
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Start the heartbeat timer.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()

    this._heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * Stop the heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer)
      this._heartbeatTimeoutTimer = null
    }
  }

  /**
   * Send a heartbeat ping and start timeout.
   */
  private sendHeartbeat(): void {
    if (this._state !== 'connected') return

    this.sendPing()

    // Start timeout timer
    this._heartbeatTimeoutTimer = setTimeout(() => {
      // No pong received, consider connection dead
      this.handleHeartbeatTimeout()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /**
   * Handle pong response.
   */
  private handlePong(): void {
    console.log('[WebSocket] Received heartbeat pong')
    // Clear timeout timer
    if (this._heartbeatTimeoutTimer) {
      clearTimeout(this._heartbeatTimeoutTimer)
      this._heartbeatTimeoutTimer = null
    }
  }

  /**
   * Handle heartbeat timeout (no pong received).
   */
  private handleHeartbeatTimeout(): void {
    console.log('[WebSocket] Heartbeat timeout - no pong received, closing connection')
    // Force close and reconnect
    if (this._ws) {
      this._ws.close(4000, 'Heartbeat timeout')
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Reconnection
  // ---------------------------------------------------------------------------

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this._isIntentionalClose) return
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[WebSocket] Max reconnect attempts exceeded:', MAX_RECONNECT_ATTEMPTS)
      this.emit('error', new Error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded`))
      return
    }

    this._reconnectAttempts++
    this._state = 'reconnecting'

    const delay = calculateNextRetry(this._reconnectAttempts)
    console.log(`[WebSocket] Scheduling reconnect attempt ${this._reconnectAttempts} in ${delay}ms`)
    this.emit('reconnecting', this._reconnectAttempts)

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this.doConnect()
    }, delay)
  }

  // ---------------------------------------------------------------------------
  // Internal: Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Clean up connection resources.
   */
  private cleanup(): void {
    this.stopHeartbeat()

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }

    if (this._ws) {
      this._ws.onopen = null
      this._ws.onclose = null
      this._ws.onerror = null
      this._ws.onmessage = null

      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        try {
          this._ws.close()
        } catch {
          // Ignore close errors
        }
      }

      this._ws = null
    }
  }

  /**
   * Flush queued messages.
   */
  private flushMessageQueue(): void {
    const queue = [...this._messageQueue]
    this._messageQueue = []

    for (const message of queue) {
      this.send(message)
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Singleton WebSocket manager instance */
let _wsManager: WebSocketManager | null = null

/**
 * Get the WebSocket manager singleton.
 *
 * @returns WebSocketManager instance
 */
export function getWebSocketManager(): WebSocketManager {
  if (!_wsManager) {
    _wsManager = new WebSocketManager()
  }
  return _wsManager
}

/**
 * Reset the WebSocket manager singleton (for testing).
 */
export function resetWebSocketManager(): void {
  if (_wsManager) {
    _wsManager.disconnect()
    _wsManager.removeAllListeners()
    _wsManager = null
  }
}
