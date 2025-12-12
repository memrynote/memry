import { useState, useCallback, useMemo, useEffect } from "react"
import { arrayMove } from "@dnd-kit/sortable"

import type { Task } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface TaskOrderState {
  /** Order by section ID */
  orders: Record<string, string[]>
  /** Whether manual ordering is active */
  isManuallyOrdered: boolean
}

interface UseTaskOrderProps {
  /** Storage key prefix for persistence */
  storageKeyPrefix?: string
  /** Whether to persist to localStorage */
  persist?: boolean
}

interface UseTaskOrderReturn {
  /** Get ordered tasks for a section */
  getOrderedTasks: (sectionId: string, tasks: Task[]) => Task[]
  /** Set order for a section */
  setOrder: (sectionId: string, order: string[]) => void
  /** Move a task within a section */
  moveTask: (sectionId: string, taskId: string, direction: "up" | "down") => void
  /** Move a task to top of section */
  moveToTop: (sectionId: string, taskId: string) => void
  /** Move a task to bottom of section */
  moveToBottom: (sectionId: string, taskId: string) => void
  /** Reorder tasks by drag */
  reorderByDrag: (sectionId: string, activeId: string, overId: string, tasks: Task[]) => void
  /** Clear manual order (reset to default sort) */
  clearOrder: (sectionId?: string) => void
  /** Whether any manual ordering is active */
  isManuallyOrdered: boolean
  /** Get the current order for a section */
  getOrder: (sectionId: string) => string[] | undefined
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STORAGE_KEY = "task-orders"

// ============================================================================
// HOOK
// ============================================================================

export const useTaskOrder = ({
  storageKeyPrefix = "",
  persist = true,
}: UseTaskOrderProps = {}): UseTaskOrderReturn => {
  const storageKey = storageKeyPrefix ? `${storageKeyPrefix}-${STORAGE_KEY}` : STORAGE_KEY

  // Initialize state from localStorage
  const [state, setState] = useState<TaskOrderState>(() => {
    if (!persist) {
      return { orders: {}, isManuallyOrdered: false }
    }

    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        return {
          orders: parsed.orders || {},
          isManuallyOrdered: Object.keys(parsed.orders || {}).length > 0,
        }
      }
    } catch (err) {
      console.warn("Failed to load task order from localStorage:", err)
    }

    return { orders: {}, isManuallyOrdered: false }
  })

  // Persist to localStorage when state changes
  useEffect(() => {
    if (!persist) return

    try {
      localStorage.setItem(storageKey, JSON.stringify({ orders: state.orders }))
    } catch (err) {
      console.warn("Failed to save task order to localStorage:", err)
    }
  }, [state.orders, persist, storageKey])

  // Get ordered tasks for a section
  const getOrderedTasks = useCallback(
    (sectionId: string, tasks: Task[]): Task[] => {
      const order = state.orders[sectionId]

      if (!order || order.length === 0) {
        // No manual order, return as-is (let caller handle default sort)
        return tasks
      }

      // Apply manual order
      const taskMap = new Map(tasks.map((t) => [t.id, t]))
      const orderedTasks: Task[] = []

      // Add tasks in saved order
      order.forEach((id) => {
        const task = taskMap.get(id)
        if (task) {
          orderedTasks.push(task)
          taskMap.delete(id)
        }
      })

      // Add any new tasks at the end (not in saved order)
      taskMap.forEach((task) => orderedTasks.push(task))

      return orderedTasks
    },
    [state.orders]
  )

  // Set order for a section
  const setOrder = useCallback((sectionId: string, order: string[]) => {
    setState((prev) => ({
      orders: {
        ...prev.orders,
        [sectionId]: order,
      },
      isManuallyOrdered: true,
    }))
  }, [])

  // Get current order for a section
  const getOrder = useCallback(
    (sectionId: string): string[] | undefined => {
      return state.orders[sectionId]
    },
    [state.orders]
  )

  // Move a task within a section
  const moveTask = useCallback(
    (sectionId: string, taskId: string, direction: "up" | "down") => {
      setState((prev) => {
        const currentOrder = prev.orders[sectionId]
        if (!currentOrder) return prev

        const currentIndex = currentOrder.indexOf(taskId)
        if (currentIndex === -1) return prev

        const newIndex =
          direction === "up"
            ? Math.max(0, currentIndex - 1)
            : Math.min(currentOrder.length - 1, currentIndex + 1)

        if (newIndex === currentIndex) return prev

        const newOrder = arrayMove(currentOrder, currentIndex, newIndex)

        return {
          orders: {
            ...prev.orders,
            [sectionId]: newOrder,
          },
          isManuallyOrdered: true,
        }
      })
    },
    []
  )

  // Move a task to top of section
  const moveToTop = useCallback((sectionId: string, taskId: string) => {
    setState((prev) => {
      const currentOrder = prev.orders[sectionId]
      if (!currentOrder) return prev

      const currentIndex = currentOrder.indexOf(taskId)
      if (currentIndex === -1 || currentIndex === 0) return prev

      const newOrder = arrayMove(currentOrder, currentIndex, 0)

      return {
        orders: {
          ...prev.orders,
          [sectionId]: newOrder,
        },
        isManuallyOrdered: true,
      }
    })
  }, [])

  // Move a task to bottom of section
  const moveToBottom = useCallback((sectionId: string, taskId: string) => {
    setState((prev) => {
      const currentOrder = prev.orders[sectionId]
      if (!currentOrder) return prev

      const currentIndex = currentOrder.indexOf(taskId)
      if (currentIndex === -1 || currentIndex === currentOrder.length - 1) return prev

      const newOrder = arrayMove(currentOrder, currentIndex, currentOrder.length - 1)

      return {
        orders: {
          ...prev.orders,
          [sectionId]: newOrder,
        },
        isManuallyOrdered: true,
      }
    })
  }, [])

  // Reorder by drag
  const reorderByDrag = useCallback(
    (sectionId: string, activeId: string, overId: string, tasks: Task[]) => {
      setState((prev) => {
        // Get current order, or initialize from tasks
        const currentOrder =
          prev.orders[sectionId] || tasks.map((t) => t.id)

        const oldIndex = currentOrder.indexOf(activeId)
        const newIndex = currentOrder.indexOf(overId)

        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
          return prev
        }

        const newOrder = arrayMove(currentOrder, oldIndex, newIndex)

        return {
          orders: {
            ...prev.orders,
            [sectionId]: newOrder,
          },
          isManuallyOrdered: true,
        }
      })
    },
    []
  )

  // Clear manual order
  const clearOrder = useCallback((sectionId?: string) => {
    setState((prev) => {
      if (sectionId) {
        // Clear specific section
        const { [sectionId]: _, ...rest } = prev.orders
        return {
          orders: rest,
          isManuallyOrdered: Object.keys(rest).length > 0,
        }
      }
      // Clear all
      return { orders: {}, isManuallyOrdered: false }
    })
  }, [])

  // Check if manually ordered
  const isManuallyOrdered = useMemo(
    () => Object.keys(state.orders).length > 0,
    [state.orders]
  )

  return {
    getOrderedTasks,
    setOrder,
    moveTask,
    moveToTop,
    moveToBottom,
    reorderByDrag,
    clearOrder,
    isManuallyOrdered,
    getOrder,
  }
}

export default useTaskOrder











