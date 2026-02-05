/**
 * WebSocket Connection Manager
 *
 * Manages real-time WebSocket connection to the sync server for push notifications.
 *
 * @module sync/websocket
 */

import WebSocket from 'ws'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { TypedEmitter } from './typed-emitter'
import { withRetry, DEFAULT_RETRY_CONFIG } from './retry'
import type { RetryConfig } from './retry'

export interface WebSocketEvents extends Record<string, unknown[]> {
  'sync:ws-connected': []
  'sync:ws-disconnected': [code: number, reason: string]
  'sync:ws-message': [data: WebSocketMessage]
  'sync:ws-error': [error: Error]
  'sync:ws-reconnecting': [attempt: number]
  'sync:linking-scanned': [sessionId: string]
  'sync:linking-approved': [payload: LinkingApprovedPayload]
  'sync:linking-completed': [payload: LinkingCompletedPayload]
  'sync:linking-expired': [sessionId: string]
}

export interface WebSocketMessage {
  type: 'sync' | 'crdt' | 'ping' | 'pong' | 'notification' | 'error' | 'linking' | 'changes'
  payload?: unknown
  noteIds?: string[]
  timestamp: number
}

export interface LinkedDeviceInfo {
  id: string
  name: string
  platform: string
}

export interface LinkingApprovedPayload {
  sessionId: string
  encryptedMasterKey: string
  encryptedKeyNonce: string
  keyConfirm: string
}

export interface LinkingCompletedPayload {
  sessionId: string
  device: LinkedDeviceInfo
}

export interface LinkingEventPayload {
  event: 'scanned' | 'approved' | 'completed' | 'expired'
  sessionId: string
  encryptedMasterKey?: string
  encryptedKeyNonce?: string
  keyConfirm?: string
  device?: LinkedDeviceInfo
}

const LinkedDeviceInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1)
})

const LinkingEventPayloadSchema = z.object({
  event: z.enum(['scanned', 'approved', 'completed', 'expired']),
  sessionId: z.string().min(1),
  encryptedMasterKey: z.string().optional(),
  encryptedKeyNonce: z.string().optional(),
  keyConfirm: z.string().optional(),
  device: LinkedDeviceInfoSchema.optional()
})

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface WebSocketConfig {
  serverUrl: string
  pingIntervalMs?: number
  pongTimeoutMs?: number
  reconnectConfig?: Partial<RetryConfig>
}

const DEFAULT_PING_INTERVAL_MS = 30000
const DEFAULT_PONG_TIMEOUT_MS = 10000
const LINKING_RATE_LIMIT_MS = 1000
const LINKING_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000

export class WebSocketManager extends TypedEmitter<WebSocketEvents> {
  private ws: WebSocket | null = null
  private _state: WebSocketState = 'disconnected'
  private serverUrl: string
  private accessToken: string | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private pingIntervalMs: number
  private pongTimeoutMs: number
  private reconnectConfig: RetryConfig
  private reconnecting = false
  private shouldReconnect = true
  private linkingRateLimiter = new Map<string, number>()
  private linkingRateLimitCleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: WebSocketConfig) {
    super()
    this.serverUrl = config.serverUrl
    this.pingIntervalMs = config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
    this.pongTimeoutMs = config.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS
    this.reconnectConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.reconnectConfig
    }
  }

  get state(): WebSocketState {
    return this._state
  }

  private setState(state: WebSocketState): void {
    this._state = state
    this.broadcastToWindows('sync:ws-state-changed', state)
  }

  async connect(accessToken: string): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      return
    }

    this.accessToken = accessToken
    this.shouldReconnect = true

    await this.establishConnection()
  }

  private async establishConnection(): Promise<void> {
    this.setState('connecting')

    const baseUrl = this.serverUrl.replace(/\/$/, '')
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/v1/sync/ws'

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`
        }
      })

      await new Promise<void>((resolve, reject) => {
        if (!this.ws) {
          reject(new Error('WebSocket not initialized'))
          return
        }

        const onOpen = (): void => {
          cleanup()
          resolve()
        }

        const onError = (err: Error): void => {
          cleanup()
          reject(err)
        }

        const onClose = (code: number, reason: Buffer): void => {
          cleanup()
          reject(new Error(`WebSocket closed: ${code} ${reason.toString()}`))
        }

        const cleanup = (): void => {
          this.ws?.removeListener('open', onOpen)
          this.ws?.removeListener('error', onError)
          this.ws?.removeListener('close', onClose)
        }

        this.ws.on('open', onOpen)
        this.ws.once('error', onError)
        this.ws.once('close', onClose)
      })

      this.setupEventHandlers()
      this.startPing()
      this.startLinkingRateLimitCleanup()
      this.setState('connected')
      this.emit('sync:ws-connected')
      this.broadcastToWindows('sync:ws-connected', undefined)
    } catch (error) {
      this.setState('disconnected')
      const err = error instanceof Error ? error : new Error(String(error))
      this.emit('sync:ws-error', err)
      throw error
    }
  }

  private setupEventHandlers(): void {
    if (!this.ws) return

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data)
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(code, reason.toString())
    })

    this.ws.on('error', (error: Error) => {
      this.emit('sync:ws-error', error)
    })

    this.ws.on('pong', () => {
      this.clearPongTimeout()
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString())

      if (message.type === 'pong') {
        this.clearPongTimeout()
        return
      }

      if (message.type === 'linking') {
        const result = LinkingEventPayloadSchema.safeParse(message.payload)
        if (!result.success) {
          this.emit('sync:ws-error', new Error(`Invalid linking payload: ${result.error.message}`))
          return
        }
        this.handleLinkingMessage(result.data)
        return
      }

      if (message.type === 'crdt') {
        console.info('[WS] Received CRDT notification:', { noteIds: message.noteIds })
      }

      this.emit('sync:ws-message', message)
      this.broadcastToWindows('sync:ws-message', message)
    } catch (error) {
      this.emit(
        'sync:ws-error',
        error instanceof Error ? error : new Error('Malformed WebSocket message')
      )
    }
  }

  private handleLinkingMessage(payload: LinkingEventPayload): void {
    const now = Date.now()
    const rateLimitKey = `${payload.sessionId}:${payload.event}`
    const lastSeen = this.linkingRateLimiter.get(rateLimitKey) ?? 0

    if (now - lastSeen < LINKING_RATE_LIMIT_MS) {
      return
    }
    this.linkingRateLimiter.set(rateLimitKey, now)

    switch (payload.event) {
      case 'scanned':
        this.emit('sync:linking-scanned', payload.sessionId)
        this.broadcastToWindows('sync:linking-scanned', payload.sessionId)
        break

      case 'approved':
        if (payload.encryptedMasterKey && payload.encryptedKeyNonce && payload.keyConfirm) {
          const approvedPayload: LinkingApprovedPayload = {
            sessionId: payload.sessionId,
            encryptedMasterKey: payload.encryptedMasterKey,
            encryptedKeyNonce: payload.encryptedKeyNonce,
            keyConfirm: payload.keyConfirm
          }
          this.emit('sync:linking-approved', approvedPayload)
          this.broadcastToWindows('sync:linking-approved', approvedPayload)
        } else {
          this.emit(
            'sync:ws-error',
            new Error('Missing required fields in linking_approved payload')
          )
        }
        break

      case 'completed':
        if (payload.device) {
          const completedPayload: LinkingCompletedPayload = {
            sessionId: payload.sessionId,
            device: payload.device
          }
          this.emit('sync:linking-completed', completedPayload)
          this.broadcastToWindows('sync:linking-completed', completedPayload)
        } else {
          this.emit('sync:ws-error', new Error('Missing device in linking_completed payload'))
        }
        break

      case 'expired':
        this.emit('sync:linking-expired', payload.sessionId)
        this.broadcastToWindows('sync:linking-expired', payload.sessionId)
        break

      default: {
        const exhaustiveCheck: never = payload.event
        this.emit('sync:ws-error', new Error(`Unknown linking event: ${exhaustiveCheck}`))
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    this.stopPing()
    this.clearPongTimeout()
    this.ws = null
    this.setState('disconnected')

    this.emit('sync:ws-disconnected', code, reason)
    this.broadcastToWindows('sync:ws-disconnected', { code, reason })

    if (this.shouldReconnect && !this.reconnecting) {
      this.scheduleReconnect()
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnecting || !this.shouldReconnect || !this.accessToken) {
      return
    }

    this.reconnecting = true
    this.setState('reconnecting')

    try {
      await withRetry(() => this.establishConnection(), {
        ...this.reconnectConfig,
        onRetry: (_error, attempt) => {
          this.emit('sync:ws-reconnecting', attempt)
          this.broadcastToWindows('sync:ws-reconnecting', attempt)
        }
      })
    } catch (error) {
      this.emit(
        'sync:ws-error',
        error instanceof Error ? error : new Error('WebSocket reconnection failed')
      )
      this.setState('disconnected')
    } finally {
      this.reconnecting = false
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingInterval = setInterval(() => {
      this.sendPing()
    }, this.pingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private sendPing(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.ping()
      this.setPongTimeout()
    }
  }

  private setPongTimeout(): void {
    this.clearPongTimeout()
    this.pongTimeout = setTimeout(() => {
      this.ws?.terminate()
    }, this.pongTimeoutMs)
  }

  private clearPongTimeout(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout)
      this.pongTimeout = null
    }
  }

  private startLinkingRateLimitCleanup(): void {
    this.stopLinkingRateLimitCleanup()
    this.linkingRateLimitCleanupInterval = setInterval(() => {
      const now = Date.now()
      for (const [key, timestamp] of this.linkingRateLimiter.entries()) {
        if (now - timestamp > LINKING_RATE_LIMIT_CLEANUP_INTERVAL_MS) {
          this.linkingRateLimiter.delete(key)
        }
      }
    }, LINKING_RATE_LIMIT_CLEANUP_INTERVAL_MS)
  }

  private stopLinkingRateLimitCleanup(): void {
    if (this.linkingRateLimitCleanupInterval) {
      clearInterval(this.linkingRateLimitCleanupInterval)
      this.linkingRateLimitCleanupInterval = null
    }
    this.linkingRateLimiter.clear()
  }

  send(message: WebSocketMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false
    }

    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.emit(
        'sync:ws-error',
        error instanceof Error ? error : new Error('WebSocket send failed')
      )
      return false
    }
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.stopPing()
    this.clearPongTimeout()
    this.stopLinkingRateLimitCleanup()

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this.setState('disconnected')
  }

  private broadcastToWindows(channel: string, data: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data)
      }
    }
  }
}

let webSocketManagerInstance: WebSocketManager | null = null

export function getWebSocketManager(): WebSocketManager | null {
  return webSocketManagerInstance
}

export function initWebSocketManager(config: WebSocketConfig): WebSocketManager {
  if (!webSocketManagerInstance) {
    webSocketManagerInstance = new WebSocketManager(config)
  }
  return webSocketManagerInstance
}
