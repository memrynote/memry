/**
 * useTaskSelection Hook Tests (T689)
 * Tests for multi-select task functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTaskSelection } from './use-task-selection'

// ============================================================================
// Test Setup
// ============================================================================

describe('useTaskSelection', () => {
  const visibleTaskIds = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5']

  beforeEach(() => {
    // No setup needed - pure state hook
  })

  // ==========================================================================
  // Initial State Tests
  // ==========================================================================

  describe('initial state', () => {
    it('should start with empty selection', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.selectedCount).toBe(0)
      expect(result.current.hasSelection).toBe(false)
      expect(result.current.selectedTaskIds).toEqual([])
    })

    it('should not be in selection mode initially', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.selection.isSelectionMode).toBe(false)
    })

    it('should have selectAllState as "none" initially', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.selection.selectAllState).toBe('none')
    })
  })

  // ==========================================================================
  // selectTask Tests
  // ==========================================================================

  describe('selectTask', () => {
    it('should add task to selection', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.selectedTaskIds).toContain('task-1')
      expect(result.current.selectedCount).toBe(1)
    })

    it('should enter selection mode when selecting', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.selection.isSelectionMode).toBe(true)
    })

    it('should update lastSelectedId', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-2')
      })

      expect(result.current.selection.lastSelectedId).toBe('task-2')
    })

    it('should set selectAllState to "some" when partially selected', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.selection.selectAllState).toBe('some')
      expect(result.current.someSelected).toBe(true)
    })

    it('should be idempotent - selecting same task twice', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-1')
      })

      expect(result.current.selectedCount).toBe(1)
    })

    it('should allow selecting multiple tasks', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-3')
        result.current.selectTask('task-5')
      })

      expect(result.current.selectedCount).toBe(3)
      expect(result.current.selectedTaskIds).toEqual(
        expect.arrayContaining(['task-1', 'task-3', 'task-5'])
      )
    })
  })

  // ==========================================================================
  // deselectTask Tests
  // ==========================================================================

  describe('deselectTask', () => {
    it('should remove task from selection', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-2')
      })

      act(() => {
        result.current.deselectTask('task-1')
      })

      expect(result.current.selectedTaskIds).not.toContain('task-1')
      expect(result.current.selectedTaskIds).toContain('task-2')
      expect(result.current.selectedCount).toBe(1)
    })

    it('should exit selection mode when last task is deselected', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.selection.isSelectionMode).toBe(true)

      act(() => {
        result.current.deselectTask('task-1')
      })

      expect(result.current.selection.isSelectionMode).toBe(false)
    })

    it('should update selectAllState correctly', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selection.selectAllState).toBe('all')

      act(() => {
        result.current.deselectTask('task-1')
      })

      expect(result.current.selection.selectAllState).toBe('some')
    })

    it('should be safe to deselect non-selected task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.deselectTask('task-1')
      })

      expect(result.current.selectedCount).toBe(0)
    })
  })

  // ==========================================================================
  // toggleTask Tests
  // ==========================================================================

  describe('toggleTask', () => {
    it('should select unselected task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.toggleTask('task-1')
      })

      expect(result.current.isSelected('task-1')).toBe(true)
    })

    it('should deselect selected task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.isSelected('task-1')).toBe(true)

      act(() => {
        result.current.toggleTask('task-1')
      })

      expect(result.current.isSelected('task-1')).toBe(false)
    })

    it('should update lastSelectedId', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.toggleTask('task-3')
      })

      expect(result.current.selection.lastSelectedId).toBe('task-3')
    })

    it('should exit selection mode when toggling off last task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.toggleTask('task-1')
      })

      expect(result.current.selection.isSelectionMode).toBe(true)

      act(() => {
        result.current.toggleTask('task-1')
      })

      expect(result.current.selection.isSelectionMode).toBe(false)
    })
  })

  // ==========================================================================
  // selectRange Tests
  // ==========================================================================

  describe('selectRange', () => {
    it('should select from lastSelectedId to target', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      act(() => {
        result.current.selectRange('task-4')
      })

      // Should select tasks 1, 2, 3, 4
      expect(result.current.selectedTaskIds).toEqual(
        expect.arrayContaining(['task-1', 'task-2', 'task-3', 'task-4'])
      )
      expect(result.current.selectedCount).toBe(4)
    })

    it('should work in reverse direction', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-4')
      })

      act(() => {
        result.current.selectRange('task-1')
      })

      expect(result.current.selectedTaskIds).toEqual(
        expect.arrayContaining(['task-1', 'task-2', 'task-3', 'task-4'])
      )
      expect(result.current.selectedCount).toBe(4)
    })

    it('should just select target when no lastSelectedId', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectRange('task-3')
      })

      expect(result.current.selectedTaskIds).toEqual(['task-3'])
      expect(result.current.selectedCount).toBe(1)
    })

    it('should handle when lastSelectedId is not in visibleTaskIds', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      // Manually set an invalid lastSelectedId by selecting then changing visible IDs
      act(() => {
        result.current.selectTask('task-1')
      })

      // Rerender with different visible IDs
      const { result: result2 } = renderHook(() =>
        useTaskSelection(['other-1', 'other-2', 'other-3'])
      )

      // The old selection state is local to that hook instance
      // New hook should handle range gracefully
      act(() => {
        result2.current.selectRange('other-2')
      })

      expect(result2.current.selectedTaskIds).toContain('other-2')
    })

    it('should update lastSelectedId to target', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectRange('task-3')
      })

      expect(result.current.selection.lastSelectedId).toBe('task-3')
    })

    it('should preserve existing selections outside range', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-5') // Select outside future range
        result.current.selectTask('task-1') // Start of range
        result.current.selectRange('task-2') // Select range 1-2
      })

      // Should have 1, 2, and 5 selected
      expect(result.current.selectedTaskIds).toEqual(
        expect.arrayContaining(['task-1', 'task-2', 'task-5'])
      )
    })
  })

  // ==========================================================================
  // selectAll / deselectAll Tests
  // ==========================================================================

  describe('selectAll', () => {
    it('should select all visible tasks', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selectedCount).toBe(5)
      expect(result.current.allSelected).toBe(true)
      expect(result.current.selection.selectAllState).toBe('all')
    })

    it('should do nothing when no visible tasks', () => {
      const { result } = renderHook(() => useTaskSelection([]))

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selectedCount).toBe(0)
    })

    it('should update lastSelectedId to last visible task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selection.lastSelectedId).toBe('task-5')
    })
  })

  describe('deselectAll', () => {
    it('should clear all selections', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selectedCount).toBe(5)

      act(() => {
        result.current.deselectAll()
      })

      expect(result.current.selectedCount).toBe(0)
      expect(result.current.hasSelection).toBe(false)
    })

    it('should exit selection mode', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      act(() => {
        result.current.deselectAll()
      })

      expect(result.current.selection.isSelectionMode).toBe(false)
    })

    it('should reset selectAllState to "none"', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
        result.current.deselectAll()
      })

      expect(result.current.selection.selectAllState).toBe('none')
    })
  })

  // ==========================================================================
  // toggleSelectAll Tests
  // ==========================================================================

  describe('toggleSelectAll', () => {
    it('should select all when none selected', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.toggleSelectAll()
      })

      expect(result.current.allSelected).toBe(true)
    })

    it('should deselect all when all selected', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectAll()
      })

      act(() => {
        result.current.toggleSelectAll()
      })

      expect(result.current.selectedCount).toBe(0)
    })

    it('should select all when some selected', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-2')
      })

      expect(result.current.someSelected).toBe(true)

      act(() => {
        result.current.toggleSelectAll()
      })

      expect(result.current.allSelected).toBe(true)
    })
  })

  // ==========================================================================
  // isSelected Tests
  // ==========================================================================

  describe('isSelected', () => {
    it('should return true for selected task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-2')
      })

      expect(result.current.isSelected('task-2')).toBe(true)
    })

    it('should return false for unselected task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.isSelected('task-2')).toBe(false)
    })

    it('should return false for non-existent task', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.isSelected('non-existent')).toBe(false)
    })
  })

  // ==========================================================================
  // enterSelectionMode / exitSelectionMode Tests
  // ==========================================================================

  describe('enterSelectionMode', () => {
    it('should enter selection mode without selecting tasks', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.enterSelectionMode()
      })

      expect(result.current.selection.isSelectionMode).toBe(true)
      expect(result.current.selectedCount).toBe(0)
    })
  })

  describe('exitSelectionMode', () => {
    it('should exit selection mode and clear selections', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-2')
      })

      expect(result.current.selection.isSelectionMode).toBe(true)
      expect(result.current.selectedCount).toBe(2)

      act(() => {
        result.current.exitSelectionMode()
      })

      expect(result.current.selection.isSelectionMode).toBe(false)
      expect(result.current.selectedCount).toBe(0)
    })
  })

  // ==========================================================================
  // Derived State Tests
  // ==========================================================================

  describe('derived state', () => {
    it('should compute hasSelection correctly', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.hasSelection).toBe(false)

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.hasSelection).toBe(true)
    })

    it('should compute allSelected correctly', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.allSelected).toBe(false)

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.allSelected).toBe(true)

      act(() => {
        result.current.deselectTask('task-1')
      })

      expect(result.current.allSelected).toBe(false)
    })

    it('should compute someSelected correctly', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      expect(result.current.someSelected).toBe(false)

      act(() => {
        result.current.selectTask('task-1')
      })

      expect(result.current.someSelected).toBe(true)

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.someSelected).toBe(false) // All selected, not some
    })

    it('should return selectedTaskIds as array', () => {
      const { result } = renderHook(() => useTaskSelection(visibleTaskIds))

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-3')
      })

      expect(Array.isArray(result.current.selectedTaskIds)).toBe(true)
      expect(result.current.selectedTaskIds).toHaveLength(2)
    })
  })

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty visibleTaskIds', () => {
      const { result } = renderHook(() => useTaskSelection([]))

      expect(result.current.selectedCount).toBe(0)
      expect(result.current.allSelected).toBe(false)

      act(() => {
        result.current.selectAll()
      })

      expect(result.current.selectedCount).toBe(0)
    })

    it('should handle single task', () => {
      const { result } = renderHook(() => useTaskSelection(['only-task']))

      act(() => {
        result.current.selectTask('only-task')
      })

      expect(result.current.allSelected).toBe(true)
      expect(result.current.someSelected).toBe(false)
    })

    it('should handle visibleTaskIds changes', () => {
      const { result, rerender } = renderHook(({ ids }) => useTaskSelection(ids), {
        initialProps: { ids: visibleTaskIds }
      })

      act(() => {
        result.current.selectTask('task-1')
        result.current.selectTask('task-2')
      })

      expect(result.current.selectedCount).toBe(2)

      // Rerender with different visible IDs
      rerender({ ids: ['task-1', 'task-3', 'task-5'] })

      // Selection state is preserved (even if some IDs are no longer visible)
      // This is by design - selection persists
      expect(result.current.selectedCount).toBe(2)
    })
  })
})
