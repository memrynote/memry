import { toErrorCode } from '@memry/contracts/telemetry-api'
import { requireDatabase } from '../../../database'
import { createLogger } from '../../../lib/logger'
import { trackMainError } from '../../../telemetry/diagnostics'
import { shouldEmitThrottled } from '../../../telemetry/throttle'
import type { CalendarSyncTarget } from '../../types'
import { syncLocalSourceToGoogleCalendar } from './sync-service'

const log = createLogger('Calendar:GoogleLocalEffects')

// This catch is the only error sink for the local→Google push path; throttle
// per failure mode (validate.ts pattern) since every local mutation retries it.
const PUSH_ERROR_THROTTLE_MS = 60_000

export function scheduleGoogleCalendarSourceSync(target: CalendarSyncTarget): void {
  void (async () => {
    try {
      await syncLocalSourceToGoogleCalendar(requireDatabase(), target)
    } catch (error) {
      if (error instanceof Error && error.message === 'Database not initialized') {
        return
      }

      log.warn('failed to reconcile local source with Google Calendar', {
        target,
        error
      })
      if (
        shouldEmitThrottled(`calendar:google_push:${toErrorCode(error)}`, PUSH_ERROR_THROTTLE_MS)
      ) {
        trackMainError('calendar', 'google_push', error)
      }
    }
  })()
}
