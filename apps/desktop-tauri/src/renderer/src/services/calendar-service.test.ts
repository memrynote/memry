import { beforeEach, describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => ({
  calendarGetRange: vi.fn(),
  calendarSearchEvents: vi.fn(),
  calendarCreateEvent: vi.fn(),
  calendarGetEvent: vi.fn(),
  calendarUpdateEvent: vi.fn(),
  calendarDeleteEvent: vi.fn(),
  calendarListLinkedNotes: vi.fn(),
  calendarGetExternalEvent: vi.fn(),
  calendarPromoteExternalEvent: vi.fn(),
  calendarListSources: vi.fn(),
  calendarUpdateSourceSelection: vi.fn()
}))

// The change event's last listener, for a test to send a payload through.
const listeners = vi.hoisted(() => new Set<(event: { payload: unknown }) => void>())
const events = vi.hoisted(() => ({
  calendarChangedEvent: {
    listen: async (handler: (event: { payload: unknown }) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }
  }
}))

vi.mock('../../../generated/bindings', () => ({ commands, events }))

import {
  calendarService,
  connectGoogleCalendarProvider,
  disconnectGoogleCalendarProvider,
  getGoogleCalendarStatus,
  listGoogleCalendars,
  onCalendarChanged,
  promoteExternalCalendarEvent,
  refreshGoogleCalendarProvider,
  retryGoogleCalendarSourceSync,
  setDefaultGoogleCalendar,
  updateGoogleCalendarSourceSelection
} from './calendar-service'

const RANGE = { startAt: '2026-05-01T00:00:00.000Z', endAt: '2026-06-01T00:00:00.000Z' }
const refusal = { kind: 'storage', code: 'storage_failed', message: 'disk is full' }

describe('calendar-service', () => {
  let api: { calendar: Record<string, ReturnType<typeof vi.fn>> }

  beforeEach(() => {
    for (const command of Object.values(commands)) command.mockReset()
    listeners.clear()
    api = {
      calendar: {
        getRange: vi.fn(),
        getProviderStatus: vi.fn().mockResolvedValue({ connected: true }),
        connectProvider: vi.fn().mockResolvedValue({ success: true }),
        disconnectProvider: vi.fn().mockResolvedValue({ success: true }),
        refreshProvider: vi.fn().mockResolvedValue({ success: true }),
        listGoogleCalendars: vi.fn().mockResolvedValue({ calendars: [] }),
        setDefaultGoogleCalendar: vi.fn().mockResolvedValue({ success: true }),
        retryGoogleCalendarSourceSync: vi.fn().mockResolvedValue({ success: true })
      }
    }
    Object.assign(window, { api })
  })

  it('reads the range, events, sources and linked notes from the Rust commands', async () => {
    commands.calendarGetRange.mockResolvedValue({ items: [] })
    commands.calendarSearchEvents.mockResolvedValue({ events: [] })
    commands.calendarGetEvent.mockResolvedValue(null)
    commands.calendarListSources.mockResolvedValue({ sources: [] })
    commands.calendarListLinkedNotes.mockResolvedValue({ notes: [] })
    commands.calendarGetExternalEvent.mockResolvedValue({ event: null })

    await expect(
      calendarService.getRange({ ...RANGE, includeUnselectedSources: true })
    ).resolves.toEqual({ items: [] })
    await expect(calendarService.searchEvents({ query: 'standup' })).resolves.toEqual({
      events: []
    })
    await expect(calendarService.getEvent('event-1')).resolves.toBeNull()
    await expect(calendarService.listSources()).resolves.toEqual({ sources: [] })
    await expect(
      calendarService.listLinkedNotes({ sourceType: 'event', sourceId: 'event-1' })
    ).resolves.toEqual({ notes: [] })
    await expect(calendarService.getExternalEvent({ externalEventId: 'ext-1' })).resolves.toEqual({
      event: null
    })

    expect(commands.calendarGetRange).toHaveBeenCalledWith({
      ...RANGE,
      includeUnselectedSources: true
    })
    expect(commands.calendarSearchEvents).toHaveBeenCalledWith({ query: 'standup' })
    expect(commands.calendarGetEvent).toHaveBeenCalledWith('event-1')
    expect(commands.calendarListSources).toHaveBeenCalledWith({})
    expect(api.calendar.getRange).not.toHaveBeenCalled()
  })

  it('answers a mutation that failed in Rust with success false and the reason', async () => {
    commands.calendarCreateEvent.mockRejectedValue(refusal)
    commands.calendarUpdateEvent.mockRejectedValue(refusal)
    commands.calendarDeleteEvent.mockRejectedValue(refusal)
    commands.calendarPromoteExternalEvent.mockRejectedValue(refusal)
    commands.calendarUpdateSourceSelection.mockRejectedValue(refusal)

    await expect(
      calendarService.createEvent({ title: 'Standup', startAt: RANGE.startAt, timezone: 'UTC' })
    ).resolves.toEqual({ success: false, event: null, error: 'disk is full' })
    await expect(calendarService.updateEvent({ id: 'event-1', title: 'x' })).resolves.toEqual({
      success: false,
      event: null,
      error: 'disk is full'
    })
    await expect(calendarService.deleteEvent('event-1')).resolves.toEqual({
      success: false,
      error: 'disk is full'
    })
    await expect(promoteExternalCalendarEvent({ externalEventId: 'ext-1' })).resolves.toEqual({
      success: false,
      eventId: null,
      error: 'disk is full'
    })
    await expect(
      updateGoogleCalendarSourceSelection({ id: 'source-1', isSelected: true })
    ).resolves.toEqual({ success: false, source: null, error: 'disk is full' })
  })

  it('passes a mutation answer through as the command sent it', async () => {
    const event = { id: 'event-1', title: 'Standup' }
    commands.calendarCreateEvent.mockResolvedValue({ success: true, event })
    commands.calendarDeleteEvent.mockResolvedValue({ success: false, error: 'Event not found' })

    await expect(
      calendarService.createEvent({ title: 'Standup', startAt: RANGE.startAt, timezone: 'UTC' })
    ).resolves.toEqual({ success: true, event })
    await expect(calendarService.deleteEvent('event-1')).resolves.toEqual({
      success: false,
      error: 'Event not found'
    })
  })

  it('keeps the provider methods on the window bridge until they are ported', async () => {
    await expect(getGoogleCalendarStatus()).resolves.toEqual({ connected: true })
    await expect(connectGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(disconnectGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(refreshGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(listGoogleCalendars()).resolves.toEqual({ calendars: [] })
    await expect(setDefaultGoogleCalendar({ calendarId: 'primary' })).resolves.toEqual({
      success: true
    })
    await expect(retryGoogleCalendarSourceSync({ sourceId: 'source-1' })).resolves.toEqual({
      success: true
    })

    expect(api.calendar.getProviderStatus).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.connectProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.disconnectProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.refreshProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.listGoogleCalendars).toHaveBeenCalledWith({})
    expect(api.calendar.setDefaultGoogleCalendar).toHaveBeenCalledWith({ calendarId: 'primary' })
    expect(api.calendar.retryGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceId: 'source-1'
    })
  })

  it('delivers each calendar change until unsubscribed', async () => {
    const callback = vi.fn()
    const unsubscribe = onCalendarChanged(callback)
    await vi.waitFor(() => expect(listeners.size).toBe(1))

    for (const listener of listeners)
      listener({ payload: { entityType: 'calendar_event', id: 'event-1' } })
    expect(callback).toHaveBeenCalledWith({ entityType: 'calendar_event', id: 'event-1' })

    unsubscribe()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
  })
})
