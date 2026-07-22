import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quick: vi.fn(),
  searchEvents: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  searchService: { quick: (text: string) => mocks.quick(text) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { searchEvents: (input: unknown) => mocks.searchEvents(input) }
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { useCanvasAddSearch } from './use-canvas-add-search'

describe('useCanvasAddSearch', () => {
  beforeEach(() => {
    mocks.quick.mockReset().mockResolvedValue({ results: [{ id: 'n1' }], queryTimeMs: 1 })
    mocks.searchEvents.mockReset().mockResolvedValue({ events: [{ id: 'e1' }] })
  })

  it('does not query anything while closed', async () => {
    // #given / #when — a closed dialog with a query
    renderHook(() => useCanvasAddSearch(false, 'abc'))

    // #then — neither source is hit
    await waitFor(() => expect(mocks.searchEvents).not.toHaveBeenCalled())
    expect(mocks.quick).not.toHaveBeenCalled()
  })

  it('queries neither source for a blank query, keeping the create row highlighted', async () => {
    // #given / #when — an open dialog with a whitespace-only query
    const { result } = renderHook(() => useCanvasAddSearch(true, '   '))

    // #then — no calls, both lists empty
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mocks.quick).not.toHaveBeenCalled()
    expect(mocks.searchEvents).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
    expect(result.current.events).toEqual([])
  })

  it('queries both sources for the same query (#869)', async () => {
    // #given / #when — a real query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — search and event search both run, both results land
    await waitFor(() => expect(result.current.results).toEqual([{ id: 'n1' }]))
    expect(result.current.events).toEqual([{ id: 'e1' }])
    expect(mocks.quick).toHaveBeenCalledWith('alpha')
    expect(mocks.searchEvents).toHaveBeenCalledWith({ query: 'alpha' })
    expect(result.current.loading).toBe(false)
  })

  it('re-queries events per keystroke, unlike the old once-per-open range fetch', async () => {
    // #given — an open dialog
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: 'alpha' }
    })
    await waitFor(() => expect(mocks.searchEvents).toHaveBeenCalledTimes(1))

    // #when — the query changes and settles
    rerender({ q: 'alphabet' })

    // #then — events are fetched again for the new query
    await waitFor(() => expect(mocks.searchEvents).toHaveBeenCalledTimes(2))
    expect(mocks.searchEvents).toHaveBeenLastCalledWith({ query: 'alphabet' })
  })

  it('debounces rapid typing into a single pair of calls for the final query', async () => {
    // #given — an open dialog
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: 'a' }
    })

    // #when — three keystrokes inside the debounce window
    rerender({ q: 'al' })
    rerender({ q: 'alp' })

    // #then — one call each, for the last query only
    await waitFor(() => expect(mocks.quick).toHaveBeenCalledTimes(1))
    expect(mocks.quick).toHaveBeenCalledWith('alp')
    expect(mocks.searchEvents).toHaveBeenCalledTimes(1)
    expect(mocks.searchEvents).toHaveBeenCalledWith({ query: 'alp' })
  })

  it('keeps events when search rejects', async () => {
    // #given — a failing search but a healthy event query
    mocks.quick.mockRejectedValue(new Error('boom'))

    // #when — we query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — one source failing does not blank the other
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
    expect(result.current.events).toEqual([{ id: 'e1' }])
  })

  it('keeps search results when the event query rejects', async () => {
    // #given — a failing event query but a healthy search
    mocks.searchEvents.mockRejectedValue(new Error('boom'))

    // #when — we query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — the reverse direction holds too
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.events).toEqual([])
    expect(result.current.results).toEqual([{ id: 'n1' }])
  })
})
