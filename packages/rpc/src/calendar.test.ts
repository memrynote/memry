import { describe, expect, it } from 'vitest'
import {
  CreateCalendarEventSchema,
  GetCalendarRangeSchema,
  ListCalendarEventsSchema,
  UpdateCalendarEventSchema
} from '../../contracts/src/calendar-api.ts'
import { CalendarChannels } from '../../contracts/src/ipc-channels.ts'
import { calendarRpc } from './calendar.ts'

describe('calendarRpc domain shape', () => {
  it('has name "calendar"', () => {
    expect(calendarRpc.name).toBe('calendar')
  })

  it('every method spec has channel, mode, and arg arrays', () => {
    for (const [key, method] of Object.entries(calendarRpc.methods)) {
      expect(method.channel, `method ${key}`).toBeTypeOf('string')
      expect(['invoke', 'sync'], `method ${key}`).toContain(method.mode)
      expect(Array.isArray(method.params)).toBe(true)
      expect(Array.isArray(method.invokeArgs)).toBe(true)
    }
  })

  it('declares a single onCalendarChanged event', () => {
    expect(Object.keys(calendarRpc.events)).toEqual(['onCalendarChanged'])
    expect(calendarRpc.events.onCalendarChanged.channel).toBe(CalendarChannels.events.CHANGED)
  })

  it('wires CRUD methods to CalendarChannels.invoke', () => {
    expect(calendarRpc.methods.createEvent.channel).toBe(CalendarChannels.invoke.CREATE_EVENT)
    expect(calendarRpc.methods.getEvent.channel).toBe(CalendarChannels.invoke.GET_EVENT)
    expect(calendarRpc.methods.updateEvent.channel).toBe(CalendarChannels.invoke.UPDATE_EVENT)
    expect(calendarRpc.methods.deleteEvent.channel).toBe(CalendarChannels.invoke.DELETE_EVENT)
    expect(calendarRpc.methods.listEvents.channel).toBe(CalendarChannels.invoke.LIST_EVENTS)
    expect(calendarRpc.methods.getRange.channel).toBe(CalendarChannels.invoke.GET_RANGE)
  })

  it('provider methods share the CalendarProviderRequest input', () => {
    expect(calendarRpc.methods.getProviderStatus.params).toEqual(['input'])
    expect(calendarRpc.methods.connectProvider.params).toEqual(['input'])
    expect(calendarRpc.methods.disconnectProvider.params).toEqual(['input'])
    expect(calendarRpc.methods.refreshProvider.params).toEqual(['input'])
  })

  it('listEvents and listSources default their options to empty object', () => {
    expect(calendarRpc.methods.listEvents.invokeArgs).toEqual(['options ?? {}'])
    expect(calendarRpc.methods.listSources.invokeArgs).toEqual(['options ?? {}'])
  })
})

describe('calendar Zod schemas (contract inputs)', () => {
  it('CreateCalendarEventSchema accepts a realistic payload', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'Sprint review',
      startAt: '2026-05-01T15:00:00Z',
      endAt: '2026-05-01T16:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('CreateCalendarEventSchema rejects missing title', () => {
    const result = CreateCalendarEventSchema.safeParse({
      startAt: '2026-05-01T15:00:00Z'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('title'))).toBe(true)
    }
  })

  it('CreateCalendarEventSchema rejects non-datetime startAt', () => {
    const result = CreateCalendarEventSchema.safeParse({
      title: 'x',
      startAt: '2026-05-01'
    })
    expect(result.success).toBe(false)
  })

  it('UpdateCalendarEventSchema requires an id', () => {
    expect(UpdateCalendarEventSchema.safeParse({ id: 'e-1' }).success).toBe(true)
    expect(UpdateCalendarEventSchema.safeParse({ title: 'x' }).success).toBe(false)
  })

  it('GetCalendarRangeSchema requires startAt/endAt datetimes', () => {
    const ok = GetCalendarRangeSchema.safeParse({
      startAt: '2026-05-01T00:00:00Z',
      endAt: '2026-05-31T23:59:59Z'
    })
    expect(ok.success).toBe(true)

    const bad = GetCalendarRangeSchema.safeParse({ startAt: '2026-05-01T00:00:00Z' })
    expect(bad.success).toBe(false)
  })

  it('ListCalendarEventsSchema accepts an empty options object with defaults', () => {
    const result = ListCalendarEventsSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.includeArchived).toBe(false)
    }
  })
})
