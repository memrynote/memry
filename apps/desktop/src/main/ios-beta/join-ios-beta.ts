import { app } from 'electron'

import type {
  IosBetaJoinInput,
  IosBetaJoinRequest,
  IosBetaJoinResult
} from '@memry/contracts/ios-beta-api'

import { createLogger } from '../lib/logger'
import { postToServer } from '../sync/http-client'
import { getValidAccessToken } from '../sync/token-manager'
import { getTelemetryRuntime } from '../telemetry/runtime'

const logger = createLogger('IosBeta')

/**
 * "Join the iPhone beta": the sync server adds the address to the TestFlight group (Apple
 * sends the invite) and to the iOS beta list. The install id rides along only while
 * telemetry is on, so a user who opted out is never linked to their email.
 */
export const joinIosBeta = async (input: IosBetaJoinInput): Promise<IosBetaJoinResult> => {
  const telemetry = getTelemetryRuntime()
  const request: IosBetaJoinRequest = {
    ...input,
    installId: telemetry?.getSettings().enabled ? telemetry.context.installId : undefined,
    appVersion: app.getVersion(),
    platform: process.platform
  }

  try {
    // Sent when signed in so the PostHog event lands on the account's person.
    const token = await getValidAccessToken().catch(() => null)
    await postToServer('/ios-beta/join', request, token ?? undefined)
    return { success: true }
  } catch (error) {
    logger.error('iPhone beta join failed', { error })
    return {
      success: false,
      error: error instanceof Error ? error.message : 'IOS_BETA_JOIN_FAILED'
    }
  }
}
