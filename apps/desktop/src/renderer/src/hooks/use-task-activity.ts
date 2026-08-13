import { useEffect } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { TaskActivityEntry } from '@memry/rpc/tasks'
import { tasksService, onTaskCompleted, onTaskMoved, onTaskUpdated } from '@/services/tasks-service'
import {
  taskActivityKeys,
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_PREVIEW_SIZE
} from './task-activity-query-keys'

export interface UseTaskActivityOptions {
  taskId: string | null
  /** Omit for the full feed; the drawer preview passes ACTIVITY_PREVIEW_SIZE. */
  limit?: number
  actions?: string[]
  enabled?: boolean
}

export interface UseTaskActivityResult {
  entries: TaskActivityEntry[]
  total: number
  hasMore: boolean
  isLoading: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  error: Error | null
}

export { ACTIVITY_PAGE_SIZE, ACTIVITY_PREVIEW_SIZE }

/**
 * Rows are append-only, so there is nothing to poll — the feed only changes
 * when a task changes. Invalidating on the task events covers both this
 * device's edits and a peer's, because a synced `task_activity` row lands
 * alongside the `tasks:updated` its own task row triggers.
 */
export function useTaskActivity(options: UseTaskActivityOptions): UseTaskActivityResult {
  const { taskId, limit, actions, enabled = true } = options
  const queryClient = useQueryClient()
  const pageSize = limit ?? ACTIVITY_PAGE_SIZE

  const query = useInfiniteQuery({
    queryKey: taskActivityKeys.list(taskId ?? '', { limit, actions }),
    queryFn: async ({ pageParam = 0 }) =>
      tasksService.getActivity({
        taskId: taskId as string,
        offset: pageParam,
        limit: pageSize,
        ...(actions && actions.length > 0 ? { actions } : {})
      }),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined
      return allPages.reduce((count, page) => count + page.entries.length, 0)
    },
    initialPageParam: 0,
    enabled: enabled && Boolean(taskId)
  })

  useEffect(() => {
    if (!taskId) return

    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: taskActivityKeys.lists() })
    }

    const unsubs = [onTaskUpdated(invalidate), onTaskCompleted(invalidate), onTaskMoved(invalidate)]
    return () => unsubs.forEach((unsub) => unsub())
  }, [queryClient, taskId])

  const lastPage = query.data?.pages[query.data.pages.length - 1]

  return {
    entries: query.data?.pages.flatMap((page) => page.entries) ?? [],
    total: lastPage?.total ?? 0,
    hasMore: lastPage?.hasMore ?? false,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    error: (query.error as Error) ?? null
  }
}
