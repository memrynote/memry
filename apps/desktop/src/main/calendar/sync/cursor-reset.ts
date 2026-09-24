import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged } from '../change-events'
import { upsertCalendarSource } from '../repositories/calendar-sources-repository'
import { syncCalendarSourceUpdate } from '../runtime-effects'
import { ProviderGoneError, classifyProviderError } from '../provider/errors'

const log = createLogger('Calendar:CursorReset')

/**
 * Pull a source incrementally; when the provider says the cursor is no longer
 * valid (`ProviderGoneError`: Google's 410, CalDAV's `valid-sync-token`, an
 * expired Graph delta link), clear the cursor on the synced source row and
 * pull again in full (#1393). Any other failure propagates unchanged.
 */
export async function pullWithCursorReset<T>(
  db: DataDb,
  providerId: string,
  source: CalendarSource,
  pull: (source: CalendarSource) => Promise<T>
): Promise<T> {
  try {
    return await pull(source)
  } catch (error) {
    if (
      !source.syncCursor ||
      !(classifyProviderError(providerId, error) instanceof ProviderGoneError)
    ) {
      throw error
    }
    log.warn('Sync cursor rejected; pulling the source in full', {
      providerId,
      sourceId: source.id
    })
    const reset = upsertCalendarSource(db, {
      ...source,
      syncCursor: null,
      syncStatus: 'pending',
      modifiedAt: new Date().toISOString()
    })
    syncCalendarSourceUpdate(reset.id)
    emitCalendarChanged({ entityType: 'calendar_source', id: reset.id })
    return await pull(reset)
  }
}
