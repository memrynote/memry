import { requireDatabase } from '../../database'
import { createLogger } from '../../lib/logger'
import type { CalendarSyncTarget } from '../types'
import { syncLocalSourceToGoogleCalendar } from './sync-service'

const log = createLogger('Calendar:GoogleLocalEffects')

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
    }
  })()
}
