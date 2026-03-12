import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHookWithProviders, act, wait } from '@tests/utils/hook-test-wrapper'
import { useSearch } from './use-search'
import type { SearchReason } from '@memry/contracts/search-api'
import type { Mock } from 'vitest'

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

const mockSearchConfig = {
  search: {
    getReasons: vi.fn().mockResolvedValue(mockReasons),
    addReason: vi.fn().mockResolvedValue({ success: true }),
    clearReasons: vi.fn().mockResolvedValue({ cleared: true })
  }
}

function getSearchMock(mockAPI: Record<string, unknown>) {
  return mockAPI.search as { getReasons: Mock; addReason: Mock; clearReasons: Mock }
}

describe('useSearch: reasons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchConfig.search.getReasons.mockResolvedValue(mockReasons)
    mockSearchConfig.search.clearReasons.mockResolvedValue({ cleared: true })
    mockSearchConfig.search.addReason.mockResolvedValue({ success: true })
  })

  it('initializes with empty reasons array', () => {
    // #when
    const { result } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })

    // #then
    expect(result.current.reasons).toEqual([])
  })

  it('loads reasons via loadReasons', async () => {
    // #given
    const { result, mockAPI } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })

    // #when
    await act(async () => {
      result.current.loadReasons()
      await wait(0)
    })

    // #then
    expect(result.current.reasons).toEqual(mockReasons)
    expect(getSearchMock(mockAPI).getReasons).toHaveBeenCalledOnce()
  })

  it('clears reasons via clearReasons', async () => {
    // #given — load reasons first
    const { result, mockAPI } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })

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
    expect(getSearchMock(mockAPI).clearReasons).toHaveBeenCalledOnce()
  })

  it('does not auto-save query strings as reasons', async () => {
    // #given
    const { result, mockAPI } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })

    // #when — type a query
    await act(async () => {
      result.current.setQuery('turkey visit')
    })

    // #then — addReason should NOT be called (reasons are saved on item click only)
    expect(getSearchMock(mockAPI).addReason).not.toHaveBeenCalled()
  })

  it('clamps query length to 500 chars', () => {
    // #given
    const { result } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })
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
    const { result } = renderHookWithProviders(() => useSearch(), {
      mockAPI: mockSearchConfig
    })
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
