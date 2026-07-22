import { Hono } from 'hono'

import { DiagnosticLogBatchSchema } from '@memry/contracts/diagnostics-api'
import { TelemetryBatchSchema } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { capturePostHogEvents } from '../services/posthog'
import { desktopErrorRecord, desktopLogRecord, pushPostHogLogs } from '../services/posthog-logs'
import {
  exceptionEvent,
  identifyEvent,
  productEvent,
  resolveDistinctId
} from '../services/posthog-transform'
import { hashTelemetryId } from '../services/telemetry'
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

  const batch = parsed.data
  const installHash = await hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId)
  // accountId stays undefined in this train: /telemetry/* deliberately bypasses
  // the auth middleware and TelemetryBatchSchema carries no account identifier,
  // so every install reports anonymously until a later release restores the
  // bearer. resolveDistinctId already falls back to installHash — nothing here
  // changes when that lands except this one field becoming populated.
  const ctx = {
    installHash,
    accountId: undefined as string | undefined,
    environment: c.env.ENVIRONMENT ?? 'unknown'
  }
  const distinctId = resolveDistinctId(ctx)

  const events = batch.events.map((event) => productEvent(batch, event, ctx))
  const exceptions = batch.events
    .map((event) => exceptionEvent(batch, event, ctx))
    .filter((event): event is NonNullable<typeof event> => event !== null)

  // identifyEvent returns null whenever ctx.accountId is unset, which is always
  // true today — so this is unreachable until account resolution ships. $identify
  // merges the anonymous install into the account PERMANENTLY, so once accountId
  // is populated a once-per-session guard MUST land together with that
  // resolution, before this can fire on every 30s batch instead of once.
  const identify = identifyEvent(batch, ctx)

  safeWaitUntil(
    c,
    capturePostHogEvents(c.env, [...(identify ? [identify] : []), ...events, ...exceptions])
  )

  // Desktop error events also become PostHog log lines (redacted stack frames
  // only — see TelemetryErrorDetailSchema) so they are searchable in the Logs tab.
  const errorEvents = batch.events.filter((event) => event.errorCode || event.error)
  if (errorEvents.length > 0) {
    safeWaitUntil(
      c,
      pushPostHogLogs(
        c.env,
        // distinctId, not installHash: log records must carry the same identity
        // as events so they surface on the right person profile.
        errorEvents.map((event) => desktopErrorRecord(batch, event, distinctId))
      )
    )
  }

  return c.json({ accepted: batch.events.length }, 202)
})

telemetry.use(
  '/logs',
  createRateLimiter({ maxRequests: 120, windowSeconds: 60, keyPrefix: 'telemetry-logs' })
)

// Redacted diagnostic log lines (client already ran redactLogLine) → PostHog
// Logs only, no D1/Analytics Engine write. Fire-and-forget, same privacy
// posture as /batch.
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
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId)
      .then((installHash) => {
        // Resolved distinct id, not the raw install hash, so these logs surface
        // on the right person profile once account resolution lands.
        const distinctId = resolveDistinctId({
          installHash,
          accountId: undefined,
          environment: c.env.ENVIRONMENT ?? 'unknown'
        })
        return pushPostHogLogs(
          c.env,
          batch.lines.map((line) => desktopLogRecord(line, meta, distinctId))
        )
      })
      // safeWaitUntil only guards the synchronous waitUntil() call, not this
      // promise — hashTelemetryId throws when TELEMETRY_HMAC_KEY is missing/
      // empty, which would otherwise surface as an unhandled rejection.
      .catch((error) => {
        logger.warn('Diagnostic log capture failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  )

  return c.json({ accepted: batch.lines.length }, 202)
})
