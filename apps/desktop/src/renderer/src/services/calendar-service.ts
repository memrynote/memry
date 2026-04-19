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
  ListGoogleCalendarsInput,
  ListGoogleCalendarsResponse,
  PromoteExternalEventInput,
  PromoteExternalEventResponse,
  RetryCalendarSourceSyncInput,
  RetryCalendarSourceSyncResponse,
  SetDefaultGoogleCalendarInput,
  SetDefaultGoogleCalendarResponse,
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
  ListGoogleCalendarsInput,
  ListGoogleCalendarsResponse,
  PromoteExternalEventInput,
  PromoteExternalEventResponse,
  RetryCalendarSourceSyncInput,
  RetryCalendarSourceSyncResponse,
  SetDefaultGoogleCalendarInput,
  SetDefaultGoogleCalendarResponse,
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

export function listGoogleCalendars(): Promise<ListGoogleCalendarsResponse> {
  return calendarService.listGoogleCalendars({})
}

export function setDefaultGoogleCalendar(
  input: SetDefaultGoogleCalendarInput
): Promise<SetDefaultGoogleCalendarResponse> {
  return calendarService.setDefaultGoogleCalendar(input)
}

export function promoteExternalCalendarEvent(
  input: PromoteExternalEventInput
): Promise<PromoteExternalEventResponse> {
  return calendarService.promoteExternalEvent(input)
}

export function retryGoogleCalendarSourceSync(
  input: RetryCalendarSourceSyncInput
): Promise<RetryCalendarSourceSyncResponse> {
  return calendarService.retryGoogleCalendarSourceSync(input)
}
