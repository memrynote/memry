import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quick: vi.fn(),
  getRange: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  searchService: {
    quick: (text: string, noteFileTypes?: string[]) => mocks.quick(text, noteFileTypes)
  }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { getRange: (input: unknown) => mocks.getRange(input) }
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { useCanvasAddSearch } from './use-canvas-add-search'

describe('useCanvasAddSearch', () => {
  beforeEach(() => {
    mocks.quick.mockReset().mockResolvedValue({ results: [{ id: 'n1' }], queryTimeMs: 1 })
    mocks.getRange.mockReset().mockResolvedValue({ items: [{ sourceId: 'e1' }] })
  })

  it('loads events once when the dialog opens, not per keystroke', async () => {
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: '' }
    })
    await waitFor(() => expect(mocks.getRange).toHaveBeenCalledTimes(1))
    rerender({ q: 'abc' })
    rerender({ q: 'abcd' })
    expect(mocks.getRange).toHaveBeenCalledTimes(1)
  })

  it('does not query anything while closed', async () => {
    renderHook(() => useCanvasAddSearch(false, 'abc'))
    await waitFor(() => expect(mocks.getRange).not.toHaveBeenCalled())
    expect(mocks.quick).not.toHaveBeenCalled()
  })

  it('skips search for an empty query but still returns events', async () => {
    const { result } = renderHook(() => useCanvasAddSearch(true, '   '))
    await waitFor(() => expect(result.current.projections).toHaveLength(1))
    expect(mocks.quick).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
  })

  it('returns search results once the query resolves', async () => {
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))
    await waitFor(() => expect(result.current.results).toEqual([{ id: 'n1' }]))
    expect(mocks.quick).toHaveBeenCalledWith('alpha', ['markdown'])
    expect(result.current.loading).toBe(false)
  })

  it('debounces rapid typing into a single search for the final query', async () => {
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: 'a' }
    })
    rerender({ q: 'al' })
    rerender({ q: 'alp' })
    await waitFor(() => expect(mocks.quick).toHaveBeenCalledTimes(1))
    expect(mocks.quick).toHaveBeenCalledWith('alp', ['markdown'])
  })

  it('falls back to empty results when search rejects', async () => {
    mocks.quick.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
  })

  it('falls back to empty events when the range query rejects', async () => {
    mocks.getRange.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCanvasAddSearch(true, ''))
    await waitFor(() => expect(mocks.getRange).toHaveBeenCalled())
    expect(result.current.projections).toEqual([])
  })
})
