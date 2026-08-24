import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type {
  CalendarProjectionBinding,
  CalendarProjectionEditability,
  CalendarProjectionItem,
  CalendarProjectionSourceMeta,
  CalendarRangeResponse,
  GetCalendarRangeInput
} from '@memry/contracts/calendar-api'
import {
  calendarBindings,
  calendarEvents,
  calendarExternalEvents,
  calendarSources,
  inboxItems,
  reminders,
  settings as settingsTable,
  tasks,
  type CalendarBindingSourceType,
  type CalendarConferenceData,
  type CalendarReminders,
  type CalendarVisibility
} from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'
import { createId } from './ids.ts'

export interface CalendarEventRecord {
  id: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  timezone: string
  isAllDay: boolean
  recurrenceRule: Record<string, unknown> | null
  recurrenceExceptions: string[] | null
  attendees: unknown[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  targetCalendarId: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface CreateCalendarEventInput {
  title: string
  startAt: string
  endAt?: string | null
  timezone?: string
  description?: string | null
  location?: string | null
  isAllDay?: boolean
  recurrenceRule?: Record<string, unknown> | null
  recurrenceExceptions?: string[] | null
  targetCalendarId?: string | null
}

export interface UpdateCalendarEventInput {
  title?: string
  startAt?: string
  endAt?: string | null
  timezone?: string
  description?: string | null
  location?: string | null
  isAllDay?: boolean
  recurrenceRule?: Record<string, unknown> | null
  recurrenceExceptions?: string[] | null
  targetCalendarId?: string | null
}

export interface ListCalendarEventsOptions {
  includeArchived?: boolean
  start?: string
  end?: string
}

export interface CalendarSourceRecord {
  id: string
  provider: string
  kind: 'account' | 'calendar'
  accountId: string | null
  remoteId: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
  isSelected: boolean
  isMemryManaged: boolean
  syncStatus: string
  lastSyncedAt: string | null
  lastError: string | null
  archivedAt: string | null
}

export interface CalendarExternalEventRecord {
  id: string
  sourceId: string
  remoteEventId: string
  remoteEtag: string | null
  remoteUpdatedAt: string | null
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  timezone: string | null
  isAllDay: boolean
  status: string
  recurrenceRule: Record<string, unknown> | null
  attendees: unknown[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  rawPayload: Record<string, unknown> | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface ListCalendarExternalEventsOptions {
  sourceId?: string
  includeArchived?: boolean
  start?: string
  end?: string
}

export interface CalendarBindingRecord {
  id: string
  sourceType: string
  sourceId: string
  provider: string
  remoteCalendarId: string
  remoteEventId: string
  ownershipMode: string
  writebackMode: string
  remoteVersion: string | null
  lastLocalSnapshot: Record<string, unknown> | null
  archivedAt: string | null
  syncedAt: string | null
  createdAt: string
  modifiedAt: string
}

export interface ListCalendarBindingsOptions {
  sourceType?: string
  sourceId?: string
  provider?: string
  includeArchived?: boolean
}

export interface CalendarGoogleSettings {
  defaultTargetCalendarId: string | null
  onboardingCompleted: boolean
  promoteConfirmDismissed: boolean
}

export interface ListCalendarSourcesOptions {
  provider?: string
  kind?: 'account' | 'calendar'
  selectedOnly?: boolean
}

export interface CalendarService {
  events: {
    create(input: CreateCalendarEventInput): Promise<CalendarEventRecord>
    get(id: string): Promise<CalendarEventRecord | null>
    list(options?: ListCalendarEventsOptions): Promise<CalendarEventRecord[]>
    update(id: string, input: UpdateCalendarEventInput): Promise<CalendarEventRecord>
    delete(id: string): Promise<boolean>
  }
  sources: {
    list(options?: ListCalendarSourcesOptions): Promise<{ sources: CalendarSourceRecord[] }>
    updateSelection(
      id: string,
      isSelected: boolean
    ): Promise<{ success: boolean; source: CalendarSourceRecord | null }>
  }
  external: {
    get(id: string): Promise<CalendarExternalEventRecord | null>
    list(
      options?: ListCalendarExternalEventsOptions
    ): Promise<{ events: CalendarExternalEventRecord[] }>
    promote(id: string): Promise<{ success: boolean; eventId: string | null }>
  }
  bindings: {
    get(id: string): Promise<CalendarBindingRecord | null>
    list(options?: ListCalendarBindingsOptions): Promise<{ bindings: CalendarBindingRecord[] }>
  }
  providerStatus(input: {
    provider: string
    accountId?: string
  }): Promise<{ provider: string; accountId?: string; connected: boolean; sourceCount: number }>
  range(input: GetCalendarRangeInput): Promise<CalendarRangeResponse>
  googleSettings(): Promise<CalendarGoogleSettings>
  setDefaultGoogleCalendar(
    calendarId: string | null,
    markOnboardingComplete?: boolean
  ): Promise<{ success: boolean }>
}

function nowIso(): string {
  return new Date().toISOString()
}

function toEvent(row: typeof calendarEvents.$inferSelect): CalendarEventRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.startAt,
    endAt: row.endAt,
    timezone: row.timezone,
    isAllDay: row.isAllDay,
    recurrenceRule: row.recurrenceRule ?? null,
    recurrenceExceptions: row.recurrenceExceptions ?? null,
    attendees: row.attendees ?? null,
    reminders: row.reminders ?? null,
    visibility: row.visibility ?? null,
    colorId: row.colorId,
    conferenceData: row.conferenceData ?? null,
    targetCalendarId: row.targetCalendarId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function toSource(row: typeof calendarSources.$inferSelect): CalendarSourceRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    accountId: row.accountId,
    remoteId: row.remoteId,
    title: row.title,
    timezone: row.timezone,
    color: row.color,
    isPrimary: row.isPrimary,
    isSelected: row.isSelected,
    isMemryManaged: row.isMemryManaged,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    archivedAt: row.archivedAt
  }
}

function toExternalEvent(
  row: typeof calendarExternalEvents.$inferSelect
): CalendarExternalEventRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    remoteEventId: row.remoteEventId,
    remoteEtag: row.remoteEtag,
    remoteUpdatedAt: row.remoteUpdatedAt,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.startAt,
    endAt: row.endAt,
    timezone: row.timezone,
    isAllDay: row.isAllDay,
    status: row.status,
    recurrenceRule: row.recurrenceRule ?? null,
    attendees: row.attendees ?? null,
    reminders: row.reminders ?? null,
    visibility: row.visibility ?? null,
    colorId: row.colorId,
    conferenceData: row.conferenceData ?? null,
    rawPayload: row.rawPayload ?? null,
    archivedAt: row.archivedAt,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function toBinding(row: typeof calendarBindings.$inferSelect): CalendarBindingRecord {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    provider: row.provider,
    remoteCalendarId: row.remoteCalendarId,
    remoteEventId: row.remoteEventId,
    ownershipMode: row.ownershipMode,
    writebackMode: row.writebackMode,
    remoteVersion: row.remoteVersion,
    lastLocalSnapshot: row.lastLocalSnapshot ?? null,
    archivedAt: row.archivedAt,
    syncedAt: row.syncedAt,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

const calendarGoogleSettingsKey = 'calendar.google'
const calendarGoogleSettingsDefaults: CalendarGoogleSettings = {
  defaultTargetCalendarId: null,
  onboardingCompleted: false,
  promoteConfirmDismissed: false
}
const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function readCalendarGoogleSettings(dataDb: DataDb): CalendarGoogleSettings {
  const row = dataDb
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, calendarGoogleSettingsKey))
    .get()
  if (!row) return { ...calendarGoogleSettingsDefaults }

  try {
    return {
      ...calendarGoogleSettingsDefaults,
      ...(JSON.parse(row.value) as Partial<CalendarGoogleSettings>)
    }
  } catch {
    return { ...calendarGoogleSettingsDefaults }
  }
}

function descriptionPreview(value: string | null | undefined): string | null {
  if (!value) return null
  return value.length > 280 ? `${value.slice(0, 277)}...` : value
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localInstant(dateStr: string, timeStr: string | null): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hours, minutes] = (timeStr ?? '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString()
}

function localAllDayEnd(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString()
}

function dueDateRange(input: GetCalendarRangeInput): { startDate: string; endDate: string } | null {
  const start = new Date(input.startAt)
  const end = new Date(input.endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  return {
    startDate: localDateString(start),
    endDate: localDateString(new Date(end.getTime() - 1))
  }
}

function projectionBinding(
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

function bindingsBySource(
  dataDb: DataDb,
  sourceType: CalendarBindingSourceType,
  sourceIds: string[]
): Map<string, CalendarProjectionBinding> {
  if (sourceIds.length === 0) return new Map()
  const rows = dataDb
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
    rows.flatMap((row) => {
      const binding = projectionBinding(row)
      return binding ? [[row.sourceId, binding] as const] : []
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

function sourceMeta(row: typeof calendarSources.$inferSelect): CalendarProjectionSourceMeta {
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

function calendarRange(dataDb: DataDb, input: GetCalendarRangeInput): CalendarRangeResponse {
  const editableEvent: CalendarProjectionEditability = {
    canMove: true,
    canResize: true,
    canEditText: true,
    canDelete: true
  }
  const editableInstant: CalendarProjectionEditability = {
    canMove: true,
    canResize: false,
    canEditText: true,
    canDelete: true
  }

  const memryEvents = dataDb
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
  const eventBindings = bindingsBySource(
    dataDb,
    'event',
    memryEvents.map((event) => event.id)
  )
  const eventItems = memryEvents.map(
    (event): CalendarProjectionItem => ({
      projectionId: `event:${event.id}`,
      sourceType: 'event',
      sourceId: event.id,
      title: event.title,
      descriptionPreview: descriptionPreview(event.description),
      startAt: event.startAt,
      endAt: event.endAt ?? null,
      isAllDay: event.isAllDay,
      timezone: event.timezone,
      visualType: 'event',
      editability: editableEvent,
      source: nativeSource('Memry'),
      binding: eventBindings.get(event.id) ?? null,
      snoozeOffsetMinutes: null
    })
  )

  const taskRange = dueDateRange(input)
  const taskRows = taskRange
    ? dataDb
        .select()
        .from(tasks)
        .where(
          and(
            isNotNull(tasks.dueDate),
            gte(tasks.dueDate, taskRange.startDate),
            lte(tasks.dueDate, taskRange.endDate),
            isNull(tasks.completedAt),
            isNull(tasks.archivedAt)
          )
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.dueTime), asc(tasks.position))
        .all()
    : []
  const taskBindings = bindingsBySource(
    dataDb,
    'task',
    taskRows.map((task) => task.id)
  )
  const taskItems = taskRows.map((task): CalendarProjectionItem => {
    const isAllDay = !task.dueTime
    return {
      projectionId: `task:${task.id}`,
      sourceType: 'task',
      sourceId: task.id,
      title: task.title,
      descriptionPreview: descriptionPreview(task.description),
      startAt: localInstant(task.dueDate!, task.dueTime ?? null),
      endAt: isAllDay ? localAllDayEnd(task.dueDate!) : null,
      isAllDay,
      timezone: localTimezone,
      visualType: 'task',
      editability: editableInstant,
      source: nativeSource('Memry Tasks'),
      binding: taskBindings.get(task.id) ?? null,
      snoozeOffsetMinutes: null
    }
  })

  const reminderRows = dataDb
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
  const reminderBindings = bindingsBySource(
    dataDb,
    'reminder',
    reminderRows.map((reminder) => reminder.id)
  )
  const reminderItems = reminderRows.map((reminder): CalendarProjectionItem => {
    const isSnoozed = reminder.status === 'snoozed' && !!reminder.snoozedUntil
    const startAt = isSnoozed ? reminder.snoozedUntil! : reminder.remindAt
    const snoozeOffsetMinutes = isSnoozed
      ? Math.round(
          (new Date(reminder.snoozedUntil!).getTime() - new Date(reminder.remindAt).getTime()) /
            60000
        )
      : null
    return {
      projectionId: `reminder:${reminder.id}`,
      sourceType: 'reminder',
      sourceId: reminder.id,
      title: reminder.title?.trim() || 'Reminder',
      descriptionPreview: descriptionPreview(reminder.note ?? reminder.highlightText),
      startAt,
      endAt: null,
      isAllDay: false,
      timezone: localTimezone,
      visualType: 'reminder',
      editability: editableInstant,
      source: nativeSource('Memry Reminders'),
      binding: reminderBindings.get(reminder.id) ?? null,
      snoozeOffsetMinutes
    }
  })

  const snoozedInboxRows = dataDb
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
  const snoozeBindings = bindingsBySource(
    dataDb,
    'inbox_snooze',
    snoozedInboxRows.map((item) => item.id)
  )
  const snoozeItems = snoozedInboxRows.map(
    (item): CalendarProjectionItem => ({
      projectionId: `inbox_snooze:${item.id}`,
      sourceType: 'inbox_snooze',
      sourceId: item.id,
      title: item.title,
      descriptionPreview: descriptionPreview(item.content),
      startAt: item.snoozedUntil!,
      endAt: null,
      isAllDay: false,
      timezone: localTimezone,
      visualType: 'snooze',
      editability: { ...editableInstant, canEditText: false },
      source: nativeSource('Memry Inbox'),
      binding: snoozeBindings.get(item.id) ?? null,
      snoozeOffsetMinutes: null
    })
  )

  const externalRows = dataDb
    .select({ event: calendarExternalEvents, source: calendarSources })
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
  const externalItems = externalRows.map(
    ({ event, source }): CalendarProjectionItem => ({
      projectionId: `external_event:${event.id}`,
      sourceType: 'external_event',
      sourceId: event.id,
      title: event.title,
      descriptionPreview: descriptionPreview(event.description),
      startAt: event.startAt,
      endAt: event.endAt ?? null,
      isAllDay: event.isAllDay,
      timezone: event.timezone ?? source.timezone ?? localTimezone,
      visualType: 'external_event',
      editability: editableEvent,
      source: sourceMeta(source),
      binding: null,
      snoozeOffsetMinutes: null
    })
  )

  return {
    items: sortProjectionItems([
      ...eventItems,
      ...taskItems,
      ...reminderItems,
      ...snoozeItems,
      ...externalItems
    ])
  }
}

export function createCalendarService(dataDb: DataDb): CalendarService {
  return {
    events: {
      async create(input) {
        const title = input.title.trim()
        if (!title) throw new Error('Calendar event title is required')
        if (!input.startAt.trim()) throw new Error('Calendar event start is required')

        const time = nowIso()
        const id = createId('calendar')
        dataDb
          .insert(calendarEvents)
          .values({
            id,
            title,
            description: input.description ?? null,
            location: input.location ?? null,
            startAt: input.startAt,
            endAt: input.endAt ?? null,
            timezone: input.timezone ?? 'UTC',
            isAllDay: input.isAllDay ?? false,
            recurrenceRule: input.recurrenceRule ?? null,
            recurrenceExceptions: input.recurrenceExceptions ?? null,
            targetCalendarId: input.targetCalendarId ?? null,
            createdAt: time,
            modifiedAt: time
          })
          .run()

        const event = await this.get(id)
        if (!event) throw new Error('Calendar event not found after create')
        return event
      },

      async get(id) {
        const row = dataDb.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
        return row ? toEvent(row) : null
      },

      async list(options = {}) {
        const rows = dataDb.select().from(calendarEvents).orderBy(asc(calendarEvents.startAt)).all()
        return rows
          .filter((event) => options.includeArchived || !event.archivedAt)
          .filter((event) => !options.start || event.startAt >= options.start)
          .filter((event) => !options.end || event.startAt <= options.end)
          .map(toEvent)
      },

      async update(id, input) {
        const row = dataDb
          .update(calendarEvents)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
            ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.isAllDay !== undefined ? { isAllDay: input.isAllDay } : {}),
            ...(input.recurrenceRule !== undefined ? { recurrenceRule: input.recurrenceRule } : {}),
            ...(input.recurrenceExceptions !== undefined
              ? { recurrenceExceptions: input.recurrenceExceptions }
              : {}),
            ...(input.targetCalendarId !== undefined
              ? { targetCalendarId: input.targetCalendarId }
              : {}),
            modifiedAt: nowIso()
          })
          .where(eq(calendarEvents.id, id))
          .returning()
          .get()
        if (!row) throw new Error(`Calendar event not found: ${id}`)
        return toEvent(row)
      },

      async delete(id) {
        dataDb.delete(calendarEvents).where(eq(calendarEvents.id, id)).run()
        return true
      }
    },

    sources: {
      async list(options = {}) {
        const sources = dataDb
          .select()
          .from(calendarSources)
          .orderBy(asc(calendarSources.title))
          .all()
          .filter((source) => !source.archivedAt)
          .filter((source) => !options.provider || source.provider === options.provider)
          .filter((source) => !options.kind || source.kind === options.kind)
          .filter((source) => !options.selectedOnly || source.isSelected)
          .map(toSource)
        return { sources }
      },

      async updateSelection(id, isSelected) {
        const row = dataDb
          .update(calendarSources)
          .set({ isSelected, modifiedAt: nowIso() })
          .where(eq(calendarSources.id, id))
          .returning()
          .get()
        return { success: !!row, source: row ? toSource(row) : null }
      }
    },

    external: {
      async get(id) {
        const row = dataDb
          .select()
          .from(calendarExternalEvents)
          .where(eq(calendarExternalEvents.id, id))
          .get()
        return row ? toExternalEvent(row) : null
      },

      async list(options = {}) {
        const events = dataDb
          .select()
          .from(calendarExternalEvents)
          .orderBy(asc(calendarExternalEvents.startAt))
          .all()
          .filter((event) => options.includeArchived || !event.archivedAt)
          .filter((event) => !options.sourceId || event.sourceId === options.sourceId)
          .filter((event) => !options.start || event.startAt >= options.start)
          .filter((event) => !options.end || event.startAt <= options.end)
          .map(toExternalEvent)
        return { events }
      },

      async promote(id) {
        const mirror = dataDb
          .select()
          .from(calendarExternalEvents)
          .where(eq(calendarExternalEvents.id, id))
          .get()
        if (!mirror) throw new Error(`External calendar event not found: ${id}`)

        const source = dataDb
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, mirror.sourceId))
          .get()
        if (!source) {
          throw new Error(
            `External calendar event ${id} references missing source ${mirror.sourceId}`
          )
        }

        const existingBinding = dataDb
          .select()
          .from(calendarBindings)
          .all()
          .find(
            (binding) =>
              !binding.archivedAt &&
              binding.provider === source.provider &&
              binding.remoteCalendarId === source.remoteId &&
              binding.remoteEventId === mirror.remoteEventId
          )
        const time = nowIso()

        if (existingBinding) {
          if (!mirror.archivedAt) {
            dataDb
              .update(calendarExternalEvents)
              .set({ archivedAt: time, modifiedAt: time })
              .where(eq(calendarExternalEvents.id, mirror.id))
              .run()
          }
          return { success: true, eventId: existingBinding.sourceId }
        }

        const eventId = createId('calendar')
        const bindingId = createId('calendar_binding')
        dataDb
          .insert(calendarEvents)
          .values({
            id: eventId,
            title: mirror.title,
            description: mirror.description ?? null,
            location: mirror.location ?? null,
            startAt: mirror.startAt,
            endAt: mirror.endAt ?? null,
            timezone: mirror.timezone ?? 'UTC',
            isAllDay: mirror.isAllDay,
            recurrenceRule: mirror.recurrenceRule ?? null,
            recurrenceExceptions: null,
            attendees: mirror.attendees ?? null,
            reminders: mirror.reminders ?? null,
            visibility: mirror.visibility ?? null,
            colorId: mirror.colorId ?? null,
            conferenceData: mirror.conferenceData ?? null,
            targetCalendarId: source.remoteId,
            clock: { ...(mirror.clock ?? {}) },
            createdAt: time,
            modifiedAt: time
          })
          .run()
        dataDb
          .insert(calendarBindings)
          .values({
            id: bindingId,
            sourceType: 'event',
            sourceId: eventId,
            provider: source.provider,
            remoteCalendarId: source.remoteId,
            remoteEventId: mirror.remoteEventId,
            ownershipMode: 'provider_managed',
            writebackMode: 'time_and_text',
            remoteVersion: mirror.remoteEtag,
            lastLocalSnapshot: null,
            clock: { ...(mirror.clock ?? {}) },
            createdAt: time,
            modifiedAt: time
          })
          .run()
        dataDb
          .update(calendarExternalEvents)
          .set({ archivedAt: time, modifiedAt: time })
          .where(eq(calendarExternalEvents.id, mirror.id))
          .run()

        return { success: true, eventId }
      }
    },

    bindings: {
      async get(id) {
        const row = dataDb.select().from(calendarBindings).where(eq(calendarBindings.id, id)).get()
        return row ? toBinding(row) : null
      },

      async list(options = {}) {
        const bindings = dataDb
          .select()
          .from(calendarBindings)
          .orderBy(asc(calendarBindings.createdAt))
          .all()
          .filter((binding) => options.includeArchived || !binding.archivedAt)
          .filter((binding) => !options.sourceType || binding.sourceType === options.sourceType)
          .filter((binding) => !options.sourceId || binding.sourceId === options.sourceId)
          .filter((binding) => !options.provider || binding.provider === options.provider)
          .map(toBinding)
        return { bindings }
      }
    },

    async providerStatus(input) {
      const sources = (
        await this.sources.list({
          provider: input.provider
        })
      ).sources.filter((source) => !input.accountId || source.accountId === input.accountId)
      return {
        provider: input.provider,
        ...(input.accountId ? { accountId: input.accountId } : {}),
        connected: sources.some((source) => source.kind === 'account'),
        sourceCount: sources.length
      }
    },

    async range(input) {
      return calendarRange(dataDb, input)
    },

    async googleSettings() {
      return readCalendarGoogleSettings(dataDb)
    },

    async setDefaultGoogleCalendar(calendarId, markOnboardingComplete = true) {
      const current = readCalendarGoogleSettings(dataDb)
      const next: CalendarGoogleSettings = {
        ...calendarGoogleSettingsDefaults,
        ...current,
        defaultTargetCalendarId: calendarId,
        onboardingCompleted: markOnboardingComplete ? true : current.onboardingCompleted
      }
      const modifiedAt = nowIso()
      dataDb
        .insert(settingsTable)
        .values({
          key: calendarGoogleSettingsKey,
          value: JSON.stringify(next),
          modifiedAt
        })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: JSON.stringify(next), modifiedAt }
        })
        .run()
      return { success: true }
    }
  }
}
