/**
 * Sortable Column Header Component
 *
 * A table header cell (<th>) with drag-to-reorder functionality.
 * Uses @dnd-kit for drag-and-drop support.
 *
 * IMPORTANT: This renders a <th> element directly (not wrapped in a div)
 * to maintain proper table structure.
 */

import { useState, useRef, useCallback } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import type { Header } from '@tanstack/react-table'
import type { NoteWithProperties, ColumnConfig } from '@memry/contracts/folder-view-api'
import { GripVertical, type AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getColumnLabel } from '@/lib/contract-display-names'
import { useT } from '@memry/i18n/renderer'

interface SortableColumnHeaderProps {
  /** TanStack Table header object */
  header: Header<NoteWithProperties, unknown>
  /** Column configuration from view config */
  columnConfig: ColumnConfig
  /** Optional icon for the column */
  icon?: AppIcon
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
  /** Display density (comfortable/compact) - T099 */
  density?: 'comfortable' | 'compact'
  /** Show borders between columns - T099 */
  showColumnBorders?: boolean
  /** Whether this is the last column (no border on right) - T099 */
  isLastColumn?: boolean
}

/**
 * Sortable table header cell with dnd-kit integration.
 * Renders a <th> element directly to maintain proper table structure.
 */
export function SortableColumnHeader({
  header,
  columnConfig,
  icon: Icon,
  sortIndex,
  totalSortedColumns = 0,
  onWidthChange,
  onDisplayNameChange,
  isHighlighted = false,
  density = 'comfortable',
  showColumnBorders = true,
  isLastColumn = false
}: SortableColumnHeaderProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  // Sortable hook
  const { attributes, listeners, setNodeRef, transition, isDragging, isOver } = useSortable({
    id: columnConfig.id,
    data: {
      type: 'column',
      columnConfig
    }
  })

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
  const sortDirection = column.getIsSorted()
  const canSort = column.getCanSort()

  // Display name
  const displayName = columnConfig.displayName || getColumnLabel(columnId)

  // Styles for the header cell
  // NOTE: We intentionally do NOT apply CSS transforms to table cells
  // as it breaks table layout. Instead, we use opacity for visual feedback.
  // For the last column, use minWidth + flex:1 so it expands to fill remaining space
  const style: React.CSSProperties = isLastColumn
    ? {
        minWidth: header.getSize(),
        flex: 1,
        transition: transition || undefined
      }
    : {
        width: header.getSize(),
        // Only apply transition for smooth width changes during resize
        transition: transition || undefined
      }

  // ============================================================================
  // Sort Handling
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
      column.toggleSorting(undefined, true)
    },
    [column, canSort, isEditing]
  )

  // ============================================================================
  // Resize Handling
  // ============================================================================

  const handleResizeStart = useCallback(() => {
    isResizingRef.current = true
    resizeStartWidthRef.current = column.getSize()
  }, [column])

  const handleResizeEnd = useCallback(() => {
    if (isResizingRef.current) {
      isResizingRef.current = false
      const newWidth = column.getSize()
      if (newWidth !== resizeStartWidthRef.current && onWidthChange) {
        onWidthChange(columnId, newWidth)
      }
    }
  }, [column, columnId, onWidthChange])

  const handleResize = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      event.stopPropagation()
      handleResizeStart()

      const tanstackHandler = header.getResizeHandler()
      tanstackHandler(event)

      const handleEnd = () => {
        handleResizeEnd()
        document.removeEventListener('mouseup', handleEnd)
        document.removeEventListener('touchend', handleEnd)
      }

      document.addEventListener('mouseup', handleEnd)
      document.addEventListener('touchend', handleEnd, { passive: true })
    },
    [header, handleResizeStart, handleResizeEnd]
  )

  // ============================================================================
  // Display Name Editing
  // ============================================================================

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      event.preventDefault()
      setEditValue(displayName)
      setIsEditing(true)
    },
    [displayName]
  )

  const saveDisplayName = useCallback(() => {
    const trimmedValue = editValue.trim()
    setIsEditing(false)
    if (trimmedValue && trimmedValue !== displayName && onDisplayNameChange) {
      onDisplayNameChange(columnId, trimmedValue)
    }
  }, [editValue, displayName, columnId, onDisplayNameChange])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setEditValue('')
  }, [])

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

  const handleBlur = useCallback(() => {
    saveDisplayName()
  }, [saveDisplayName])

  // ============================================================================
  // Render
  // ============================================================================

  const renderSortIndicator = () => {
    if (!sortDirection) return null
    const arrow = sortDirection === 'asc' ? '▲' : '▼'
    const showIndex = totalSortedColumns > 1 && sortIndex !== undefined
    return (
      <span className="ms-1 text-muted-foreground/70 whitespace-nowrap">
        {arrow}
        {showIndex && <sup className="text-[10px] ms-0.5">{sortIndex}</sup>}
      </span>
    )
  }

  return (
    <th
      ref={setNodeRef}
      style={style}
      className={cn(
        // T099: Density-aware padding
        density === 'compact' ? 'px-2 py-1' : 'px-3 py-2',
        'text-start text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground/80',
        'select-none relative group',
        canSort && !isEditing && 'cursor-pointer hover:bg-muted/50',
        header.column.getIsResizing() && 'bg-muted/30',
        isHighlighted && 'bg-primary/10 text-primary',
        isDragging && 'opacity-50 z-50',
        // T099: Column borders (not on last column)
        showColumnBorders && !isLastColumn && 'border-e border-border/30',
        // Drop indicator - accent line on the leading edge
        isOver &&
          'before:absolute before:start-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-primary before:rounded-full before:z-20'
      )}
      onClick={handleSortClick}
    >
      <div className="flex items-center gap-1 min-w-0">
        {/* Drag handle - visible on hover */}
        <div
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
            }
          }}
          className={cn(
            'flex-shrink-0 cursor-grab active:cursor-grabbing',
            'opacity-0 group-hover:opacity-100 transition-opacity',
            'text-muted-foreground/50 hover:text-muted-foreground',
            '-ms-1 me-0.5'
          )}
          aria-label={`Drag to reorder column: ${columnConfig.displayName ?? columnConfig.id}`}
          title={tPhaseF('phaseF.componentsFolderViewSortableColumnHeader.dragToReorderColumn')}
        >
          <GripVertical className="h-4 w-4" />
        </div>

        {Icon && (
          <Icon className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" aria-hidden />
        )}

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={editValue}
            aria-label={tPhaseF('phaseF.componentsFolderViewSortableColumnHeader.editColumnName')}
            onChange={(e) => setEditValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'flex-1 min-w-0 px-1 py-0.5 -mx-1 -my-0.5',
              'bg-background border border-primary rounded text-sm',
              'focus:outline-none'
            )}
          />
        ) : (
          <span
            className="truncate"
            onDoubleClick={handleDoubleClick}
            title={tPhaseF('folderView.columnHeader.doubleClickToEdit', { name: displayName })}
          >
            {displayName}
          </span>
        )}

        {!isEditing && renderSortIndicator()}
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        onMouseDown={handleResize}
        onTouchStart={handleResize}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            const delta = e.key === 'ArrowLeft' ? -10 : 10
            const newWidth = Math.max(50, column.getSize() + delta)
            onWidthChange?.(columnId, newWidth)
          }
        }}
        aria-label={tPhaseF('phaseF.componentsFolderViewSortableColumnHeader.resizeColumn')}
        className={cn(
          'absolute end-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
          'opacity-0 group-hover:opacity-100 hover:bg-primary/50',
          header.column.getIsResizing() && 'opacity-100 bg-primary'
        )}
      />
    </th>
  )
}

export default SortableColumnHeader
