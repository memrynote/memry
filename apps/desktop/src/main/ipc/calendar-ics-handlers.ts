import { ipcMain } from 'electron'
import { CalendarChannels } from '@memry/contracts/ipc-channels'
import {
  IcsCalendarSourceRequestSchema,
  SubscribeIcsCalendarSchema,
  UpdateIcsCalendarSchema,
  type IcsCalendarMutationResponse
} from '@memry/contracts/calendar-api'
import { createLogger } from '../lib/logger'
import { IcsFeedError } from '../calendar/ics/ics-feed'
import {
  refreshIcsCalendarSource,
  subscribeIcsCalendar,
  summarizeIcsCalendarEvents,
  unsubscribeIcsCalendar,
  updateIcsCalendar
} from '../calendar/ics/ics-subscriptions'
import { getCalendarSourceById } from '../calendar/repositories/calendar-sources-repository'
import { mapCalendarSource } from '../calendar/calendar-source-record'
import { createValidatedHandler, withDb } from './validate'

const log = createLogger('IPC:CalendarIcs')

function feedFailure(error: unknown): IcsCalendarMutationResponse {
  if (error instanceof IcsFeedError) {
    return { success: false, source: null, errorCode: error.code, error: error.message }
  }
  throw error
}

export function registerCalendarIcsHandlers(): void {
  ipcMain.handle(
    CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR,
    createValidatedHandler(
      SubscribeIcsCalendarSchema,
      withDb(async (db, input): Promise<IcsCalendarMutationResponse> => {
        try {
          const source = await subscribeIcsCalendar(db, input)
          return {
            success: true,
            source: mapCalendarSource(source),
            summary: summarizeIcsCalendarEvents(db, source.id)
          }
        } catch (error) {
          log.warn('Calendar feed subscribe failed', {
            code: error instanceof IcsFeedError ? error.code : 'unknown'
          })
          return feedFailure(error)
        }
      }, 'errors:calendar.syncFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.UNSUBSCRIBE_ICS_CALENDAR,
    createValidatedHandler(
      IcsCalendarSourceRequestSchema,
      withDb((db, input): IcsCalendarMutationResponse => {
        const source = unsubscribeIcsCalendar(db, input.sourceId)
        return { success: true, source: mapCalendarSource(source) }
      }, 'errors:calendar.updateSourceSelectionFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.REFRESH_ICS_CALENDAR,
    createValidatedHandler(
      IcsCalendarSourceRequestSchema,
      withDb(async (db, input): Promise<IcsCalendarMutationResponse> => {
        try {
          const source = await refreshIcsCalendarSource(db, input.sourceId)
          return { success: true, source: mapCalendarSource(source) }
        } catch (error) {
          const response = feedFailure(error)
          const source = getCalendarSourceById(db, input.sourceId)
          return { ...response, source: source ? mapCalendarSource(source) : null }
        }
      }, 'errors:calendar.syncFailed')
    )
  )

  ipcMain.handle(
    CalendarChannels.invoke.UPDATE_ICS_CALENDAR,
    createValidatedHandler(
      UpdateIcsCalendarSchema,
      withDb((db, input): IcsCalendarMutationResponse => {
        const source = updateIcsCalendar(db, input)
        return { success: true, source: mapCalendarSource(source) }
      }, 'errors:calendar.updateSubscriptionFailed')
    )
  )
}

export function unregisterCalendarIcsHandlers(): void {
  ipcMain.removeHandler(CalendarChannels.invoke.SUBSCRIBE_ICS_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.UNSUBSCRIBE_ICS_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.REFRESH_ICS_CALENDAR)
  ipcMain.removeHandler(CalendarChannels.invoke.UPDATE_ICS_CALENDAR)
}
