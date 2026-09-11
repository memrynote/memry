import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeatmapEntry, JournalEntry } from '../../../../../preload/index.d'
import { useJournalChangeEvents } from '@/hooks/use-journal-change-events'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { JournalWidget } from './journal-widget'

const { mockGetEntry, mockGetHeatmap, mockOpenTab, createdListeners } = vi.hoisted(() => ({
  mockGetEntry: vi.fn(),
  mockGetHeatmap: vi.fn(),
  mockOpenTab: vi.fn(),
  createdListeners: new Set<(event: { date: string }) => void>()
}))

vi.mock('@/services/journal-service', () => ({
  journalService: { getEntry: mockGetEntry, getHeatmap: mockGetHeatmap },
  onJournalEntryCreated: (callback: (event: { date: string }) => void) => {
    createdListeners.add(callback)
    return () => createdListeners.delete(callback)
  },
  onJournalEntryUpdated: () => () => {},
  onJournalEntryDeleted: () => () => {},
  onJournalExternalChange: () => () => {}
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: mockOpenTab })
}))

/**
 * Today is pinned to a date that puts the upcoming window across a month *and* a year
 * boundary, which is exactly the case the widget used to have no way to express.
 */
const TODAY = '2026-12-30'
const UPCOMING = ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']

function entry(date: string, content: string): JournalEntry {
  return {
    id: date,
    date,
    content,
    wordCount: content.split(' ').length,
    characterCount: content.length,
    tags: [],
    createdAt: `${date}T09:00:00.000Z`,
    modifiedAt: `${date}T09:00:00.000Z`
  }
}

const server = new Map<string, JournalEntry>()

function heatmapFor(year: number): HeatmapEntry[] {
  return [...server.values()]
    .filter((e) => e.date.startsWith(String(year)))
    .map((e) => ({ date: e.date, characterCount: e.content.length, level: 1 as const }))
}

function Harness(): React.JSX.Element {
  useJournalChangeEvents()
  return <JournalWidget config={{}} size="M" />
}

function renderWidget(): void {
  const client = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
}

function upcomingRows(): HTMLElement[] {
  return screen.queryAllByTestId('journal-upcoming-day')
}

function rowFor(date: string): HTMLElement {
  const row = upcomingRows().find((r) => r.dataset.date === date)
  if (!row) throw new Error(`no upcoming row for ${date}`)
  return row
}

describe('home journal widget upcoming days', () => {
  beforeEach(() => {
    // Local noon, so the widget's local-date snapshot is TODAY in every timezone.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
    createdListeners.clear()
    server.clear()
    mockOpenTab.mockReset()
    mockGetEntry.mockReset()
    mockGetEntry.mockImplementation(async (date: string) => server.get(date) ?? null)
    mockGetHeatmap.mockReset()
    mockGetHeatmap.mockImplementation(async (year: number) => heatmapFor(year))
  })

  it('lists today and the next three local days, across month and year boundaries', async () => {
    renderWidget()
    await waitFor(() => expect(upcomingRows()).toHaveLength(4))
    expect(upcomingRows().map((r) => r.dataset.date)).toEqual(UPCOMING)
  })

  it('previews a future entry and leaves the other days marked empty', async () => {
    server.set('2027-01-01', entry('2027-01-01', 'Fly home, then unpack slowly.'))
    renderWidget()

    await waitFor(() =>
      expect(rowFor('2027-01-01').textContent).toContain('Fly home, then unpack slowly.')
    )
    expect(rowFor('2027-01-02').textContent).toContain('No entry yet')
    expect(rowFor('2026-12-31').textContent).toContain('No entry yet')
  })

  it('opens the journal tab with the clicked future ISO date', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderWidget()
    await waitFor(() => expect(upcomingRows()).toHaveLength(4))

    await user.click(rowFor('2027-01-02'))

    expect(mockOpenTab).toHaveBeenCalledTimes(1)
    expect(mockOpenTab.mock.calls[0][0]).toMatchObject({
      type: 'journal',
      viewState: { date: '2027-01-02' }
    })
  })

  // The widget never refetches on its own, so without the app-level listener the
  // 30s staleTime would keep serving the empty cache long after the entry landed.
  it('picks up an entry written for a future day while the widget is mounted', async () => {
    renderWidget()
    await waitFor(() => expect(rowFor('2026-12-31').textContent).toContain('No entry yet'))

    server.set('2026-12-31', entry('2026-12-31', 'Pack for the flight.'))
    for (const listener of [...createdListeners]) listener({ date: '2026-12-31' })

    await waitFor(() => expect(rowFor('2026-12-31').textContent).toContain('Pack for the flight.'))
  })

  it('reads at most one entry per upcoming day', async () => {
    renderWidget()
    await waitFor(() => expect(upcomingRows()).toHaveLength(4))
    await waitFor(() => expect(mockGetEntry).toHaveBeenCalled())

    const requested = mockGetEntry.mock.calls.map((call) => call[0] as string)
    for (const date of UPCOMING) {
      expect(requested.filter((d) => d === date)).toHaveLength(1)
    }
  })
})
