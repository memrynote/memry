import { Hono } from 'hono'

import { DiagnosticLogBatchSchema } from '@memry/contracts/diagnostics-api'
import { LandingTelemetryBatchSchema, TelemetryBatchSchema } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { desktopErrorEntry, desktopLogEntry, pushLokiEntries } from '../services/loki'
import {
  hashTelemetryId,
  writeLandingTelemetryBatch,
  writeTelemetryBatch
} from '../services/telemetry'
import type { AppContext } from '../types'

const logger = createLogger('Telemetry')

export const telemetry = new Hono<AppContext>()

telemetry.use(
  '/batch',
  createRateLimiter({ maxRequests: 60, windowSeconds: 60, keyPrefix: 'telemetry' })
)

telemetry.post('/batch', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = TelemetryBatchSchema.safeParse(body)
  if (!parsed.success) {
    // Surface which fields failed (path + zod code only — never the values, which
    // may hold the raw identifiers the schema is designed to reject) so the 400 is
    // diagnosable in logs instead of an opaque VALIDATION_ERROR.
    logger.warn('Invalid telemetry payload', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid telemetry payload', 400)
  }

  const result = await writeTelemetryBatch(c.env, parsed.data)

  // Desktop error events also become Loki log lines (redacted stack frames
  // only — see TelemetryErrorDetailSchema) so they are searchable in Grafana.
  const batch = parsed.data
  const errorEvents = batch.events.filter((event) => event.errorCode || event.error)
  if (errorEvents.length > 0) {
    safeWaitUntil(
      c,
      hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId).then((installHash) =>
        pushLokiEntries(
          c.env,
          errorEvents.map((event) => desktopErrorEntry(batch, event, installHash))
        )
      )
    )
  }

  return c.json(result, 202)
})

telemetry.use(
  '/logs',
  createRateLimiter({ maxRequests: 120, windowSeconds: 60, keyPrefix: 'telemetry-logs' })
)

// Redacted diagnostic log lines (client already ran redactLogLine) → Loki only,
// no D1/Analytics Engine write. Fire-and-forget, same privacy posture as /batch.
telemetry.post('/logs', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = DiagnosticLogBatchSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn('Invalid diagnostic log batch', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid diagnostic log batch', 400)
  }

  const batch = parsed.data
  const meta = {
    appVersion: batch.appVersion,
    buildChannel: batch.buildChannel,
    platform: batch.platform,
    arch: batch.arch
  }
  safeWaitUntil(
    c,
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId).then((installHash) =>
      pushLokiEntries(
        c.env,
        batch.lines.map((line) => desktopLogEntry(line, meta, installHash))
      )
    )
  )

  return c.json({ accepted: batch.lines.length }, 202)
})

telemetry.use(
  '/web',
  createRateLimiter({ maxRequests: 60, windowSeconds: 60, keyPrefix: 'telemetry-web' })
)

// Anonymous landing-site events (apps/landing) → LANDING_TELEMETRY. No auth,
// same privacy posture as /batch: the schema rejects anything shaped like an
// email, URL, path, or raw identifier.
telemetry.post('/web', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = LandingTelemetryBatchSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn('Invalid landing telemetry payload', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid landing telemetry payload', 400)
  }

  const result = await writeLandingTelemetryBatch(c.env, parsed.data)
  return c.json(result, 202)
})
