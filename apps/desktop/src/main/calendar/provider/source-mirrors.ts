import { and, eq, inArray } from 'drizzle-orm'
import type { CalendarSourceRecord } from '@memry/contracts/calendar-api'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { emitCalendarChanged } from '../change-events'
import { mapCalendarSource } from '../calendar-source-record'
import {
  getCalendarSourceById,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import {
  syncCalendarBindingDelete,
  syncCalendarExternalEventDelete,
  syncCalendarSourceCreate,
  syncCalendarSourceUpdate
} from '../runtime-effects'

/** Save a source row, enqueue it for sync as a create or an update, and tell the renderer. */
export function upsertSyncedCalendarSource(
  db: DataDb,
  source: typeof calendarSources.$inferInsert
): CalendarSourceRecord {
  const existing = getCalendarSourceById(db, source.id)
  const saved = upsertCalendarSource(db, {
    ...source,
    createdAt: existing?.createdAt ?? source.createdAt
  })

  if (existing) {
    syncCalendarSourceUpdate(source.id)
  } else {
    syncCalendarSourceCreate(source.id)
  }

  emitCalendarChanged({ entityType: 'calendar_source', id: source.id })
  return mapCalendarSource(saved)
}

/**
 * Drop the local mirror of one or more calendar sources: the external events
 * pulled from them and the bindings tying Memry items to their remote events.
 *
 * Promoted events live in `calendar_events` and are the user's own copy, so
 * they deliberately stay — only the mirror of the remote calendar goes. This
 * runs both when a calendar is de-selected and when its account is
 * disconnected; in both cases nothing is left to refresh those rows, so
 * leaving them behind would strand them on the calendar view forever.
 */
export function purgeCalendarSourceMirrors(
  db: DataDb,
  provider: string,
  sources: (typeof calendarSources.$inferSelect)[]
): void {
  if (sources.length === 0) return

  const sourceIds = sources.map((source) => source.id)
  const remoteIds = sources.map((source) => source.remoteId)

  const externalRows = db
    .select()
    .from(calendarExternalEvents)
    .where(inArray(calendarExternalEvents.sourceId, sourceIds))
    .all()

  const bindingRows = db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.provider, provider),
        inArray(calendarBindings.remoteCalendarId, remoteIds)
      )
    )
    .all()

  if (externalRows.length === 0 && bindingRows.length === 0) return

  db.transaction((tx) => {
    if (externalRows.length > 0) {
      tx.delete(calendarExternalEvents)
        .where(
          inArray(
            calendarExternalEvents.id,
            externalRows.map((row) => row.id)
          )
        )
        .run()
    }

    if (bindingRows.length > 0) {
      tx.delete(calendarBindings)
        .where(
          inArray(
            calendarBindings.id,
            bindingRows.map((row) => row.id)
          )
        )
        .run()
    }
  })

  for (const row of externalRows) {
    syncCalendarExternalEventDelete(row.id, JSON.stringify(row))
    emitCalendarChanged({ entityType: 'calendar_external_event', id: row.id })
  }

  for (const row of bindingRows) {
    syncCalendarBindingDelete(row.id, JSON.stringify(row))
    emitCalendarChanged({ entityType: 'calendar_binding', id: row.id })
  }
}
