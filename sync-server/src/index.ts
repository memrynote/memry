/**
 * Memry Sync Server
 *
 * Cloudflare Workers API for sync and E2EE operations.
 * Uses Hono.js framework with D1 (metadata) and R2 (encrypted blobs).
 *
 * @module sync-server
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { SyncServerError } from './lib/errors'
import auth from './routes/auth'
import sync from './routes/sync'

// Type definitions for Cloudflare bindings
export interface Env {
  // D1 Database
  DB: D1Database

  // R2 Bucket for encrypted blobs
  BLOB_BUCKET: R2Bucket

  // Durable Objects
  USER_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace

  // Environment variables
  ENVIRONMENT: string

  // Secrets (set via wrangler secret put)
  JWT_SECRET: string
  OAUTH_GOOGLE_CLIENT_ID?: string
  OAUTH_GOOGLE_CLIENT_SECRET?: string
  RESEND_API_KEY?: string
  OAUTH_CALLBACK_URL?: string
}

// Create Hono app with environment bindings
const app = new Hono<{ Bindings: Env }>()

// Global middleware
app.use('*', logger())
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'app://memry'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    name: 'memry-sync',
    version: '1.0.0',
    status: 'healthy',
    environment: c.env.ENVIRONMENT,
  })
})

// API version prefix
const api = new Hono<{ Bindings: Env }>()

// Mount API routes
api.get('/status', (c) => {
  return c.json({ status: 'ok' })
})

// Auth routes (signup, login, OAuth, device registration)
api.route('/auth', auth)

// Sync routes (push, pull, manifest)
api.route('/sync', sync)

// Mount API under /api/v1
app.route('/api/v1', api)

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404)
})

// Error handler
app.onError((err, c) => {
  // Handle known errors
  if (err instanceof SyncServerError) {
    return c.json(err.toJSON(), err.statusCode)
  }

  // Log unknown errors
  console.error('Server error:', err)

  return c.json(
    {
      error: 'INTERNAL_ERROR',
      message: c.env.ENVIRONMENT === 'development' ? err.message : 'Internal server error',
    },
    500
  )
})

// Export for Cloudflare Workers
export default app

// =============================================================================
// Durable Object: UserSyncState (T090-T093)
// =============================================================================
/**
 * Manages real-time sync state for a user across devices.
 *
 * Handles:
 * - WebSocket connections for each device
 * - Broadcasting sync updates to connected devices
 * - Tracking connected devices
 */
export class UserSyncState implements DurableObject {
  private connections: Map<string, WebSocket> = new Map()

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request)
    }

    // Internal API endpoints
    switch (url.pathname) {
      case '/broadcast':
        return this.handleBroadcast(request)
      case '/status':
        return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  /**
   * Handle WebSocket upgrade request.
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const deviceId = url.searchParams.get('deviceId')
    const token = url.searchParams.get('token')

    if (!deviceId) {
      return new Response('deviceId required', { status: 400 })
    }

    // TODO: Validate token in production
    // For now, accept all connections with a deviceId

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept the WebSocket
    this.state.acceptWebSocket(server, [deviceId])

    // Store connection
    this.connections.set(deviceId, server)

    // Send welcome message
    server.send(
      JSON.stringify({
        type: 'connected',
        payload: { deviceId, timestamp: Date.now() },
      })
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Handle broadcast request from sync endpoints.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        type: string
        payload: unknown
        excludeDevice?: string
      }

      const message = JSON.stringify({
        type: body.type,
        payload: body.payload,
      })

      // Broadcast to all connected devices except the sender
      let sentCount = 0
      for (const [deviceId, socket] of this.connections.entries()) {
        if (deviceId !== body.excludeDevice) {
          try {
            socket.send(message)
            sentCount++
          } catch {
            // Socket might be closed, remove it
            this.connections.delete(deviceId)
          }
        }
      }

      return new Response(JSON.stringify({ sent: sentCount }), {
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Failed to broadcast' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  /**
   * Handle status request.
   */
  private handleStatus(): Response {
    return new Response(
      JSON.stringify({
        connectedDevices: Array.from(this.connections.keys()),
        count: this.connections.size,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  /**
   * Handle WebSocket messages from clients.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string) as { type: string; payload?: unknown }

      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }))
          break

        case 'subscribe':
          // Handle subscription to specific item types
          // For now, all devices receive all updates
          break

        default:
          // Unknown message type
          break
      }
    } catch {
      // Invalid message format
    }
  }

  /**
   * Handle WebSocket close event.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Find and remove the closed connection
    for (const [deviceId, socket] of this.connections.entries()) {
      if (socket === ws) {
        this.connections.delete(deviceId)
        break
      }
    }
  }

  /**
   * Handle WebSocket error event.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Find and remove the errored connection
    for (const [deviceId, socket] of this.connections.entries()) {
      if (socket === ws) {
        this.connections.delete(deviceId)
        break
      }
    }
  }
}

// =============================================================================
// Durable Object: LinkingSession
// =============================================================================
/**
 * Manages device linking sessions.
 *
 * Handles:
 * - QR code generation for linking
 * - Secure key exchange between devices
 * - Session expiration
 */
export class LinkingSession implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/create':
        return this.handleCreate(request)
      case '/scan':
        return this.handleScan(request)
      case '/approve':
        return this.handleApprove(request)
      case '/status':
        return this.handleStatus()
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  /**
   * Create a new linking session.
   */
  private async handleCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      userId: string
      deviceId: string
      ephemeralPublicKey: string
    }

    const session = {
      id: crypto.randomUUID(),
      userId: body.userId,
      initiatorDeviceId: body.deviceId,
      ephemeralPublicKey: body.ephemeralPublicKey,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    }

    await this.state.storage.put('session', session)

    // Set alarm for expiration
    await this.state.storage.setAlarm(session.expiresAt)

    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Handle QR code scan from new device.
   */
  private async handleScan(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      newDevicePublicKey: string
      newDeviceName: string
      newDevicePlatform: string
    }

    const session = await this.state.storage.get<{
      id: string
      userId: string
      status: string
      expiresAt: number
    }>('session')

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 })
    }

    if (session.status !== 'pending') {
      return new Response(JSON.stringify({ error: 'Session already used' }), { status: 400 })
    }

    if (session.expiresAt < Date.now()) {
      return new Response(JSON.stringify({ error: 'Session expired' }), { status: 400 })
    }

    // Update session with new device info
    const updatedSession = {
      ...session,
      newDevicePublicKey: body.newDevicePublicKey,
      newDeviceName: body.newDeviceName,
      newDevicePlatform: body.newDevicePlatform,
      status: 'scanned',
    }

    await this.state.storage.put('session', updatedSession)

    // Notify the initiator device via UserSyncState
    try {
      const userStateId = this.env.USER_STATE.idFromName(session.userId)
      const userState = this.env.USER_STATE.get(userStateId)

      await userState.fetch(
        new Request('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'linking-request',
            payload: {
              sessionId: session.id,
              deviceName: body.newDeviceName,
              devicePlatform: body.newDevicePlatform,
            },
          }),
        })
      )
    } catch {
      // Continue even if notification fails
    }

    return new Response(JSON.stringify({ status: 'scanned', sessionId: session.id }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Handle approval from existing device.
   */
  private async handleApprove(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      encryptedMasterKey: string
      encryptedKeyNonce: string
      keyConfirm: string
    }

    const session = await this.state.storage.get<{
      id: string
      userId: string
      status: string
    }>('session')

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 })
    }

    if (session.status !== 'scanned') {
      return new Response(JSON.stringify({ error: 'Session not ready for approval' }), { status: 400 })
    }

    // Update session with encrypted key
    const updatedSession = {
      ...session,
      encryptedMasterKey: body.encryptedMasterKey,
      encryptedKeyNonce: body.encryptedKeyNonce,
      keyConfirm: body.keyConfirm,
      status: 'approved',
    }

    await this.state.storage.put('session', updatedSession)

    // Notify via UserSyncState
    try {
      const userStateId = this.env.USER_STATE.idFromName(session.userId)
      const userState = this.env.USER_STATE.get(userStateId)

      await userState.fetch(
        new Request('https://internal/broadcast', {
          method: 'POST',
          body: JSON.stringify({
            type: 'linking-approved',
            payload: { sessionId: session.id },
          }),
        })
      )
    } catch {
      // Continue even if notification fails
    }

    return new Response(JSON.stringify({ status: 'approved' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Get session status.
   */
  private async handleStatus(): Promise<Response> {
    const session = await this.state.storage.get('session')

    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 })
    }

    return new Response(JSON.stringify(session), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Handle alarm for session expiration.
   */
  async alarm(): Promise<void> {
    const session = await this.state.storage.get<{ status: string }>('session')

    if (session && session.status !== 'completed') {
      // Mark as expired
      await this.state.storage.put('session', { ...session, status: 'expired' })
    }
  }
}
