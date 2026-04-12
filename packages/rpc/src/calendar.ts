import { z } from 'zod'
import { CalendarChannels } from '../../contracts/src/ipc-channels.ts'
import {
  CreateCalendarEventSchema,
  UpdateCalendarEventSchema,
  ListCalendarEventsSchema,
  GetCalendarRangeSchema,
  ListCalendarSourcesSchema,
  UpdateCalendarSourceSelectionSchema,
  CalendarProviderRequestSchema,
  type CalendarChangedEvent,
  type CalendarDeleteResponse,
  type CalendarEventListResponse,
  type CalendarEventMutationResponse,
  type CalendarEventRecord,
  type CalendarProjectionItem,
  type CalendarProviderMutationResponse,
  type CalendarProviderStatus,
  type CalendarRangeResponse,
  type CalendarSourceListResponse,
  type CalendarSourceMutationResponse,
  type CalendarSourceRecord
} from '../../contracts/src/calendar-api.ts'
import { defineDomain, defineEvent, defineMethod, type RpcClient, type RpcSubscriptions } from './schema.ts'

export type CreateCalendarEventInput = z.input<typeof CreateCalendarEventSchema>
export type UpdateCalendarEventInput = z.input<typeof UpdateCalendarEventSchema>
export type ListCalendarEventsInput = z.input<typeof ListCalendarEventsSchema>
export type GetCalendarRangeInput = z.input<typeof GetCalendarRangeSchema>
export type ListCalendarSourcesInput = z.input<typeof ListCalendarSourcesSchema>
export type UpdateCalendarSourceSelectionInput = z.input<typeof UpdateCalendarSourceSelectionSchema>
export type CalendarProviderRequest = z.input<typeof CalendarProviderRequestSchema>

export type {
  CalendarChangedEvent,
  CalendarDeleteResponse,
  CalendarEventListResponse,
  CalendarEventMutationResponse,
  CalendarEventRecord,
  CalendarProjectionItem,
  CalendarProviderMutationResponse,
  CalendarProviderStatus,
  CalendarRangeResponse,
  CalendarSourceListResponse,
  CalendarSourceMutationResponse,
  CalendarSourceRecord
}

export const calendarRpc = defineDomain({
  name: 'calendar',
  methods: {
    createEvent: defineMethod<(input: CreateCalendarEventInput) => Promise<CalendarEventMutationResponse>>({
      channel: CalendarChannels.invoke.CREATE_EVENT,
      params: ['input']
    }),
    getEvent: defineMethod<(id: string) => Promise<CalendarEventRecord | null>>({
      channel: CalendarChannels.invoke.GET_EVENT,
      params: ['id']
    }),
    updateEvent: defineMethod<(input: UpdateCalendarEventInput) => Promise<CalendarEventMutationResponse>>({
      channel: CalendarChannels.invoke.UPDATE_EVENT,
      params: ['input']
    }),
    deleteEvent: defineMethod<(id: string) => Promise<CalendarDeleteResponse>>({
      channel: CalendarChannels.invoke.DELETE_EVENT,
      params: ['id']
    }),
    listEvents: defineMethod<(options?: ListCalendarEventsInput) => Promise<CalendarEventListResponse>>({
      channel: CalendarChannels.invoke.LIST_EVENTS,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    getRange: defineMethod<(input: GetCalendarRangeInput) => Promise<CalendarRangeResponse>>({
      channel: CalendarChannels.invoke.GET_RANGE,
      params: ['input']
    }),
    listSources: defineMethod<(options?: ListCalendarSourcesInput) => Promise<CalendarSourceListResponse>>({
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
    getProviderStatus: defineMethod<(input: CalendarProviderRequest) => Promise<CalendarProviderStatus>>({
      channel: CalendarChannels.invoke.GET_PROVIDER_STATUS,
      params: ['input']
    }),
    connectProvider: defineMethod<(input: CalendarProviderRequest) => Promise<CalendarProviderMutationResponse>>({
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
    })
  },
  events: {
    onCalendarChanged: defineEvent<CalendarChangedEvent>(CalendarChannels.events.CHANGED)
  }
})

export type CalendarClientAPI = RpcClient<typeof calendarRpc>
export type CalendarSubscriptions = RpcSubscriptions<typeof calendarRpc>
