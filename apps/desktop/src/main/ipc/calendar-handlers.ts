import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  CreateCalendarEventSchema,
  GetCalendarRangeSchema,
  ListCalendarEventsSchema,
  ListCalendarSourcesSchema,
  ListGoogleCalendarsSchema,
  PromoteExternalEventSchema,
  RetryCalendarSourceSyncSchema,
  SearchCalendarEventsSchema,
  SetDefaultGoogleCalendarSchema,
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
  type CalendarProviderAccountConnectionStatus,
  type CalendarProviderAccountStatus,
  type CalendarProviderMutationResponse,
  type CalendarProviderStatus,
  type CalendarRangeResponse,
  type CalendarSourceListResponse,
  type CalendarSourceMutationResponse,
  type CalendarSourceRecord,
  type ListGoogleCalendarsResponse,
  type PromoteExternalEventResponse,
  type RetryCalendarSourceSyncResponse,
  type SetDefaultGoogleCalendarResponse
} from '@memry/contracts/calendar-api'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { createLogger } from '../lib/logger'
import { trackCalendar } from './calendar-telemetry'
import { trackMainError } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'
import { requireDatabase, getIndexDatabase, type DataDb } from '../database'
import { generateId } from '../lib/id'
import { createStringHandler, createValidatedHandler, withDb } from './validate'
import {
  getCalendarSourceById,
  listCalendarSources as listCalendarSourceRows,
  upsertCalendarSource
} from '../calendar/repositories/calendar-sources-repository'
import { searchCalendarEventsByTitle } from '../calendar/repositories/calendar-events-repository'
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasAnyGoogleCalendarLocalAuth,
  hasGoogleCalendarLocalAuth,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from '../calendar/providers/google/oauth'
import { getCalendarRangeProjection } from '../calendar/projection'
import { getCalendarEnabledPropertyNames } from '../calendar/calendar-property-visibility'
import { getCalendarSettings } from './settings-handlers'
import {
  discoverGoogleCalendarSources,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  syncGoogleCalendarNow,
  syncGoogleCalendarSource
} from '../calendar/providers/google/sync-service'
import {
  listGoogleCalendars,
  setDefaultGoogleCalendar
} from '../calendar/providers/google/onboarding'
import { createGoogleCalendarClient } from '../calendar/providers/google/client'
import { getGooglePushRuntime } from '../calendar/providers/google/push-runtime'
import {
  promoteExternalEvent,
  ExternalEventNotFoundError,
  ExternalEventSourceMissingError
} from '../calendar/promote-external-event'
import { isMemryUserSignedIn } from '../auth-state'
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
import { getMainI18n } from '../lib/main-i18n'

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
    lastError: row.lastError ?? null,
    metadata: row.metadata ?? null,
    archivedAt: row.archivedAt ?? null,
    syncedAt: row.syncedAt ?? null,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

async function buildProviderAccountStatus(
  source: typeof calendarSources.$inferSelect
): Promise<CalendarProviderAccountStatus | null> {
  const accountId = source.accountId
  if (!accountId) return null

  const metadata = (source.metadata as { email?: string; lastError?: string } | null) ?? null
  const hasLocalAuth =
    source.provider === 'google' ? await hasGoogleCalendarLocalAuth(accountId) : false

  let status: CalendarProviderAccountConnectionStatus
  if (!hasLocalAuth) {
    status = 'reconnect_required'
  } else if (source.syncStatus === 'error') {
    status = 'error'
  } else {
    status = 'connected'
  }

  return {
    accountId,
    email: metadata?.email ?? source.title,
    status,
    lastSyncedAt: source.lastSyncedAt ?? null,
    lastError: source.lastError ?? metadata?.lastError ?? null
  }
}

async function buildProviderStatus(db: DataDb, provider: string): Promise<CalendarProviderStatus> {
  const allSources = listCalendarSourceRows(db, { provider })
  const accountSources = allSources.filter((source) => source.kind === 'account')
  const account = accountSources[0] ?? null
  const calendars = allSources.filter((source) => source.kind === 'calendar')
  const syncedCandidates = [
    ...accountSources.map((source) => source.lastSyncedAt ?? null),
    ...calendars.map((source) => source.lastSyncedAt ?? null)
  ].filter((value): value is string => Boolean(value))
  const hasLocalAuth = provider === 'google' ? await hasAnyGoogleCalendarLocalAuth(db) : false

  const accounts: CalendarProviderAccountStatus[] = []
  for (const source of accountSources) {
    const accountStatus = await buildProviderAccountStatus(source)
    if (accountStatus) accounts.push(accountStatus)
  }

  return {
    provider,
    connected: Boolean(account),
    hasLocalAuth,
    account: account ? { id: account.id, title: account.title } : null,
    accounts,
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
function purgeCalendarSourceMirrors(
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

async function disconnectGoogleAccount(
  db: DataDb,
  provider: string,
  accountId: string
): Promise<CalendarProviderMutationResponse> {
  try {
    await disconnectGoogleCalendar(accountId)
  } catch (err) {
    log.warn('Google Calendar disconnect failed', { accountId, err })
  }

  trackMainEvent('calendar_google_disconnected', {
    surface: 'calendar',
    action: 'disconnected',
    source: 'google',
    result: 'success',
    metrics: { itemCount: 1 }
  })

  const allProviderSources = listCalendarSourceRows(db, { provider })
  const targetSources = allProviderSources.filter((source) =>
    source.kind === 'account' ? source.accountId === accountId : source.accountId === accountId
  )

  if (targetSources.length === 0) {
    return {
      success: true,
      status: await buildProviderStatus(db, provider)
    }
  }

  const pushRuntime = getGooglePushRuntime()
  if (pushRuntime) {
    for (const source of targetSources) {
      if (source.kind !== 'calendar' || source.isMemryManaged) continue
      void pushRuntime.handleSelectionToggle({
        sourceId: source.id,
        isSelected: false,
        calendarId: source.remoteId
      })
    }
  }

  // Mirrors first, then the tombstones. If a crash lands between the two the
  // sources stay unarchived with nothing under them, which the next disconnect
  // or a rediscovery both resolve — the reverse order would strand events
  // under a source no longer listed anywhere.
  purgeCalendarSourceMirrors(db, provider, targetSources)

  const now = new Date().toISOString()

  db.transaction((tx) => {
    for (const source of targetSources) {
      if (source.archivedAt) continue
      tx.update(calendarSources)
        .set({ archivedAt: now, modifiedAt: now })
        .where(eq(calendarSources.id, source.id))
        .run()
    }
  })

  for (const source of targetSources) {
    if (source.archivedAt) continue
    syncCalendarSourceUpdate(source.id)
    emitCalendarChanged({ entityType: 'calendar_source', id: source.id })
  }

  return {
    success: true,
    status: await buildProviderStatus(db, provider)
  }
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
            targetCalendarId: input.targetCalendarId ?? null,
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

        const updated = syncCalendarSourceUpsert(db, {
          ...existing,
          isSelected: input.isSelected,
          modifiedAt: new Date().toISOString()
        })

        // Turning a calendar off takes its events with it. Nothing polls an
        // unselected source, so anything left behind would sit on the calendar
        // view with no way to refresh or remove it.
        if (!input.isSelected) {
          purgeCalendarSourceMirrors(db, existing.provider, [existing])
        }

        if (
          updated.provider === 'google' &&
          updated.kind === 'calendar' &&
          !updated.isMemryManaged
        ) {
          const pushRuntime = getGooglePushRuntime()
          if (pushRuntime) {
            void pushRuntime.handleSelectionToggle({
              sourceId: updated.id,
              isSelected: updated.isSelected,
              calendarId: updated.remoteId
            })
          }
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
        return await buildProviderStatus(requireDatabase(), input.provider)
      }
    )
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
        const accountSourceId = `google-account:${connected.accountId}`
        const primaryCalendarSourceId = `google-calendar:${connected.primaryCalendar.remoteId}`

        syncCalendarSourceUpsert(db, {
          id: accountSourceId,
          provider: 'google',
          kind: 'account',
          accountId: connected.accountId,
          remoteId: connected.account.remoteId,
          title: connected.account.title,
          timezone: connected.account.timezone,
          color: null,
          isPrimary: false,
          isSelected: false,
          isMemryManaged: false,
          syncStatus: 'pending',
          metadata: { connectedVia: 'oauth', email: connected.account.email },
          // A per-account disconnect tombstones these rows instead of deleting
          // them, and every read path filters on `archivedAt IS NULL`. Without
          // clearing it here the reconnect finishes, stores fresh tokens, and
          // still leaves the account row invisible — so status reports "Not
          // Connected" forever and the user can never get back in (#1201).
          archivedAt: null,
          createdAt: now,
          modifiedAt: now
        })

        syncCalendarSourceUpsert(db, {
          id: primaryCalendarSourceId,
          provider: 'google',
          kind: 'calendar',
          accountId: connected.accountId,
          remoteId: connected.primaryCalendar.remoteId,
          title: connected.primaryCalendar.title,
          timezone: connected.primaryCalendar.timezone,
          color: connected.primaryCalendar.color,
          isPrimary: connected.primaryCalendar.isPrimary,
          isSelected: true,
          isMemryManaged: false,
          syncStatus: 'pending',
          metadata: null,
          // Same tombstone as above: discovery already revives calendar rows
          // (`discoverGoogleCalendarSources`), but it runs after this upsert and
          // is allowed to fail, so the primary has to clear its own.
          archivedAt: null,
          createdAt: now,
          modifiedAt: now
        })

        // Pull in the rest of the account's calendars so the picker has more
        // than the primary to offer. Non-fatal: a failure here leaves the user
        // connected with the primary working, and the next sync retries it.
        try {
          await discoverGoogleCalendarSources(
            db,
            createGoogleCalendarClient({ accountId: connected.accountId }),
            connected.accountId
          )
        } catch (error) {
          log.warn('Calendar discovery failed after connect', {
            accountId: connected.accountId,
            error
          })
          trackMainError('calendar', 'source_discovery', error)
        }

        void startGoogleCalendarSyncRunner().catch((error) => {
          // Only the inner sync self-logs; pre-sync awaits (keychain read, auth
          // checks) can throw before that. Swallow to keep connect success green.
          log.warn('startGoogleCalendarSyncRunner failed after connect', error)
          trackMainError('calendar', 'sync_runner_start', error)
        })

        trackCalendar('calendar_google_connected', 'connected', 'google')

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'errors:calendar.connectProviderFailed')
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

        if (input.accountId) {
          return await disconnectGoogleAccount(db, input.provider, input.accountId)
        }

        stopGoogleCalendarSyncRunner()
        const accountIdsToDisconnect = listGoogleAccountIds(db)
        for (const accountId of accountIdsToDisconnect) {
          try {
            await disconnectGoogleCalendar(accountId)
          } catch (err) {
            log.warn('Google Calendar disconnect failed', { accountId, err })
          }
        }

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

        trackMainEvent('calendar_google_disconnected', {
          surface: 'calendar',
          action: 'disconnected',
          source: 'google',
          result: 'success',
          metrics: { itemCount: accountIdsToDisconnect.length }
        })

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'errors:calendar.disconnectProviderFailed')
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

        if (!(await isMemryUserSignedIn())) {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: getMainI18n().t('errors:calendar.signInBeforeRefresh')
          }
        }

        if (!(await hasAnyGoogleCalendarLocalAuth(db))) {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: getMainI18n().t('errors:calendar.googleNotConnected')
          }
        }

        await syncGoogleCalendarNow(db)
        emitCalendarChanged({ entityType: 'projection', id: 'google-refresh' })

        trackCalendar('calendar_google_sync_completed', 'sync_completed', 'google')

        return {
          success: true,
          status: await buildProviderStatus(db, input.provider)
        }
      }, 'errors:calendar.refreshProviderFailed')
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
        try {
          await syncGoogleCalendarSource(db, source.id)
        } catch (err) {
          log.warn('Google Calendar source retry sync failed', err)
          trackMainError('calendar', 'google_source_retry', err)
          const updated = getCalendarSourceById(db, source.id)
          return {
            success: false,
            source: updated ? mapCalendarSource(updated) : null,
            error:
              err instanceof Error ? err.message : getMainI18n().t('errors:calendar.syncFailed')
          }
        }
        const refreshed = getCalendarSourceById(db, source.id)
        return {
          success: true,
          source: refreshed ? mapCalendarSource(refreshed) : null
        }
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
          throw err
        }
      }, 'errors:calendar.promoteExternalEventFailed')
    )
  )
}

export function unregisterCalendarHandlers(): void {
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
}
