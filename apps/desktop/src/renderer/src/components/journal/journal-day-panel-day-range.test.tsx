import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { CalendarProjectionItem, GetCalendarRangeInput } from '@/services/calendar-service'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { toLocalDateString } from '@/components/calendar/date-utils'
import { CalendarWidget } from '@/components/home/widgets/calendar-widget'
import { runInTz } from '@/lib/test-support/run-in-tz'
import { JournalDayPanel } from './journal-day-panel'

/**
 * The Journal day panel and the Home board must be looking at the same day (#1954). The panel
 * built its own window by pinning local date components to `T00:00:00.000Z`, which is the defect
 * #1920 removed from the Home board — so once that landed, the two surfaces disagreed with each
 * other by the host's UTC offset. At UTC-7 a 22:00 local event is 05:00Z the next day: inside the
 * panel's window for tomorrow, inside Home's window for today.
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

vi.mock('@/hooks/use-feature-flags', () => ({
  // Only the calendar section is under test; the panel renders nothing at all without it.
  useFeatureFlags: () => ({ isEnabled: (flag: string) => flag === 'calendar' })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: vi.fn(async () => ({ tasks: [] })),
    getStats: vi.fn(async () => ({ overdue: 0 }))
  },
  onTaskCreated: () => () => {},
  onTaskUpdated: () => () => {},
  onTaskDeleted: () => () => {},
  onTaskCompleted: () => () => {}
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({ projects: [] })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({ tasks: [], projects: [] })
}))

let i18nInstance: I18nInstance

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

function renderWith(node: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
  render(
    <I18nextProvider i18n={i18nInstance}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nextProvider>
  )
}

beforeAll(async () => {
  i18nInstance = await createRendererI18n({ locale: 'en' })
})

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

describe('the Journal day panel and the Home board ask for one day', () => {
  // Each side gets its own QueryClient, or the shared key would dedupe the second fetch away and
  // leave nothing to compare.
  it('requests the same window as the Home calendar widget', async () => {
    renderWith(<JournalDayPanel date={toLocalDateString(new Date())} />)
    await waitFor(() => expect(requestedRanges).toHaveLength(1))
    cleanup()

    renderWith(<CalendarWidget config={{}} size="M" />)
    await waitFor(() => expect(requestedRanges).toHaveLength(2))

    const [panel, widget] = requestedRanges
    expect(panel).toEqual(widget)
  })

  it.each([
    ['a local-evening event', 22, 0],
    ['a local just-past-midnight event', 0, 30]
  ])('shows %s that belongs to the day it is displaying', async (_label, hour, minute) => {
    server.items = [event('e1', 'Investor sync', todayLocalAt(hour, minute))]
    renderWith(<JournalDayPanel date={toLocalDateString(new Date())} />)

    expect(await screen.findByText('Investor sync')).toBeInTheDocument()
  })

  it('leaves out an event that belongs to the next local day', async () => {
    server.items = [event('e1', 'Tomorrow standup', todayLocalAt(24, 30))]
    renderWith(<JournalDayPanel date={toLocalDateString(new Date())} />)

    await waitFor(() => expect(requestedRanges).toHaveLength(1))
    expect(screen.queryByText('Tomorrow standup')).not.toBeInTheDocument()
  })
})

/**
 * The cases above only separate the two windows on a machine that is not at UTC, and the renderer
 * project runs on vitest's `threads` pool where assigning `process.env.TZ` never reaches the C++
 * `tzset`. So the one case that has to hold on a UTC CI runner runs in a child `node` with a real
 * `TZ`, via `runInTz` (the mechanism `local-day-range.test.ts` uses). The zone matrix itself
 * lives there; this pins the single instant #1954 reported.
 */
const HELPER_URL = pathToFileURL(
  resolve(dirname(expect.getState().testPath!), '../../lib/local-day-range.ts')
).href

function windowsIn(tz: string, date: string): { local: string[]; retired: string[] } {
  const source = `
    const { localDayRange } = await import(${JSON.stringify(HELPER_URL)})
    const date = ${JSON.stringify(date)}
    const local = localDayRange(date)
    // The window the panel used to build, kept here only to prove it differs.
    const start = new Date(date + 'T00:00:00.000Z')
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 1)
    process.stdout.write(
      JSON.stringify({
        local: [local.startAt, local.endAt],
        retired: [start.toISOString(), end.toISOString()]
      })
    )
  `
  return runInTz(tz, source)
}

describe('the window the panel retired', () => {
  it('put a 22:00 local event at UTC-7 into tomorrow, where Home never looked', () => {
    const { local, retired } = windowsIn('America/Los_Angeles', '2026-06-24')
    // 22:00 local on the 24th, the instant the issue reported.
    const at = '2026-06-25T05:00:00.000Z'

    expect(at >= local[0] && at < local[1]).toBe(true)
    expect(at >= retired[0] && at < retired[1]).toBe(false)
  })
})
