import { Hono } from 'hono'

import { IosBetaJoinRequestSchema } from '@memry/contracts/ios-beta-api'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import {
  addExternalBetaTester,
  addToIosBetaSegment,
  readAppStoreConnectConfig,
  tagIosBetaContact
} from '../services/ios-beta'
import { capturePostHogEvents } from '../services/posthog'
import { resolveDistinctId } from '../services/posthog-transform'
import { hashTelemetryId, resolveTelemetryAccountHash } from '../services/telemetry'
import type { AppContext } from '../types'

const logger = createLogger('IosBeta')

export const iosBeta = new Hono<AppContext>()

// Apple mails every address this route adds, so it stays far below what a person needs.
iosBeta.use(
  '/join',
  createRateLimiter({ maxRequests: 5, windowSeconds: 3600, keyPrefix: 'ios-beta' })
)

/**
 * The desktop "Join the iPhone beta" request. Unauthenticated so signed-out users can join.
 * The TestFlight invite is the outcome the user waits for, so only its failure fails the
 * request. The Resend list and the PostHog event are bookkeeping: a failure there is logged.
 * PostHog gets the install hash and the source, never the email.
 */
iosBeta.post('/join', async (c) => {
  const parsed = IosBetaJoinRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid iOS beta request', 400)
  }
  const { email, source, installId, appVersion, platform } = parsed.data

  const ascConfig = readAppStoreConnectConfig(c.env)
  if (!ascConfig) {
    logger.error('ASC_* TestFlight env is not configured')
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'iPhone beta invites are unavailable', 503)
  }

  const invite = await addExternalBetaTester(ascConfig, email)
  if (!invite.ok) {
    logger.error('App Store Connect beta tester error', {
      status: invite.status,
      detail: invite.detail
    })
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      'Could not send the TestFlight invite. Please try again.',
      502
    )
  }

  const installHash = installId
    ? await hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, installId).catch((error: unknown) => {
        logger.warn('Install id hashing failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        return undefined
      })
    : undefined

  const segment = await addToIosBetaSegment(c.env.RESEND_API_KEY, email)
  if (segment.ok) {
    const tagged = await tagIosBetaContact(c.env.RESEND_API_KEY, email, {
      signup_source: 'desktop',
      ...(installHash ? { install_hash: installHash } : {})
    })
    if (!tagged.ok) {
      logger.warn('Resend contact properties not set', {
        status: tagged.status,
        detail: tagged.detail
      })
    }
  } else {
    logger.error('Resend iOS beta segment error', {
      status: segment.status,
      detail: segment.detail
    })
  }

  if (installHash) {
    const accountHash = await resolveTelemetryAccountHash(
      c.req.header('Authorization'),
      c.env.JWT_PUBLIC_KEY,
      c.env.TELEMETRY_HMAC_KEY
    ).catch(() => undefined)
    const environment = c.env.ENVIRONMENT ?? 'unknown'
    await capturePostHogEvents(c.env, [
      {
        event: 'ios_beta_joined',
        distinct_id: resolveDistinctId({ installHash, accountHash, environment }),
        properties: {
          source,
          app_version: appVersion,
          platform,
          environment,
          $set: { ios_beta_joined: true }
        }
      }
    ])
  }

  return c.json({ success: true })
})
