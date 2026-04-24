import { useEffect } from 'react'
import {
  useQuery,
  useQueryClient,
  useInfiniteQuery,
  useMutation,
  type UseQueryResult
} from '@tanstack/react-query'
import type {
  InboxFilingHistoryResponse,
  InboxItem,
  InboxItemListItem,
  InboxStats,
  InboxSuggestionsResponse
} from '@memry/rpc/inbox'
import {
  inboxService,
  onInboxCaptured,
  onInboxUpdated,
  onInboxArchived,
  onInboxFiled,
  onInboxSnoozeDue,
  onInboxTranscriptionComplete,
  onInboxMetadataComplete,
  onInboxSnoozed,
  type InboxListInput
} from '@/services/inbox-service'
import { inboxKeys, DEFAULT_PAGE_SIZE, ITEM_STALE_TIME, STATS_STALE_TIME } from './inbox-query-keys'

// =============================================================================
// Types
// =============================================================================

export interface UseInboxListOptions extends InboxListInput {
  enabled?: boolean
}

export interface UseInboxListResult {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
  isLoading: boolean
  isFetching: boolean
  error: Error | null
  refetch: () => void
  loadMore: () => void
  isLoadingMore: boolean
}

export interface UseInboxItemResult {
  item: InboxItem | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export interface UseInboxStatsResult {
  stats: InboxStats | null
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export interface ArchivedListOptions {
  search?: string
  limit?: number
  enabled?: boolean
}

// =============================================================================
// useInboxList
// =============================================================================

export function useInboxList(options: UseInboxListOptions = {}): UseInboxListResult {
  const queryClient = useQueryClient()
  const { enabled = true, ...listOptions } = options

  const query = useInfiniteQuery({
    queryKey: inboxKeys.list(listOptions),
    queryFn: async ({ pageParam = 0 }) => {
      const response = await inboxService.list({
        ...listOptions,
        offset: pageParam,
        limit: listOptions.limit ?? DEFAULT_PAGE_SIZE
      })
      return response
    },
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce((acc, page) => acc + page.items.length, 0)
      return lastPage.hasMore ? totalFetched : undefined
    },
    initialPageParam: 0,
    staleTime: ITEM_STALE_TIME,
    enabled
  })

  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const lastPage = query.data?.pages[query.data.pages.length - 1]
  const total = lastPage?.total ?? 0
  const hasMore = lastPage?.hasMore ?? false

  useEffect(() => {
    const unsubCaptured = onInboxCaptured(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    })

    const unsubUpdated = onInboxUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    })

    const unsubArchived = onInboxArchived(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
    })

    const unsubFiled = onInboxFiled(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    })

    const unsubSnoozeDue = onInboxSnoozeDue(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    })

    const unsubMetadata = onInboxMetadataComplete(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    })

    const unsubTranscription = onInboxTranscriptionComplete(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    })

    return () => {
      unsubCaptured()
      unsubUpdated()
      unsubArchived()
      unsubFiled()
      unsubSnoozeDue()
      unsubMetadata()
      unsubTranscription()
    }
  }, [queryClient])

  return {
    items,
    total,
    hasMore,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: (): void => {
      void query.refetch()
    },
    loadMore: (): void => {
      void query.fetchNextPage()
    },
    isLoadingMore: query.isFetchingNextPage
  }
}

// =============================================================================
// useInboxItem
// =============================================================================

export function useInboxItem(id: string | null): UseInboxItemResult {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.item(id ?? ''),
    queryFn: () => inboxService.get(id!),
    enabled: !!id,
    staleTime: ITEM_STALE_TIME
  })

  useEffect(() => {
    if (!id) return

    const unsubUpdated = onInboxUpdated((event) => {
      if (event.id === id) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.item(id) })
      }
    })

    const unsubArchived = onInboxArchived((event) => {
      if (event.id === id) {
        queryClient.setQueryData(inboxKeys.item(id), null)
      }
    })

    const unsubTranscription = onInboxTranscriptionComplete((event) => {
      if (event.id === id) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.item(id) })
      }
    })

    const unsubMetadata = onInboxMetadataComplete((event) => {
      if (event.id === id) {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.item(id) })
      }
    })

    return () => {
      unsubUpdated()
      unsubArchived()
      unsubTranscription()
      unsubMetadata()
    }
  }, [id, queryClient])

  return {
    item: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: (): void => {
      void query.refetch()
    }
  }
}

// =============================================================================
// useInboxStats
// =============================================================================

export function useInboxStats(): UseInboxStatsResult {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.stats(),
    queryFn: () => inboxService.getStats(),
    staleTime: STATS_STALE_TIME
  })

  useEffect(() => {
    const unsubCaptured = onInboxCaptured(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    })

    const unsubArchived = onInboxArchived(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    })

    const unsubFiled = onInboxFiled(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    })

    return () => {
      unsubCaptured()
      unsubArchived()
      unsubFiled()
    }
  }, [queryClient])

  return {
    stats: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: (): void => {
      void query.refetch()
    }
  }
}

// =============================================================================
// Simple query hooks
// =============================================================================

export function useInboxTags(): UseQueryResult<Array<{ tag: string; count: number }>> {
  return useQuery({
    queryKey: inboxKeys.tags(),
    queryFn: () => inboxService.getTags(),
    staleTime: STATS_STALE_TIME
  })
}

export function useInboxSuggestions(
  itemId: string | null
): UseQueryResult<InboxSuggestionsResponse> {
  return useQuery({
    queryKey: inboxKeys.suggestions(itemId ?? ''),
    queryFn: () => inboxService.getSuggestions(itemId!),
    enabled: !!itemId,
    staleTime: STATS_STALE_TIME
  })
}

export function useInboxSnoozed() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.snoozed(),
    queryFn: () => inboxService.getSnoozed(),
    staleTime: ITEM_STALE_TIME
  })

  useEffect(() => {
    const unsubSnoozed = onInboxSnoozed(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    })

    const unsubSnoozeDue = onInboxSnoozeDue(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    })

    return () => {
      unsubSnoozed()
      unsubSnoozeDue()
    }
  }, [queryClient])

  return query
}

export function useInboxPatterns() {
  return useQuery({
    queryKey: inboxKeys.patterns(),
    queryFn: () => inboxService.getPatterns(),
    staleTime: STATS_STALE_TIME * 5
  })
}

export function useInboxStaleThreshold(): {
  threshold: number
  isLoading: boolean
  setThreshold: (days: number) => void
  isUpdating: boolean
} {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.staleThreshold(),
    queryFn: () => inboxService.getStaleThreshold()
  })

  const mutation = useMutation({
    mutationFn: (days: number) => inboxService.setStaleThreshold(days),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.staleThreshold() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    }
  })

  return {
    threshold: query.data ?? 7,
    isLoading: query.isLoading,
    setThreshold: mutation.mutate,
    isUpdating: mutation.isPending
  }
}

export function useInboxArchived(options: ArchivedListOptions = {}): UseInboxListResult {
  const queryClient = useQueryClient()
  const { enabled = true, ...listOptions } = options

  const query = useInfiniteQuery({
    queryKey: inboxKeys.archived(listOptions),
    queryFn: async ({ pageParam = 0 }) => {
      const response = await inboxService.listArchived({
        ...listOptions,
        offset: pageParam,
        limit: listOptions.limit ?? 50
      })
      return response
    },
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce((acc, page) => acc + page.items.length, 0)
      return lastPage.hasMore ? totalFetched : undefined
    },
    initialPageParam: 0,
    staleTime: ITEM_STALE_TIME,
    enabled
  })

  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const lastPage = query.data?.pages[query.data.pages.length - 1]
  const total = lastPage?.total ?? 0
  const hasMore = lastPage?.hasMore ?? false

  useEffect(() => {
    const unsubArchived = onInboxArchived(() => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
    })
    return () => {
      unsubArchived()
    }
  }, [queryClient])

  return {
    items,
    total,
    hasMore,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: (): void => {
      void query.refetch()
    },
    loadMore: (): void => {
      void query.fetchNextPage()
    },
    isLoadingMore: query.isFetchingNextPage
  }
}

export function useInboxFilingHistory(options?: {
  limit?: number
}): UseQueryResult<InboxFilingHistoryResponse> {
  return useQuery({
    queryKey: inboxKeys.filingHistory(),
    queryFn: () => inboxService.getFilingHistory(options),
    staleTime: ITEM_STALE_TIME
  })
}
