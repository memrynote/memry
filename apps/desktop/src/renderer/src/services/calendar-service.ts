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
  ListCalendarProvidersResponse,
  ListProviderCalendarsResponse,
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
  ListCalendarProvidersResponse,
  ListProviderCalendarsResponse,
  SetDefaultGoogleCalendarInput,
  SetDefaultGoogleCalendarResponse,
  UpdateCalendarSourceSelectionInput,
  UpdateCalendarEventInput
}

export const calendarService: CalendarClientAPI = createWindowApiForwarder(
  () => window.api.calendar
)

/** The one provider id the renderer still hard-codes, for the Google-named helpers below. */
export const GOOGLE_CALENDAR_PROVIDER_ID = 'google'

export function onCalendarChanged(callback: (event: CalendarChangedEvent) => void): () => void {
  return window.api.onCalendarChanged(callback)
}

/** Providers this build can connect, with the capabilities that drive the UI. */
export function listCalendarProviders(): Promise<ListCalendarProvidersResponse> {
  return calendarService.listProviders()
}

export function getCalendarProviderStatus(provider: string): Promise<CalendarProviderStatus> {
  return calendarService.getProviderStatus({ provider })
}

export function connectCalendarProvider(
  provider: string
): Promise<CalendarProviderMutationResponse> {
  return calendarService.connectProvider({ provider })
}

/**
 * Omitting `accountId` disconnects every linked account for that provider —
 * that is the main-process fallback branch. Pass one to unlink a single account.
 */
export function disconnectCalendarProvider(
  provider: string,
  accountId?: string
): Promise<CalendarProviderMutationResponse> {
  return calendarService.disconnectProvider({
    provider,
    ...(accountId ? { accountId } : {})
  })
}

export function refreshCalendarProvider(
  provider: string
): Promise<CalendarProviderMutationResponse> {
  return calendarService.refreshProvider({ provider })
}

export function getGoogleCalendarStatus(): Promise<CalendarProviderStatus> {
  return getCalendarProviderStatus(GOOGLE_CALENDAR_PROVIDER_ID)
}

export function connectGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return connectCalendarProvider(GOOGLE_CALENDAR_PROVIDER_ID)
}

export function disconnectGoogleCalendarProvider(
  accountId?: string
): Promise<CalendarProviderMutationResponse> {
  return disconnectCalendarProvider(GOOGLE_CALENDAR_PROVIDER_ID, accountId)
}

export function refreshGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return refreshCalendarProvider(GOOGLE_CALENDAR_PROVIDER_ID)
}

export function updateGoogleCalendarSourceSelection(
  input: UpdateCalendarSourceSelectionInput
): Promise<CalendarSourceMutationResponse> {
  return calendarService.updateSourceSelection(input)
}

export function listProviderCalendars(
  provider: string = GOOGLE_CALENDAR_PROVIDER_ID
): Promise<ListProviderCalendarsResponse> {
  return calendarService.listProviderCalendars({ provider })
}

export function listGoogleCalendars(): Promise<ListGoogleCalendarsResponse> {
  return listProviderCalendars(GOOGLE_CALENDAR_PROVIDER_ID)
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

export function retryCalendarSourceSync(
  input: RetryCalendarSourceSyncInput
): Promise<RetryCalendarSourceSyncResponse> {
  return calendarService.retryCalendarSourceSync(input)
}

export function retryGoogleCalendarSourceSync(
  input: RetryCalendarSourceSyncInput
): Promise<RetryCalendarSourceSyncResponse> {
  return retryCalendarSourceSync(input)
}
