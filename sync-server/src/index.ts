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

// =============================================================================
// WebSocket Route Handler
// =============================================================================

/**
 * Handle WebSocket upgrade requests for /ws route.
 *
 * Validates the token and forwards the request to the UserSyncState Durable Object.
 */
async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  // Extract auth params from query string
  const userId = url.searchParams.get('userId')
  const deviceId = url.searchParams.get('deviceId')
  const token = url.searchParams.get('token')

  // Validate required params
  if (!userId) {
    return new Response('userId query param required', { status: 400 })
  }
  if (!deviceId) {
    return new Response('deviceId query param required', { status: 400 })
  }
  if (!token) {
    return new Response('token query param required', { status: 400 })
  }

  // TODO: Validate JWT token matches userId
  // For now, accept connections with valid params (DO also validates deviceId)

  // Get or create the UserSyncState Durable Object for this user
  const doId = env.USER_STATE.idFromName(userId)
  const stub = env.USER_STATE.get(doId)

  // Forward the WebSocket upgrade request to the DO
  return stub.fetch(request)
}

// =============================================================================
// Worker Fetch Handler
// =============================================================================

/**
 * Main fetch handler that routes WebSocket upgrades to the DO
 * and all other requests to the Hono app.
 */
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Handle WebSocket upgrades to /ws
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketUpgrade(request, env)
    }

    // Pass all other requests to Hono
    return app.fetch(request, env, ctx)
  },
}

// Export for Cloudflare Workers
export default worker

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
// Durable Object: LinkingSession (Re-export from dedicated module)
// =============================================================================
export { LinkingSession } from './durable-objects/linking-session'
