import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalChangeEvents } from '@/hooks/use-journal-change-events'
import { APP_QUERY_DEFAULT_OPTIONS } from '@/lib/query-client-options'
import { JournalWidget } from './journal-widget'

type JournalListener = (event: { date: string; entry?: unknown }) => void

const { mockGetHeatmap, mockGetEntry, listeners, server } = vi.hoisted(() => ({
  mockGetHeatmap: vi.fn(),
  mockGetEntry: vi.fn(),
  listeners: {
    created: new Set<JournalListener>(),
    updated: new Set<JournalListener>(),
    deleted: new Set<JournalListener>(),
    external: new Set<JournalListener>()
  },
  server: { entries: new Map<string, string>() }
}))

function subscription(set: Set<JournalListener>) {
  return (callback: JournalListener) => {
    set.add(callback)
    return () => set.delete(callback)
  }
}

vi.mock('@/services/journal-service', () => ({
  journalService: { getHeatmap: mockGetHeatmap, getEntry: mockGetEntry },
  onJournalEntryCreated: subscription(listeners.created),
  onJournalEntryUpdated: subscription(listeners.updated),
  onJournalEntryDeleted: subscription(listeners.deleted),
  onJournalExternalChange: subscription(listeners.external)
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

/**
 * Pin only the time of day, on today's real local date: the widget derives its own
 * "today" from the wall clock, and a clock faked onto another date would move the week
 * strip and the heatmap year out from under the fixtures.
 */
const NOW = new Date()
NOW.setHours(9, 30, 0, 0)

function isoDaysAgo(days: number): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

const TODAY = isoDaysAgo(0)
const YESTERDAY = isoDaysAgo(1)

function write(date: string, content: string): void {
  server.entries.set(date, content)
}

function emit(set: Set<JournalListener>, date: string): void {
  act(() => {
    for (const listener of [...set]) listener({ date })
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/**
 * Mirrors the app: the journal invalidation listener sits at App level and outlives every
 * tab switch, while only the active tab's page is mounted below it.
 */
function Harness({ boardVisible }: { boardVisible: boolean }): React.JSX.Element {
  useJournalChangeEvents()
  return boardVisible ? <JournalWidget config={{}} size="M" /> : <div data-testid="other-tab" />
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

function showsText(text: string): boolean {
  return screen.queryAllByText((_, node) => node?.textContent === text).length > 0
}

function dayMarkedAsHavingAnEntry(iso: string): boolean {
  const button = screen.queryByLabelText(iso)
  if (!button) return false
  // A date with no entry draws a dashed outline; today and entry days draw a filled circle.
  return !button.innerHTML.includes('border-dashed')
}

describe('home journal widget stays current', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    for (const set of Object.values(listeners)) set.clear()
    server.entries = new Map([[YESTERDAY, 'Yesterday note']])

    mockGetHeatmap.mockReset()
    mockGetHeatmap.mockImplementation(async (year: number) =>
      [...server.entries.entries()]
        .filter(([date]) => Number(date.slice(0, 4)) === year)
        .map(([date, content]) => ({ date, characterCount: content.length, level: 1 }))
    )

    mockGetEntry.mockReset()
    mockGetEntry.mockImplementation(async (date: string) => {
      const content = server.entries.get(date)
      return content
        ? { id: `j${date}`, date, content, tags: [], createdAt: NOW.toISOString() }
        : null
    })
  })

  it('shows an entry created elsewhere while the board is open', async () => {
    renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))
    const heatmapCallsAfterMount = mockGetHeatmap.mock.calls.length

    write(TODAY, 'Written on the journal tab')
    emit(listeners.created, TODAY)
    await settle()

    expect(showsText('Written on the journal tab')).toBe(true)
    expect(dayMarkedAsHavingAnEntry(TODAY)).toBe(true)
    // Pins the invalidation, not just the render: the heatmap actually refetched.
    expect(mockGetHeatmap.mock.calls.length).toBeGreaterThan(heatmapCallsAfterMount)
  })

  it('shows edited text for an entry it is already previewing', async () => {
    renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))
    const entryCallsAfterMount = mockGetEntry.mock.calls.length

    write(YESTERDAY, 'Yesterday note, with more added')
    emit(listeners.updated, YESTERDAY)
    await settle()

    expect(showsText('Yesterday note, with more added')).toBe(true)
    expect(mockGetEntry.mock.calls.length).toBeGreaterThan(entryCallsAfterMount)
  })

  it('shows an entry created while the board tab was unmounted', async () => {
    const { showBoard } = renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))

    showBoard(false)
    await settle()

    write(TODAY, 'Written while Home was in the background')
    emit(listeners.created, TODAY)
    await settle()

    showBoard(true)
    await waitFor(() => expect(showsText('Written while Home was in the background')).toBe(true))
    expect(dayMarkedAsHavingAnEntry(TODAY)).toBe(true)
  })

  it('shows an edit that arrived from sync while the board tab was unmounted', async () => {
    const { showBoard } = renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))

    showBoard(false)
    await settle()

    write(YESTERDAY, 'Yesterday note, edited on another device')
    emit(listeners.updated, YESTERDAY)
    await settle()

    showBoard(true)
    await waitFor(() => expect(showsText('Yesterday note, edited on another device')).toBe(true))
  })

  it('drops an entry deleted while the board tab was unmounted', async () => {
    const { showBoard } = renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))

    showBoard(false)
    await settle()

    server.entries.delete(YESTERDAY)
    emit(listeners.deleted, YESTERDAY)
    await settle()

    showBoard(true)
    await waitFor(() => expect(dayMarkedAsHavingAnEntry(YESTERDAY)).toBe(false))
    expect(showsText('Yesterday note')).toBe(false)
  })

  it('ignores a broadcast without a usable local date', async () => {
    renderApp()
    await waitFor(() => expect(showsText('Yesterday note')).toBe(true))
    const heatmapCallsAfterMount = mockGetHeatmap.mock.calls.length

    act(() => {
      for (const listener of [...listeners.updated])
        listener({ date: undefined as unknown as string })
    })
    await settle()

    expect(mockGetHeatmap.mock.calls.length).toBe(heatmapCallsAfterMount)
  })
})
