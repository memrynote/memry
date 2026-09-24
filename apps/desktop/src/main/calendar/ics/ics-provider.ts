import { and, eq, isNull } from 'drizzle-orm'
import {
  ICS_CALENDAR_PROVIDER,
  type CalendarProviderMutationResponse,
  type CalendarProviderRequest
} from '@memry/contracts/calendar-api'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { getMainI18n } from '../../lib/main-i18n'
import { mapCalendarSource } from '../calendar-source-record'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import type { ProviderDefinition } from '../provider/registry'
import { buildProviderStatus } from '../provider/status'
import { IcsFeedError } from './ics-feed'
import {
  purgeIcsCalendarEvents,
  refreshIcsCalendarSource,
  subscribeIcsCalendar,
  unsubscribeIcsCalendar
} from './ics-subscriptions'

const log = createLogger('Calendar:IcsProvider')

async function failure(
  db: DataDb,
  error: unknown,
  sourceId?: string
): Promise<CalendarProviderMutationResponse> {
  if (!(error instanceof IcsFeedError)) throw error
  const source = sourceId ? getCalendarSourceById(db, sourceId) : undefined
  return {
    success: false,
    status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER),
    error: error.message,
    errorCode: error.code,
    source: source ? mapCalendarSource(source) : null
  }
}

async function missingSourceResponse(db: DataDb): Promise<CalendarProviderMutationResponse> {
  return {
    success: false,
    status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER),
    error: getMainI18n().t('errors:calendar.sourceNotFound')
  }
}

/**
 * `calendar:connect-provider` with `connection.kind = 'url'`: the generic
 * route to what `calendar:subscribe-ics` does (#1392).
 */
async function connectIcs(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  if (input.connection?.kind !== 'url') {
    return await failure(db, new IcsFeedError('invalid_url'))
  }
  try {
    const source = await subscribeIcsCalendar(db, {
      url: input.connection.url,
      title: input.connection.title
    })
    return {
      success: true,
      status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER),
      source: mapCalendarSource(source)
    }
  } catch (error) {
    log.warn('Calendar feed subscribe failed', {
      code: error instanceof IcsFeedError ? error.code : 'unknown'
    })
    return await failure(db, error)
  }
}

async function disconnectIcs(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  if (!input.sourceId) return await missingSourceResponse(db)
  const source = unsubscribeIcsCalendar(db, input.sourceId)
  return {
    success: true,
    status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER),
    source: mapCalendarSource(source)
  }
}

/** One feed when `sourceId` is given, otherwise every visible feed now. */
async function refreshIcs(
  db: DataDb,
  input: CalendarProviderRequest
): Promise<CalendarProviderMutationResponse> {
  if (input.sourceId) {
    try {
      const source = await refreshIcsCalendarSource(db, input.sourceId)
      return {
        success: true,
        status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER),
        source: mapCalendarSource(source)
      }
    } catch (error) {
      return await failure(db, error, input.sourceId)
    }
  }

  const sources = db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, ICS_CALENDAR_PROVIDER),
        eq(calendarSources.isSelected, true),
        isNull(calendarSources.archivedAt)
      )
    )
    .all()
  let firstFailure: CalendarProviderMutationResponse | null = null
  for (const source of sources) {
    try {
      await refreshIcsCalendarSource(db, source.id)
    } catch (error) {
      firstFailure ??= await failure(db, error, source.id)
    }
  }
  return (
    firstFailure ?? {
      success: true,
      status: await buildProviderStatus(db, ICS_CALENDAR_PROVIDER)
    }
  )
}

export const icsCalendarProvider: ProviderDefinition = {
  id: ICS_CALENDAR_PROVIDER,
  capabilities: PROVIDER_CAPABILITIES[ICS_CALENDAR_PROVIDER],
  connect: connectIcs,
  disconnect: disconnectIcs,
  refresh: refreshIcs,
  // A feed URL is not a credential: ICS has no local auth to report, exactly
  // as the status looked before the registry existed.
  hasAnyLocalAuth: async () => false,
  hasAccountLocalAuth: async () => false,
  onSelectionChanged(db, before, after) {
    if (!after.isSelected) {
      purgeIcsCalendarEvents(db, after.id)
    } else if (!before.isSelected) {
      void refreshIcsCalendarSource(db, after.id).catch((err) => {
        log.warn('Immediate refresh after enabling a subscribed calendar failed', err)
      })
    }
  },
  async retrySource(db, source) {
    try {
      const refreshed = await refreshIcsCalendarSource(db, source.id)
      return { success: true, source: mapCalendarSource(refreshed) }
    } catch (error) {
      if (!(error instanceof IcsFeedError)) throw error
      const updated = getCalendarSourceById(db, source.id)
      return {
        success: false,
        source: updated ? mapCalendarSource(updated) : null,
        error: error.message
      }
    }
  }
}
