import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHookWithProviders, act, wait } from '@tests/utils/hook-test-wrapper'
import type { SearchReason } from '@memry/contracts/search-api'

const searchService = vi.hoisted(() => ({
  query: vi.fn(),
  getReasons: vi.fn(),
  addReason: vi.fn(),
  clearReasons: vi.fn()
}))

vi.mock('@/services/search-service', () => ({ searchService }))

import { useSearch } from './use-search'

const mockReasons: SearchReason[] = [
  {
    id: 'r1',
    itemId: 'note-1',
    itemType: 'note',
    itemTitle: 'Turkey Trip',
    itemIcon: '✈️',
    searchQuery: 'turkey',
    visitedAt: '2026-03-12T10:00:00.000Z'
  },
  {
    id: 'r2',
    itemId: 'task-1',
    itemType: 'task',
    itemTitle: 'Buy Groceries',
    itemIcon: null,
    searchQuery: 'groceries',
    visitedAt: '2026-03-12T09:00:00.000Z'
  }
]

describe('useSearch: reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchService.getReasons.mockResolvedValue(mockReasons)
    searchService.clearReasons.mockResolvedValue({ cleared: true })
  })

  it('initializes with empty reasons array', () => {
    // #when
    const { result } = renderHookWithProviders(() => useSearch())

    // #then
    expect(result.current.reasons).toEqual([])
  })

  it('loads reasons via loadReasons', async () => {
    // #given
    const { result } = renderHookWithProviders(() => useSearch())

    // #when
    await act(async () => {
      result.current.loadReasons()
      await wait(0)
    })

    // #then
    expect(result.current.reasons).toEqual(mockReasons)
    expect(searchService.getReasons).toHaveBeenCalledOnce()
  })

  it('clears reasons via clearReasons', async () => {
    // #given — load reasons first
    const { result } = renderHookWithProviders(() => useSearch())

    await act(async () => {
      result.current.loadReasons()
      await wait(0)
    })
    expect(result.current.reasons).toHaveLength(2)

    // #when
    await act(async () => {
      result.current.clearReasons()
      await wait(0)
    })

    // #then
    expect(result.current.reasons).toEqual([])
    expect(searchService.clearReasons).toHaveBeenCalledOnce()
  })

  it('does not auto-save query strings as reasons', async () => {
    // #given
    const { result } = renderHookWithProviders(() => useSearch())

    // #when — type a query
    await act(async () => {
      result.current.setQuery('turkey visit')
    })

    // #then — addReason should NOT be called (reasons are saved on item click only)
    expect(searchService.addReason).not.toHaveBeenCalled()
  })

  it('clamps query length to 500 chars', () => {
    // #given
    const { result } = renderHookWithProviders(() => useSearch())
    const longQuery = 'a'.repeat(600)

    // #when
    act(() => {
      result.current.setQuery(longQuery)
    })

    // #then
    expect(result.current.query).toHaveLength(500)
  })

  it('reset clears query, results, and filters', () => {
    // #given
    const { result } = renderHookWithProviders(() => useSearch())
    act(() => {
      result.current.setQuery('something')
    })

    // #when
    act(() => {
      result.current.reset()
    })

    // #then
    expect(result.current.query).toBe('')
    expect(result.current.results).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })
})
