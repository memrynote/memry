/**
 * useInboxSelection Hook
 *
 * Manages selection state for inbox items with support for:
 * - Single item selection/toggle
 * - Range selection (shift-click)
 * - Multi-select (cmd/ctrl-click)
 * - Select all / Deselect all
 * - Keyboard shortcuts integration
 */

import { useState, useCallback, useMemo, useEffect } from 'react'

// =============================================================================
// TYPES
// =============================================================================

export interface SelectionState {
  /** Set of currently selected item IDs */
  selectedIds: Set<string>
  /** Last selected item ID for shift-click range selection */
  lastSelectedId: string | null
}

export interface UseInboxSelectionOptions {
  /** Callback when selection changes */
  onSelectionChange?: (selectedIds: Set<string>) => void
  /** Whether to preserve selection when items change */
  preserveOnItemsChange?: boolean
}

export interface UseInboxSelectionReturn {
  /** Set of currently selected item IDs */
  selectedIds: Set<string>
  /** Number of selected items */
  selectedCount: number
  /** Last selected item ID (for range selection) */
  lastSelectedId: string | null
  /** Whether all visible items are selected */
  isAllSelected: boolean
  /** Whether some but not all items are selected */
  isPartiallySelected: boolean
  /** Whether bulk mode is active (any items selected) */
  isInBulkMode: boolean
  /** Check if a specific item is selected */
  isSelected: (id: string) => boolean
  /** Toggle selection for a single item */
  toggleSelection: (id: string) => void
  /** Handle item click with modifier key support */
  handleItemClick: (
    id: string,
    event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }
  ) => void
  /** Select a range of items (shift-click) */
  selectRange: (fromId: string, toId: string) => void
  /** Select all visible items */
  selectAll: () => void
  /** Deselect all items */
  deselectAll: () => void
  /** Clear selection (alias for deselectAll) */
  clearSelection: () => void
  /** Set selection to specific IDs */
  setSelection: (ids: Set<string> | string[]) => void
  /** Add items to selection */
  addToSelection: (ids: string[]) => void
  /** Remove items from selection */
  removeFromSelection: (ids: string[]) => void
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useInboxSelection<T extends { id: string }>(
  items: T[],
  options: UseInboxSelectionOptions = {}
): UseInboxSelectionReturn {
  const { onSelectionChange, preserveOnItemsChange = true } = options

  // Selection state
  const [state, setState] = useState<SelectionState>({
    selectedIds: new Set<string>(),
    lastSelectedId: null,
  })

  // Create a Set of valid item IDs for validation
  const validItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items])

  // Clean up stale selections when items change
  useEffect(() => {
    if (!preserveOnItemsChange) {
      setState({ selectedIds: new Set(), lastSelectedId: null })
      return
    }

    // Remove selections for items that no longer exist
    setState((prev) => {
      const validatedIds = new Set(
        Array.from(prev.selectedIds).filter((id) => validItemIds.has(id))
      )

      // If nothing changed, keep the same reference
      if (validatedIds.size === prev.selectedIds.size) {
        return prev
      }

      return {
        ...prev,
        selectedIds: validatedIds,
        lastSelectedId:
          prev.lastSelectedId && validItemIds.has(prev.lastSelectedId)
            ? prev.lastSelectedId
            : null,
      }
    })
  }, [validItemIds, preserveOnItemsChange])

  // Notify on selection changes
  useEffect(() => {
    onSelectionChange?.(state.selectedIds)
  }, [state.selectedIds, onSelectionChange])

  // Derived values
  const selectedCount = state.selectedIds.size
  const isAllSelected = items.length > 0 && selectedCount === items.length
  const isPartiallySelected = selectedCount > 0 && selectedCount < items.length
  const isInBulkMode = selectedCount > 0

  // Check if item is selected
  const isSelected = useCallback(
    (id: string): boolean => state.selectedIds.has(id),
    [state.selectedIds]
  )

  // Toggle single item selection
  const toggleSelection = useCallback((id: string) => {
    setState((prev) => {
      const newSelectedIds = new Set(prev.selectedIds)
      if (newSelectedIds.has(id)) {
        newSelectedIds.delete(id)
      } else {
        newSelectedIds.add(id)
      }
      return {
        selectedIds: newSelectedIds,
        lastSelectedId: id,
      }
    })
  }, [])

  // Select range of items (for shift-click)
  const selectRange = useCallback(
    (fromId: string, toId: string) => {
      const fromIndex = items.findIndex((item) => item.id === fromId)
      const toIndex = items.findIndex((item) => item.id === toId)

      if (fromIndex === -1 || toIndex === -1) return

      const start = Math.min(fromIndex, toIndex)
      const end = Math.max(fromIndex, toIndex)

      const rangeIds = items.slice(start, end + 1).map((item) => item.id)

      setState((prev) => ({
        selectedIds: new Set([...prev.selectedIds, ...rangeIds]),
        lastSelectedId: toId,
      }))
    },
    [items]
  )

  // Handle item click with modifier support
  const handleItemClick = useCallback(
    (
      id: string,
      event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }
    ) => {
      const { shiftKey, metaKey, ctrlKey } = event

      // Shift+click: range selection from last selected item
      if (shiftKey) {
        if (state.lastSelectedId && state.lastSelectedId !== id) {
          // We have an anchor point - select the range
          selectRange(state.lastSelectedId, id)
        } else {
          // No anchor or same item - just select this item as the new anchor
          setState((prev) => ({
            selectedIds: new Set([...prev.selectedIds, id]),
            lastSelectedId: id,
          }))
        }
        return
      }

      // Cmd/Ctrl+click: toggle without affecting others
      if (metaKey || ctrlKey) {
        toggleSelection(id)
        return
      }

      // Plain click: toggle selection
      toggleSelection(id)
    },
    [state.lastSelectedId, selectRange, toggleSelection]
  )

  // Select all items
  const selectAll = useCallback(() => {
    const allIds = new Set(items.map((item) => item.id))
    setState((prev) => ({
      ...prev,
      selectedIds: allIds,
    }))
  }, [items])

  // Deselect all items
  const deselectAll = useCallback(() => {
    setState({
      selectedIds: new Set(),
      lastSelectedId: null,
    })
  }, [])

  // Clear selection (alias)
  const clearSelection = deselectAll

  // Set selection to specific IDs
  const setSelection = useCallback(
    (ids: Set<string> | string[]) => {
      const newIds = ids instanceof Set ? ids : new Set(ids)
      // Validate against current items
      const validIds = new Set(
        Array.from(newIds).filter((id) => validItemIds.has(id))
      )
      setState((prev) => ({
        ...prev,
        selectedIds: validIds,
      }))
    },
    [validItemIds]
  )

  // Add items to selection
  const addToSelection = useCallback((ids: string[]) => {
    setState((prev) => ({
      selectedIds: new Set([...prev.selectedIds, ...ids]),
      // Update lastSelectedId to the last item added (for range selection)
      lastSelectedId: ids.length > 0 ? ids[ids.length - 1] : prev.lastSelectedId,
    }))
  }, [])

  // Remove items from selection
  const removeFromSelection = useCallback((ids: string[]) => {
    setState((prev) => {
      const newSelectedIds = new Set(prev.selectedIds)
      ids.forEach((id) => newSelectedIds.delete(id))
      return {
        ...prev,
        selectedIds: newSelectedIds,
      }
    })
  }, [])

  return {
    selectedIds: state.selectedIds,
    selectedCount,
    lastSelectedId: state.lastSelectedId,
    isAllSelected,
    isPartiallySelected,
    isInBulkMode,
    isSelected,
    toggleSelection,
    handleItemClick,
    selectRange,
    selectAll,
    deselectAll,
    clearSelection,
    setSelection,
    addToSelection,
    removeFromSelection,
  }
}

// =============================================================================
// KEYBOARD SHORTCUTS HOOK
// =============================================================================

export interface UseSelectionKeyboardOptions {
  /** Currently focused item ID */
  focusedId: string | null
  /** Toggle selection for focused item */
  toggleSelection: (id: string) => void
  /** Select all items */
  selectAll: () => void
  /** Deselect all items */
  deselectAll: () => void
  /** Whether selection shortcuts are enabled */
  enabled?: boolean
}

/**
 * Hook to add keyboard shortcuts for selection operations
 */
export function useSelectionKeyboard({
  focusedId,
  toggleSelection,
  selectAll,
  deselectAll,
  enabled = true,
}: UseSelectionKeyboardOptions): void {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if in an input
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modKey = isMac ? e.metaKey : e.ctrlKey

      switch (e.key.toLowerCase()) {
        // 'x' - Toggle selection on focused item
        case 'x':
          if (!modKey && !e.shiftKey && focusedId) {
            e.preventDefault()
            toggleSelection(focusedId)
          }
          break

        // Cmd/Ctrl + A - Select all
        case 'a':
          if (modKey && !e.shiftKey) {
            e.preventDefault()
            selectAll()
          }
          // Cmd/Ctrl + Shift + A - Deselect all
          else if (modKey && e.shiftKey) {
            e.preventDefault()
            deselectAll()
          }
          break

        // Escape - Clear selection
        case 'escape':
          e.preventDefault()
          deselectAll()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, focusedId, toggleSelection, selectAll, deselectAll])
}
