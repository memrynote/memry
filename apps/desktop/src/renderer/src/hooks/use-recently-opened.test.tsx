import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import type { Tab } from '@/contexts/tabs/types'

const activeTab = vi.hoisted(() => ({ current: null as Partial<Tab> | null }))
const logWarn = vi.hoisted(() => vi.fn())

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => activeTab.current
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { useRecordRecentlyOpened } from './use-recently-opened'

const record = vi.fn().mockResolvedValue({ recorded: true })

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Advances the clock and settles the write the dwell started. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useRecordRecentlyOpened', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    record.mockClear()
    logWarn.mockClear()
    activeTab.current = null
    // @ts-expect-error partial window.api for this hook only
    window.api = { recents: { record } }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a note that stays in front past the dwell', async () => {
    activeTab.current = { type: 'note', entityId: 'n1' }
    renderHook(() => useRecordRecentlyOpened(), { wrapper })

    expect(record).not.toHaveBeenCalled()
    await advance(2000)
    expect(record).toHaveBeenCalledWith({ itemId: 'n1', itemType: 'note' })
  })

  // Cmd-tabbing past a note is not reading it — otherwise flipping through
  // tabs would fill the trail with notes you never looked at.
  it('does not record a note you tab straight past', async () => {
    activeTab.current = { type: 'note', entityId: 'n1' }
    const { rerender } = renderHook(() => useRecordRecentlyOpened(), { wrapper })

    await advance(500)
    activeTab.current = { type: 'note', entityId: 'n2' }
    rerender()
    await advance(2000)

    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith({ itemId: 'n2', itemType: 'note' })
  })

  it('throttles repeat visits to the same note', async () => {
    activeTab.current = { type: 'note', entityId: 'n1' }
    const { rerender } = renderHook(() => useRecordRecentlyOpened(), { wrapper })
    await advance(2000)

    activeTab.current = { type: 'note', entityId: 'n2' }
    rerender()
    await advance(2000)

    activeTab.current = { type: 'note', entityId: 'n1' }
    rerender()
    await advance(2000)

    expect(record.mock.calls.map((c) => c[0].itemId)).toEqual(['n1', 'n2'])
  })

  // #4236: a failed write used to start the throttle anyway, so the note stayed out of
  // the trail for the next minute even when the user came back to it.
  it.each([
    {
      failure: 'answers recorded: false',
      failOnce: () => record.mockResolvedValueOnce({ recorded: false })
    },
    { failure: 'rejects', failOnce: () => record.mockRejectedValueOnce(new Error('ipc down')) }
  ])('logs a write that $failure and records the note on the next visit', async ({ failOnce }) => {
    failOnce()
    activeTab.current = { type: 'note', entityId: 'n1' }
    const { rerender } = renderHook(() => useRecordRecentlyOpened(), { wrapper })
    await advance(2000)

    expect(logWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ itemType: 'note', itemId: 'n1' })
    )

    activeTab.current = { type: 'note', entityId: 'n2' }
    rerender()
    await advance(2000)
    activeTab.current = { type: 'note', entityId: 'n1' }
    rerender()
    await advance(2000)

    expect(record.mock.calls.map((c) => c[0].itemId)).toEqual(['n1', 'n2', 'n1'])
  })

  it('records the same note again once the throttle window has passed', async () => {
    activeTab.current = { type: 'note', entityId: 'n1' }
    const { rerender } = renderHook(() => useRecordRecentlyOpened(), { wrapper })
    await advance(2000)

    activeTab.current = null
    rerender()
    await advance(60_000)

    activeTab.current = { type: 'note', entityId: 'n1' }
    rerender()
    await advance(2000)

    expect(record).toHaveBeenCalledTimes(2)
  })

  // Canvases open in the same tab bar as notes and are just as much "something
  // you looked at", so the trail has to carry them too (Aurelie, 22 Aug 2026).
  it('records a canvas that stays in front past the dwell', async () => {
    activeTab.current = { type: 'canvas', entityId: 'c1' }
    renderHook(() => useRecordRecentlyOpened(), { wrapper })

    expect(record).not.toHaveBeenCalled()
    await advance(2000)
    expect(record).toHaveBeenCalledWith({ itemId: 'c1', itemType: 'canvas' })
  })

  // The throttle is keyed per item, so a canvas that happens to share an id
  // with a just-opened note must still be written.
  it('throttles per item type, not per bare id', async () => {
    activeTab.current = { type: 'note', entityId: 'x1' }
    const { rerender } = renderHook(() => useRecordRecentlyOpened(), { wrapper })
    await advance(2000)

    activeTab.current = { type: 'canvas', entityId: 'x1' }
    rerender()
    await advance(2000)

    expect(record.mock.calls.map((c) => c[0])).toEqual([
      { itemId: 'x1', itemType: 'note' },
      { itemId: 'x1', itemType: 'canvas' }
    ])
  })

  it('ignores tabs that carry no recordable entity', async () => {
    activeTab.current = { type: 'home' }
    renderHook(() => useRecordRecentlyOpened(), { wrapper })
    await advance(5000)
    expect(record).not.toHaveBeenCalled()
  })
})
