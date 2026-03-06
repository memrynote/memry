/**
 * Column Header Component
 *
 * Interactive column header for folder table view with:
 * - Sorting: Click to toggle (multi-sort enabled by default)
 * - Resize: Drag right edge to resize column
 * - Display name editing: Double-click to edit inline
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import type { Header } from '@tanstack/react-table'
import type { NoteWithProperties, ColumnConfig } from '@memry/contracts/folder-view-api'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

/**
 * Props for drag handle passed from SortableColumnHeader
 */
export interface DragHandleProps {
  /** Drag listeners from useSortable */
  listeners?: Record<string, unknown>
  /** Drag attributes from useSortable */
  attributes?: Record<string, unknown>
}

interface ColumnHeaderProps {
  /** TanStack Table header object */
  header: Header<NoteWithProperties, unknown>
  /** Column configuration from view config */
  columnConfig: ColumnConfig
  /** Sort index for multi-sort (1-based, undefined if not sorted) */
  sortIndex?: number
  /** Total number of sorted columns (for showing sort index) */
  totalSortedColumns?: number
  /** Called when column width changes (after resize ends) */
  onWidthChange?: (columnId: string, width: number) => void
  /** Called when display name changes */
  onDisplayNameChange?: (columnId: string, displayName: string) => void
  /** Whether this column is highlighted (from column selector search) */
  isHighlighted?: boolean
  /** Props for the drag handle (from SortableColumnHeader) */
  dragHandleProps?: DragHandleProps
  /** Whether the column is currently being dragged */
  isDragging?: boolean
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Capitalize first letter and add spaces before capitals (for camelCase)
 */
function formatColumnName(str: string): string {
  if (!str) return str
  // Handle camelCase by adding space before capitals
  const spaced = str.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ============================================================================
// Component
// ============================================================================

/**
 * Interactive column header with sorting, resize, and inline editing.
 */
export function ColumnHeader({
  header,
  columnConfig,
  sortIndex,
  totalSortedColumns = 0,
  onWidthChange,
  onDisplayNameChange,
  isHighlighted = false,
  dragHandleProps,
  isDragging = false,
  className
}: ColumnHeaderProps): React.JSX.Element {
  // Edit mode state
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Track resize state for persistence
  const isResizingRef = useRef(false)
  const resizeStartWidthRef = useRef(0)

  // Get column info
  const column = header.column
  const columnId = column.id
  const sortDirection = column.getIsSorted() // 'asc' | 'desc' | false
  const canSort = column.getCanSort()

  // Display name: use config displayName, or format the column ID
  const displayName = columnConfig.displayName || formatColumnName(columnId)

  // ============================================================================
  // Sort Handling (T052)
  // ============================================================================

  /**
   * Handle click on header to toggle sort.
   * Always uses multi-sort mode - each click adds/toggles in the sort order.
   * Click cycles: none → asc → desc → none (removes from sort)
   */
  const handleSortClick = useCallback(
    (_event: React.MouseEvent) => {
      if (!canSort || isEditing) return

      // Always use multi-sort mode (second param = true)
      // This allows clicking multiple columns to build up sort order
      column.toggleSorting(undefined, true)
    },
    [column, canSort, isEditing]
  )

  // ============================================================================
  // Resize Handling (T053)
  // ============================================================================

  /**
   * Handle resize start - track initial width
   */
  const handleResizeStart = useCallback(() => {
    isResizingRef.current = true
    resizeStartWidthRef.current = column.getSize()
  }, [column])

  /**
   * Handle resize end - emit width change if changed
   */
  const handleResizeEnd = useCallback(() => {
    if (isResizingRef.current) {
      isResizingRef.current = false
      const newWidth = column.getSize()

      // Only emit if width actually changed
      if (newWidth !== resizeStartWidthRef.current && onWidthChange) {
        onWidthChange(columnId, newWidth)
      }
    }
  }, [column, columnId, onWidthChange])

  /**
   * Custom resize handler that wraps TanStack's handler
   */
  const handleResize = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation()
      handleResizeStart()

      // Get TanStack's resize handler
      const tanstackHandler = header.getResizeHandler()
      tanstackHandler(event)

      // Listen for mouseup/touchend to detect resize end
      const handleEnd = () => {
        handleResizeEnd()
        document.removeEventListener('mouseup', handleEnd)
        document.removeEventListener('touchend', handleEnd)
      }

      document.addEventListener('mouseup', handleEnd)
      document.addEventListener('touchend', handleEnd)
    },
    [header, handleResizeStart, handleResizeEnd]
  )

  // ============================================================================
  // Display Name Editing (T054)
  // ============================================================================

  /**
   * Enter edit mode on double-click
   */
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      event.preventDefault()
      setEditValue(displayName)
      setIsEditing(true)
    },
    [displayName]
  )

  /**
   * Save the edited display name
   */
  const saveDisplayName = useCallback(() => {
    const trimmedValue = editValue.trim()
    setIsEditing(false)

    // Only save if value changed and is not empty
    if (trimmedValue && trimmedValue !== displayName && onDisplayNameChange) {
      onDisplayNameChange(columnId, trimmedValue)
    }
  }, [editValue, displayName, columnId, onDisplayNameChange])

  /**
   * Cancel editing and revert
   */
  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditValue('')
  }, [])

  /**
   * Handle key events in edit input
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        saveDisplayName()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelEdit()
      }
    },
    [saveDisplayName, cancelEdit]
  )

  /**
   * Handle blur on edit input - save changes
   */
  const handleBlur = useCallback(() => {
    saveDisplayName()
  }, [saveDisplayName])

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // ============================================================================
  // Render
  // ============================================================================

  // Sort indicator
  const renderSortIndicator = () => {
    if (!sortDirection) return null

    const arrow = sortDirection === 'asc' ? '▲' : '▼'
    // Show sort index as superscript only when multi-sorting (more than 1 column sorted)
    const showIndex = totalSortedColumns > 1 && sortIndex !== undefined

    return (
      <span className="ml-1 text-muted-foreground/70 whitespace-nowrap">
        {arrow}
        {showIndex && <sup className="text-[10px] ml-0.5">{sortIndex}</sup>}
      </span>
    )
  }

  return (
    <th
      className={cn(
        'px-3 py-2 text-left font-medium text-muted-foreground',
        'select-none relative group',
        canSort && !isEditing && 'cursor-pointer hover:bg-muted/50',
        header.column.getIsResizing() && 'bg-muted/30',
        isHighlighted && 'bg-primary/10 text-primary',
        isDragging && 'opacity-50',
        className
      )}
      style={{ width: header.getSize() }}
      onClick={handleSortClick}
    >
      <div className="flex items-center gap-1 min-w-0">
        {/* Drag handle - visible on hover */}
        {dragHandleProps && (
          <div
            {...(dragHandleProps.listeners as React.HTMLAttributes<HTMLDivElement>)}
            {...(dragHandleProps.attributes as React.HTMLAttributes<HTMLDivElement>)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'flex-shrink-0 cursor-grab active:cursor-grabbing',
              'opacity-0 group-hover:opacity-100 transition-opacity',
              'text-muted-foreground/50 hover:text-muted-foreground',
              '-ml-1 mr-0.5'
            )}
            title="Drag to reorder column"
          >
            <GripVertical className="h-4 w-4" />
          </div>
        )}

        {isEditing ? (
          // Edit mode: inline input
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'flex-1 min-w-0 px-1 py-0.5 -mx-1 -my-0.5',
              'bg-background border border-primary rounded text-sm',
              'focus:outline-none focus:ring-1 focus:ring-primary'
            )}
          />
        ) : (
          // Display mode: column name with double-click to edit
          <span
            className="truncate"
            onDoubleClick={handleDoubleClick}
            title={`${displayName} (double-click to edit)`}
          >
            {displayName}
          </span>
        )}

        {!isEditing && renderSortIndicator()}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResize}
        onTouchStart={handleResize}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
          'opacity-0 group-hover:opacity-100 hover:bg-primary/50',
          header.column.getIsResizing() && 'opacity-100 bg-primary'
        )}
      />
    </th>
  )
}

export default ColumnHeader
