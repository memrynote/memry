import { useState, useCallback, useMemo, useRef, useEffect } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SelectionState {
  /** Set of selected task IDs */
  selectedIds: Set<string>
  /** Is selection mode active */
  isSelectionMode: boolean
  /** Last selected ID (for shift+click range) */
  lastSelectedId: string | null
  /** Select all state */
  selectAllState: 'none' | 'some' | 'all'
}

export interface UseTaskSelectionReturn {
  /** Current selection state */
  selection: SelectionState
  /** Number of selected tasks */
  selectedCount: number
  /** Whether any tasks are selected */
  hasSelection: boolean
  /** Whether all visible tasks are selected */
  allSelected: boolean
  /** Whether some (but not all) visible tasks are selected */
  someSelected: boolean
  /** Array of selected task IDs */
  selectedTaskIds: string[]
  /** Select a single task */
  selectTask: (taskId: string) => void
  /** Deselect a single task */
  deselectTask: (taskId: string) => void
  /** Toggle selection of a single task */
  toggleTask: (taskId: string) => void
  /** Select a range of tasks (for shift+click) */
  selectRange: (toId: string) => void
  /** Select all visible tasks */
  selectAll: () => void
  /** Deselect all tasks */
  deselectAll: () => void
  /** Toggle select all */
  toggleSelectAll: () => void
  /** Check if a specific task is selected */
  isSelected: (taskId: string) => boolean
  /** Enter selection mode without selecting any tasks */
  enterSelectionMode: () => void
  /** Exit selection mode and clear all selections */
  exitSelectionMode: () => void
}

export interface UseTaskSelectionOptions {
  /** External selection to mirror, used when other layers need the same selected IDs */
  controlledSelectedIds?: Set<string>
  /** Called synchronously whenever selection changes */
  onSelectionChange?: (ids: Set<string>) => void
}

// ============================================================================
// INITIAL STATE
// ============================================================================

const initialSelectionState: SelectionState = {
  selectedIds: new Set(),
  isSelectionMode: false,
  lastSelectedId: null,
  selectAllState: 'none'
}

const areSetsEqual = (left: Set<string>, right: Set<string>): boolean => {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

const getNextLastSelectedId = (
  selectedIds: Set<string>,
  previousLastSelectedId: string | null
): string | null => {
  if (previousLastSelectedId && selectedIds.has(previousLastSelectedId)) {
    return previousLastSelectedId
  }

  const selectedArray = Array.from(selectedIds)
  return selectedArray[selectedArray.length - 1] ?? null
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Hook to manage task selection state for multi-select functionality
 * @param visibleTaskIds - Array of task IDs currently visible in the view
 */
export const useTaskSelection = (
  visibleTaskIds: string[],
  options: UseTaskSelectionOptions = {}
): UseTaskSelectionReturn => {
  const { controlledSelectedIds, onSelectionChange } = options
  const [selection, setSelectionState] = useState<SelectionState>(initialSelectionState)
  const selectionRef = useRef(selection)

  // ========== DERIVED STATE ==========

  const selectedCount = selection.selectedIds.size
  const hasSelection = selectedCount > 0
  const allSelected = selectedCount === visibleTaskIds.length && visibleTaskIds.length > 0
  const someSelected = selectedCount > 0 && selectedCount < visibleTaskIds.length
  const selectedTaskIds = useMemo(() => Array.from(selection.selectedIds), [selection.selectedIds])

  // ========== HELPER FUNCTIONS ==========

  const calculateSelectAllState = useCallback(
    (newSelectedSize: number): SelectionState['selectAllState'] => {
      if (newSelectedSize === 0) return 'none'
      if (newSelectedSize === visibleTaskIds.length) return 'all'
      return 'some'
    },
    [visibleTaskIds.length]
  )

  const setSelection = useCallback(
    (updater: SelectionState | ((prev: SelectionState) => SelectionState)): void => {
      const nextSelection =
        typeof updater === 'function'
          ? (updater as (prev: SelectionState) => SelectionState)(selectionRef.current)
          : updater

      selectionRef.current = nextSelection
      setSelectionState(nextSelection)
      onSelectionChange?.(nextSelection.selectedIds)
    },
    [onSelectionChange]
  )

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  useEffect(() => {
    if (!controlledSelectedIds) return
    if (areSetsEqual(controlledSelectedIds, selectionRef.current.selectedIds)) return

    setSelection((prev) => ({
      ...prev,
      selectedIds: new Set(controlledSelectedIds),
      isSelectionMode: controlledSelectedIds.size > 0,
      lastSelectedId: getNextLastSelectedId(controlledSelectedIds, prev.lastSelectedId),
      selectAllState: calculateSelectAllState(controlledSelectedIds.size)
    }))
  }, [calculateSelectAllState, controlledSelectedIds, setSelection])

  // ========== ACTIONS ==========

  const selectTask = useCallback(
    (taskId: string): void => {
      setSelection((prev) => {
        const newSelected = new Set(prev.selectedIds)
        newSelected.add(taskId)
        return {
          ...prev,
          selectedIds: newSelected,
          isSelectionMode: true,
          lastSelectedId: taskId,
          selectAllState: calculateSelectAllState(newSelected.size)
        }
      })
    },
    [calculateSelectAllState]
  )

  const deselectTask = useCallback(
    (taskId: string): void => {
      setSelection((prev) => {
        const newSelected = new Set(prev.selectedIds)
        newSelected.delete(taskId)
        const newIsSelectionMode = newSelected.size > 0
        return {
          ...prev,
          selectedIds: newSelected,
          isSelectionMode: newIsSelectionMode,
          selectAllState: calculateSelectAllState(newSelected.size)
        }
      })
    },
    [calculateSelectAllState]
  )

  const toggleTask = useCallback(
    (taskId: string): void => {
      setSelection((prev) => {
        const newSelected = new Set(prev.selectedIds)
        if (newSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
        const newIsSelectionMode = newSelected.size > 0
        return {
          ...prev,
          selectedIds: newSelected,
          isSelectionMode: newIsSelectionMode,
          lastSelectedId: taskId,
          selectAllState: calculateSelectAllState(newSelected.size)
        }
      })
    },
    [calculateSelectAllState]
  )

  const selectRange = useCallback(
    (toId: string): void => {
      setSelection((prev) => {
        const fromId = prev.lastSelectedId
        if (!fromId) {
          // No previous selection, just select this one
          const newSelected = new Set(prev.selectedIds)
          newSelected.add(toId)
          return {
            ...prev,
            selectedIds: newSelected,
            isSelectionMode: true,
            lastSelectedId: toId,
            selectAllState: calculateSelectAllState(newSelected.size)
          }
        }

        const fromIndex = visibleTaskIds.indexOf(fromId)
        const toIndex = visibleTaskIds.indexOf(toId)

        if (fromIndex === -1 || toIndex === -1) {
          // One of the IDs not found, just select the target
          const newSelected = new Set(prev.selectedIds)
          newSelected.add(toId)
          return {
            ...prev,
            selectedIds: newSelected,
            isSelectionMode: true,
            lastSelectedId: toId,
            selectAllState: calculateSelectAllState(newSelected.size)
          }
        }

        // Select range
        const start = Math.min(fromIndex, toIndex)
        const end = Math.max(fromIndex, toIndex)
        const rangeIds = visibleTaskIds.slice(start, end + 1)

        const newSelected = new Set(prev.selectedIds)
        rangeIds.forEach((id) => newSelected.add(id))

        return {
          ...prev,
          selectedIds: newSelected,
          isSelectionMode: true,
          lastSelectedId: toId,
          selectAllState: calculateSelectAllState(newSelected.size)
        }
      })
    },
    [visibleTaskIds, calculateSelectAllState]
  )

  const selectAll = useCallback((): void => {
    if (visibleTaskIds.length === 0) return

    setSelection({
      selectedIds: new Set(visibleTaskIds),
      isSelectionMode: true,
      lastSelectedId: visibleTaskIds[visibleTaskIds.length - 1] || null,
      selectAllState: 'all'
    })
  }, [visibleTaskIds])

  const deselectAll = useCallback((): void => {
    setSelection(initialSelectionState)
  }, [])

  const toggleSelectAll = useCallback((): void => {
    if (allSelected) {
      deselectAll()
    } else {
      selectAll()
    }
  }, [allSelected, selectAll, deselectAll])

  const isSelected = useCallback(
    (taskId: string): boolean => {
      return selection.selectedIds.has(taskId)
    },
    [selection.selectedIds]
  )

  const enterSelectionMode = useCallback((): void => {
    setSelection((prev) => ({
      ...prev,
      isSelectionMode: true
    }))
  }, [])

  const exitSelectionMode = useCallback((): void => {
    setSelection(initialSelectionState)
  }, [])

  return {
    selection,
    selectedCount,
    hasSelection,
    allSelected,
    someSelected,
    selectedTaskIds,
    selectTask,
    deselectTask,
    toggleTask,
    selectRange,
    selectAll,
    deselectAll,
    toggleSelectAll,
    isSelected,
    enterSelectionMode,
    exitSelectionMode
  }
}

export default useTaskSelection
