import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { InboxJob } from '../../../../preload/index.d'

import {
  inboxService,
  onInboxArchived,
  onInboxCaptured,
  onInboxMetadataComplete,
  onInboxProcessingError,
  onInboxTranscriptionComplete,
  onInboxUpdated
} from '@/services/inbox-service'
import { ITEM_STALE_TIME, inboxKeys } from '@/hooks/inbox-query-keys'

export interface UseInboxJobsResult {
  jobs: InboxJob[]
  jobsByItemId: Record<string, InboxJob[]>
  activeCount: number
  failedCount: number
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

export function useInboxJobs(itemIds: string[] = []): UseInboxJobsResult {
  const queryClient = useQueryClient()

  const normalizedItemIds = [...new Set(itemIds.filter(Boolean))].sort()

  const query = useQuery({
    queryKey: inboxKeys.jobs(normalizedItemIds.length ? { itemIds: normalizedItemIds } : undefined),
    queryFn: () =>
      inboxService.getJobs(normalizedItemIds.length ? { itemIds: normalizedItemIds } : undefined),
    staleTime: ITEM_STALE_TIME
  })

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all })
    }

    const unsubCaptured = onInboxCaptured(invalidate)
    const unsubUpdated = onInboxUpdated(invalidate)
    const unsubArchived = onInboxArchived(invalidate)
    const unsubMetadata = onInboxMetadataComplete(invalidate)
    const unsubTranscription = onInboxTranscriptionComplete(invalidate)
    const unsubProcessingError = onInboxProcessingError(invalidate)

    return () => {
      unsubCaptured()
      unsubUpdated()
      unsubArchived()
      unsubMetadata()
      unsubTranscription()
      unsubProcessingError()
    }
  }, [queryClient])

  const jobs = query.data?.jobs ?? []
  const jobsByItemId = useMemo(() => {
    return jobs.reduce<Record<string, InboxJob[]>>((acc, job) => {
      if (!acc[job.itemId]) acc[job.itemId] = []
      acc[job.itemId].push(job)
      return acc
    }, {})
  }, [jobs])

  const activeCount = jobs.filter(
    (job) => job.status === 'pending' || job.status === 'running'
  ).length
  const failedCount = jobs.filter((job) => job.status === 'failed').length

  return {
    jobs,
    jobsByItemId,
    activeCount,
    failedCount,
    isLoading: query.isLoading,
    error: query.error,
    refetch: (): void => {
      void query.refetch()
    }
  }
}
