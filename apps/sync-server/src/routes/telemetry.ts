import { Hono } from 'hono'

import { TelemetryBatchSchema } from '@memry/contracts/telemetry-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { writeTelemetryBatch } from '../services/telemetry'
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
  return c.json(result, 202)
})
