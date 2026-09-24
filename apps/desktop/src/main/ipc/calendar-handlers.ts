import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  CreateCalendarEventSchema,
  GetCalendarRangeSchema,
  ListCalendarEventsSchema,
  ListCalendarSourcesSchema,
  ListGoogleCalendarsSchema,
  ListProviderCalendarsSchema,
  PromoteExternalEventSchema,
  RetryCalendarSourceSyncSchema,
  SearchCalendarEventsSchema,
  SetDefaultGoogleCalendarSchema,
  SetDefaultProviderCalendarSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema,
  UpdateCalendarEventSchema,
  type CalendarChangedEvent,
  type CalendarDeleteResponse,
  type CalendarEventListResponse,
  type CalendarEventMutationResponse,
  type CalendarEventRecord,
  type CalendarEventSearchItem,
  type CalendarEventSearchResponse,
  type CalendarProviderMutationResponse,
  type CalendarProviderStatus,
  type CalendarRangeResponse,
  type CalendarSourceListResponse,
  type CalendarSourceMutationResponse,
  type CalendarSourceRecord,
  type ListCalendarProvidersResponse,
  type ListGoogleCalendarsResponse,
  type ListProviderCalendarsResponse,
  type PromoteExternalEventResponse,
  type RetryCalendarSourceSyncResponse,
  type SetDefaultGoogleCalendarResponse,
  type SetDefaultProviderCalendarResponse
} from '@memry/contracts/calendar-api'
import {
  calendarEventColorFromColorId,
  colorIdForCalendarEventColor
} from '@memry/contracts/calendar-colors'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { createLogger } from '../lib/logger'
import { trackCalendar } from './calendar-telemetry'
import { trackMainError } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'
import { requireDatabase, getIndexDatabase, type DataDb } from '../database'
import { generateId } from '../lib/id'
import { createStringHandler, createValidatedHandler, withDb } from './validate'
import {
  getCalendarSourceById,
  listCalendarSources as listCalendarSourceRows
} from '../calendar/repositories/calendar-sources-repository'
import { searchCalendarEventsByTitle } from '../calendar/repositories/calendar-events-repository'
import { resolveDefaultGoogleAccountId } from '../calendar/google/oauth'
import { getCalendarRangeProjection } from '../calendar/projection'
import { getCalendarEnabledPropertyNames } from '../calendar/calendar-property-visibility'
import { getCalendarSettings } from './settings-handlers'
import { listGoogleCalendars, setDefaultGoogleCalendar } from '../calendar/google/onboarding'
import { createGoogleCalendarClient } from '../calendar/google/client'
import { googleCalendarProvider } from '../calendar/google/google-provider'
import {
  promoteExternalEvent,
  ExternalEventNotFoundError,
  ExternalEventReadOnlyError,
  ExternalEventSourceMissingError
} from '../calendar/promote-external-event'
import {
  syncCalendarEventCreate,
  syncCalendarEventDelete,
  syncCalendarEventUpdate
} from '../calendar/runtime-effects'
import { getMainI18n } from '../lib/main-i18n'
import { mapCalendarSource } from '../calendar/calendar-source-record'
import { registerCalendarIcsHandlers, unregisterCalendarIcsHandlers } from './calendar-ics-handlers'
import { registerBuiltinCalendarProviders } from '../calendar/provider/builtin-providers'
import { getProvider, listProviders, unsupportedProviderError } from '../calendar/provider/registry'
import {
  purgeCalendarSourceMirrors,
  upsertSyncedCalendarSource
} from '../calendar/provider/source-mirrors'
import { buildProviderStatus } from '../calendar/provider/status'

const log = createLogger('IPC:Calendar')

function emitCalendarChanged(event: CalendarChangedEvent): void {
  broadcastToAllWindows(CalendarChannels.events.CHANGED, event)
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
    recurrenceRule: row.recurrenceRule ?? null,
    recurrenceExceptions: row.recurrenceExceptions ?? null,
    attendees: (row.attendees as CalendarEventRecord['attendees']) ?? null,
    reminders: (row.reminders as CalendarEventRecord['reminders']) ?? null,
    visibility: (row.visibility as CalendarEventRecord['visibility']) ?? null,
    colorId: row.colorId ?? null,
    color: calendarEventColorFromColorId(row.colorId),
    conferenceData: (row.conferenceData as CalendarEventRecord['conferenceData']) ?? null,
    parentEventId: row.parentEventId ?? null,
    originalStartTime: row.originalStartTime ?? null,
    targetCalendarId: row.targetCalendarId ?? null,
    archivedAt: row.archivedAt ?? null,
    syncedAt: row.syncedAt ?? null,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

/** Lean picker projection — deliberately not mapCalendarEvent (#869). */
function toEventSearchItem(row: typeof calendarEvents.$inferSelect): CalendarEventSearchItem {
  return {
    id: row.id,
    title: row.title,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    isAllDay: row.isAllDay
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

async function unsupportedProvider(
  db: DataDb,
  provider: string
): Promise<CalendarProviderMutationResponse> {
  return {
    success: false,
    status: await buildProviderStatus(db, provider),
    error: unsupportedProviderError(provider)
  }
}

export function registerCalendarHandlers(): void {
  registerBuiltinCalendarProviders()
  registerCalendarIcsHandlers()
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
            targetCalendarId: input.targetCalendarId ?? null,
            colorId: colorIdForCalendarEventColor(input.color ?? null),
            createdAt: now,
            modifiedAt: now
          })
          .run()

        const created = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
        if (!created) {
          throw new Error('Failed to load created calendar event')
        }

        try {
          syncCalendarEventCreate(id)
        } catch (error) {
          log.warn('syncCalendarEventCreate failed; event persisted locally', error)
          // The event will never reach device sync or Google — permanent divergence.
          trackMainError('calendar', 'event_create_sync_enqueue', error)
        }
        emitCalendarChanged({ entityType: 'calendar_event', id })
        trackCalendar('calendar_event_created', 'created', 'calendar_page')
        return { success: true, event: mapCalendarEvent(created) }
      }, 'errors:calendar.createEventFailed')
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
        const existing = db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.id, input.id))
          .get()
        if (!existing) {
          return {
            success: false,
            event: null,
            error: getMainI18n().t('errors:calendar.eventNotFound')
          }
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
        if (Object.prototype.hasOwnProperty.call(input, 'endAt'))
          changes.endAt = input.endAt ?? null
        if (Object.prototype.hasOwnProperty.call(input, 'timezone'))
          changes.timezone = input.timezone
        if (Object.prototype.hasOwnProperty.call(input, 'isAllDay'))
          changes.isAllDay = input.isAllDay
        if (Object.prototype.hasOwnProperty.call(input, 'recurrenceRule')) {
          changes.recurrenceRule = input.recurrenceRule ?? null
        }
        if (Object.prototype.hasOwnProperty.call(input, 'recurrenceExceptions')) {
          changes.recurrenceExceptions = input.recurrenceExceptions ?? null
        }
        if (Object.prototype.hasOwnProperty.call(input, 'targetCalendarId')) {
          changes.targetCalendarId = input.targetCalendarId ?? null
        }
        // The form sends the colour on every save. Re-saving the colour the
        // event already has must not mark colorId as edited, or each save
        // would bump its field clock and push it to Google again.
        if (
          Object.prototype.hasOwnProperty.call(input, 'color') &&
          calendarEventColorFromColorId(existing.colorId) !== (input.color ?? null)
        ) {
          changes.colorId = colorIdForCalendarEventColor(input.color ?? null)
        }

        db.update(calendarEvents).set(changes).where(eq(calendarEvents.id, input.id)).run()

        const updated = db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.id, input.id))
          .get()
        if (!updated) {
          throw new Error('Failed to load updated calendar event')
        }

        const changedFields = Object.keys(changes).filter(
          (field) => field !== 'modifiedAt' && field !== 'targetCalendarId'
        )
        syncCalendarEventUpdate(input.id, changedFields)
        emitCalendarChanged({ entityType: 'calendar_event', id: input.id })
        trackCalendar('calendar_event_updated', 'updated', undefined, {
          itemCount: changedFields.length
        })
        return { success: true, event: mapCalendarEvent(updated) }
      }, 'errors:calendar.updateEventFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.DELETE_EVENT,
    createStringHandler(
      withDb((db, id): CalendarDeleteResponse => {
        const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
        if (!existing) {
          return { success: false, error: getMainI18n().t('errors:calendar.eventNotFound') }
        }

        db.delete(calendarEvents).where(eq(calendarEvents.id, id)).run()
        syncCalendarEventDelete(id, JSON.stringify(existing))
        emitCalendarChanged({ entityType: 'calendar_event', id })
        // Direct trackMainEvent: trackCalendar's name union predates this event.
        trackMainEvent('calendar_event_deleted', {
          surface: 'calendar',
          action: 'deleted',
          source: 'calendar_page',
          result: 'success'
        })
        return { success: true }
      }, 'errors:calendar.deleteEventFailed')
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
    CalendarChannels.invoke.SEARCH_EVENTS,
    createValidatedHandler(SearchCalendarEventsSchema, (input): CalendarEventSearchResponse => {
      const rows = searchCalendarEventsByTitle(requireDatabase(), {
        query: input.query,
        limit: input.limit,
        now: new Date().toISOString()
      })
      return { events: rows.map(toEventSearchItem) }
    })
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_RANGE,
    createValidatedHandler(GetCalendarRangeSchema, (input): CalendarRangeResponse => {
      return getCalendarRangeProjection(
        requireDatabase(),
        getIndexDatabase(),
        input,
        getCalendarEnabledPropertyNames(),
        getCalendarSettings().showNotesOnCalendar
      )
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
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.sourceNotFound')
          }
        }

        if (existing.kind !== 'calendar') {
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.onlySourcesSelectable')
          }
        }

        const updated = upsertSyncedCalendarSource(db, {
          ...existing,
          isSelected: input.isSelected,
          modifiedAt: new Date().toISOString()
        })
        const saved = getCalendarSourceById(db, existing.id) ?? existing

        const definition = getProvider(existing.provider)
        if (definition) {
          definition.onSelectionChanged(db, existing, saved)
        } else if (!input.isSelected) {
          // A provider this build does not know still gets the purge: nothing
          // here polls an unselected source, so its events would be stranded.
          purgeCalendarSourceMirrors(db, existing.provider, [existing])
        }

        return { success: true, source: updated }
      }, 'errors:calendar.updateSourceSelectionFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.GET_PROVIDER_STATUS,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      async (input): Promise<CalendarProviderStatus> => {
        return await buildProviderStatus(requireDatabase(), input.provider, {
          includeCapabilities: input.includeCapabilities
        })
      }
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.CONNECT_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        const definition = getProvider(input.provider)
        if (!definition) return await unsupportedProvider(db, input.provider)
        return await definition.connect(db, input)
      }, 'errors:calendar.connectProviderFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.DISCONNECT_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        const definition = getProvider(input.provider)
        if (!definition) return await unsupportedProvider(db, input.provider)
        return await definition.disconnect(db, input)
      }, 'errors:calendar.disconnectProviderFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.REFRESH_PROVIDER,
    createValidatedHandler(
      CalendarProviderRequestSchema,
      withDb(async (db, input): Promise<CalendarProviderMutationResponse> => {
        const definition = getProvider(input.provider)
        if (!definition) return await unsupportedProvider(db, input.provider)
        return await definition.refresh(db, input)
      }, 'errors:calendar.refreshProviderFailed')
    )
  )

  ipcMain.handle(CalendarChannels.invoke.LIST_PROVIDERS, (): ListCalendarProvidersResponse => ({
    providers: listProviders().map((definition) => ({
      id: definition.id,
      capabilities: definition.capabilities
    }))
  }))

  ipcMain.handle(
    CalendarChannels.invoke.LIST_PROVIDER_CALENDARS,
    createValidatedHandler(
      ListProviderCalendarsSchema,
      withDb(async (db, input): Promise<ListProviderCalendarsResponse> => {
        const definition = getProvider(input.provider)
        if (!definition?.listCalendars) {
          return { provider: input.provider, calendars: [], primary: null, currentDefaultId: null }
        }
        return await definition.listCalendars(db)
      }, 'errors:calendar.listGoogleCalendarsFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.SET_DEFAULT_PROVIDER_CALENDAR,
    createValidatedHandler(
      SetDefaultProviderCalendarSchema,
      withDb((db, input): SetDefaultProviderCalendarResponse => {
        const definition = getProvider(input.provider)
        if (!definition?.setDefaultCalendar) {
          return { success: false, error: unsupportedProviderError(input.provider) }
        }
        return definition.setDefaultCalendar(db, input)
      }, 'errors:calendar.setDefaultGoogleCalendarFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.RETRY_SOURCE_SYNC,
    createValidatedHandler(
      RetryCalendarSourceSyncSchema,
      withDb(async (db, input): Promise<RetryCalendarSourceSyncResponse> => {
        const source = getCalendarSourceById(db, input.sourceId)
        if (!source) {
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.sourceNotFound')
          }
        }
        const definition = getProvider(source.provider)
        if (!definition) {
          return { success: false, source: null, error: unsupportedProviderError(source.provider) }
        }
        if (source.kind !== 'calendar') {
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.onlySourcesSelectable')
          }
        }
        return await definition.retrySource(db, source)
      }, 'errors:calendar.syncFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.LIST_GOOGLE_CALENDARS,
    createValidatedHandler(
      ListGoogleCalendarsSchema,
      withDb(async (db): Promise<ListGoogleCalendarsResponse> => {
        const accountId = resolveDefaultGoogleAccountId(db)
        if (!accountId) {
          return { calendars: [], primary: null, currentDefaultId: null }
        }
        return await listGoogleCalendars(db, createGoogleCalendarClient({ accountId }))
      }, 'errors:calendar.listGoogleCalendarsFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR,
    createValidatedHandler(
      SetDefaultGoogleCalendarSchema,
      withDb((db, input): SetDefaultGoogleCalendarResponse => {
        return setDefaultGoogleCalendar(db, input)
      }, 'errors:calendar.setDefaultGoogleCalendarFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC,
    createValidatedHandler(
      RetryCalendarSourceSyncSchema,
      withDb(async (db, input): Promise<RetryCalendarSourceSyncResponse> => {
        const source = getCalendarSourceById(db, input.sourceId)
        if (!source) {
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.sourceNotFound')
          }
        }
        if (source.provider !== 'google' || source.kind !== 'calendar') {
          return {
            success: false,
            source: null,
            error: getMainI18n().t('errors:calendar.onlyGoogleSourcesRetryable')
          }
        }
        return await googleCalendarProvider.retrySource(db, source)
      }, 'errors:calendar.retryGoogleSourceSyncFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT,
    createValidatedHandler(
      PromoteExternalEventSchema,
      withDb((db, input): PromoteExternalEventResponse => {
        try {
          return promoteExternalEvent(db, input)
        } catch (err) {
          if (
            err instanceof ExternalEventNotFoundError ||
            err instanceof ExternalEventSourceMissingError
          ) {
            // SourceMissing especially is referential breakage between
            // calendar_external_events and calendar_sources, not a user state.
            trackMainError('calendar', 'promote_external_event', err)
            return { success: false, eventId: null, error: err.message }
          }
          if (err instanceof ExternalEventReadOnlyError) {
            return { success: false, eventId: null, error: err.message }
          }
          throw err
        }
      }, 'errors:calendar.promoteExternalEventFailed')
    )
  )
}

export function unregisterCalendarHandlers(): void {
  unregisterCalendarIcsHandlers()
  ipcMain.removeHandler(CalendarChannels.invoke.CREATE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.UPDATE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.DELETE_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_EVENTS)
  ipcMain.removeHandler(CalendarChannels.invoke.SEARCH_EVENTS)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_RANGE)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_SOURCES)
  ipcMain.removeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_PROVIDER_STATUS)
  ipcMain.removeHandler(CalendarChannels.invoke.CONNECT_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.REFRESH_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS)
  ipcMain.removeHandler(CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT)
  ipcMain.removeHandler(CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_PROVIDERS)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_PROVIDER_CALENDARS)
  ipcMain.removeHandler(CalendarChannels.invoke.SET_DEFAULT_PROVIDER_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.RETRY_SOURCE_SYNC)
}
