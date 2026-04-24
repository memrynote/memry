import type {
  CalendarChangedEvent,
  CalendarClientAPI,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarProjectionItem,
  CalendarProjectionVisualType,
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
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

export type {
  CalendarChangedEvent,
  CalendarClientAPI,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarProjectionItem,
  CalendarProjectionVisualType,
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

export const calendarService: CalendarClientAPI = createInvokeForwarder<CalendarClientAPI>(
  'calendar'
)

export function onCalendarChanged(callback: (event: CalendarChangedEvent) => void): () => void {
  return subscribeEvent<CalendarChangedEvent>('calendar-changed', callback)
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
