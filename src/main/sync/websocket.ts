/**
 * WebSocket Connection Manager
 *
 * Manages real-time WebSocket connection to the sync server for push notifications.
 *
 * @module sync/websocket
 */

import WebSocket from 'ws'
import { BrowserWindow } from 'electron'
import { TypedEmitter } from './typed-emitter'
import { withRetry, DEFAULT_RETRY_CONFIG } from './retry'
import type { RetryConfig } from './retry'

export interface WebSocketEvents extends Record<string, unknown[]> {
  'sync:ws-connected': []
  'sync:ws-disconnected': [code: number, reason: string]
  'sync:ws-message': [data: WebSocketMessage]
  'sync:ws-error': [error: Error]
  'sync:ws-reconnecting': [attempt: number]
}

export interface WebSocketMessage {
  type: 'sync' | 'ping' | 'pong' | 'notification' | 'error'
  payload?: unknown
  timestamp: number
}

export type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface WebSocketConfig {
  serverUrl: string
  pingIntervalMs?: number
  pongTimeoutMs?: number
  reconnectConfig?: Partial<RetryConfig>
}

const DEFAULT_PING_INTERVAL_MS = 30000
const DEFAULT_PONG_TIMEOUT_MS = 10000

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
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/sync/ws'

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

      this.emit('sync:ws-message', message)
      this.broadcastToWindows('sync:ws-message', message)
    } catch (error) {
      this.emit('sync:ws-error', error instanceof Error ? error : new Error('Malformed WebSocket message'))
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
      await withRetry(
        () => this.establishConnection(),
        {
          ...this.reconnectConfig,
          onRetry: (_error, attempt) => {
            this.emit('sync:ws-reconnecting', attempt)
            this.broadcastToWindows('sync:ws-reconnecting', attempt)
          }
        }
      )
    } catch (error) {
      this.emit('sync:ws-error', error instanceof Error ? error : new Error('WebSocket reconnection failed'))
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

  send(message: WebSocketMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false
    }

    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.emit('sync:ws-error', error instanceof Error ? error : new Error('WebSocket send failed'))
      return false
    }
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.stopPing()
    this.clearPongTimeout()

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
