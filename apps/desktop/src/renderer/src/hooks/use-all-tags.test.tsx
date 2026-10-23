import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAllTags } from './use-all-tags'

const mocks = vi.hoisted(() => ({
  notesGetTags: vi.fn(),
  inboxGetTags: vi.fn(),
  tagListeners: [] as Array<() => void>,
  tagUnsubscribes: [] as Array<ReturnType<typeof vi.fn>>
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getTags: mocks.notesGetTags
  },
  onTagsChanged: (callback: () => void) => {
    mocks.tagListeners.push(callback)
    const unsubscribe = vi.fn()
    mocks.tagUnsubscribes.push(unsubscribe)
    return unsubscribe
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
    mocks.tagUnsubscribes = []
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
      { name: 'Work', count: 7, color: '#111111', source: 'both' },
      { name: 'inbox', count: 6, source: 'inbox' },
      { name: 'work/dev', count: 5, source: 'inbox' },
      { name: 'work/design', count: 2, color: '#222222', source: 'notes' },
      { name: 'personal', count: 1, color: '#333333', source: 'notes' }
    ])
    expect(result.current.searchTags('work').map((tag) => tag.name)).toEqual([
      'Work',
      'work/dev',
      'work/design'
    ])
    expect(result.current.getPopularTags(2).map((tag) => tag.name)).toEqual(['Work', 'inbox'])
    expect(result.current.getRecentTags(3).map((tag) => tag.name)).toEqual([
      'Work',
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

  it('subscribes to tag events once across re-renders and unsubscribes on unmount', async () => {
    const { result, rerender, unmount } = renderHook(() => useAllTags(), {
      wrapper: createWrapper()
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // The sole consumer (tag-autocomplete) re-renders on every keystroke.
    for (let i = 0; i < 10; i += 1) {
      rerender()
    }

    expect(mocks.tagListeners).toHaveLength(1)
    expect(mocks.tagUnsubscribes.filter((fn) => fn.mock.calls.length > 0)).toHaveLength(0)

    // A tags-changed event arriving after those re-renders must still reach the
    // consumer (guards against a listener left holding stale render state).
    // mockResolvedValue (not ...Once) so an unconsumed queue entry can never leak
    // into the next test in this file.
    mocks.notesGetTags.mockResolvedValue([{ tag: 'after-rerenders', count: 12 }])
    await act(async () => {
      mocks.tagListeners[mocks.tagListeners.length - 1]()
    })
    await waitFor(() => expect(result.current.tags[0].name).toBe('after-rerenders'))

    unmount()
    expect(mocks.tagUnsubscribes.filter((fn) => fn.mock.calls.length > 0)).toHaveLength(1)
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
