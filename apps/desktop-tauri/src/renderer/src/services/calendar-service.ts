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
  IcsCalendarMutationResponse,
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
import type {
  CalendarLinkedNotesResponse,
  GetExternalEventResponse,
  CalendarEventSearchResponse,
  GetExternalEventInput,
  ListLinkedNotesInput
} from '@memry/contracts/calendar-api'
import { commands, events } from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { subscribeToEvent } from './tauri-event'
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
  IcsCalendarMutationResponse,
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

/**
 * A mutation that failed in Rust answers `success: false` with the reason, as Electron's
 * `withDb` answered a handler that threw.
 */
async function answered<T extends { success: boolean }>(
  call: () => Promise<T>,
  refused: (error: string) => T
): Promise<T> {
  try {
    return await call()
  } catch (error) {
    return refused(extractErrorMessage(error))
  }
}

/*
 * The commands send the contract's shapes (`calendar/views.rs`). Their JSON fields (recurrence,
 * attendees, reminders, conference data, source metadata) travel as `Value`, and an absent
 * optional field is left out, so the generated types are wider than the contract's.
 */
// oxlint-disable typescript/no-unsafe-type-assertion -- see above: the commands send the contract shapes

/** The native calendar methods served from Rust commands (`commands/calendar.rs`, #3546 29b). */
const ported = {
  getRange: async (input: GetCalendarRangeInput): Promise<CalendarRangeResponse> =>
    (await commands.calendarGetRange(input)) as CalendarRangeResponse,

  searchEvents: async (
    input: Parameters<CalendarClientAPI['searchEvents']>[0]
  ): Promise<CalendarEventSearchResponse> =>
    (await commands.calendarSearchEvents(input)) as CalendarEventSearchResponse,

  createEvent: (input: CreateCalendarEventInput): Promise<CalendarEventMutationResponse> =>
    answered(
      async () => (await commands.calendarCreateEvent(input)) as CalendarEventMutationResponse,
      (error) => ({ success: false, event: null, error })
    ),

  getEvent: async (id: string): Promise<CalendarEventRecord | null> =>
    (await commands.calendarGetEvent(id)) as CalendarEventRecord | null,

  updateEvent: (input: UpdateCalendarEventInput): Promise<CalendarEventMutationResponse> =>
    answered(
      async () => (await commands.calendarUpdateEvent(input)) as CalendarEventMutationResponse,
      (error) => ({ success: false, event: null, error })
    ),

  deleteEvent: (id: string): Promise<CalendarDeleteResponse> =>
    answered(
      async () => (await commands.calendarDeleteEvent(id)) as CalendarDeleteResponse,
      (error) => ({ success: false, error })
    ),

  listLinkedNotes: (input: ListLinkedNotesInput): Promise<CalendarLinkedNotesResponse> =>
    commands.calendarListLinkedNotes(input),

  getExternalEvent: async (input: GetExternalEventInput): Promise<GetExternalEventResponse> =>
    (await commands.calendarGetExternalEvent(input)) as GetExternalEventResponse,

  promoteExternalEvent: (input: PromoteExternalEventInput): Promise<PromoteExternalEventResponse> =>
    answered(
      async () =>
        (await commands.calendarPromoteExternalEvent(input)) as PromoteExternalEventResponse,
      (error) => ({ success: false, eventId: null, error })
    ),

  listSources: async (options?: ListCalendarSourcesInput): Promise<CalendarSourceListResponse> =>
    (await commands.calendarListSources(options ?? {})) as CalendarSourceListResponse,

  updateSourceSelection: (
    input: UpdateCalendarSourceSelectionInput
  ): Promise<CalendarSourceMutationResponse> =>
    answered(
      async () =>
        (await commands.calendarUpdateSourceSelection(input)) as CalendarSourceMutationResponse,
      (error) => ({ success: false, source: null, error })
    )
} satisfies Partial<CalendarClientAPI>

// oxlint-enable typescript/no-unsafe-type-assertion

export const calendarService: CalendarClientAPI = createWindowApiForwarder<
  CalendarClientAPI,
  keyof typeof ported
>(() => window.api.calendar, ported)

export function onCalendarChanged(callback: (event: CalendarChangedEvent) => void): () => void {
  return subscribeToEvent(events.calendarChangedEvent, callback)
}

export function getGoogleCalendarStatus(): Promise<CalendarProviderStatus> {
  return calendarService.getProviderStatus({ provider: 'google' })
}

export function connectGoogleCalendarProvider(): Promise<CalendarProviderMutationResponse> {
  return calendarService.connectProvider({ provider: 'google' })
}

/**
 * Omitting `accountId` disconnects every linked Google account — that is the
 * main-process fallback branch. Pass one to unlink a single account.
 */
export function disconnectGoogleCalendarProvider(
  accountId?: string
): Promise<CalendarProviderMutationResponse> {
  return calendarService.disconnectProvider({
    provider: 'google',
    ...(accountId ? { accountId } : {})
  })
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
