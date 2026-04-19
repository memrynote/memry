import { BrowserWindow, ipcMain } from 'electron'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  CreateCalendarEventSchema,
  GetCalendarRangeSchema,
  ListCalendarEventsSchema,
  ListCalendarSourcesSchema,
  ListGoogleCalendarsSchema,
  PromoteExternalEventSchema,
  SetDefaultGoogleCalendarSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema,
  UpdateCalendarEventSchema,
  type CalendarChangedEvent,
  type CalendarDeleteResponse,
  type CalendarEventListResponse,
  type CalendarEventMutationResponse,
  type CalendarEventRecord,
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
  type SetDefaultGoogleCalendarResponse
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
  hasAnyGoogleCalendarLocalAuth,
  hasGoogleCalendarLocalAuth,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from '../calendar/google/oauth'
import { getCalendarRangeProjection } from '../calendar/projection'
import {
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  syncGoogleCalendarNow
} from '../calendar/google/sync-service'
import { listGoogleCalendars, setDefaultGoogleCalendar } from '../calendar/google/onboarding'
import { createGoogleCalendarClient } from '../calendar/google/client'
import { getGooglePushRuntime } from '../calendar/google/push-runtime'
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

const log = createLogger('IPC:Calendar')

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
    recurrenceExceptions: (row.recurrenceExceptions as string[] | null) ?? null,
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
    status = 'disconnected'
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
    lastError: metadata?.lastError ?? null
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
        }
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
        const existing = db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.id, input.id))
          .get()
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
      }, 'Failed to update calendar source selection')
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
          createdAt: now,
          modifiedAt: now
        })

        void startGoogleCalendarSyncRunner().catch(() => {
          // Runner self-logs on failure; swallow to keep connect success green.
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

        if (!(await isMemryUserSignedIn())) {
          return {
            success: false,
            status: await buildProviderStatus(db, input.provider),
            error: 'Sign in to Memry before refreshing Google Calendar'
          }
        }

        if (!(await hasAnyGoogleCalendarLocalAuth(db))) {
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
      }, 'Failed to list Google calendars')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR,
    createValidatedHandler(
      SetDefaultGoogleCalendarSchema,
      withDb((db, input): SetDefaultGoogleCalendarResponse => {
        return setDefaultGoogleCalendar(db, input)
      }, 'Failed to set default Google calendar')
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
            return { success: false, eventId: null, error: err.message }
          }
          throw err
        }
      }, 'Failed to promote external calendar event')
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
  ipcMain.removeHandler(CalendarChannels.invoke.UPDATE_SOURCE_SELECTION)
  ipcMain.removeHandler(CalendarChannels.invoke.GET_PROVIDER_STATUS)
  ipcMain.removeHandler(CalendarChannels.invoke.CONNECT_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.DISCONNECT_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.REFRESH_PROVIDER)
  ipcMain.removeHandler(CalendarChannels.invoke.LIST_GOOGLE_CALENDARS)
  ipcMain.removeHandler(CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT)
}
