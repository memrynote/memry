import { toErrorCode } from '@memry/contracts/telemetry-api'
import { requireDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import { trackMainError } from '../../telemetry/diagnostics'
import { shouldEmitThrottled } from '../../telemetry/throttle'
import type { CalendarSyncTarget } from '../types'
import { syncLocalSourceToProvider } from '../provider/write-dispatch'

const log = createLogger('Calendar:GoogleLocalEffects')

// This catch is the only error sink for the local→provider push path; throttle
// per failure mode (validate.ts pattern) since every local mutation retries it.
const PUSH_ERROR_THROTTLE_MS = 60_000

/**
 * Reconcile one local change with the calendar provider that owns it. The
 * name predates other writers; the push now goes to exactly the provider the
 * write route picks (#2372), which is Google for every install that only has
 * Google.
 */
export function scheduleGoogleCalendarSourceSync(target: CalendarSyncTarget): void {
  void (async () => {
    try {
      await syncLocalSourceToProvider(requireDatabase(), target)
    } catch (error) {
      if (error instanceof Error && error.message === 'Database not initialized') {
        return
      }

      log.warn('failed to reconcile local source with its calendar provider', {
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
