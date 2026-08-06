export { UserSyncState } from './durable-objects/user-sync-state'
export { LinkingSession } from './durable-objects/linking-session'

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { AppError, ErrorCodes, errorHandler } from './lib/errors'
import { auth } from './routes/auth'
import { blob } from './routes/blob'
import { calendarChannels } from './routes/calendar-channels'
import { devices } from './routes/devices'
import { diagnostics } from './routes/diagnostics'
import { feedback } from './routes/feedback'
import { linking } from './routes/linking'
import { sync } from './routes/sync'
import { telemetry } from './routes/telemetry'
import { webhooks } from './routes/webhooks'
import { securityHeaders } from './middleware/security'
import {
  cleanupConsumedSetupTokens,
  cleanupExpiredGoogleCalendarChannels,
  cleanupExpiredLinkingSessions,
  cleanupExpiredOtpCodes,
  cleanupExpiredTombstones,
  cleanupExpiredUploadSessions,
  cleanupOrphanedBlobChunks,
  cleanupStaleIdentifySessions,
  cleanupStaleRateLimits
} from './services/cleanup'
import { createLogger } from './lib/logger'
import { captureServerError } from './services/analytics'
import { syncReleaseDownloadCounts } from './services/release-downloads'
import type { Bindings, AppContext } from './types'

const logger = createLogger('Server')

// Electron routes all requests through main process (no browser CORS).
// Only development servers need explicit origins; staging/production
// rely on ALLOWED_ORIGIN env var for any web-based clients.
const ORIGIN_BY_ENV: Record<string, string[]> = {
  development: ['http://localhost:5173', 'http://localhost:3000'],
  staging: [],
  production: []
}

const app = new Hono<AppContext>()

app.use('*', securityHeaders)

const MAX_BODY_BYTES_API = 1 * 1024 * 1024
const MAX_BODY_BYTES_BLOB = 10 * 1024 * 1024
const MAX_BODY_BYTES_TELEMETRY = 128 * 1024

const bodyLimitError = () => {
  throw new AppError(ErrorCodes.VALIDATION_BODY_TOO_LARGE, 'Request body too large', 413)
}

const METHOD_WITHOUT_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

const getMaxBodyBytes = (path: string): number => {
  if (path.startsWith('/telemetry/') || path.startsWith('/diagnostics/')) {
    return MAX_BODY_BYTES_TELEMETRY
  }

  const isBlobRoute = path.includes('/blob') || path.includes('/attachments/')
  return isBlobRoute ? MAX_BODY_BYTES_BLOB : MAX_BODY_BYTES_API
}

const isBodyWithinLimit = async (request: Request, maxBodyBytes: number): Promise<boolean> => {
  if (!request.body) {
    return true
  }

  const reader = request.clone().body?.getReader()
  if (!reader) {
    return true
  }

  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return true
      }

      totalBytes += value.byteLength
      if (totalBytes > maxBodyBytes) {
        return false
      }
    }
  } finally {
    reader.releaseLock()
  }
}

app.use('*', async (c, next) => {
  const maxBodyBytes = getMaxBodyBytes(c.req.path)

  const contentLength = c.req.header('Content-Length')
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    bodyLimitError()
  }

  if (!METHOD_WITHOUT_BODY.has(c.req.method)) {
    const withinLimit = await isBodyWithinLimit(c.req.raw, maxBodyBytes)
    if (!withinLimit) {
      bodyLimitError()
    }
  }

  await next()
})

app.use('*', async (c, next) => {
  const origins = [...(ORIGIN_BY_ENV[c.env.ENVIRONMENT] ?? [])]
  if (c.env.ALLOWED_ORIGIN) {
    origins.push(c.env.ALLOWED_ORIGIN)
  }
  const middleware = cors({ origin: origins })
  return middleware(c, next)
})

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT
  if (!env) {
    throw new Error('ENVIRONMENT binding is required (development | staging | production)')
  }

  const requiredSecrets = [
    'JWT_PUBLIC_KEY',
    'JWT_PRIVATE_KEY',
    'RESEND_API_KEY',
    'OTP_HMAC_KEY',
    'RECOVERY_DUMMY_SECRET',
    'WEBHOOK_HMAC_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_CHECKOUT_TOKEN_SECRET',
    'PADDLE_API_KEY',
    'TELEMETRY_HMAC_KEY'
  ] as const

  for (const key of requiredSecrets) {
    const value = c.env[key]
    const missing = typeof value !== 'string' || value.length === 0

    if (missing && env !== 'development') {
      throw new Error(`Missing required secret: ${key}`)
    }

    if (missing && env === 'development') {
      logger.warn('Missing secret binding', { key })
    }
  }

  await next()
})

app.onError(errorHandler)

app.get('/health', (c) => c.json({ status: 'ok' }))

app.route('/auth', auth)
app.route('/auth/linking', linking)
app.route('/devices', devices)
app.route('/sync', sync)
app.route('/sync', blob)
app.route('/telemetry', telemetry)
app.route('/diagnostics', diagnostics)
app.route('/feedback', feedback)
app.route('/webhooks', webhooks)
app.route('/calendar/channels', calendarChannels)

// GitHub release download counts are a once-a-day pull, so they ride their own
// trigger rather than the 6-hourly cleanup sweep (see wrangler.toml [triggers]).
const DAILY_CRON = '0 4 * * *'

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (event, env, _ctx) => {
  const tasks: Array<[string, Promise<unknown>]> = [
    // Action names are verbatim here rather than prefixed at the call site: the
    // cleanups keep the `cleanup_` action names they have always emitted, while
    // the daily release pull is not a cleanup and must not inherit that prefix.
    ['cleanup_expired_otp_codes', cleanupExpiredOtpCodes(env.DB)],
    ['cleanup_expired_linking_sessions', cleanupExpiredLinkingSessions(env.DB)],
    ['cleanup_expired_upload_sessions', cleanupExpiredUploadSessions(env.DB, env.STORAGE)],
    ['cleanup_stale_rate_limits', cleanupStaleRateLimits(env.DB)],
    ['cleanup_consumed_setup_tokens', cleanupConsumedSetupTokens(env.DB)],
    ['cleanup_expired_tombstones', cleanupExpiredTombstones(env.DB, env.STORAGE)],
    ['cleanup_orphaned_blob_chunks', cleanupOrphanedBlobChunks(env.DB, env.STORAGE)],
    ['cleanup_expired_gcal_channels', cleanupExpiredGoogleCalendarChannels(env.DB)],
    ['cleanup_stale_identify_sessions', cleanupStaleIdentifySessions(env.DB)]
  ]

  if (event.cron === DAILY_CRON) {
    tasks.push(['release_download_counts', syncReleaseDownloadCounts(env)])
  }

  const results = await Promise.allSettled(tasks.map(([, promise]) => promise))

  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      // captureServerError logs + pushes a redacted log line and an event to PostHog
      await captureServerError(env, {
        error: result.reason,
        source: 'cron',
        action: tasks[i][0],
        statusCode: 500,
        handled: true
      })
    }
  }
}

export { app }
export default { fetch: app.fetch, scheduled }
