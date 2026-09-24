import {
  CALDAV_CALENDAR_PROVIDER,
  type CalendarProviderMutationResponse,
  type CalendarProviderRequest,
  type RetryCalendarSourceSyncResponse
} from '@memry/contracts/calendar-api'
import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { mapCalendarSource } from '../calendar-source-record'
import { emitCalendarChanged } from '../change-events'
import {
  getCalendarSourceById,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { syncCalendarSourceUpdate } from '../runtime-effects'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import type { ProviderDefinition } from '../provider/registry'
import { purgeCalendarSourceMirrors } from '../provider/source-mirrors'
import { buildProviderStatus } from '../provider/status'
import { checkProviderWriterCompat, writerCompatAllowsConnect } from '../provider/writer-compat'
import { createWriterCompatDeps } from '../provider/writer-compat-runtime'
import {
  hasCaldavAuthFailure,
  hasCaldavLocalAuth,
  listCaldavAccountSources,
  readCaldavPassword
} from './caldav-accounts'
import {
  CaldavConnectError,
  connectCaldavAccount,
  disconnectCaldavAccount,
  discoverCaldavCalendars
} from './caldav-connect'
import { listSelectedCaldavCalendars, syncCaldavCalendarSource, syncCaldavNow } from './caldav-sync'
import { syncLocalSourceToCaldav } from './caldav-write'
import {
  clearDefaultWriteTargetFor,
  dropStaleDefaultWriteTarget,
  readDefaultWriteTarget,
  writeDefaultWriteTarget
} from '../provider/write-routing'

const log = createLogger('Calendar:CaldavProvider')

async function failure(
  db: DataDb,
  errorCode: string,
  error?: string
): Promise<CalendarProviderMutationResponse> {
  return {
    success: false,
    status: await buildProviderStatus(db, CALDAV_CALENDAR_PROVIDER),
    errorCode,
    error: error ?? errorCode
  }
}

async function connectCaldav(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  const connection = input.connection
  if (connection?.kind !== 'basic') return await failure(db, 'invalid_url')

  // #1396: a writable CalDAV account is a second writer. Devices too old to
  // route writes would double-push its items, so the user must see them first.
  const compat = await checkProviderWriterCompat(
    CALDAV_CALENDAR_PROVIDER,
    createWriterCompatDeps(db)
  )
  if (!writerCompatAllowsConnect(compat, connection.acknowledgeOutdatedDevices)) {
    return await failure(db, 'outdated_devices')
  }

  try {
    await connectCaldavAccount(db, {
      serverUrl: connection.serverUrl,
      username: connection.username,
      password: connection.password,
      preset: connection.preset ?? null,
      selectedCalendarIds: connection.selectedCalendarIds
    })
  } catch (error) {
    if (error instanceof CaldavConnectError) return await failure(db, error.code, error.message)
    throw error
  }

  void syncCaldavNow(db).catch((error) => {
    log.warn('First CalDAV sync after connect failed', error)
  })
  return { success: true, status: await buildProviderStatus(db, CALDAV_CALENDAR_PROVIDER) }
}

async function refreshCaldav(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  if (input.sourceId) {
    try {
      await syncCaldavCalendarSource(db, input.sourceId)
    } catch (error) {
      const source = getCalendarSourceById(db, input.sourceId)
      return {
        ...(await failure(db, 'sync_failed', error instanceof Error ? error.message : undefined)),
        source: source ? mapCalendarSource(source) : null
      }
    }
    const source = getCalendarSourceById(db, input.sourceId)
    return {
      success: true,
      status: await buildProviderStatus(db, CALDAV_CALENDAR_PROVIDER),
      source: source ? mapCalendarSource(source) : null
    }
  }
  const { failed } = await syncCaldavNow(db, { accountId: input.accountId })
  emitCalendarChanged({ entityType: 'projection', id: 'caldav-refresh' })
  if (failed > 0) return await failure(db, 'sync_failed')
  return { success: true, status: await buildProviderStatus(db, CALDAV_CALENDAR_PROVIDER) }
}

async function retryCaldavSource(
  db: DataDb,
  source: CalendarSource
): Promise<RetryCalendarSourceSyncResponse> {
  try {
    await syncCaldavCalendarSource(db, source.id)
  } catch (error) {
    const updated = getCalendarSourceById(db, source.id)
    return {
      success: false,
      source: updated ? mapCalendarSource(updated) : null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  const refreshed = getCalendarSourceById(db, source.id)
  return { success: true, source: refreshed ? mapCalendarSource(refreshed) : null }
}

export const caldavCalendarProvider: ProviderDefinition = {
  id: CALDAV_CALENDAR_PROVIDER,
  capabilities: PROVIDER_CAPABILITIES[CALDAV_CALENDAR_PROVIDER],
  connect: connectCaldav,
  async disconnect(db, input) {
    await disconnectCaldavAccount(db, input.accountId)
    return { success: true, status: await buildProviderStatus(db, CALDAV_CALENDAR_PROVIDER) }
  },
  refresh: refreshCaldav,
  async hasAnyLocalAuth(db) {
    for (const account of listCaldavAccountSources(db)) {
      if (account.accountId && (await hasCaldavLocalAuth(db, account.accountId))) return true
    }
    return false
  },
  hasAccountLocalAuth: (db, accountId) => hasCaldavLocalAuth(db, accountId),
  async accountReconnectReason(db, accountId) {
    if (hasCaldavAuthFailure(db, accountId)) return 'rejected'
    return (await readCaldavPassword(accountId)) ? null : 'missing'
  },
  onSelectionChanged(db, before, after) {
    // The mirror is synced, so unticking removes the events everywhere, as it
    // does for Google; ticking pulls straight away.
    if (!after.isSelected) {
      purgeCalendarSourceMirrors(db, before.provider, [before])
      // The events are gone, so the cursor that covered them is too: turning
      // the calendar back on must pull it in full.
      if (after.syncCursor) {
        upsertCalendarSource(db, {
          ...after,
          syncCursor: null,
          modifiedAt: new Date().toISOString()
        })
        syncCalendarSourceUpdate(after.id)
      }
      dropStaleDefaultWriteTarget(db)
      return
    }
    if (!before.isSelected) {
      void syncCaldavCalendarSource(db, after.id).catch((error) => {
        log.warn('Immediate sync after enabling a CalDAV calendar failed', error)
      })
    }
  },
  retrySource: retryCaldavSource,
  writer: {
    syncLocalSource: (db, target, route) => syncLocalSourceToCaldav(db, target, route)
  },
  async listCalendars(db) {
    const writableAccounts = new Set<string>()
    for (const account of listCaldavAccountSources(db)) {
      if (account.accountId && (await hasCaldavLocalAuth(db, account.accountId))) {
        writableAccounts.add(account.accountId)
      }
    }
    const calendars = listSelectedCaldavCalendars(db)
      .filter((source) => source.accountId && writableAccounts.has(source.accountId))
      .map((source) => ({
        id: source.remoteId,
        title: source.title,
        timezone: source.timezone ?? null,
        color: source.color ?? null,
        isPrimary: false
      }))
    const target = readDefaultWriteTarget(db)
    return {
      provider: CALDAV_CALENDAR_PROVIDER,
      calendars,
      primary: null,
      currentDefaultId:
        target?.provider === CALDAV_CALENDAR_PROVIDER ? target.remoteCalendarId : null
    }
  },
  setDefaultCalendar(db, input) {
    if (input.calendarId) {
      writeDefaultWriteTarget(db, {
        provider: CALDAV_CALENDAR_PROVIDER,
        remoteCalendarId: input.calendarId
      })
    } else {
      clearDefaultWriteTargetFor(db, CALDAV_CALENDAR_PROVIDER)
    }
    return { success: true }
  },
  async discover(connection) {
    if (connection.kind !== 'basic') {
      return { success: false, calendars: [], errorCode: 'invalid_url' }
    }
    try {
      const info = await discoverCaldavCalendars(connection)
      return {
        success: true,
        calendars: info.calendars.map((calendar) => ({
          id: calendar.url,
          title: calendar.displayName,
          color: calendar.color
        }))
      }
    } catch (error) {
      if (!(error instanceof CaldavConnectError)) throw error
      return { success: false, calendars: [], errorCode: error.code, error: error.message }
    }
  }
}
