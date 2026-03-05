/**
 * Inbox Hooks
 * React hooks for inbox operations in the renderer process.
 * Uses TanStack Query for caching and data fetching.
 *
 * @module hooks/use-inbox
 */

import { useEffect } from 'react'
import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
  type UseQueryResult,
  type UseMutationResult
} from '@tanstack/react-query'
import type {
  InboxItem,
  InboxItemListItem,
  InboxStats,
  InboxCaptureResponse,
  InboxFileResponse,
  InboxBulkResponse,
  InboxSuggestionsResponse,
  InboxFilingHistoryResponse
} from '../../../preload/index.d'
import {
  inboxService,
  onInboxCaptured,
  onInboxUpdated,
  onInboxArchived,
  onInboxFiled,
  onInboxSnoozed,
  onInboxSnoozeDue,
  onInboxTranscriptionComplete,
  onInboxMetadataComplete,
  onInboxProcessingError,
  type CaptureTextInput,
  type CaptureLinkInput,
  type CaptureImageInput,
  type CaptureVoiceInput,
  type InboxListInput,
  type InboxUpdateInput,
  type FileItemInput,
  type SnoozeInput,
  type BulkArchiveInput,
  type BulkTagInput
} from '@/services/inbox-service'

// =============================================================================
// Query Keys
// =============================================================================

export const inboxKeys = {
  all: ['inbox'] as const,
  lists: () => [...inboxKeys.all, 'list'] as const,
  list: (options?: InboxListInput) => [...inboxKeys.lists(), options] as const,
  items: () => [...inboxKeys.all, 'items'] as const,
  item: (id: string) => [...inboxKeys.items(), id] as const,
  stats: () => [...inboxKeys.all, 'stats'] as const,
  patterns: () => [...inboxKeys.all, 'patterns'] as const,
  tags: () => [...inboxKeys.all, 'tags'] as const,
  snoozed: () => [...inboxKeys.all, 'snoozed'] as const,
  suggestions: (itemId: string) => [...inboxKeys.all, 'suggestions', itemId] as const,
  staleThreshold: () => [...inboxKeys.all, 'staleThreshold'] as const,
  archived: (options?: { search?: string }) => [...inboxKeys.all, 'archived', options] as const,
  filingHistory: () => [...inboxKeys.all, 'filingHistory'] as const
}

// =============================================================================
// Types
// =============================================================================

export interface UseInboxListOptions extends InboxListInput {
  /** Whether to enable the query (default: true) */
  enabled?: boolean
}

export interface UseInboxListResult {
  /** List of inbox items */
  items: InboxItemListItem[]
  /** Total count of items matching the filter */
  total: number
  /** Whether there are more items to load */
  hasMore: boolean
  /** Whether the initial load is in progress */
  isLoading: boolean
  /** Whether a refetch is in progress */
  isFetching: boolean
  /** Error if the query failed */
  error: Error | null
  /** Refetch the list */
  refetch: () => void
  /** Load more items (infinite scroll) */
  loadMore: () => void
  /** Whether loading more is in progress */
  isLoadingMore: boolean
}

export interface UseInboxItemResult {
  /** The inbox item, or null if not found */
  item: InboxItem | null
  /** Whether the item is loading */
  isLoading: boolean
  /** Error if the query failed */
  error: Error | null
  /** Refetch the item */
  refetch: () => void
}

export interface UseInboxStatsResult {
  /** Inbox statistics */
  stats: InboxStats | null
  /** Whether stats are loading */
  isLoading: boolean
  /** Error if the query failed */
  error: Error | null
  /** Refetch stats */
  refetch: () => void
}

// =============================================================================
// Constants
// =============================================================================

/** Default page size for list queries */
const DEFAULT_PAGE_SIZE = 50

/** Stale time for inbox items (30 seconds) */
const ITEM_STALE_TIME = 30 * 1000

/** Stale time for stats (1 minute) */
const STATS_STALE_TIME = 60 * 1000

// =============================================================================
// useInboxList Hook
// =============================================================================

/**
 * Hook for fetching paginated inbox items.
 * Supports filtering by type and infinite scroll.
 *
 * @param options - List options and filters
 * @returns List state and operations
 */
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

  // Flatten items from all pages
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const lastPage = query.data?.pages[query.data.pages.length - 1]
  const total = lastPage?.total ?? 0
  const hasMore = lastPage?.hasMore ?? false

  // Subscribe to inbox events for real-time updates
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
// useInboxItem Hook
// =============================================================================

/**
 * Hook for fetching a single inbox item.
 *
 * @param id - Item ID
 * @returns Item state and operations
 */
export function useInboxItem(id: string | null): UseInboxItemResult {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.item(id ?? ''),
    queryFn: () => inboxService.get(id!),
    enabled: !!id,
    staleTime: ITEM_STALE_TIME
  })

  // Subscribe to updates for this specific item
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
// useInboxStats Hook
// =============================================================================

/**
 * Hook for fetching inbox statistics.
 *
 * @returns Stats state and operations
 */
export function useInboxStats(): UseInboxStatsResult {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.stats(),
    queryFn: () => inboxService.getStats(),
    staleTime: STATS_STALE_TIME
  })

  // Subscribe to events that affect stats
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
// useInboxTags Hook
// =============================================================================

/**
 * Hook for fetching inbox tags with counts.
 */
export function useInboxTags(): UseQueryResult<Array<{ tag: string; count: number }>> {
  return useQuery({
    queryKey: inboxKeys.tags(),
    queryFn: () => inboxService.getTags(),
    staleTime: STATS_STALE_TIME
  })
}

// =============================================================================
// useInboxSuggestions Hook
// =============================================================================

/**
 * Hook for fetching filing suggestions for an item.
 *
 * @param itemId - Item ID
 * @returns Suggestions state
 */
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

// =============================================================================
// useInboxSnoozed Hook
// =============================================================================

/**
 * Hook for fetching snoozed inbox items.
 */
export function useInboxSnoozed() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: inboxKeys.snoozed(),
    queryFn: () => inboxService.getSnoozed(),
    staleTime: ITEM_STALE_TIME
  })

  // Subscribe to snooze events
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

// =============================================================================
// useInboxPatterns Hook
// =============================================================================

/**
 * Hook for fetching capture patterns analytics.
 */
export function useInboxPatterns() {
  return useQuery({
    queryKey: inboxKeys.patterns(),
    queryFn: () => inboxService.getPatterns(),
    staleTime: STATS_STALE_TIME * 5 // 5 minutes, patterns don't change often
  })
}

// =============================================================================
// useInboxStaleThreshold Hook
// =============================================================================

/**
 * Hook for getting and setting the stale threshold.
 */
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

// =============================================================================
// Capture Mutations
// =============================================================================

/**
 * Hook for capturing text content.
 */
export function useCaptureText(): UseMutationResult<InboxCaptureResponse, Error, CaptureTextInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureTextInput) => inboxService.captureText(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for capturing a link.
 */
export function useCaptureLink(): UseMutationResult<InboxCaptureResponse, Error, CaptureLinkInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureLinkInput) => inboxService.captureLink(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for capturing a voice memo.
 * Handles audio blob conversion and triggers transcription.
 */
export function useCaptureVoice(): UseMutationResult<
  InboxCaptureResponse,
  Error,
  CaptureVoiceInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureVoiceInput) => inboxService.captureVoice(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for capturing an image.
 */
export function useCaptureImage(): UseMutationResult<
  InboxCaptureResponse,
  Error,
  CaptureImageInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CaptureImageInput) => inboxService.captureImage(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// CRUD Mutations
// =============================================================================

/**
 * Hook for updating an inbox item.
 */
export function useUpdateInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: InboxUpdateInput) => inboxService.update(input),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(variables.id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    }
  })
}

/**
 * Hook for archiving an inbox item.
 */
export function useArchiveInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.archive(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Filing Mutations
// =============================================================================

/**
 * Hook for filing an inbox item.
 */
export function useFileInboxItem(): UseMutationResult<InboxFileResponse, Error, FileItemInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: FileItemInput) => inboxService.file(input),
    onSuccess: (_, variables) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(variables.itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for converting an inbox item to a note.
 */
export function useConvertToNote(): UseMutationResult<InboxFileResponse, Error, string> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.convertToNote(itemId),
    onSuccess: (_, itemId) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for linking an inbox item to an existing note.
 */
export function useLinkToNote() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ itemId, noteId }: { itemId: string; noteId: string }) =>
      inboxService.linkToNote(itemId, noteId),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Tag Mutations
// =============================================================================

/**
 * Hook for adding a tag to an inbox item.
 */
export function useAddInboxTag() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ itemId, tag }: { itemId: string; tag: string }) =>
      inboxService.addTag(itemId, tag),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

/**
 * Hook for removing a tag from an inbox item.
 */
export function useRemoveInboxTag() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ itemId, tag }: { itemId: string; tag: string }) =>
      inboxService.removeTag(itemId, tag),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

// =============================================================================
// Snooze Mutations
// =============================================================================

/**
 * Hook for snoozing an inbox item.
 */
export function useSnoozeInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SnoozeInput) => inboxService.snooze(input),
    onSuccess: (_, { itemId }) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    }
  })
}

/**
 * Hook for unsnoozing an inbox item.
 */
export function useUnsnoozeInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.unsnooze(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.snoozed() })
    }
  })
}

// =============================================================================
// Bulk Mutations
// =============================================================================

/**
 * Hook for bulk archiving inbox items.
 */
export function useBulkArchiveInboxItems(): UseMutationResult<
  InboxBulkResponse,
  Error,
  BulkArchiveInput
> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: BulkArchiveInput) => inboxService.bulkArchive(input),
    onSuccess: (_, { itemIds }) => {
      itemIds.forEach((id) => {
        queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

/**
 * Hook for bulk tagging inbox items.
 */
export function useBulkTagInboxItems(): UseMutationResult<InboxBulkResponse, Error, BulkTagInput> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: BulkTagInput) => inboxService.bulkTag(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.tags() })
    }
  })
}

/**
 * Hook for filing all stale items.
 */
export function useFileAllStale(): UseMutationResult<InboxBulkResponse, Error, void> {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => inboxService.fileAllStale(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

// =============================================================================
// Transcription Mutations
// =============================================================================

/**
 * Hook for retrying transcription on a voice item.
 */
export function useRetryTranscription() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.retryTranscription(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
    }
  })
}

// =============================================================================
// Metadata Mutations
// =============================================================================

/**
 * Hook for retrying metadata fetch on a link item.
 */
export function useRetryMetadata() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (itemId: string) => inboxService.retryMetadata(itemId),
    onSuccess: (_, itemId) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.item(itemId) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
    }
  })
}

// =============================================================================
// Processing Error Subscription Hook
// =============================================================================

/**
 * Hook for subscribing to processing error events.
 *
 * @param callback - Callback to invoke when a processing error occurs
 */
export function useInboxProcessingErrors(
  callback: (event: { id: string; operation: string; error: string }) => void
): void {
  useEffect(() => {
    const unsub = onInboxProcessingError(callback)
    return unsub
  }, [callback])
}

export interface ArchivedListOptions {
  search?: string
  limit?: number
  enabled?: boolean
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

export function useUnarchiveInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.unarchive(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
}

export function useDeletePermanentInboxItem() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => inboxService.deletePermanent(id),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: inboxKeys.item(id) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.archived({}) })
      void queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
    }
  })
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

export function useInboxOperations() {
  const captureText = useCaptureText()
  const captureLink = useCaptureLink()
  const updateItem = useUpdateInboxItem()
  const archiveItem = useArchiveInboxItem()
  const fileItem = useFileInboxItem()
  const convertToNote = useConvertToNote()
  const addTag = useAddInboxTag()
  const removeTag = useRemoveInboxTag()
  const snoozeItem = useSnoozeInboxItem()
  const unsnoozeItem = useUnsnoozeInboxItem()
  const bulkArchive = useBulkArchiveInboxItems()
  const bulkTag = useBulkTagInboxItems()
  const fileAllStale = useFileAllStale()
  const retryTranscription = useRetryTranscription()
  const retryMetadata = useRetryMetadata()

  return {
    // Capture
    captureText: captureText.mutateAsync,
    captureLink: captureLink.mutateAsync,
    isCaptureTextPending: captureText.isPending,
    isCaptureLinkPending: captureLink.isPending,

    // CRUD
    updateItem: updateItem.mutateAsync,
    archiveItem: archiveItem.mutateAsync,
    isUpdatePending: updateItem.isPending,
    isArchivePending: archiveItem.isPending,

    // Filing
    fileItem: fileItem.mutateAsync,
    convertToNote: convertToNote.mutateAsync,
    isFilePending: fileItem.isPending,
    isConvertPending: convertToNote.isPending,

    // Tags
    addTag: addTag.mutateAsync,
    removeTag: removeTag.mutateAsync,

    // Snooze
    snoozeItem: snoozeItem.mutateAsync,
    unsnoozeItem: unsnoozeItem.mutateAsync,

    // Bulk
    bulkArchive: bulkArchive.mutateAsync,
    bulkTag: bulkTag.mutateAsync,
    fileAllStale: fileAllStale.mutateAsync,
    isBulkArchivePending: bulkArchive.isPending,
    isBulkTagPending: bulkTag.isPending,
    isFileAllStalePending: fileAllStale.isPending,

    // Transcription
    retryTranscription: retryTranscription.mutateAsync,
    isRetryTranscriptionPending: retryTranscription.isPending,

    // Metadata
    retryMetadata: retryMetadata.mutateAsync,
    isRetryMetadataPending: retryMetadata.isPending
  }
}
