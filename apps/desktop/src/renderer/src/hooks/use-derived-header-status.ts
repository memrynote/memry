import { useEffect, useMemo } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { taskStatusCategory, type TaskStatusCategory } from '@memry/shared/note-status'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import {
  onProjectUpdated,
  onTaskCompleted,
  onTaskCreated,
  onTaskDeleted,
  onTaskMoved,
  onTaskUpdated,
  tasksService
} from '@/services/tasks-service'

const noteTaskKeys = {
  all: ['note-task-status'] as const,
  task: (taskId: string) => ['note-task-status', 'task', taskId] as const,
  project: (projectId: string) => ['note-task-status', 'statuses', projectId] as const
}

/**
 * Where each task written in the note body sits (#3176), or null while the
 * note has none. The body names the tasks, as it does for main and the Rust
 * core: a task linked to the note from its detail panel does not count, and one
 * that lost its link still does. A task whose row has not arrived is left out
 * rather than read as to-do.
 */
export function useNoteTaskCategories(content: string): TaskStatusCategory[] | null {
  const queryClient = useQueryClient()
  const taskIds = useMemo(() => [...scanTaskCheckboxStates(content).keys()], [content])

  const taskQueries = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: noteTaskKeys.task(taskId),
      queryFn: () => tasksService.get(taskId)
    }))
  })
  const projectIds = [
    ...new Set(taskQueries.flatMap((query) => (query.data ? [query.data.projectId] : [])))
  ]
  const statusQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: noteTaskKeys.project(projectId),
      queryFn: () => tasksService.listStatuses(projectId)
    }))
  })

  useEffect(() => {
    const refresh = (): void => void queryClient.invalidateQueries({ queryKey: noteTaskKeys.all })
    const unsubscribe = [
      onTaskCreated(refresh),
      onTaskUpdated(refresh),
      onTaskDeleted(refresh),
      onTaskCompleted(refresh),
      onTaskMoved(refresh),
      onProjectUpdated(refresh)
    ]
    return () => unsubscribe.forEach((off) => off())
  }, [queryClient])

  const isLoading = [...taskQueries, ...statusQueries].some((query) => query.isPending)
  const statusById = new Map(
    statusQueries.flatMap((query) => query.data ?? []).map((status) => [status.id, status])
  )
  const categories = isLoading
    ? []
    : taskQueries.flatMap((query) =>
        query.data
          ? [
              taskStatusCategory(
                { completed: query.data.completedAt !== null },
                query.data.statusId ? (statusById.get(query.data.statusId) ?? null) : null
              )
            ]
          : []
      )

  // The caller memoizes on this, so it stays the same array until a category changes.
  const key = categories.join(',')
  return useMemo(() => (key ? (key.split(',') as TaskStatusCategory[]) : null), [key])
}
