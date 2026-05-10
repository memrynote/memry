import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAllTags } from './use-all-tags'

const mocks = vi.hoisted(() => ({
  notesGetTags: vi.fn(),
  inboxGetTags: vi.fn(),
  tagListeners: [] as Array<() => void>
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getTags: mocks.notesGetTags
  },
  onTagsChanged: (callback: () => void) => {
    mocks.tagListeners.push(callback)
    return vi.fn()
  }
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    getTags: mocks.inboxGetTags
  }
}))

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0
      }
    }
  })

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useAllTags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tagListeners = []
    mocks.notesGetTags.mockResolvedValue([
      { tag: 'Work', count: 4, color: '#111111' },
      { tag: 'work/design', count: 2, color: '#222222' },
      { tag: 'personal', count: 1, color: '#333333' }
    ])
    mocks.inboxGetTags.mockResolvedValue([
      { tag: 'work', count: 3 },
      { tag: 'inbox', count: 6 },
      { tag: 'work/dev', count: 5 }
    ])
  })

  it('combines note and inbox tags, preserving source and search ordering', async () => {
    const { result } = renderHook(() => useAllTags(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.tags).toEqual([
      { name: 'work', count: 7, color: '#111111', source: 'both' },
      { name: 'inbox', count: 6, source: 'inbox' },
      { name: 'work/dev', count: 5, source: 'inbox' },
      { name: 'work/design', count: 2, color: '#222222', source: 'notes' },
      { name: 'personal', count: 1, color: '#333333', source: 'notes' }
    ])
    expect(result.current.searchTags('work').map((tag) => tag.name)).toEqual([
      'work',
      'work/dev',
      'work/design'
    ])
    expect(result.current.getPopularTags(2).map((tag) => tag.name)).toEqual(['work', 'inbox'])
    expect(result.current.getRecentTags(3).map((tag) => tag.name)).toEqual([
      'work',
      'inbox',
      'work/dev'
    ])
    expect(result.current.getChildTags('work').map((tag) => tag.name)).toEqual([
      'work/dev',
      'work/design'
    ])
    expect(result.current.getChildTags('work', 'de').map((tag) => tag.name)).toEqual([
      'work/dev',
      'work/design'
    ])
  })

  it('refetches notes on tag events and both sources through refetch', async () => {
    const { result } = renderHook(() => useAllTags(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    mocks.notesGetTags.mockResolvedValueOnce([{ tag: 'updated', count: 9 }])
    await act(async () => {
      mocks.tagListeners[0]()
    })
    await waitFor(() => expect(result.current.tags[0].name).toBe('updated'))

    await act(async () => {
      result.current.refetch()
    })
    expect(mocks.notesGetTags).toHaveBeenCalledTimes(3)
    expect(mocks.inboxGetTags).toHaveBeenCalledTimes(2)
  })

  it('surfaces query errors while still exposing empty helper results', async () => {
    mocks.notesGetTags.mockRejectedValueOnce(new Error('notes failed'))
    mocks.inboxGetTags.mockResolvedValueOnce([])

    const { result } = renderHook(() => useAllTags(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toEqual(new Error('notes failed'))
    expect(result.current.searchTags('x')).toEqual([])
    expect(result.current.getPopularTags()).toEqual([])
    expect(result.current.getRecentTags()).toEqual([])
  })
})
