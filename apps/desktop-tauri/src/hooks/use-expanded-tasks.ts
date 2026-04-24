import { useState, useCallback, useEffect } from 'react'

import type { Task } from '@/data/sample-tasks'
import { hasSubtasks } from '@/lib/subtask-utils'

// ============================================================================
// TYPES
// ============================================================================

interface UseExpandedTasksOptions {
  /** Key for localStorage persistence (e.g., "all-tasks" or "project-123") */
  storageKey?: string
  /** Whether to persist expanded state to localStorage */
  persist?: boolean
}

interface UseExpandedTasksReturn {
  /** Set of expanded task IDs */
  expandedIds: Set<string>
  /** Check if a specific task is expanded */
  isExpanded: (taskId: string) => boolean
  /** Toggle the expanded state of a task */
  toggleExpanded: (taskId: string) => void
  /** Expand a specific task */
  expand: (taskId: string) => void
  /** Collapse a specific task */
  collapse: (taskId: string) => void
  /** Expand all tasks that have subtasks */
  expandAll: (tasks: Task[]) => void
  /** Collapse all tasks */
  collapseAll: () => void
}

// ============================================================================
// STORAGE HELPERS
// ============================================================================

const STORAGE_PREFIX = 'expandedTasks'

const getStorageKey = (key: string): string => {
  return `${STORAGE_PREFIX}-${key}`
}

const loadFromStorage = (key: string): Set<string> => {
  try {
    const stored = localStorage.getItem(getStorageKey(key))
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return new Set(parsed)
      }
    }
  } catch (err) {
    // Ignore storage errors
  }
  return new Set()
}

const saveToStorage = (key: string, expandedIds: Set<string>): void => {
  try {
    localStorage.setItem(getStorageKey(key), JSON.stringify(Array.from(expandedIds)))
  } catch (err) {
    // Ignore storage errors
  }
}

// ============================================================================
// USE EXPANDED TASKS HOOK
// ============================================================================

export const useExpandedTasks = (options: UseExpandedTasksOptions = {}): UseExpandedTasksReturn => {
  const { storageKey = 'default', persist = true } = options

  // Initialize from localStorage if persisting
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    if (persist) {
      return loadFromStorage(storageKey)
    }
    return new Set()
  })

  // Persist to localStorage when expandedIds changes
  useEffect(() => {
    if (persist) {
      saveToStorage(storageKey, expandedIds)
    }
  }, [expandedIds, storageKey, persist])

  // Reload from storage when storageKey changes
  useEffect(() => {
    if (persist) {
      setExpandedIds(loadFromStorage(storageKey))
    }
  }, [storageKey, persist])

  const isExpanded = useCallback(
    (taskId: string): boolean => {
      return expandedIds.has(taskId)
    },
    [expandedIds]
  )

  const toggleExpanded = useCallback((taskId: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) {
        next.delete(taskId)
      } else {
        next.add(taskId)
      }
      return next
    })
  }, [])

  const expand = useCallback((taskId: string): void => {
    setExpandedIds((prev) => {
      if (prev.has(taskId)) return prev
      const next = new Set(prev)
      next.add(taskId)
      return next
    })
  }, [])

  const collapse = useCallback((taskId: string): void => {
    setExpandedIds((prev) => {
      if (!prev.has(taskId)) return prev
      const next = new Set(prev)
      next.delete(taskId)
      return next
    })
  }, [])

  const expandAll = useCallback((tasks: Task[]): void => {
    const parentIds = tasks.filter((t) => hasSubtasks(t)).map((t) => t.id)
    setExpandedIds(new Set(parentIds))
  }, [])

  const collapseAll = useCallback((): void => {
    setExpandedIds(new Set())
  }, [])

  return {
    expandedIds,
    isExpanded,
    toggleExpanded,
    expand,
    collapse,
    expandAll,
    collapseAll
  }
}

export default useExpandedTasks
