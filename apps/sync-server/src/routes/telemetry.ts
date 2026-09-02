import { Hono } from 'hono'

import { DiagnosticLogBatchSchema } from '@memry/contracts/diagnostics-api'
import { TelemetryBatchSchema } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { claimExceptionBudget } from '../services/exception-budget'
import { capturePostHogEvents } from '../services/posthog'
import { desktopErrorRecord, desktopLogRecord, pushPostHogLogs } from '../services/posthog-logs'
import {
  exceptionEvent,
  identifyEvent,
  isLegacyMutationDropNoise,
  productEvent,
  resolveDistinctId
} from '../services/posthog-transform'
import {
  hashTelemetryId,
  resolveTelemetryAccount,
  resolveTelemetryPlan
} from '../services/telemetry'
import { claimIdentifySession } from '../services/telemetry-identify'
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
  const [installHash, account] = await Promise.all([
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId),
    // /telemetry/* still bypasses the auth middleware — a bad or absent bearer
    // must never reject telemetry. resolveTelemetryAccount returns undefined in
    // that case and the batch reports anonymously against installHash. Its
    // accountHash is the HMAC of the account id, never the raw id.
    resolveTelemetryAccount(
      c.req.header('Authorization'),
      c.env.JWT_PUBLIC_KEY,
      c.env.TELEMETRY_HMAC_KEY
    )
  ])
  const accountHash = account?.accountHash

  // $identify merges the anonymous install person into the account person
  // PERMANENTLY, and the desktop flushes roughly every 30s. claimIdentifySession
  // is the once-per-session guard that keeps this to one merge per app session
  // instead of ~120/hour. It doubles as the guard for the billing-plan lookup
  // below: both are per-session facts, so one claim pays for both and the plan
  // read costs one D1 row per session rather than one per batch.
  const identifyClaimed = accountHash
    ? await claimIdentifySession(c.env.DB, batch.sessionId, accountHash)
    : false
  // Server-resolved, never client-supplied: the desktop does not send a plan and
  // must not be trusted to, since `free`/`pro` is exactly the kind of dimension a
  // tampered client would inflate.
  const plan =
    identifyClaimed && account ? await resolveTelemetryPlan(c.env.DB, account.userId) : undefined

  const ctx = {
    installHash,
    accountHash,
    environment: c.env.ENVIRONMENT ?? 'unknown',
    plan: plan?.plan,
    planStatus: plan?.planStatus
  }
  const distinctId = resolveDistinctId(ctx)

  // Pre-fix desktops (< 2026.821) ship the per-mutation drop tripwire
  // unthrottled; those events are dropped before ALL THREE sinks below, not
  // demoted — see isLegacyMutationDropNoise. The 202 still reports the raw
  // count so old clients keep flushing normally.
  const forwardable = batch.events.filter((event) => !isLegacyMutationDropNoise(batch, event))

  const events = forwardable.map((event) => productEvent(batch, event, ctx))
  let exceptions = forwardable
    .map((event) => exceptionEvent(batch, event, ctx))
    .filter((event): event is NonNullable<typeof event> => event !== null)
  if (exceptions.length > 0) {
    // Per-install hourly cap on the `$exception` stream only — the product
    // events and log lines for the same failures still forward, so a capped
    // install stays diagnosable while Error Tracking stays affordable.
    const granted = await claimExceptionBudget(c.env.DB, installHash, exceptions.length)
    if (granted < exceptions.length) exceptions = exceptions.slice(0, granted)
  }

  // identifyEvent still returns null for an anonymous batch, which is why the
  // claim above is only attempted when there is an account to merge to.
  const identify = identifyClaimed ? identifyEvent(batch, ctx) : null

  safeWaitUntil(
    c,
    capturePostHogEvents(c.env, [...(identify ? [identify] : []), ...events, ...exceptions])
  )

  // Desktop error events also become PostHog log lines (redacted stack frames
  // only — see TelemetryErrorDetailSchema) so they are searchable in the Logs tab.
  const errorEvents = forwardable.filter((event) => event.errorCode || event.error)
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
        // on the right person profile once account resolution lands here too.
        // Still anonymous: the desktop log shipper does not attach a bearer to
        // /telemetry/logs yet, so wiring the header read on this side alone
        // would be dead code. Tracked as a follow-up.
        const distinctId = resolveDistinctId({
          installHash,
          accountHash: undefined,
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
