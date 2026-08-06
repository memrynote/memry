import { Hono } from 'hono'

import { DiagnosticReportSchema } from '@memry/contracts/diagnostics-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { desktopReportRecords, pushPostHogLogs } from '../services/posthog-logs'
import { resolveDistinctId } from '../services/posthog-transform'
import { hashTelemetryId, resolveTelemetryAccountHash } from '../services/telemetry'
import type { AppContext } from '../types'

const logger = createLogger('Diagnostics')

export const diagnostics = new Hono<AppContext>()

diagnostics.use(
  '/report',
  createRateLimiter({ maxRequests: 10, windowSeconds: 3600, keyPrefix: 'diagnostics' })
)

diagnostics.post('/report', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = DiagnosticReportSchema.safeParse(body)
  if (!parsed.success) {
    // Same privacy convention as /telemetry/batch: log path + zod code only, never values.
    logger.warn('Invalid diagnostic report', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid diagnostic report', 400)
  }

  const report = parsed.data
  safeWaitUntil(
    c,
    Promise.all([
      hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, report.installId),
      // The VERIFIED bearer, not report.accountId. The body field is
      // client-asserted, so trusting it would let any caller attribute an
      // incident report to another person's PostHog profile. Identity here
      // resolves exactly the way /telemetry/batch resolves it.
      resolveTelemetryAccountHash(
        c.req.header('Authorization'),
        c.env.JWT_PUBLIC_KEY,
        c.env.TELEMETRY_HMAC_KEY
      )
    ])
      .then(([installHash, accountHash]) => {
        // resolveDistinctId, not the bare installHash: the event and log paths
        // already resolve identity this way, and a report landing on a
        // different distinct_id than the events around it would split one
        // person's history across two profiles.
        const distinctId = resolveDistinctId({
          installHash,
          accountHash,
          environment: c.env.ENVIRONMENT ?? 'unknown'
        })
        return pushPostHogLogs(c.env, desktopReportRecords(report, distinctId))
      })
      // safeWaitUntil only guards the synchronous waitUntil() call, not this
      // promise — hashTelemetryId throws when TELEMETRY_HMAC_KEY is missing/
      // empty, which would otherwise surface as an unhandled rejection.
      .catch((error) => {
        logger.warn('Diagnostic report capture failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  )

  return c.json({ incidentId: report.incidentId }, 202)
})
