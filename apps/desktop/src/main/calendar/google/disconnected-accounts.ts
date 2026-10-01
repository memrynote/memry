import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged } from '../change-events'
import { purgeCalendarSourceMirrors } from '../provider/source-mirrors'
import { syncCalendarSourceUpdate } from '../runtime-effects'

const log = createLogger('Calendar:GoogleDisconnectedAccounts')

/**
 * True when the user disconnected `accountId`: its account row exists and every
 * copy of it is tombstoned. An account with no row at all is not "disconnected"
 * (a fresh connect writes the row first, legacy rows may predate it).
 */
export function isGoogleAccountDisconnected(db: DataDb, accountId: string): boolean {
  const accountRows = db
    .select({ archivedAt: calendarSources.archivedAt })
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, 'google'),
        eq(calendarSources.kind, 'account'),
        eq(calendarSources.accountId, accountId)
      )
    )
    .all()
  return accountRows.length > 0 && accountRows.every((row) => row.archivedAt !== null)
}

/**
 * Drop the mirrors of `sources` and tombstone them. Mirrors go first: if a crash
 * lands between the two the sources stay unarchived with nothing under them,
 * which the next disconnect or a rediscovery both resolve — the reverse order
 * would strand events under a source no longer listed anywhere.
 */
export function archiveGoogleSources(
  db: DataDb,
  provider: string,
  sources: CalendarSource[]
): void {
  const live = sources.filter((source) => !source.archivedAt)
  if (live.length === 0) return

  purgeCalendarSourceMirrors(db, provider, live)

  const now = new Date().toISOString()
  db.transaction((tx) => {
    for (const source of live) {
      tx.update(calendarSources)
        .set({ archivedAt: now, modifiedAt: now })
        .where(eq(calendarSources.id, source.id))
        .run()
    }
  })

  for (const source of live) {
    syncCalendarSourceUpdate(source.id)
    emitCalendarChanged({ entityType: 'calendar_source', id: source.id })
  }
}

/**
 * Archive live Google calendars whose account was disconnected. Older versions
 * let a sync pass that was in flight during a disconnect write the calendar back
 * with `archivedAt: null` (#2516, #2555). With the account gone nothing syncs or
 * lists that calendar any more, so its events stayed on the calendar view for
 * good. Reconnecting the account revives the calendars through discovery.
 */
export function archiveCalendarsOfDisconnectedGoogleAccounts(db: DataDb): void {
  const liveCalendars = db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, 'google'),
        eq(calendarSources.kind, 'calendar'),
        isNull(calendarSources.archivedAt),
        isNotNull(calendarSources.accountId)
      )
    )
    .all()
  if (liveCalendars.length === 0) return

  const accountIds = [...new Set(liveCalendars.map((source) => source.accountId as string))]
  const disconnected = new Set(
    accountIds.filter((accountId) => isGoogleAccountDisconnected(db, accountId))
  )
  const orphaned = liveCalendars.filter(
    (source) => source.accountId !== null && disconnected.has(source.accountId)
  )
  if (orphaned.length === 0) return

  log.info('Archiving calendars left behind by a disconnected Google account', {
    count: orphaned.length
  })
  archiveGoogleSources(db, 'google', orphaned)
}
