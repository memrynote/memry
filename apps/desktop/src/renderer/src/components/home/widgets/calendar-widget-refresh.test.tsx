import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarChangedEvent, CalendarProjectionItem } from '@/services/calendar-service'
import { useCalendarChangeEvents } from '@/hooks/use-calendar-change-events'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { CalendarWidget } from './calendar-widget'

const { mockGetRange, listeners, server } = vi.hoisted(() => ({
  mockGetRange: vi.fn(),
  listeners: new Set<(event: CalendarChangedEvent) => void>(),
  server: { items: [] as CalendarProjectionItem[] }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getRange: mockGetRange },
  onCalendarChanged: (callback: (event: CalendarChangedEvent) => void) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

const SOURCE_TYPE_BY_VISUAL_TYPE = {
  event: 'calendar_event',
  external_event: 'calendar_external_event',
  note: 'note'
} as const

/**
 * The instant these tests pretend it is, on today's real local date.
 *
 * `use-today` snapshots the local date into module scope at import and re-reads the wall clock
 * for its first subscriber. A clock faked onto any other date therefore arrives as a midnight
 * rollover, which moves `todayCalendarRange`, moves the query key with it, and makes the widget
 * fetch a second day on mount. Only the time of day is pinned, and from local fields rather than
 * a UTC instant, which far enough from UTC would name a different day.
 */
const NOW = new Date()
NOW.setHours(9, 30, 0, 0)

function todayAtHour(hour: number): string {
  const at = new Date(NOW)
  at.setHours(hour, 0, 0, 0)
  return at.toISOString()
}

function projectionItem(
  id: string,
  title: string,
  hour: number,
  visualType: keyof typeof SOURCE_TYPE_BY_VISUAL_TYPE
): CalendarProjectionItem {
  return {
    projectionId: id,
    sourceType: SOURCE_TYPE_BY_VISUAL_TYPE[visualType],
    sourceId: id,
    title,
    descriptionPreview: null,
    startAt: todayAtHour(hour),
    endAt: todayAtHour(hour + 1),
    isAllDay: false,
    timezone: 'UTC',
    visualType,
    editability: 'full',
    source: { provider: visualType === 'external_event' ? 'google' : null },
    binding: null,
    snoozeOffsetMinutes: null
  } as unknown as CalendarProjectionItem
}

function emit(event: CalendarChangedEvent): void {
  for (const listener of [...listeners]) listener(event)
}

let settingsListener: ((event: { key: string; value: unknown }) => void) | undefined

function emitSettings(key: string): void {
  act(() => settingsListener?.({ key, value: {} }))
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

function eventTitles(): string[] {
  return screen.queryAllByTestId('calendar-event').map((row) => row.textContent ?? '')
}

function showsEvent(title: string): boolean {
  return eventTitles().some((text) => text.includes(title))
}

/**
 * Mirrors the app: the calendar invalidation listener sits at App level and outlives
 * every tab switch, while only the active tab's page is mounted below it.
 */
function Harness({ boardVisible }: { boardVisible: boolean }): React.JSX.Element {
  useCalendarChangeEvents()
  return boardVisible ? <CalendarWidget config={{}} size="M" /> : <div data-testid="other-tab" />
}

function renderApp(): { showBoard: (visible: boolean) => void } {
  const client = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
  const tree = (visible: boolean): React.JSX.Element => (
    <QueryClientProvider client={client}>
      <Harness boardVisible={visible} />
    </QueryClientProvider>
  )
  const view = render(tree(true))
  return { showBoard: (visible: boolean) => view.rerender(tree(visible)) }
}

describe('home calendar widget stays current', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    listeners.clear()
    server.items = [projectionItem('e1', 'Standup', 10, 'event')]
    mockGetRange.mockReset()
    mockGetRange.mockImplementation(async () => ({ items: server.items }))
    settingsListener = undefined
    window.api.onSettingsChanged = vi.fn((callback) => {
      settingsListener = callback
      return () => {
        settingsListener = undefined
      }
    })
  })

  it('shows an event created elsewhere while the board is open', async () => {
    renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))
    expect(mockGetRange).toHaveBeenCalledTimes(1)

    server.items = [...server.items, projectionItem('e2', 'Design review', 14, 'event')]
    emit({ entityType: 'calendar_event', id: 'e2' })

    await waitFor(() => expect(mockGetRange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showsEvent('Design review')).toBe(true))
  })

  it('shows a provider event that syncs in while the board is open', async () => {
    renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))

    server.items = [...server.items, projectionItem('g1', 'Sales sync', 15, 'external_event')]
    emit({ entityType: 'calendar_external_event', id: 'g1' })

    await waitFor(() => expect(mockGetRange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showsEvent('Sales sync')).toBe(true))
  })

  // The invalidation is the assertion, not the render: the board's range is still
  // inside its 30s staleTime when the tab comes back, so without an invalidation
  // that outlived the unmount react-query serves the cache and never calls getRange
  // a second time.
  it('shows an event created while the board tab was unmounted', async () => {
    const { showBoard } = renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))
    expect(mockGetRange).toHaveBeenCalledTimes(1)

    showBoard(false)
    expect(screen.getByTestId('other-tab')).toBeTruthy()

    server.items = [...server.items, projectionItem('e2', 'Design review', 14, 'event')]
    emit({ entityType: 'calendar_event', id: 'e2' })

    showBoard(true)
    await waitFor(() => expect(mockGetRange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showsEvent('Design review')).toBe(true))
    expect(showsEvent('Standup')).toBe(true)
  })

  it('shows a note that a calendar settings change brought into the projection', async () => {
    renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))
    expect(mockGetRange).toHaveBeenCalledTimes(1)

    server.items = [...server.items, projectionItem('n1', 'Trip planning', 16, 'note')]
    emitSettings('calendar')

    await waitFor(() => expect(mockGetRange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showsEvent('Trip planning')).toBe(true))
  })

  // The trailing calendar emit is the control: it proves the same settle window is
  // long enough to observe a refetch, so the first assertion is not passing vacuously.
  it('ignores a settings change under another key', async () => {
    renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))
    expect(mockGetRange).toHaveBeenCalledTimes(1)

    server.items = [...server.items, projectionItem('n1', 'Trip planning', 16, 'note')]

    emitSettings('notes')
    await settle()
    expect(mockGetRange).toHaveBeenCalledTimes(1)
    expect(showsEvent('Trip planning')).toBe(false)

    emitSettings('calendar')
    await settle()
    expect(mockGetRange).toHaveBeenCalledTimes(2)
    expect(showsEvent('Trip planning')).toBe(true)
  })

  it('shows a provider event that syncs in while the board tab was unmounted', async () => {
    const { showBoard } = renderApp()
    await waitFor(() => expect(showsEvent('Standup')).toBe(true))

    showBoard(false)

    server.items = [...server.items, projectionItem('g1', 'Sales sync', 15, 'external_event')]
    emit({ entityType: 'calendar_external_event', id: 'g1' })

    showBoard(true)
    await waitFor(() => expect(mockGetRange).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showsEvent('Sales sync')).toBe(true))
  })
})
