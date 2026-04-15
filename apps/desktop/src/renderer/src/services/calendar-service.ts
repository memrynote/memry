import type {
  CalendarChangedEvent,
  CalendarClientAPI,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarProjectionItem,
  CalendarProviderMutationResponse,
  CalendarProviderRequest,
  CalendarProviderStatus,
  CalendarRangeResponse,
  CalendarSourceListResponse,
  CalendarSourceMutationResponse,
  CalendarSourceRecord,
  CreateCalendarEventInput,
  GetCalendarRangeInput,
  ListCalendarEventsInput,
  ListCalendarSourcesInput,
  UpdateCalendarSourceSelectionInput,
  UpdateCalendarEventInput
} from '@memry/rpc/calendar'
import { createWindowApiForwarder } from './window-api-forwarder'

export type {
  CalendarChangedEvent,
  CalendarClientAPI,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarProjectionItem,
  CalendarProviderMutationResponse,
  CalendarProviderRequest,
  CalendarProviderStatus,
  CalendarRangeResponse,
  CalendarSourceListResponse,
  CalendarSourceMutationResponse,
  CalendarSourceRecord,
  CreateCalendarEventInput,
  GetCalendarRangeInput,
  ListCalendarEventsInput,
  ListCalendarSourcesInput,
  UpdateCalendarSourceSelectionInput,
  UpdateCalendarEventInput
}

export const calendarService: CalendarClientAPI = createWindowApiForwarder(
  () => window.api.calendar
)

export function onCalendarChanged(callback: (event: CalendarChangedEvent) => void): () => void {
  return window.api.onCalendarChanged(callback)
}

export function getGoogleCalendarStatus(): Promise<CalendarProviderStatus> {
  return calendarService.getProviderStatus({ provider: 'google' })
}

export function connectGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return calendarService.connectProvider({ provider: 'google' })
}

export function disconnectGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return calendarService.disconnectProvider({ provider: 'google' })
}

export function refreshGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return calendarService.refreshProvider({ provider: 'google' })
}

export function updateGoogleCalendarSourceSelection(
  input: UpdateCalendarSourceSelectionInput
): Promise<CalendarSourceMutationResponse> {
  return calendarService.updateSourceSelection(input)
}
