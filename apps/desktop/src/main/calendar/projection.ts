import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, lt, or, sql } from 'drizzle-orm'
import type {
  CalendarProjectionBinding,
  CalendarProjectionEditability,
  CalendarProjectionItem,
  CalendarProjectionSourceMeta,
  CalendarRangeResponse,
  GetCalendarRangeInput
} from '@memry/contracts/calendar-api'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { DataDb } from '../database'

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function getDescriptionPreview(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > 280 ? `${value.slice(0, 277)}...` : value
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toLocalInstant(dateStr: string, timeStr: string | null): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hours, minutes] = (timeStr ?? '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString()
}

function toLocalAllDayEnd(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString()
}

function getLocalDueDateRange(
  input: GetCalendarRangeInput
): { startDate: string; endDate: string } | null {
  const start = new Date(input.startAt)
  const end = new Date(input.endAt)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return null
  }

  return {
    startDate: toLocalDateString(start),
    endDate: toLocalDateString(new Date(end.getTime() - 1))
  }
}

function toBinding(
  row: typeof calendarBindings.$inferSelect | undefined
): CalendarProjectionBinding | null {
  if (!row) return null

  return {
    provider: row.provider,
    remoteCalendarId: row.remoteCalendarId,
    remoteEventId: row.remoteEventId,
    ownershipMode: row.ownershipMode,
    writebackMode: row.writebackMode
  }
}

function loadBindingsBySource(
  db: DataDb,
  sourceType: typeof calendarBindings.$inferSelect.sourceType,
  sourceIds: string[]
): Map<string, CalendarProjectionBinding> {
  if (sourceIds.length === 0) return new Map()

  const rows = db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.sourceType, sourceType),
        inArray(calendarBindings.sourceId, sourceIds),
        isNull(calendarBindings.archivedAt)
      )
    )
    .all()

  return new Map(
    rows.map((row) => {
      const binding = toBinding(row)
      return [row.sourceId, binding!] as const
    })
  )
}

function nativeSource(title: string): CalendarProjectionSourceMeta {
  return {
    provider: null,
    calendarSourceId: null,
    title,
    color: null,
    kind: null,
    isMemryManaged: true
  }
}

function externalSource(row: typeof calendarSources.$inferSelect): CalendarProjectionSourceMeta {
  return {
    provider: row.provider,
    calendarSourceId: row.id,
    title: row.title,
    color: row.color ?? null,
    kind: row.kind,
    isMemryManaged: row.isMemryManaged
  }
}

function sortProjectionItems(items: CalendarProjectionItem[]): CalendarProjectionItem[] {
  return [...items].sort((left, right) => {
    if (left.startAt !== right.startAt) return left.startAt.localeCompare(right.startAt)
    return left.projectionId.localeCompare(right.projectionId)
  })
}

function loadMemryEvents(db: DataDb, input: GetCalendarRangeInput): CalendarProjectionItem[] {
  const rows = db
    .select()
    .from(calendarEvents)
    .where(
      and(
        isNull(calendarEvents.archivedAt),
        sql`${calendarEvents.startAt} < ${input.endAt}`,
        sql`coalesce(${calendarEvents.endAt}, ${calendarEvents.startAt}) >= ${input.startAt}`
      )
    )
    .orderBy(asc(calendarEvents.startAt))
    .all()

  const bindings = loadBindingsBySource(
    db,
    'event',
    rows.map((row) => row.id)
  )

  const editability: CalendarProjectionEditability = {
    canMove: true,
    canResize: true,
    canEditText: true,
    canDelete: true
  }

  return rows.map((row) => ({
    projectionId: `event:${row.id}`,
    sourceType: 'event',
    sourceId: row.id,
    title: row.title,
    descriptionPreview: getDescriptionPreview(row.description),
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    isAllDay: row.isAllDay,
    timezone: row.timezone,
    visualType: 'event',
    editability,
    source: nativeSource('Memry'),
    binding: bindings.get(row.id) ?? null
  }))
}

function loadTaskItems(db: DataDb, input: GetCalendarRangeInput): CalendarProjectionItem[] {
  const dueRange = getLocalDueDateRange(input)
  if (!dueRange) return []

  const rows = db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        gte(tasks.dueDate, dueRange.startDate),
        lte(tasks.dueDate, dueRange.endDate),
        isNull(tasks.completedAt),
        isNull(tasks.archivedAt)
      )
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.dueTime), asc(tasks.position))
    .all()

  const bindings = loadBindingsBySource(
    db,
    'task',
    rows.map((row) => row.id)
  )

  const editability: CalendarProjectionEditability = {
    canMove: true,
    canResize: false,
    canEditText: true,
    canDelete: true
  }

  return rows.map((row) => {
    const isAllDay = !row.dueTime

    return {
      projectionId: `task:${row.id}`,
      sourceType: 'task',
      sourceId: row.id,
      title: row.title,
      descriptionPreview: getDescriptionPreview(row.description),
      startAt: toLocalInstant(row.dueDate!, row.dueTime ?? null),
      endAt: isAllDay ? toLocalAllDayEnd(row.dueDate!) : null,
      isAllDay,
      timezone: LOCAL_TIMEZONE,
      visualType: 'task',
      editability,
      source: nativeSource('Memry Tasks'),
      binding: bindings.get(row.id) ?? null
    }
  })
}

function loadReminderItems(db: DataDb, input: GetCalendarRangeInput): CalendarProjectionItem[] {
  const rows = db
    .select()
    .from(reminders)
    .where(
      or(
        and(
          eq(reminders.status, 'pending'),
          gte(reminders.remindAt, input.startAt),
          lt(reminders.remindAt, input.endAt)
        ),
        and(
          eq(reminders.status, 'snoozed'),
          isNotNull(reminders.snoozedUntil),
          gte(reminders.snoozedUntil, input.startAt),
          lt(reminders.snoozedUntil, input.endAt)
        )
      )
    )
    .orderBy(asc(reminders.remindAt))
    .all()

  const bindings = loadBindingsBySource(
    db,
    'reminder',
    rows.map((row) => row.id)
  )

  const editability: CalendarProjectionEditability = {
    canMove: true,
    canResize: false,
    canEditText: true,
    canDelete: true
  }

  return rows.map((row) => {
    const effectiveStartAt =
      row.status === 'snoozed' && row.snoozedUntil ? row.snoozedUntil : row.remindAt

    return {
      projectionId: `reminder:${row.id}`,
      sourceType: 'reminder',
      sourceId: row.id,
      title: row.title?.trim() || 'Reminder',
      descriptionPreview: getDescriptionPreview(row.note ?? row.highlightText),
      startAt: effectiveStartAt,
      endAt: null,
      isAllDay: false,
      timezone: LOCAL_TIMEZONE,
      visualType: 'reminder',
      editability,
      source: nativeSource('Memry Reminders'),
      binding: bindings.get(row.id) ?? null
    }
  })
}

function loadInboxSnoozeItems(db: DataDb, input: GetCalendarRangeInput): CalendarProjectionItem[] {
  const rows = db
    .select()
    .from(inboxItems)
    .where(
      and(
        isNotNull(inboxItems.snoozedUntil),
        gte(inboxItems.snoozedUntil, input.startAt),
        lt(inboxItems.snoozedUntil, input.endAt),
        isNull(inboxItems.filedAt),
        isNull(inboxItems.archivedAt)
      )
    )
    .orderBy(asc(inboxItems.snoozedUntil))
    .all()

  const bindings = loadBindingsBySource(
    db,
    'inbox_snooze',
    rows.map((row) => row.id)
  )

  const editability: CalendarProjectionEditability = {
    canMove: true,
    canResize: false,
    canEditText: false,
    canDelete: true
  }

  return rows.map((row) => ({
    projectionId: `inbox_snooze:${row.id}`,
    sourceType: 'inbox_snooze',
    sourceId: row.id,
    title: row.title,
    descriptionPreview: getDescriptionPreview(row.content),
    startAt: row.snoozedUntil!,
    endAt: null,
    isAllDay: false,
    timezone: LOCAL_TIMEZONE,
    visualType: 'snooze',
    editability,
    source: nativeSource('Memry Inbox'),
    binding: bindings.get(row.id) ?? null
  }))
}

function loadExternalEvents(db: DataDb, input: GetCalendarRangeInput): CalendarProjectionItem[] {
  const rows = db
    .select({
      event: calendarExternalEvents,
      source: calendarSources
    })
    .from(calendarExternalEvents)
    .innerJoin(calendarSources, eq(calendarExternalEvents.sourceId, calendarSources.id))
    .where(
      and(
        isNull(calendarExternalEvents.archivedAt),
        isNull(calendarSources.archivedAt),
        sql`${calendarExternalEvents.startAt} < ${input.endAt}`,
        sql`coalesce(${calendarExternalEvents.endAt}, ${calendarExternalEvents.startAt}) >= ${input.startAt}`,
        input.includeUnselectedSources ? undefined : eq(calendarSources.isSelected, true)
      )
    )
    .orderBy(asc(calendarExternalEvents.startAt))
    .all()

  const editability: CalendarProjectionEditability = {
    canMove: true,
    canResize: true,
    canEditText: true,
    canDelete: true
  }

  return rows.map(({ event, source }) => ({
    projectionId: `external_event:${event.id}`,
    sourceType: 'external_event',
    sourceId: event.id,
    title: event.title,
    descriptionPreview: getDescriptionPreview(event.description),
    startAt: event.startAt,
    endAt: event.endAt ?? null,
    isAllDay: event.isAllDay,
    timezone: event.timezone ?? source.timezone ?? LOCAL_TIMEZONE,
    visualType: 'external_event',
    editability,
    source: externalSource(source),
    binding: null
  }))
}

export function getCalendarRangeProjection(
  db: DataDb,
  input: GetCalendarRangeInput
): CalendarRangeResponse {
  const items = sortProjectionItems([
    ...loadMemryEvents(db, input),
    ...loadTaskItems(db, input),
    ...loadReminderItems(db, input),
    ...loadInboxSnoozeItems(db, input),
    ...loadExternalEvents(db, input)
  ])

  return { items }
}
