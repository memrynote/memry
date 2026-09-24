import { eq, inArray } from 'drizzle-orm'
import {
  GOOGLE_CALENDAR_PROVIDER,
  type CalendarProviderMutationResponse,
  type CalendarProviderRequest,
  type RetryCalendarSourceSyncResponse
} from '@memry/contracts/calendar-api'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { getMainI18n } from '../../lib/main-i18n'
import { isMemryUserSignedIn } from '../../auth-state'
import { trackMainError } from '../../telemetry/diagnostics'
import { trackMainEvent } from '../../telemetry/track'
import { emitCalendarChanged } from '../change-events'
import { mapCalendarSource } from '../calendar-source-record'
import {
  getCalendarSourceById,
  listCalendarSources
} from '../repositories/calendar-sources-repository'
import {
  syncCalendarBindingDelete,
  syncCalendarExternalEventDelete,
  syncCalendarSourceDelete,
  syncCalendarSourceUpdate
} from '../runtime-effects'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import type { ProviderDefinition } from '../provider/registry'
import { purgeCalendarSourceMirrors, upsertSyncedCalendarSource } from '../provider/source-mirrors'
import { buildProviderStatus } from '../provider/status'
import { createGoogleCalendarClient } from './client'
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  hasAnyGoogleCalendarLocalAuth,
  hasGoogleCalendarLocalAuth,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from './oauth'
import { listGoogleCalendars, setDefaultGoogleCalendar } from './onboarding'
import { getGooglePushRuntime } from './push-runtime'
import {
  discoverGoogleCalendarSources,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  syncGoogleCalendarNow,
  syncGoogleCalendarSource,
  syncLocalSourceToGoogleCalendar
} from './sync-service'

const log = createLogger('Calendar:GoogleProvider')

function trackGoogle(
  name: 'calendar_google_connected' | 'calendar_google_sync_completed',
  action: string
): void {
  trackMainEvent(name, { surface: 'calendar', action, source: 'google', result: 'success' })
}

async function connectGoogle(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  const connected = await connectGoogleCalendar()
  const now = new Date().toISOString()
  const accountSourceId = `google-account:${connected.accountId}`
  const primaryCalendarSourceId = `google-calendar:${connected.primaryCalendar.remoteId}`

  upsertSyncedCalendarSource(db, {
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

  upsertSyncedCalendarSource(db, {
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

  trackGoogle('calendar_google_connected', 'connected')

  return {
    success: true,
    status: await buildProviderStatus(db, input.provider)
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

  const allProviderSources = listCalendarSources(db, { provider })
  const targetSources = allProviderSources.filter((source) => source.accountId === accountId)

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

async function disconnectGoogle(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
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

  const providerSources = listCalendarSources(db, { provider: input.provider })
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
}

async function refreshGoogle(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
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

  trackGoogle('calendar_google_sync_completed', 'sync_completed')

  return {
    success: true,
    status: await buildProviderStatus(db, input.provider)
  }
}

function onGoogleSelectionChanged(db: DataDb, before: CalendarSource, after: CalendarSource): void {
  // Turning a calendar off takes its events with it. Nothing polls an
  // unselected source, so anything left behind would sit on the calendar
  // view with no way to refresh or remove it.
  if (!after.isSelected) {
    purgeCalendarSourceMirrors(db, before.provider, [before])
  }

  if (after.kind !== 'calendar' || after.isMemryManaged) return

  const pushRuntime = getGooglePushRuntime()
  if (pushRuntime) {
    void pushRuntime.handleSelectionToggle({
      sourceId: after.id,
      isSelected: after.isSelected,
      calendarId: after.remoteId
    })
  }

  // The mirror image of the purge above. Turning a calendar on used to
  // change nothing the user could see until the next runner pass, so
  // the toggle read as broken in exactly the way turning one off does
  // not. Fire and forget: the toggle must not wait on the network, and
  // the sync emits its own change events when the events land.
  if (after.isSelected && !before.isSelected) {
    void syncGoogleCalendarSource(db, after.id).catch((err) => {
      log.warn('Immediate sync after enabling a Google calendar failed', err)
    })
  }
}

async function retryGoogleSource(
  db: DataDb,
  source: CalendarSource
): Promise<RetryCalendarSourceSyncResponse> {
  try {
    await syncGoogleCalendarSource(db, source.id)
  } catch (err) {
    log.warn('Google Calendar source retry sync failed', err)
    trackMainError('calendar', 'google_source_retry', err)
    const updated = getCalendarSourceById(db, source.id)
    return {
      success: false,
      source: updated ? mapCalendarSource(updated) : null,
      error: err instanceof Error ? err.message : getMainI18n().t('errors:calendar.syncFailed')
    }
  }
  const refreshed = getCalendarSourceById(db, source.id)
  return {
    success: true,
    source: refreshed ? mapCalendarSource(refreshed) : null
  }
}

export const googleCalendarProvider: ProviderDefinition = {
  id: GOOGLE_CALENDAR_PROVIDER,
  capabilities: PROVIDER_CAPABILITIES[GOOGLE_CALENDAR_PROVIDER],
  connect: connectGoogle,
  disconnect: disconnectGoogle,
  refresh: refreshGoogle,
  hasAnyLocalAuth: (db) => hasAnyGoogleCalendarLocalAuth(db),
  hasAccountLocalAuth: (_db, accountId) => hasGoogleCalendarLocalAuth(accountId),
  onSelectionChanged: onGoogleSelectionChanged,
  retrySource: retryGoogleSource,
  async listCalendars(db) {
    const accountId = resolveDefaultGoogleAccountId(db)
    if (!accountId) {
      return {
        provider: GOOGLE_CALENDAR_PROVIDER,
        calendars: [],
        primary: null,
        currentDefaultId: null
      }
    }
    const listed = await listGoogleCalendars(db, createGoogleCalendarClient({ accountId }))
    return { provider: GOOGLE_CALENDAR_PROVIDER, ...listed }
  },
  setDefaultCalendar: (db, input) =>
    setDefaultGoogleCalendar(db, {
      calendarId: input.calendarId,
      markOnboardingComplete: input.markOnboardingComplete
    }),
  writer: {
    syncLocalSource: (db, target) => syncLocalSourceToGoogleCalendar(db, target)
  }
}
