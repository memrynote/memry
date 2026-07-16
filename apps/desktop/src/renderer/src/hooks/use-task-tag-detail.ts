import { getI18n } from 'react-i18next'
/**
 * Hook for listing tasks that carry a given tag (or a descendant of it) in
 * the sidebar tag drill-down view.
 *
 * The backend task filter (`main/database/queries/tasks.ts`) is exact-match
 * with AND semantics and no hierarchy support, so it is intentionally not
 * used here — that would put two different tag-matching behaviors under one
 * "tag detail" header. Instead we fetch tasks unfiltered and match tags
 * client-side, including descendants, to mirror the notes sections'
 * `includeDescendants` behavior in `useTagDetail`.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  tasksService,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  type Task
} from '@/services/tasks-service'

const log = createLogger('Hook:TaskTagDetail')

export interface UseTaskTagDetailOptions {
  tag: string
}

export interface UseTaskTagDetailReturn {
  tasks: Task[]
  count: number
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * True when `taskTag` is exactly `tag`, or a descendant of it (`work/urgent`
 * is a descendant of `work`). Case-insensitive, case-preserving on display.
 *
 * The `/` boundary check matters: without it, `workshop` would wrongly match
 * `work`.
 */
export function matchesTagOrDescendant(taskTag: string, tag: string): boolean {
  const a = taskTag.toLowerCase()
  const b = tag.toLowerCase()
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Fetches all non-archived tasks and filters to those tagged with `tag` or a
 * descendant of it. Refreshes on task CRUD events so it stays live without
 * an explicit `tags` list option on the backend call.
 */
export function useTaskTagDetail({ tag }: UseTaskTagDetailOptions): UseTaskTagDetailReturn {
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTasks = useCallback(async () => {
    if (!tag) return

    setIsLoading(true)
    setError(null)

    try {
      // No `tags` option — see the module comment above.
      const response = await tasksService.list({
        includeCompleted: true,
        includeArchived: false,
        limit: 1000
      })
      setAllTasks(response.tasks)
    } catch (err) {
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadTasks')
      )
      setError(message)
      log.error('Error fetching tasks:', err)
    } finally {
      setIsLoading(false)
    }
  }, [tag])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await fetchTasks()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [fetchTasks])

  useEffect(() => {
    const unsubscribers = [
      onTaskCreated(() => void fetchTasks()),
      onTaskUpdated(() => void fetchTasks()),
      onTaskDeleted(() => void fetchTasks()),
      onTaskCompleted(() => void fetchTasks())
    ]
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [fetchTasks])

  const tasks = useMemo(
    () =>
      allTasks.filter((task) =>
        (task.tags ?? []).some((taskTag) => matchesTagOrDescendant(taskTag, tag))
      ),
    [allTasks, tag]
  )

  return useMemo(
    () => ({
      tasks,
      count: tasks.length,
      isLoading,
      error,
      refresh: fetchTasks
    }),
    [tasks, isLoading, error, fetchTasks]
  )
}
