export { UserSyncState } from './durable-objects/user-sync-state'
export { LinkingSession } from './durable-objects/linking-session'

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { AppError, ErrorCodes, errorHandler } from './lib/errors'
import { auth } from './routes/auth'
import { securityHeaders } from './middleware/security'
import {
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredUploadSessions,
  cleanupStaleRateLimits
} from './services/cleanup'
import type { Bindings, AppContext } from './types'

const ORIGIN_BY_ENV: Record<string, string[]> = {
  development: ['http://localhost:5173', 'http://localhost:3000'],
  staging: [],
  production: []
}

const app = new Hono<AppContext>()

app.use('*', securityHeaders)

const MAX_BODY_BYTES_API = 1 * 1024 * 1024
const MAX_BODY_BYTES_BLOB = 10 * 1024 * 1024

app.use('*', async (c, next) => {
  const contentLength = c.req.header('Content-Length')
  if (contentLength) {
    const size = parseInt(contentLength, 10)
    const isBlob = c.req.path.includes('/blob')
    const limit = isBlob ? MAX_BODY_BYTES_BLOB : MAX_BODY_BYTES_API
    if (size > limit) {
      throw new AppError(
        ErrorCodes.VALIDATION_BODY_TOO_LARGE,
        `Request body too large (limit: ${limit} bytes)`,
        413
      )
    }
  }
  await next()
})

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development'
  const origins = [...(ORIGIN_BY_ENV[env] ?? [])]
  if (c.env.ALLOWED_ORIGIN) {
    origins.push(c.env.ALLOWED_ORIGIN)
  }
  const middleware = cors({ origin: origins })
  return middleware(c, next)
})

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development'
  const requiredSecrets = ['JWT_PUBLIC_KEY', 'JWT_PRIVATE_KEY', 'RESEND_API_KEY'] as const

  for (const key of requiredSecrets) {
    const value = c.env[key]
    const missing = typeof value !== 'string' || value.length === 0

    if (missing && env !== 'development') {
      throw new Error(`Missing required secret: ${key}`)
    }

    if (missing && env === 'development') {
      console.warn(`[dev] Missing secret binding: ${key}`)
    }
  }

  await next()
})

app.onError(errorHandler)

app.get('/health', (c) =>
  c.json({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    timestamp: Date.now()
  })
)

app.route('/auth', auth)

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env, _ctx) => {
  const results = await Promise.allSettled([
    cleanupExpiredOtpCodes(env.DB),
    cleanupExpiredLinkingSessions(env.DB),
    cleanupExpiredUploadSessions(env.DB, env.STORAGE),
    cleanupStaleRateLimits(env.DB)
  ])

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(`Cleanup task ${i} failed:`, result.reason)
    }
  }
}

export default { fetch: app.fetch, scheduled }
