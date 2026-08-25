export { UserSyncState } from './durable-objects/user-sync-state'
export { LinkingSession } from './durable-objects/linking-session'
export { RateLimiter } from './durable-objects/rate-limiter'

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { AppError, ErrorCodes, errorHandler } from './lib/errors'
import { auth } from './routes/auth'
import { blob } from './routes/blob'
import { bootstrap } from './routes/bootstrap'
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
  cleanupExpiredBootstrapSessions,
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
import { logCrdtTraffic } from './services/sync-telemetry'
import { runPackBackfill } from './services/pack-backfill'
import { handlePackQueueMessage } from './services/pack-consumer'
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
// Sync routes carry encrypted payloads the routes themselves cap at 5MB
// decoded (MAX_UPDATE_BYTES, MAX_ENCRYPTED_DATA_BYTES); base64 plus the JSON
// envelope needs headroom above that, or those route checks are unreachable.
const MAX_BODY_BYTES_SYNC = 8 * 1024 * 1024
const MAX_BODY_BYTES_BLOB = 10 * 1024 * 1024
const MAX_BODY_BYTES_TELEMETRY = 128 * 1024

// A body over the cap dies HERE, before any route runs. For `/sync/crdt/*` that
// meant the route's own `snapshot_rejected` / `updates_rejected` event — the one
// carrying `totalBytes`, the single most useful number for diagnosing an
// oversized CRDT payload — was never emitted, and the only trace left was a bare
// 413 with no size in it. Emit the route's event here instead, with the size we
// observed, so a rejection stays diagnosable wherever it is caught. `totalBytes`
// is the ENCODED request body (base64 + JSON envelope), roughly 4/3 of the
// decoded snapshot the route would have measured.
const CRDT_REJECTION_EVENT: Record<string, 'snapshot_rejected' | 'updates_rejected'> = {
  '/sync/crdt/snapshot': 'snapshot_rejected',
  '/sync/crdt/updates': 'updates_rejected'
}

const logOversizedCrdtBody = (path: string, observedBytes: number): void => {
  const event = CRDT_REJECTION_EVENT[path]
  if (!event) return

  logCrdtTraffic({
    endpoint: path,
    event,
    totalBytes: observedBytes,
    latencyMs: 0,
    reason: 'body_limit_exceeded'
  })
}

const bodyLimitError = (path: string, observedBytes: number) => {
  logOversizedCrdtBody(path, observedBytes)
  throw new AppError(ErrorCodes.VALIDATION_BODY_TOO_LARGE, 'Request body too large', 413)
}

const METHOD_WITHOUT_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

const getMaxBodyBytes = (path: string): number => {
  if (path.startsWith('/telemetry/') || path.startsWith('/diagnostics/')) {
    return MAX_BODY_BYTES_TELEMETRY
  }

  const isBlobRoute = path.includes('/blob') || path.includes('/attachments/')
  if (isBlobRoute) {
    return MAX_BODY_BYTES_BLOB
  }

  return path.startsWith('/sync/') ? MAX_BODY_BYTES_SYNC : MAX_BODY_BYTES_API
}

// `observedBytes` is what was counted before the read stopped: exact when the
// body fits, and a lower bound (just past the cap) when it does not — the stream
// is deliberately abandoned rather than buffered to measure a payload we are
// about to reject.
interface BodyLimitCheck {
  withinLimit: boolean
  observedBytes: number
}

const isBodyWithinLimit = async (
  request: Request,
  maxBodyBytes: number
): Promise<BodyLimitCheck> => {
  if (!request.body) {
    return { withinLimit: true, observedBytes: 0 }
  }

  const reader = request.clone().body?.getReader()
  if (!reader) {
    return { withinLimit: true, observedBytes: 0 }
  }

  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return { withinLimit: true, observedBytes: totalBytes }
      }

      totalBytes += value.byteLength
      if (totalBytes > maxBodyBytes) {
        return { withinLimit: false, observedBytes: totalBytes }
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
    bodyLimitError(c.req.path, Number(contentLength))
  }

  if (!METHOD_WITHOUT_BODY.has(c.req.method)) {
    const { withinLimit, observedBytes } = await isBodyWithinLimit(c.req.raw, maxBodyBytes)
    if (!withinLimit) {
      bodyLimitError(c.req.path, observedBytes)
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
app.route('/sync/bootstrap', bootstrap)
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
    ['cleanup_stale_identify_sessions', cleanupStaleIdentifySessions(env.DB)],
    ['cleanup_expired_bootstrap_sessions', cleanupExpiredBootstrapSessions(env.DB)],
    // Pack backfill (#1839) rides the 6-hourly trigger: a bounded number of
    // packs per tick (see pack-backfill.ts for the pacing model), resumed via
    // watermarks until every vault's historical items are packed.
    ['pack_backfill', runPackBackfill(env.DB, env.STORAGE)]
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
        // No hardcoded 500 any more: an error that carries its own status says
        // so (GitHub's rate limiter answering the release pull is a handled
        // 403, not a server fault), and everything else still defaults to 500
        // inside captureServerError.
        handled: true
      })
    }
  }
}

export { app }

// Queue consumer for pack compaction (#1839). Thin on purpose — message
// validation, retry semantics, and all compaction logic live in
// services/pack-consumer.ts / services/pack-compaction.ts so they stay
// testable without real Queues.
const queue: ExportedHandlerQueueHandler<Bindings> = async (batch, env, _ctx) => {
  // Messages are processed SEQUENTIALLY even if the platform delivers a
  // batch: each message can build packs (hundreds of subrequests), and
  // concurrent builds would make the invocation's subrequest budget
  // unpredictable. wrangler.toml pins max_batch_size = 1; this loop is the
  // belt to that suspenders.
  for (const message of batch.messages) {
    try {
      await handlePackQueueMessage(env, message.body)
    } catch (error) {
      logger.error('pack compaction failed; retrying delivery', {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      })
      // Throwing inside the queue handler makes the platform retry every
      // message of the batch (at-least-once); the core is idempotent, so a
      // redelivery is at worst one no-op pass. markAllFailed vs retry per
      // message: with batch size 1 they are equivalent.
      throw error
    }
  }
}

export default { fetch: app.fetch, scheduled, queue }
