import { Hono } from 'hono'

import { DiagnosticReportSchema } from '@memry/contracts/diagnostics-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { desktopReportRecords, pushPostHogLogs } from '../services/posthog-logs'
import { hashTelemetryId } from '../services/telemetry'
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
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, report.installId).then((installHash) =>
      pushPostHogLogs(c.env, desktopReportRecords(report, installHash))
    )
  )

  return c.json({ incidentId: report.incidentId }, 202)
})
