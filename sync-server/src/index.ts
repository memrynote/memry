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

// Error handling
import { SyncError, isSyncError, ErrorCode } from './lib/errors'

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
    exposeHeaders: ['X-Server-Cursor', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
    credentials: true,
    maxAge: 86400,
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
    version: '1.0.0',
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
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return c.json(
      {
        status: 'unhealthy',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    )
  }
})

// =============================================================================
// Auth Routes (Public - for login/registration)
// =============================================================================

// Auth routes will be implemented in Phase 2+ (T035-T039)
// Placeholder routes for now

app.post('/api/v1/auth/otp/request', async (c) => {
  return c.json({ message: 'OTP request endpoint - to be implemented' }, 501)
})

app.post('/api/v1/auth/otp/verify', async (c) => {
  return c.json({ message: 'OTP verify endpoint - to be implemented' }, 501)
})

app.post('/api/v1/auth/token/refresh', async (c) => {
  return c.json({ message: 'Token refresh endpoint - to be implemented' }, 501)
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

/**
 * Sync status endpoint.
 */
protectedApi.get('/sync/status', async (c) => {
  const auth = c.get('auth')
  return c.json({
    message: 'Sync status endpoint',
    userId: auth.userId,
    deviceId: auth.deviceId,
  })
})

/**
 * Sync push endpoint (placeholder).
 */
protectedApi.post('/sync/push', async (c) => {
  return c.json({ message: 'Sync push endpoint - to be implemented' }, 501)
})

/**
 * Sync pull endpoint (placeholder).
 */
protectedApi.get('/sync/pull', async (c) => {
  return c.json({ message: 'Sync pull endpoint - to be implemented' }, 501)
})

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
      path: c.req.path,
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
      message: 'Internal server error',
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
  },
}

// =============================================================================
// Durable Object Exports
// =============================================================================

/**
 * User sync state Durable Object.
 * Manages real-time sync state for a user.
 */
export class UserSyncState {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    void request
    // Placeholder - to be implemented in Phase 3
    return new Response(JSON.stringify({ status: 'not_implemented' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * Linking session Durable Object.
 * Manages device linking flow state.
 */
export class LinkingSession {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    void request
    // Placeholder - to be implemented in Phase 2
    return new Response(JSON.stringify({ status: 'not_implemented' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
