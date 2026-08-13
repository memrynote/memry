import { z } from 'zod'
import { CalendarChannels } from '../../contracts/src/ipc-channels.ts'
import {
  CreateCalendarEventSchema,
  UpdateCalendarEventSchema,
  ListCalendarEventsSchema,
  ListGoogleCalendarsSchema,
  ListProviderCalendarsSchema,
  GetCalendarRangeSchema,
  ListCalendarSourcesSchema,
  PromoteExternalEventSchema,
  RetryCalendarSourceSyncSchema,
  SearchCalendarEventsSchema,
  SetDefaultGoogleCalendarSchema,
  SetDefaultProviderCalendarSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema,
  type CalendarChangedEvent,
  type CalendarDeleteResponse,
  type CalendarEventListResponse,
  type CalendarEventMutationResponse,
  type CalendarEventRecord,
  type CalendarEventSearchResponse,
  type CalendarProjectionItem,
  type CalendarProjectionVisualType,
  type CalendarProviderMutationResponse,
  type CalendarProviderStatus,
  type CalendarRangeResponse,
  type CalendarSourceListResponse,
  type CalendarSourceMutationResponse,
  type CalendarSourceRecord,
  type ListCalendarProvidersResponse,
  type ListGoogleCalendarsResponse,
  type ListProviderCalendarsResponse,
  type PromoteExternalEventResponse,
  type RetryCalendarSourceSyncResponse,
  type SetDefaultGoogleCalendarResponse,
  type SetDefaultProviderCalendarResponse
} from '../../contracts/src/calendar-api.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export type CreateCalendarEventInput = z.input<typeof CreateCalendarEventSchema>
export type UpdateCalendarEventInput = z.input<typeof UpdateCalendarEventSchema>
export type ListCalendarEventsInput = z.input<typeof ListCalendarEventsSchema>
export type SearchCalendarEventsInput = z.input<typeof SearchCalendarEventsSchema>
export type GetCalendarRangeInput = z.input<typeof GetCalendarRangeSchema>
export type ListCalendarSourcesInput = z.input<typeof ListCalendarSourcesSchema>
export type UpdateCalendarSourceSelectionInput = z.input<typeof UpdateCalendarSourceSelectionSchema>
export type CalendarProviderRequest = z.input<typeof CalendarProviderRequestSchema>
export type ListGoogleCalendarsInput = z.input<typeof ListGoogleCalendarsSchema>
export type ListProviderCalendarsInput = z.input<typeof ListProviderCalendarsSchema>
export type PromoteExternalEventInput = z.input<typeof PromoteExternalEventSchema>
export type SetDefaultGoogleCalendarInput = z.input<typeof SetDefaultGoogleCalendarSchema>
export type SetDefaultProviderCalendarInput = z.input<typeof SetDefaultProviderCalendarSchema>
export type RetryCalendarSourceSyncInput = z.input<typeof RetryCalendarSourceSyncSchema>

export type {
  CalendarChangedEvent,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarEventSearchResponse,
  CalendarProjectionItem,
  CalendarProjectionVisualType,
  CalendarProviderMutationResponse,
  CalendarProviderStatus,
  CalendarRangeResponse,
  CalendarSourceListResponse,
  CalendarSourceMutationResponse,
  CalendarSourceRecord,
  ListCalendarProvidersResponse,
  ListGoogleCalendarsResponse,
  ListProviderCalendarsResponse,
  PromoteExternalEventResponse,
  RetryCalendarSourceSyncResponse,
  SetDefaultGoogleCalendarResponse,
  SetDefaultProviderCalendarResponse
}

export const calendarRpc = defineDomain({
  name: 'calendar',
  methods: {
    createEvent: defineMethod<
      (input: CreateCalendarEventInput) => Promise<CalendarEventMutationResponse>
    >({
      channel: CalendarChannels.invoke.CREATE_EVENT,
      params: ['input']
    }),
    getEvent: defineMethod<(id: string) => Promise<CalendarEventRecord | null>>({
      channel: CalendarChannels.invoke.GET_EVENT,
      params: ['id']
    }),
    updateEvent: defineMethod<
      (input: UpdateCalendarEventInput) => Promise<CalendarEventMutationResponse>
    >({
      channel: CalendarChannels.invoke.UPDATE_EVENT,
      params: ['input']
    }),
    deleteEvent: defineMethod<(id: string) => Promise<CalendarDeleteResponse>>({
      channel: CalendarChannels.invoke.DELETE_EVENT,
      params: ['id']
    }),
    listEvents: defineMethod<
      (options?: ListCalendarEventsInput) => Promise<CalendarEventListResponse>
    >({
      channel: CalendarChannels.invoke.LIST_EVENTS,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    searchEvents: defineMethod<
      (input: SearchCalendarEventsInput) => Promise<CalendarEventSearchResponse>
    >({
      channel: CalendarChannels.invoke.SEARCH_EVENTS,
      params: ['input']
    }),
    getRange: defineMethod<(input: GetCalendarRangeInput) => Promise<CalendarRangeResponse>>({
      channel: CalendarChannels.invoke.GET_RANGE,
      params: ['input']
    }),
    listSources: defineMethod<
      (options?: ListCalendarSourcesInput) => Promise<CalendarSourceListResponse>
    >({
      channel: CalendarChannels.invoke.LIST_SOURCES,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    updateSourceSelection: defineMethod<
      (input: UpdateCalendarSourceSelectionInput) => Promise<CalendarSourceMutationResponse>
    >({
      channel: CalendarChannels.invoke.UPDATE_SOURCE_SELECTION,
      params: ['input']
    }),
    getProviderStatus: defineMethod<
      (input: CalendarProviderRequest) => Promise<CalendarProviderStatus>
    >({
      channel: CalendarChannels.invoke.GET_PROVIDER_STATUS,
      params: ['input']
    }),
    connectProvider: defineMethod<
      (input: CalendarProviderRequest) => Promise<CalendarProviderMutationResponse>
    >({
      channel: CalendarChannels.invoke.CONNECT_PROVIDER,
      params: ['input']
    }),
    disconnectProvider: defineMethod<
      (input: CalendarProviderRequest) => Promise<CalendarProviderMutationResponse>
    >({
      channel: CalendarChannels.invoke.DISCONNECT_PROVIDER,
      params: ['input']
    }),
    refreshProvider: defineMethod<
      (input: CalendarProviderRequest) => Promise<CalendarProviderMutationResponse>
    >({
      channel: CalendarChannels.invoke.REFRESH_PROVIDER,
      params: ['input']
    }),
    listProviders: defineMethod<() => Promise<ListCalendarProvidersResponse>>({
      channel: CalendarChannels.invoke.LIST_PROVIDERS,
      params: []
    }),
    listProviderCalendars: defineMethod<
      (options?: ListProviderCalendarsInput) => Promise<ListProviderCalendarsResponse>
    >({
      channel: CalendarChannels.invoke.LIST_PROVIDER_CALENDARS,
      params: ['options'],
      invokeArgs: ["options ?? { provider: 'google' }"]
    }),
    setDefaultProviderCalendar: defineMethod<
      (input: SetDefaultProviderCalendarInput) => Promise<SetDefaultProviderCalendarResponse>
    >({
      channel: CalendarChannels.invoke.SET_DEFAULT_PROVIDER_CALENDAR,
      params: ['input']
    }),
    retryCalendarSourceSync: defineMethod<
      (input: RetryCalendarSourceSyncInput) => Promise<RetryCalendarSourceSyncResponse>
    >({
      channel: CalendarChannels.invoke.RETRY_SOURCE_SYNC,
      params: ['input']
    }),
    // Permanent compatibility aliases — see the channel constants. Never remove.
    listGoogleCalendars: defineMethod<
      (options?: ListGoogleCalendarsInput) => Promise<ListGoogleCalendarsResponse>
    >({
      channel: CalendarChannels.invoke.LIST_GOOGLE_CALENDARS,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    setDefaultGoogleCalendar: defineMethod<
      (input: SetDefaultGoogleCalendarInput) => Promise<SetDefaultGoogleCalendarResponse>
    >({
      channel: CalendarChannels.invoke.SET_DEFAULT_GOOGLE_CALENDAR,
      params: ['input']
    }),
    promoteExternalEvent: defineMethod<
      (input: PromoteExternalEventInput) => Promise<PromoteExternalEventResponse>
    >({
      channel: CalendarChannels.invoke.PROMOTE_EXTERNAL_EVENT,
      params: ['input']
    }),
    retryGoogleCalendarSourceSync: defineMethod<
      (input: RetryCalendarSourceSyncInput) => Promise<RetryCalendarSourceSyncResponse>
    >({
      channel: CalendarChannels.invoke.RETRY_GOOGLE_CALENDAR_SOURCE_SYNC,
      params: ['input']
    })
  },
  events: {
    onCalendarChanged: defineEvent<CalendarChangedEvent>(CalendarChannels.events.CHANGED)
  }
})

export type CalendarClientAPI = RpcClient<typeof calendarRpc>
export type CalendarSubscriptions = RpcSubscriptions<typeof calendarRpc>
