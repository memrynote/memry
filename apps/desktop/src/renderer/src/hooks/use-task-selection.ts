import { useState, useCallback, useMemo } from 'react'

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
  const [internalSelection, setInternalSelectionState] =
    useState<SelectionState>(initialSelectionState)

  const calculateSelectAllState = useCallback(
    (newSelectedSize: number): SelectionState['selectAllState'] => {
      if (newSelectedSize === 0) return 'none'
      if (newSelectedSize === visibleTaskIds.length) return 'all'
      return 'some'
    },
    [visibleTaskIds.length]
  )

  const selectedIds = controlledSelectedIds ?? internalSelection.selectedIds
  const lastSelectedId = getNextLastSelectedId(selectedIds, internalSelection.lastSelectedId)
  const isSelectionMode =
    controlledSelectedIds !== undefined
      ? controlledSelectedIds.size > 0
      : internalSelection.isSelectionMode
  const selectAllState = calculateSelectAllState(selectedIds.size)
  const selection = useMemo<SelectionState>(
    () => ({
      selectedIds,
      isSelectionMode,
      lastSelectedId,
      selectAllState
    }),
    [selectedIds, isSelectionMode, lastSelectedId, selectAllState]
  )

  // ========== DERIVED STATE ==========

  const selectedCount = selectedIds.size
  const hasSelection = selectedCount > 0
  const allSelected = selectedCount === visibleTaskIds.length && visibleTaskIds.length > 0
  const someSelected = selectedCount > 0 && selectedCount < visibleTaskIds.length
  const selectedTaskIds = useMemo(() => Array.from(selectedIds), [selectedIds])

  const setSelection = useCallback(
    (updater: SelectionState | ((prev: SelectionState) => SelectionState)): void => {
      const nextSelection =
        typeof updater === 'function'
          ? (updater as (prev: SelectionState) => SelectionState)(selection)
          : updater

      if (controlledSelectedIds === undefined) {
        setInternalSelectionState(nextSelection)
      } else {
        setInternalSelectionState((prev) => ({
          ...prev,
          isSelectionMode: nextSelection.isSelectionMode,
          lastSelectedId: nextSelection.lastSelectedId,
          selectAllState: nextSelection.selectAllState
        }))
      }
      onSelectionChange?.(nextSelection.selectedIds)
    },
    [selection, controlledSelectedIds, onSelectionChange]
  )

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
    [calculateSelectAllState, setSelection]
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
    [calculateSelectAllState, setSelection]
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
    [calculateSelectAllState, setSelection]
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
    [visibleTaskIds, calculateSelectAllState, setSelection]
  )

  const selectAll = useCallback((): void => {
    if (visibleTaskIds.length === 0) return

    setSelection({
      selectedIds: new Set(visibleTaskIds),
      isSelectionMode: true,
      lastSelectedId: visibleTaskIds[visibleTaskIds.length - 1] || null,
      selectAllState: 'all'
    })
  }, [visibleTaskIds, setSelection])

  const deselectAll = useCallback((): void => {
    setSelection(initialSelectionState)
  }, [setSelection])

  const toggleSelectAll = useCallback((): void => {
    if (allSelected) {
      deselectAll()
    } else {
      selectAll()
    }
  }, [allSelected, selectAll, deselectAll])

  const isSelected = useCallback(
    (taskId: string): boolean => {
      return selectedIds.has(taskId)
    },
    [selectedIds]
  )

  const enterSelectionMode = useCallback((): void => {
    setSelection((prev) => ({
      ...prev,
      isSelectionMode: true
    }))
  }, [setSelection])

  const exitSelectionMode = useCallback((): void => {
    setSelection(initialSelectionState)
  }, [setSelection])

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
