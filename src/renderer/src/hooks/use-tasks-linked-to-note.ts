import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'

import {
  tasksService,
  type Task,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted
} from '@/services/tasks-service'

// ============================================================================
// TYPES
// ============================================================================

interface UseTasksLinkedToNoteResult {
  tasks: Task[]
  isLoading: boolean
  error: string | null
  refresh: () => void
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to fetch tasks linked to a specific note.
 * Automatically refreshes when tasks are created, updated, or deleted.
 *
 * @param noteId - The ID of the note to get linked tasks for (null to skip loading)
 * @returns Object containing tasks, loading state, error state, and refresh function
 */
export function useTasksLinkedToNote(noteId: string | null): UseTasksLinkedToNoteResult {
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadTasks = useCallback(async (id: string): Promise<void> => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await tasksService.getLinkedTasks(id)
      setTasks(result)
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to load linked tasks'))
      setTasks([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Load tasks when noteId changes
  useEffect(() => {
    if (noteId) {
      loadTasks(noteId)
    } else {
      setTasks([])
      setError(null)
    }
  }, [noteId, loadTasks])

  // Subscribe to task events to refresh when tasks change
  useEffect(() => {
    if (!noteId) return

    const refresh = (): void => {
      loadTasks(noteId)
    }

    const unsubCreated = onTaskCreated(refresh)
    const unsubUpdated = onTaskUpdated(refresh)
    const unsubDeleted = onTaskDeleted(refresh)

    return () => {
      unsubCreated()
      unsubUpdated()
      unsubDeleted()
    }
  }, [noteId, loadTasks])

  const refresh = useCallback((): void => {
    if (noteId) {
      loadTasks(noteId)
    }
  }, [noteId, loadTasks])

  return {
    tasks,
    isLoading,
    error,
    refresh
  }
}

export default useTasksLinkedToNote
