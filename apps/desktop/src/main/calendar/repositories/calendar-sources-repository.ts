import { and, asc, eq, isNull } from 'drizzle-orm'
import {
  calendarSources,
  type CalendarSource,
  type CalendarSourceKind,
  type NewCalendarSource
} from '@memry/db-schema/schema/calendar-sources'
import {
  calendarBindings,
  type CalendarBinding,
  type CalendarBindingSourceType,
  type NewCalendarBinding
} from '@memry/db-schema/schema/calendar-bindings'
import type { DataDb } from '../../database/types'

export function upsertCalendarSource(db: DataDb, source: NewCalendarSource): CalendarSource {
  const existing = db.select().from(calendarSources).where(eq(calendarSources.id, source.id)).get()

  if (existing) {
    db.update(calendarSources).set(source).where(eq(calendarSources.id, source.id)).run()
  } else {
    db.insert(calendarSources).values(source).run()
  }

  return db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.id, source.id))
    .get() as CalendarSource
}

export function getCalendarSourceById(db: DataDb, id: string): CalendarSource | undefined {
  return db.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
}

export function listCalendarSources(
  db: DataDb,
  options: { provider?: string; kind?: CalendarSourceKind; selectedOnly?: boolean } = {}
): CalendarSource[] {
  const conditions = [isNull(calendarSources.archivedAt)]

  if (options.provider) {
    conditions.push(eq(calendarSources.provider, options.provider))
  }
  if (options.kind) {
    conditions.push(eq(calendarSources.kind, options.kind))
  }
  if (options.selectedOnly) {
    conditions.push(eq(calendarSources.isSelected, true))
  }

  return db
    .select()
    .from(calendarSources)
    .where(and(...conditions))
    .orderBy(asc(calendarSources.title))
    .all()
}

export function upsertCalendarBinding(db: DataDb, binding: NewCalendarBinding): CalendarBinding {
  const existing = db
    .select()
    .from(calendarBindings)
    .where(eq(calendarBindings.id, binding.id))
    .get()

  if (existing) {
    db.update(calendarBindings).set(binding).where(eq(calendarBindings.id, binding.id)).run()
  } else {
    db.insert(calendarBindings).values(binding).run()
  }

  return db
    .select()
    .from(calendarBindings)
    .where(eq(calendarBindings.id, binding.id))
    .get() as CalendarBinding
}

export function listCalendarBindingsForSource(
  db: DataDb,
  sourceType: CalendarBindingSourceType,
  sourceId: string
): CalendarBinding[] {
  return db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.sourceType, sourceType),
        eq(calendarBindings.sourceId, sourceId),
        isNull(calendarBindings.archivedAt)
      )
    )
    .all()
}

export function findCalendarBindingByRemoteEvent(
  db: DataDb,
  provider: string,
  remoteCalendarId: string,
  remoteEventId: string
): CalendarBinding | undefined {
  return db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.provider, provider),
        eq(calendarBindings.remoteCalendarId, remoteCalendarId),
        eq(calendarBindings.remoteEventId, remoteEventId),
        isNull(calendarBindings.archivedAt)
      )
    )
    .get()
}
