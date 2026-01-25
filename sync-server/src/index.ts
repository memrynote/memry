/**
 * T030: Hono.js App Entry Point
 *
 * Main entry point for the Memry sync server.
 * Integrates middleware, error handling, and scheduled jobs.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

// Middleware
import { authMiddleware, type AuthContext } from './middleware/auth'

// Services
import { runCleanupJobs, logCleanupResult } from './services/cleanup'

// Routes
import { authRoutes } from './routes/auth'
import { syncRoutes } from './routes/sync'

// Durable Objects
import { UserSyncState } from './durable-objects/user-state'

// Error handling
import { SyncError, isSyncError, ErrorCode } from './lib/errors'

// HTTP status codes not in standard libraries
const HTTP_UPGRADE_REQUIRED = 426

// Auth for WebSocket
import { verifyAccessToken } from './services/auth'
import { getLinkingSession, verifyLinkingToken } from './services/linking'

/**
 * Cloudflare Workers environment bindings.
 */
export interface Env {
  // D1 Database
  DB: D1Database
  // R2 Bucket
  BUCKET: R2Bucket
  // Durable Objects
  USER_SYNC_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace
  // Secrets
  JWT_SECRET: string
  RESEND_API_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  // Variables
  EMAIL_FROM: string
  EMAIL_FROM_NAME: string
}

/**
 * Variables set by middleware.
 */
interface Variables {
  auth: AuthContext
}

/**
 * Hono app with typed environment and variables.
 */
const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// =============================================================================
// Global Middleware
// =============================================================================

app.use('*', logger())

app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'app://memry'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: [
      'X-Server-Cursor',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After'
    ],
    credentials: true,
    maxAge: 86400
  })
)

// =============================================================================
// Public Routes (No Auth)
// =============================================================================

/**
 * Root health check.
 */
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'memry-sync-server',
    version: '1.0.0'
  })
})

/**
 * Health check with database connectivity.
 */
app.get('/health', async (c) => {
  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first()

    return c.json({
      status: 'healthy',
      database: result?.ok === 1 ? 'connected' : 'error',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      500
    )
  }
})

// =============================================================================
// Auth Routes (Public - for login/registration)
// =============================================================================

// Mount auth routes at /api/v1/auth
app.route('/api/v1/auth', authRoutes)

// =============================================================================
// WebSocket Route (requires auth but bypasses standard middleware)
// =============================================================================

app.get('/api/v1/sync/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, HTTP_UPGRADE_REQUIRED)
  }

  const token = c.req.query('token') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')

  if (!token) {
    return c.json({ error: 'Missing authentication token' }, 401)
  }

  let payload
  try {
    payload = await verifyAccessToken(token, c.env.JWT_SECRET)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const doId = c.env.USER_SYNC_STATE.idFromName(payload.sub)
  const stub = c.env.USER_SYNC_STATE.get(doId)

  const url = new URL(c.req.url)
  url.searchParams.delete('token')
  url.searchParams.set('deviceId', payload.deviceId)
  const wsRequest = new Request(url.toString(), c.req.raw)

  return stub.fetch(wsRequest)
})

/**
 * WebSocket for linking session real-time updates.
 * Requires authentication:
 * - Initiator (role=initiator): JWT token required
 * - New device (role=new_device): Linking token required
 */
app.get('/api/v1/auth/linking/:sessionId/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, HTTP_UPGRADE_REQUIRED)
  }

  const sessionId = c.req.param('sessionId')
  const role = c.req.query('role')

  if (role !== 'initiator' && role !== 'new_device') {
    return c.json({ error: 'Invalid role parameter' }, 400)
  }

  const session = await getLinkingSession(c.env.DB, sessionId)
  if (!session) {
    return c.json({ error: 'Linking session not found' }, 404)
  }

  if (session.expires_at < Date.now()) {
    return c.json({ error: 'Linking session expired' }, 410)
  }

  if (role === 'initiator') {
    const jwtToken = c.req.query('token') ?? c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!jwtToken) {
      return c.json({ error: 'Missing authentication token' }, 401)
    }

    try {
      const payload = await verifyAccessToken(jwtToken, c.env.JWT_SECRET)
      if (payload.sub !== session.user_id) {
        return c.json({ error: 'Session does not belong to user' }, 403)
      }
    } catch {
      return c.json({ error: 'Invalid token' }, 401)
    }
  } else {
    const linkingToken = c.req.query('linkingToken')
    if (!linkingToken) {
      return c.json({ error: 'Missing linking token' }, 401)
    }

    const tokenValid = await verifyLinkingToken(linkingToken, session.linking_token_hash)
    if (!tokenValid) {
      return c.json({ error: 'Invalid linking token' }, 401)
    }
  }

  const doId = c.env.LINKING_SESSION.idFromName(sessionId)
  const stub = c.env.LINKING_SESSION.get(doId)

  const url = new URL(c.req.url)
  url.searchParams.delete('token')
  url.searchParams.delete('linkingToken')
  const wsRequest = new Request(url.toString(), c.req.raw)

  return stub.fetch(wsRequest)
})

// =============================================================================
// Protected Routes (Require Auth)
// =============================================================================

/**
 * Protected API routes group.
 * All routes under /api/v1/ (except auth) require authentication.
 */
const protectedApi = new Hono<{ Bindings: Env; Variables: Variables }>()

// Apply auth middleware to all protected routes
protectedApi.use('*', authMiddleware())

// Mount sync routes under /sync
protectedApi.route('/sync', syncRoutes)

/**
 * Blob upload endpoint (placeholder).
 */
protectedApi.post('/blobs', async (c) => {
  return c.json({ message: 'Blob upload endpoint - to be implemented' }, 501)
})

/**
 * Blob download endpoint (placeholder).
 */
protectedApi.get('/blobs/:id', async (c) => {
  return c.json({ message: 'Blob download endpoint - to be implemented' }, 501)
})

/**
 * Device list endpoint (placeholder).
 */
protectedApi.get('/devices', async (c) => {
  return c.json({ message: 'Device list endpoint - to be implemented' }, 501)
})

/**
 * Device removal endpoint (placeholder).
 */
protectedApi.delete('/devices/:id', async (c) => {
  return c.json({ message: 'Device removal endpoint - to be implemented' }, 501)
})

// Mount protected routes
app.route('/api/v1', protectedApi)

// =============================================================================
// Error Handling
// =============================================================================

/**
 * 404 handler.
 */
app.notFound((c) => {
  return c.json(
    {
      error: ErrorCode.SYNC_ITEM_NOT_FOUND,
      message: 'Not found',
      path: c.req.path
    },
    404
  )
})

/**
 * Global error handler.
 * Converts SyncError to JSON responses with appropriate status codes.
 */
app.onError((err, c) => {
  // Handle SyncError with proper status codes
  if (isSyncError(err)) {
    return c.json(err.toJSON(), err.statusCode)
  }

  // Log unexpected errors
  console.error('Unexpected server error:', err)

  // Return generic error for unexpected errors
  return c.json(
    {
      error: ErrorCode.SERVER_INTERNAL_ERROR,
      message: 'Internal server error'
    },
    500
  )
})

// =============================================================================
// Worker Export
// =============================================================================

export default {
  /**
   * Handle HTTP requests.
   */
  fetch: app.fetch,

  /**
   * Handle scheduled events (cron triggers).
   * Runs cleanup jobs for expired data.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runCleanupJobs(env.DB)
          logCleanupResult(result)
        } catch (error) {
          console.error('Cleanup job failed:', error)
        }
      })()
    )
  }
}

// =============================================================================
// Durable Object Exports
// =============================================================================

export { UserSyncState } from './durable-objects/user-state'
export { LinkingSession } from './durable-objects/linking-session'
