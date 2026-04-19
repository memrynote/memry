import { and, eq, isNull } from 'drizzle-orm'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import type { DataDb } from '../../database/types'
import type { CalendarSyncTarget } from '../types'
import { resolveDefaultGoogleAccountId } from './oauth'

function findAccountIdForCalendarRemoteId(db: DataDb, remoteCalendarId: string): string | null {
  const row = db
    .select({ accountId: calendarSources.accountId })
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, 'google'),
        eq(calendarSources.kind, 'calendar'),
        eq(calendarSources.remoteId, remoteCalendarId),
        isNull(calendarSources.archivedAt)
      )
    )
    .get()
  return row?.accountId ?? null
}

function findEventTargetCalendarId(db: DataDb, eventId: string): string | null {
  const row = db
    .select({ targetCalendarId: calendarEvents.targetCalendarId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .get()
  return row?.targetCalendarId ?? null
}

export function resolveTargetGoogleAccountId(
  db: DataDb,
  target: CalendarSyncTarget,
  existingBinding: typeof calendarBindings.$inferSelect | undefined
): string | null {
  if (existingBinding?.remoteCalendarId) {
    const accountId = findAccountIdForCalendarRemoteId(db, existingBinding.remoteCalendarId)
    if (accountId) return accountId
  }

  if (target.sourceType === 'event') {
    const targetCalendarId = findEventTargetCalendarId(db, target.sourceId)
    if (targetCalendarId) {
      const accountId = findAccountIdForCalendarRemoteId(db, targetCalendarId)
      if (accountId) return accountId
    }
  }

  return resolveDefaultGoogleAccountId(db)
}
