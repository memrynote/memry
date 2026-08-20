import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('calendar-service', () => {
  let api: {
    calendar: Record<string, ReturnType<typeof vi.fn>>
    onCalendarChanged: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    api = {
      calendar: {
        getRange: vi.fn().mockResolvedValue({ items: [] }),
        getProviderStatus: vi.fn().mockResolvedValue({ connected: true }),
        connectProvider: vi.fn().mockResolvedValue({ success: true }),
        disconnectProvider: vi.fn().mockResolvedValue({ success: true }),
        refreshProvider: vi.fn().mockResolvedValue({ success: true }),
        updateSourceSelection: vi.fn().mockResolvedValue({ success: true }),
        listProviderCalendars: vi.fn().mockResolvedValue({ calendars: [] }),
        setDefaultGoogleCalendar: vi.fn().mockResolvedValue({ success: true }),
        promoteExternalEvent: vi.fn().mockResolvedValue({ success: true, eventId: 'event-1' }),
        retryCalendarSourceSync: vi.fn().mockResolvedValue({ success: true })
      },
      onCalendarChanged: vi.fn(() => vi.fn())
    }
    ;(window as typeof window & { api: unknown }).api = api
  })

  it('forwards generic calendar API methods through the window bridge', async () => {
    await expect(
      calendarService.getRange({ start: '2026-05-01', end: '2026-05-31' })
    ).resolves.toEqual({ items: [] })

    expect(api.calendar.getRange).toHaveBeenCalledWith({
      start: '2026-05-01',
      end: '2026-05-31'
    })
  })

  it('forwards Google calendar convenience methods', async () => {
    await expect(getGoogleCalendarStatus()).resolves.toEqual({ connected: true })
    await expect(connectGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(disconnectGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(refreshGoogleCalendarProvider()).resolves.toEqual({ success: true })
    await expect(
      updateGoogleCalendarSourceSelection({ sourceId: 'source-1', selected: true })
    ).resolves.toEqual({ success: true })
    await expect(listGoogleCalendars()).resolves.toEqual({ calendars: [] })
    await expect(setDefaultGoogleCalendar({ calendarId: 'primary' })).resolves.toEqual({
      success: true
    })
    await expect(
      promoteExternalCalendarEvent({ externalId: 'external-1', sourceId: 'source-1' })
    ).resolves.toEqual({ success: true, eventId: 'event-1' })
    await expect(retryGoogleCalendarSourceSync({ sourceId: 'source-1' })).resolves.toEqual({
      success: true
    })

    expect(api.calendar.getProviderStatus).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.connectProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.disconnectProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.refreshProvider).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.updateSourceSelection).toHaveBeenCalledWith({
      sourceId: 'source-1',
      selected: true
    })
    expect(api.calendar.listProviderCalendars).toHaveBeenCalledWith({ provider: 'google' })
    expect(api.calendar.setDefaultGoogleCalendar).toHaveBeenCalledWith({ calendarId: 'primary' })
    expect(api.calendar.promoteExternalEvent).toHaveBeenCalledWith({
      externalId: 'external-1',
      sourceId: 'source-1'
    })
    expect(api.calendar.retryCalendarSourceSync).toHaveBeenCalledWith({
      sourceId: 'source-1'
    })
  })

  it('subscribes to calendar change events', () => {
    const callback = vi.fn()
    const unsubscribe = vi.fn()
    api.onCalendarChanged.mockReturnValueOnce(unsubscribe)

    expect(onCalendarChanged(callback)).toBe(unsubscribe)
    expect(api.onCalendarChanged).toHaveBeenCalledWith(callback)
  })
})
