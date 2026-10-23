import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarProjectionItem, GetCalendarRangeInput } from '@/services/calendar-service'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { CalendarWidget } from './widgets/calendar-widget'
import { HomeHeader } from './home-header'

/**
 * The Home board's header count and its calendar widget must be looking at the same day (#1920).
 * They used to build "today" separately: the widget pinned local date components to
 * `T00:00:00.000Z`, the header used a local `setHours(0, 0, 0, 0)`. Every non-zero UTC offset put
 * a band of hours in one window and not the other, so the header advertised events the widget had
 * no row for.
 */

const { mockGetRange, requestedRanges, server } = vi.hoisted(() => ({
  mockGetRange: vi.fn(),
  requestedRanges: [] as GetCalendarRangeInput[],
  server: { items: [] as CalendarProjectionItem[] }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { getRange: mockGetRange },
  onCalendarChanged: () => () => {}
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({ tasks: [], projects: [] })
}))

/** An instant at a local wall-clock time on today's local date. */
function todayLocalAt(hour: number, minute = 0): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).toISOString()
}

function event(id: string, title: string, startAt: string): CalendarProjectionItem {
  return {
    projectionId: id,
    sourceType: 'calendar_event',
    sourceId: id,
    title,
    descriptionPreview: null,
    startAt,
    endAt: new Date(Date.parse(startAt) + 30 * 60_000).toISOString(),
    isAllDay: false,
    timezone: 'UTC',
    visualType: 'event',
    editability: 'full',
    source: { provider: null },
    binding: null,
    snoozeOffsetMinutes: null
  } as unknown as CalendarProjectionItem
}

function Header(): React.JSX.Element {
  return (
    <HomeHeader
      boards={[{ id: 'b1', name: 'Home', position: 0, widgets: [] }]}
      activeBoardId="b1"
      onSelectBoard={() => {}}
      onCreateBoard={() => {}}
      onDeleteBoard={() => {}}
      onManageBoards={() => {}}
      showAddWidget={false}
      galleryOpen={false}
      onGalleryOpenChange={() => {}}
      onAddWidget={() => {}}
    />
  )
}

function renderWith(node: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function renderBoard(): void {
  renderWith(
    <>
      <Header />
      <CalendarWidget config={{}} size="M" />
    </>
  )
}

beforeEach(() => {
  requestedRanges.length = 0
  server.items = []
  // Stands in for the main process, which selects on the instants it is handed.
  mockGetRange.mockImplementation(async (input: GetCalendarRangeInput) => {
    requestedRanges.push(input)
    return {
      items: server.items.filter((i) => i.startAt >= input.startAt && i.startAt < input.endAt)
    }
  })
})

describe('the Home board asks for one day', () => {
  // Each side gets its own QueryClient, or the shared key would dedupe the second fetch away and
  // leave nothing to compare. On a UTC runner this is the only case here that fails without the
  // fix: the two old windows agreed on the start and differed only at the end.
  it('the header and the widget request the same window', async () => {
    renderWith(<Header />)
    await waitFor(() => expect(requestedRanges).toHaveLength(1))
    cleanup()

    renderWith(<CalendarWidget config={{}} size="M" />)
    await waitFor(() => expect(requestedRanges).toHaveLength(2))

    const [header, widget] = requestedRanges
    expect(widget).toEqual(header)
  })

  it('shares one query key, so the board fetches the day once', async () => {
    renderBoard()

    await waitFor(() => expect(screen.queryByLabelText(/loading/i)).not.toBeInTheDocument())
    expect(mockGetRange).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a local-evening event', 22, 0],
    ['a local just-past-midnight event', 0, 30]
  ])('%s the header counts is one the widget shows', async (_label, hour, minute) => {
    server.items = [event('e1', 'Investor sync', todayLocalAt(hour, minute))]
    renderBoard()

    expect(await screen.findByText('Investor sync')).toBeInTheDocument()
    expect(screen.getByText('1 event')).toBeInTheDocument()
  })
})
