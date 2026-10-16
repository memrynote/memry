import { and, asc, eq, inArray } from 'drizzle-orm'
import type { CalendarLinkedNote, ListLinkedNotesInput } from '@memry/contracts/calendar-api'
import { encodeExternalEventRelationId } from '@memry/contracts/relation-uri'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { DataDb, IndexDb } from '../database'
import { getIncomingPropertyRefs } from '../database/queries/notes'

/**
 * The mirror rows a native event was promoted from. A note linked to a Google
 * event before the event was first opened points at the mirror, and the
 * event's card must still list it after promotion swapped the mirror for a
 * native event.
 */
function promotedMirrorIds(db: DataDb, eventId: string): string[] {
  return db
    .select({ id: calendarExternalEvents.id })
    .from(calendarBindings)
    .innerJoin(
      calendarSources,
      and(
        eq(calendarSources.provider, calendarBindings.provider),
        eq(calendarSources.remoteId, calendarBindings.remoteCalendarId)
      )
    )
    .innerJoin(
      calendarExternalEvents,
      and(
        eq(calendarExternalEvents.sourceId, calendarSources.id),
        eq(calendarExternalEvents.remoteEventId, calendarBindings.remoteEventId)
      )
    )
    .where(and(eq(calendarBindings.sourceType, 'event'), eq(calendarBindings.sourceId, eventId)))
    .all()
    .map((row) => row.id)
}

/** Notes whose relation properties link to one calendar item, by title. */
export function listLinkedNotes(
  dataDb: DataDb,
  indexDb: IndexDb,
  input: ListLinkedNotesInput
): CalendarLinkedNote[] {
  const mirrorIds =
    input.sourceType === 'event' ? promotedMirrorIds(dataDb, input.sourceId) : [input.sourceId]
  const refs = [
    ...(input.sourceType === 'event'
      ? getIncomingPropertyRefs(indexDb, 'event', input.sourceId)
      : []),
    ...mirrorIds.flatMap((id) =>
      getIncomingPropertyRefs(indexDb, 'external-event', encodeExternalEventRelationId(id))
    )
  ]
  const noteIds = [...new Set(refs.map((ref) => ref.sourceNoteId))]
  if (noteIds.length === 0) return []

  return indexDb
    .select({ id: noteCache.id, title: noteCache.title, emoji: noteCache.emoji })
    .from(noteCache)
    .where(inArray(noteCache.id, noteIds))
    .orderBy(asc(noteCache.title))
    .all()
}
