import { BrowserWindow, ipcMain } from 'electron'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  CreateCalendarEventSchema,
  GetCalendarRangeSchema,
  ListCalendarEventsSchema,
  ListCalendarSourcesSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema,
  UpdateCalendarEventSchema,
  type CalendarChangedEvent,
  type CalendarDeleteResponse,
  type CalendarEventListResponse,
  type CalendarEventMutationResponse,
  type CalendarEventRecord,
  type CalendarProviderMutationResponse,
  type CalendarProviderStatus,
  type CalendarRangeResponse,
  type CalendarSourceListResponse,
  type CalendarSourceMutationResponse,
  type CalendarSourceRecord
} from '@memry/contracts/calendar-api'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { createLogger } from '../lib/logger'
import { requireDatabase, type DataDb } from '../database'
import { generateId } from '../lib/id'
import { createStringHandler, createValidatedHandler, withDb } from './validate'
import {
  getCalendarSourceById,
  listCalendarSources as listCalendarSourceRows,
  upsertCalendarSource
} from '../calendar/repositories/calendar-sources-repository'
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasGoogleCalendarLocalAuth
} from '../calendar/google/oauth'
import { getCalendarRangeProjection } from '../calendar/projection'
import { syncGoogleCalendarNow } from '../calendar/google/sync-service'
import {
  syncCalendarBindingDelete,
  syncCalendarEventCreate,
  syncCalendarEventDelete,
  syncCalendarEventUpdate,
  syncCalendarExternalEventDelete,
  syncCalendarSourceCreate,
  syncCalendarSourceDelete,
  syncCalendarSourceUpdate
} from '../calendar/runtime-effects'

createLogger('IPC:Calendar')

function emitCalendarChanged(event: CalendarChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CalendarChannels.events.CHANGED, event)
  }
}

function mapCalendarEvent(row: typeof calendarEvents.$inferSelect): CalendarEventRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    timezone: row.timezone,
    isAllDay: row.isAllDay,
    recurrenceRule: (row.recurrenceRule as Record<string, unknown> | null) ?? null,
    recurrenceExceptions:
      (row.recurrenceExceptions as Array<Record<string, unknown>> | null) ?? null,
    archivedAt: row.archivedAt ?? null,
    syncedAt: row.syncedAt ?? null,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function mapCalendarSource(row: typeof calendarSources.$inferSelect): CalendarSourceRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    accountId: row.accountId ?? null,
    remoteId: row.remoteId,
    title: row.title,
    timezone: row.timezone ?? null,
    color: row.color ?? null,
    isPrimary: row.isPrimary,
    isSelected: row.isSelected,
    isMemryManaged: row.isMemryManaged,
    syncCursor: row.syncCursor ?? null,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    archivedAt: row.archivedAt ?? null,
    syncedAt: row.syncedAt ?? null,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

async function buildProviderStatus(db: DataDb, provider: string): Promise<CalendarProviderStatus> {
  const allSources = listCalendarSourceRows(db, { provider })
  const account = allSources.find((source) => source.kind === 'account') ?? null
  const calendars = allSources.filter((source) => source.kind === 'calendar')
  const syncedCandidates = [
    account?.lastSyncedAt ?? null,
    ...calendars.map((source) => source.lastSyncedAt ?? null)
  ].filter((value): value is string => Boolean(value))
  const hasLocalAuth = provider === 'google' ? await hasGoogleCalendarLocalAuth() : false

  return {
    provider,
    connected: Boolean(account),
    hasLocalAuth,
    account: account ? { id: account.id, title: account.title } : null,
    calendars: {
      total: calendars.length,
      selected: calendars.filter((source) => source.isSelected).length,
      memryManaged: calendars.filter((source) => source.isMemryManaged).length
    },
    lastSyncedAt: syncedCandidates.sort().at(-1) ?? null
  }
}

function sortSources(sources: CalendarSourceRecord[]): CalendarSourceRecord[] {
  return [...sources].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'account' ? -1 : 1
    }
    return left.title.localeCompare(right.title)
  })
}

function syncCalendarSourceUpsert(
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

export function registerCalendarHandlers(): void {
  ipcMain.handle(
    CalendarChannels.invoke.CREATE_EVENT,
    createValidatedHandler(
      CreateCalendarEventSchema,
      withDb((db, input): CalendarEventMutationResponse => {
        const now = new Date().toISOString()
        const id = generateId()

        db.insert(calendarEvents)
          .values({
            id,
            title: input.title,
            description: input.description ?? null,
            location: input.location ?? null,
            startAt: input.startAt,
            endAt: input.endAt ?? null,
            timezone: input.timezone,
            isAllDay: input.isAllDay,
            recurrenceRule: input.recurrenceRule ?? null,
            recurrenceExceptions: input.recurrenceExceptions ?? null,
            createdAt: now,
            modifiedAt: now
          })
          .run()

        const created = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
        if (!created) {
          throw new Error('Failed to load created calendar event')
        }

        syncCalendarEventCreate(id)
        emitCalendarChanged({ entityType: 'calendar_event', id })
        return { success: true, event: mapCalendarEvent(created) }
      }, 'Failed to create calendar event')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_EVENT,
    createStringHandler((id): CalendarEventRecord | null => {
      const row = requireDatabase()
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, id))
        .get()

      return row ? mapCalendarEvent(row) : null
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.UPDATE_EVENT,
    createValidatedHandler(
      UpdateCalendarEventSchema,
      withDb((db, input): CalendarEventMutationResponse => {
        const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).get()
        if (!existing) {
          return { success: false, event: null, error: 'Calendar event not found' }
        }

        const changes: Partial<typeof calendarEvents.$inferInsert> = {
          modifiedAt: new Date().toISOString()
        }

        if (Object.prototype.hasOwnProperty.call(input, 'title')) changes.title = input.title
        if (Object.prototype.hasOwnProperty.call(input, 'description')) {
          changes.description = input.description ?? null
        }
        if (Object.prototype.hasOwnProperty.call(input, 'location')) {
          changes.location = input.location ?? null
        }
        if (Object.prototype.hasOwnProperty.call(input, 'startAt')) changes.startAt = input.startAt
        if (Object.prototype.hasOwnProperty.call(input, 'endAt')) changes.endAt = input.endAt ?? null
        if (Object.prototype.hasOwnProperty.call(input, 'timezone')) changes.timezone = input.timezone
        if (Object.prototype.hasOwnProperty.call(input, 'isAllDay')) changes.isAllDay = input.isAllDay
        if (Object.prototype.hasOwnProperty.call(input, 'recurrenceRule')) {
          changes.recurrenceRule = input.recurrenceRule ?? null
        }
        if (Object.prototype.hasOwnProperty.call(input, 'recurrenceExceptions')) {
          changes.recurrenceExceptions = input.recurrenceExceptions ?? null
        }

        db.update(calendarEvents).set(changes).where(eq(calendarEvents.id, input.id)).run()

        const updated = db.select().from(calendarEvents).where(eq(calendarEvents.id, input.id)).get()
        if (!updated) {
          throw new Error('Failed to load updated calendar event')
        }

        syncCalendarEventUpdate(input.id)
        emitCalendarChanged({ entityType: 'calendar_event', id: input.id })
        return { success: true, event: mapCalendarEvent(updated) }
      }, 'Failed to update calendar event')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.DELETE_EVENT,
    createStringHandler(
      withDb((db, id): CalendarDeleteResponse => {
        const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
        if (!existing) {
          return { success: false, error: 'Calendar event not found' }
        }

        db.delete(calendarEvents).where(eq(calendarEvents.id, id)).run()
        syncCalendarEventDelete(id, JSON.stringify(existing))
        emitCalendarChanged({ entityType: 'calendar_event', id })
        return { success: true }
      }, 'Failed to delete calendar event')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.LIST_EVENTS,
    createValidatedHandler(ListCalendarEventsSchema, (input): CalendarEventListResponse => {
      const db = requireDatabase()
      const conditions = input.includeArchived ? [] : [isNull(calendarEvents.archivedAt)]
      const rows = db
        .select()
        .from(calendarEvents)
        .where(and(...conditions))
        .orderBy(asc(calendarEvents.startAt))
        .all()

      return { events: rows.map(mapCalendarEvent) }
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_RANGE,
    createValidatedHandler(GetCalendarRangeSchema, (input): CalendarRangeResponse => {
      return getCalendarRangeProjection(requireDatabase(), input)
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.LIST_SOURCES,
    createValidatedHandler(ListCalendarSourcesSchema, (input): CalendarSourceListResponse => {
      const rows = listCalendarSourceRows(requireDatabase(), input)
      return { sources: sortSources(rows.map(mapCalendarSource)) }
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.UPDATE_SOURCE_SELECTION,
    createValidatedHandler(
      UpdateCalendarSourceSelectionSchema,
      withDb((db, input): CalendarSourceMutationResponse => {
        const existing = getCalendarSourceById(db, input.id)
        if (!existing) {
          return { success: false, source: null, error: 'Calendar source not found' }
        }

        if (existing.kind !== 'calendar') {
          return {
            success: false,
            source: null,
            error: 'Only calendar sources can be selected'
          }
        }

        const updated = syncCalendarSourceUpsert(db, {
          ...existing,
          isSelected: input.isSelected,
          modifiedAt: new Date().toISOString()
        })

        return { success: true, source: updated }
      }, 'Failed to update calendar source selection')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_PROVIDER_STATUS,
    createValidatedHandler(CalendarProviderRequestSchema, async (input): Promise<CalendarProviderStatus> => {
      return await buildProviderStatus(requireDatabase(), input.provider)
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.CONNECT_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        if (input.provider !== 'google') {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: `Unsupported calendar provider: ${input.provider}`
          }
        }

        const connected = await connectGoogleCalendar()
        const now = new Date().toISOString()
        const accountSourceId = `google-account:${connected.account.remoteId}`
        const primaryCalendarSourceId = `google-calendar:${connected.primaryCalendar.remoteId}`

        syncCalendarSourceUpsert(db, {
          id: accountSourceId,
          provider: 'google',
          kind: 'account',
          accountId: null,
          remoteId: connected.account.remoteId,
          title: connected.account.title,
          timezone: connected.account.timezone,
          color: null,
          isPrimary: false,
          isSelected: false,
          isMemryManaged: false,
          syncStatus: 'pending',
          metadata: { connectedVia: 'oauth' },
          createdAt: now,
          modifiedAt: now
        })

        syncCalendarSourceUpsert(db, {
          id: primaryCalendarSourceId,
          provider: 'google',
          kind: 'calendar',
          accountId: accountSourceId,
          remoteId: connected.primaryCalendar.remoteId,
          title: connected.primaryCalendar.title,
          timezone: connected.primaryCalendar.timezone,
          color: connected.primaryCalendar.color,
          isPrimary: connected.primaryCalendar.isPrimary,
          isSelected: true,
          isMemryManaged: false,
          syncStatus: 'pending',
          metadata: null,
          createdAt: now,
          modifiedAt: now
        })

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'Failed to connect calendar provider')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.DISCONNECT_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        if (input.provider !== 'google') {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: `Unsupported calendar provider: ${input.provider}`
          }
        }

        await disconnectGoogleCalendar()

        const providerSources = listCalendarSourceRows(db, { provider: input.provider })
        const sourceIds = providerSources.map((source) => source.id)

        const externalRows =
          sourceIds.length > 0
            ? db
                .select()
                .from(calendarExternalEvents)
                .where(inArray(calendarExternalEvents.sourceId, sourceIds))
                .all()
            : []

        const bindingRows = db
          .select()
          .from(calendarBindings)
          .where(eq(calendarBindings.provider, input.provider))
          .all()

        db.transaction((tx) => {
          if (externalRows.length > 0) {
            tx.delete(calendarExternalEvents)
              .where(inArray(calendarExternalEvents.id, externalRows.map((row) => row.id)))
              .run()
          }

          if (bindingRows.length > 0) {
            tx.delete(calendarBindings)
              .where(inArray(calendarBindings.id, bindingRows.map((row) => row.id)))
              .run()
          }

          if (providerSources.length > 0) {
            tx.delete(calendarSources).where(eq(calendarSources.provider, input.provider)).run()
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

        for (const row of providerSources) {
          syncCalendarSourceDelete(row.id, JSON.stringify(row))
          emitCalendarChanged({ entityType: 'calendar_source', id: row.id })
        }

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'Failed to disconnect calendar provider')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.REFRESH_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        if (input.provider !== 'google') {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: `Unsupported calendar provider: ${input.provider}`
          }
        }

        if (!(await hasGoogleCalendarLocalAuth())) {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: 'Google Calendar is not connected on this device'
          }
        }

        await syncGoogleCalendarNow(db)
        emitCalendarChanged({ entityType: 'projection', id: 'google-refresh' })

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'Failed to refresh calendar provider')
    )
  )
}

export function unregisterCalendarHandlers(): void {
  ipcMain.removeHandler(CalendarChannels.invoke.CREATE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.UPDATE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.DELETE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_EVENTS)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_RANGE)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_SOURCES)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_PROVIDER_STATUS)
  ipcMain.removeHandler(CalendarChannels.invoke.CONNECT_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER)
}
