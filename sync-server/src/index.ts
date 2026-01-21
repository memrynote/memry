import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

// Cloudflare Workers environment bindings
interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  USER_SYNC_STATE: DurableObjectNamespace
  LINKING_SESSION: DurableObjectNamespace
}

// Hono app with typed environment
const app = new Hono<{ Bindings: Env }>()

// Middleware
app.use('*', logger())
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'app://memry'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Server-Cursor'],
    credentials: true,
    maxAge: 86400
  })
)

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'memry-sync-server',
    version: '1.0.0'
  })
})

// Health check with database connectivity
app.get('/health', async (c) => {
  try {
    // Check D1 connectivity
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

// API routes placeholder (to be implemented in Phase 2+)
app.get('/api/v1/sync/status', (c) => {
  return c.json({ message: 'Sync status endpoint - to be implemented' })
})

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err)
  return c.json(
    {
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error'
    },
    500
  )
})

// Export for Cloudflare Workers
export default app

// Durable Object exports (to be implemented)
export class UserSyncState {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    // Placeholder - to be implemented in Phase 2
    return new Response(JSON.stringify({ status: 'not_implemented' }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

export class LinkingSession {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    // Placeholder - to be implemented in Phase 2
    return new Response(JSON.stringify({ status: 'not_implemented' }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
