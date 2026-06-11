import { useState, useEffect, useCallback } from 'react'
import {
  tasksService,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  type Task
} from '@/services/tasks-service'
import { useTaskPrefetch } from './task-prefetch-context'

interface UseTaskBlockDataResult {
  task: Task | null
  isLoading: boolean
  isDeleted: boolean
}

export function useTaskBlockData(taskId: string): UseTaskBlockDataResult {
  const prefetch = useTaskPrefetch()
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)

  // The per-note batch prefetch is read during render (no effect / no setState
  // needed). An individually-fetched task or a live event update takes
  // precedence over the cached one.
  const cachedTask = taskId ? (prefetch.getCached(taskId) ?? null) : null
  const task = fetchedTask ?? cachedTask

  const loadTask = useCallback(async (id: string): Promise<void> => {
    setIsLoading(true)
    try {
      const result = await tasksService.get(id)
      if (result) {
        setFetchedTask(result)
        setIsDeleted(false)
      } else {
        setIsDeleted(true)
      }
    } catch {
      setIsDeleted(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!taskId) return
    // Covered by the batch prefetch (read above as cachedTask) — no IPC needed.
    if (prefetch.getCached(taskId)) return
    // Batch still loading: wait for it (this effect re-runs when it settles)
    // instead of each block firing its own request — the "line by line" fill.
    if (prefetch.status === 'loading') return

    let cancelled = false
    void (async () => {
      await loadTask(taskId)
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, loadTask, prefetch])

  useEffect(() => {
    if (!taskId) return

    const unsubUpdated = onTaskUpdated((event) => {
      if (event.id === taskId) {
        setFetchedTask(event.task)
      }
    })

    const unsubCompleted = onTaskCompleted((event) => {
      if (event.id === taskId) {
        setFetchedTask(event.task)
      }
    })

    const unsubDeleted = onTaskDeleted((event) => {
      if (event.id === taskId) {
        setIsDeleted(true)
        setFetchedTask(null)
      }
    })

    return () => {
      unsubUpdated()
      unsubCompleted()
      unsubDeleted()
    }
  }, [taskId])

  return { task, isLoading, isDeleted }
}
