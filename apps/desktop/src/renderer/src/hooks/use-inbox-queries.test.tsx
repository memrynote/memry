import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type QueryConfig = {
  queryKey: readonly unknown[]
  queryFn: (input?: { pageParam?: number }) => unknown
  enabled?: boolean
  getNextPageParam?: (
    lastPage: { hasMore: boolean },
    allPages: Array<{ items: unknown[] }>
  ) => unknown
}

const reactQuery = vi.hoisted(() => ({
  queryClient: {
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn()
  },
  queryConfigs: [] as QueryConfig[],
  infiniteConfigs: [] as QueryConfig[],
  mutationConfigs: [] as Array<{
    mutationFn: (input: never) => unknown
    onSuccess?: () => void
  }>,
  refetch: vi.fn(),
  fetchNextPage: vi.fn()
}))

const inboxService = vi.hoisted(() => ({
  list: vi.fn(async () => ({ items: [{ id: 'remote-item' }], total: 1, hasMore: false })),
  get: vi.fn(async () => ({ id: 'item-1', title: 'Inbox item' })),
  getStats: vi.fn(async () => ({ total: 3 })),
  getTags: vi.fn(async () => [{ tag: 'later', count: 1 }]),
  getSuggestions: vi.fn(async () => ({ suggestions: [] })),
  getSnoozed: vi.fn(async () => ({ items: [] })),
  getPatterns: vi.fn(async () => ({ patterns: [] })),
  getStaleThreshold: vi.fn(async () => 7),
  setStaleThreshold: vi.fn(async () => ({ success: true })),
  listArchived: vi.fn(async () => ({ items: [{ id: 'archived' }], total: 1, hasMore: false })),
  getFilingHistory: vi.fn(async () => ({ items: [] }))
}))

const eventState = vi.hoisted(() => ({
  callbacks: {} as Record<string, Array<(event?: { id?: string }) => void>>,
  unsubs: [] as ReturnType<typeof vi.fn>[]
}))

function subscribe(name: string, cb: (event?: { id?: string }) => void): () => void {
  eventState.callbacks[name] ??= []
  eventState.callbacks[name].push(cb)
  const unsubscribe = vi.fn()
  eventState.unsubs.push(unsubscribe)
  return unsubscribe
}

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => reactQuery.queryClient,
  useQuery: (config: QueryConfig) => {
    reactQuery.queryConfigs.push(config)
    const key = config.queryKey.join(':')
    const data =
      config.enabled === false
        ? undefined
        : key.includes('stats')
          ? { total: 3 }
          : key.includes('staleThreshold')
            ? 7
            : { id: 'item-1' }
    return {
      data,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: reactQuery.refetch
    }
  },
  useInfiniteQuery: (config: QueryConfig) => {
    reactQuery.infiniteConfigs.push(config)
    return {
      data: {
        pages: [
          {
            items: [{ id: 'local-item' }],
            total: 1,
            hasMore: true
          }
        ]
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: reactQuery.refetch,
      fetchNextPage: reactQuery.fetchNextPage,
      isFetchingNextPage: false
    }
  },
  useMutation: (config: (typeof reactQuery.mutationConfigs)[number]) => {
    reactQuery.mutationConfigs.push(config)
    return {
      mutate: vi.fn((value) => {
        config.mutationFn(value)
        config.onSuccess?.()
      }),
      isPending: false
    }
  }
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService,
  onInboxCaptured: (cb: (event?: { id?: string }) => void) => subscribe('captured', cb),
  onInboxUpdated: (cb: (event?: { id?: string }) => void) => subscribe('updated', cb),
  onInboxArchived: (cb: (event?: { id?: string }) => void) => subscribe('archived', cb),
  onInboxFiled: (cb: (event?: { id?: string }) => void) => subscribe('filed', cb),
  onInboxSnoozeDue: (cb: (event?: { id?: string }) => void) => subscribe('snoozeDue', cb),
  onInboxTranscriptionComplete: (cb: (event?: { id?: string }) => void) =>
    subscribe('transcription', cb),
  onInboxMetadataComplete: (cb: (event?: { id?: string }) => void) => subscribe('metadata', cb),
  onInboxSnoozed: (cb: (event?: { id?: string }) => void) => subscribe('snoozed', cb)
}))

import {
  useInboxArchived,
  useInboxFilingHistory,
  useInboxItem,
  useInboxList,
  useInboxPatterns,
  useInboxSnoozed,
  useInboxStaleThreshold,
  useInboxStats,
  useInboxSuggestions,
  useInboxTags
} from './use-inbox-queries'

describe('use-inbox-queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reactQuery.queryConfigs.length = 0
    reactQuery.infiniteConfigs.length = 0
    reactQuery.mutationConfigs.length = 0
    eventState.callbacks = {}
    eventState.unsubs = []
  })

  function fire(name: string, event?: { id?: string }) {
    for (const cb of eventState.callbacks[name] ?? []) {
      act(() => cb(event))
    }
  }

  it('loads inbox lists, pagination, events, and cleanup', async () => {
    const { result, unmount } = renderHook(() => useInboxList({ search: 'focus', limit: 2 }))

    expect(result.current.items).toEqual([{ id: 'local-item' }])
    expect(result.current.total).toBe(1)
    expect(result.current.hasMore).toBe(true)

    result.current.refetch()
    result.current.loadMore()
    expect(reactQuery.refetch).toHaveBeenCalled()
    expect(reactQuery.fetchNextPage).toHaveBeenCalled()

    await reactQuery.infiniteConfigs[0].queryFn({ pageParam: 4 })
    expect(inboxService.list).toHaveBeenCalledWith({
      search: 'focus',
      offset: 4,
      limit: 2
    })
    expect(
      reactQuery.infiniteConfigs[0].getNextPageParam?.({ hasMore: true }, [
        { items: [{ id: 'a' }] },
        { items: [{ id: 'b' }, { id: 'c' }] }
      ])
    ).toBe(3)
    expect(
      reactQuery.infiniteConfigs[0].getNextPageParam?.({ hasMore: false }, [{ items: [] }])
    ).toBeUndefined()

    fire('captured')
    fire('updated')
    fire('archived')
    fire('filed')
    fire('snoozeDue')
    fire('metadata')
    fire('transcription')

    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'list']
    })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'stats']
    })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'snoozed']
    })

    unmount()
    expect(eventState.unsubs.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true)
  })

  it('loads a single item and only responds to matching item events', async () => {
    const nullItem = renderHook(() => useInboxItem(null))
    expect(nullItem.result.current.item).toBeNull()
    nullItem.unmount()

    const { result } = renderHook(() => useInboxItem('item-1'))
    expect(result.current.item).toEqual({ id: 'item-1' })

    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.get).toHaveBeenCalledWith('item-1')

    fire('updated', { id: 'other' })
    expect(reactQuery.queryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-1']
    })

    fire('updated', { id: 'item-1' })
    fire('transcription', { id: 'item-1' })
    fire('metadata', { id: 'item-1' })
    fire('archived', { id: 'item-1' })

    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'items', 'item-1']
    })
    expect(reactQuery.queryClient.setQueryData).toHaveBeenCalledWith(
      ['inbox', 'items', 'item-1'],
      null
    )
  })

  it('loads stats, snoozed, archived, and helper query hooks', async () => {
    const stats = renderHook(() => useInboxStats())
    expect(stats.result.current.stats).toEqual({ total: 3 })
    fire('captured')
    fire('archived')
    fire('filed')
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'stats']
    })
    stats.unmount()

    renderHook(() => useInboxSnoozed())
    fire('snoozed')
    fire('snoozeDue')
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'snoozed']
    })
    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.getSnoozed).toHaveBeenCalled()

    const archived = renderHook(() => useInboxArchived({ search: 'done' }))
    archived.result.current.loadMore()
    await reactQuery.infiniteConfigs.at(-1)!.queryFn({ pageParam: 5 })
    expect(inboxService.listArchived).toHaveBeenCalledWith({
      search: 'done',
      offset: 5,
      limit: 50
    })
    fire('archived')
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'archived', {}]
    })

    renderHook(() => useInboxTags())
    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.getTags).toHaveBeenCalled()

    renderHook(() => useInboxSuggestions(null))
    expect(reactQuery.queryConfigs.at(-1)!.enabled).toBe(false)
    renderHook(() => useInboxSuggestions('item-1'))
    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.getSuggestions).toHaveBeenCalledWith('item-1')

    renderHook(() => useInboxPatterns())
    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.getPatterns).toHaveBeenCalled()

    renderHook(() => useInboxFilingHistory({ limit: 3 }))
    await reactQuery.queryConfigs.at(-1)!.queryFn()
    expect(inboxService.getFilingHistory).toHaveBeenCalledWith({ limit: 3 })
  })

  it('reads and updates stale threshold settings', () => {
    const { result } = renderHook(() => useInboxStaleThreshold())

    expect(result.current.threshold).toBe(7)
    result.current.setThreshold(14)

    expect(inboxService.setStaleThreshold).toHaveBeenCalledWith(14)
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'staleThreshold']
    })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'stats']
    })
    expect(reactQuery.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'list']
    })
  })
})
