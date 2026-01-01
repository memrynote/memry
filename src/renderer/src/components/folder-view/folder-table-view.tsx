/**
 * Folder Table View Component
 *
 * TanStack Table-based view for displaying notes in a folder.
 * Supports column resizing, sorting, property display, and keyboard navigation.
 *
 * Phase 17: Keyboard Navigation
 * - Arrow keys: Navigate up/down (with wrap-around)
 * - Enter / Cmd+Enter: Open selected note in new tab
 * - Escape: Clear selection
 * - Cmd/Ctrl+A: Select all rows
 * - Space: Jump to last row
 */

import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type CellContext,
  type FilterFn
} from '@tanstack/react-table'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import type { NoteWithProperties, ColumnConfig } from '@shared/contracts/folder-view-api'
import { cn } from '@/lib/utils'
import {
  TitleCell,
  FolderCell,
  TagsCell,
  DateCell,
  WordCountCell,
  PropertyCell,
  type PropertyType
} from './property-cell'
import { SortableColumnHeader } from './sortable-column-header'

/**
 * Sort order configuration (matches .folder.md format)
 */
export interface OrderConfig {
  property: string
  direction: 'asc' | 'desc'
}

interface FolderTableViewProps {
  /** Notes to display */
  notes: NoteWithProperties[]
  /** Column configuration */
  columns: ColumnConfig[]
  /** Initial sort order from saved config */
  initialSorting?: OrderConfig[]
  /** Global search filter string */
  globalFilter?: string
  /** Query string to highlight in cells */
  highlightQuery?: string
  /** Called when a note is clicked to open it */
  onNoteOpen?: (noteId: string) => void
  /** Called when a folder cell is clicked */
  onFolderClick?: (folderPath: string) => void
  /** Called when a tag is clicked */
  onTagClick?: (tag: string) => void
  /** Called when column config changes (resize, reorder) */
  onColumnsChange?: (columns: ColumnConfig[]) => void
  /** Called when display name changes for a column */
  onDisplayNameChange?: (columnId: string, displayName: string) => void
  /** Called when sort order changes */
  onSortingChange?: (sorting: OrderConfig[]) => void
  /** Called when selection changes (for bulk operations) */
  onSelectionChange?: (selectedIds: Set<string>) => void
  /** Column IDs to highlight (from column selector search) */
  highlightedColumns?: string[]
  /** Loading state */
  isLoading?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Custom global filter function that searches across all visible columns.
 * Case-insensitive substring matching.
 */
const globalFilterFn: FilterFn<NoteWithProperties> = (row, columnId, filterValue) => {
  const value = row.getValue(columnId)
  if (value === null || value === undefined) return false

  const searchValue = String(filterValue).toLowerCase()

  // Handle arrays (tags)
  if (Array.isArray(value)) {
    return value.some((item) => String(item).toLowerCase().includes(searchValue))
  }

  return String(value).toLowerCase().includes(searchValue)
}

/**
 * Map column ID to property type for cell rendering
 */
function getColumnType(columnId: string): PropertyType {
  switch (columnId) {
    case 'created':
    case 'modified':
      return 'date'
    case 'wordCount':
      return 'number'
    case 'tags':
      return 'multiselect'
    default:
      return 'text'
  }
}

/**
 * Convert OrderConfig[] (from .folder.md) to TanStack SortingState
 */
function orderConfigToSortingState(order?: OrderConfig[]): SortingState {
  if (!order || order.length === 0) {
    return []
  }
  return order.map((o) => ({
    id: o.property,
    desc: o.direction === 'desc'
  }))
}

/**
 * Convert TanStack SortingState to OrderConfig[] (for .folder.md)
 */
function sortingStateToOrderConfig(sorting: SortingState): OrderConfig[] {
  return sorting.map((s) => ({
    property: s.id,
    direction: s.desc ? 'desc' : 'asc'
  }))
}

/**
 * Table view for folder notes using TanStack Table.
 */
export function FolderTableView({
  notes,
  columns: columnConfig,
  initialSorting,
  globalFilter,
  highlightQuery,
  onNoteOpen,
  onFolderClick,
  onTagClick,
  onColumnsChange,
  onDisplayNameChange,
  onSortingChange,
  onSelectionChange,
  highlightedColumns = [],
  isLoading,
  className
}: FolderTableViewProps): React.JSX.Element {
  // Convert initial sorting from OrderConfig[] to SortingState
  const [sorting, setSorting] = useState<SortingState>(() =>
    orderConfigToSortingState(initialSorting)
  )

  // ============================================================================
  // Keyboard Navigation State (Phase 17)
  // ============================================================================

  /** Currently focused row for keyboard navigation */
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)

  /** Selected rows for bulk operations (Cmd/Ctrl+A) */
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())

  /** Ref to table container for focus management */
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // Create a map of column configs for quick lookup
  const columnConfigMap = useMemo(() => {
    const map = new Map<string, ColumnConfig>()
    columnConfig.forEach((col) => map.set(col.id, col))
    return map
  }, [columnConfig])

  // Handle column width change from ColumnHeader
  const handleWidthChange = useCallback(
    (columnId: string, width: number) => {
      if (!onColumnsChange) return

      const updatedColumns = columnConfig.map((col) =>
        col.id === columnId ? { ...col, width } : col
      )
      onColumnsChange(updatedColumns)
    },
    [columnConfig, onColumnsChange]
  )

  // Keep a stable ref to onSortingChange to avoid effect re-runs
  const onSortingChangeRef = useRef(onSortingChange)
  onSortingChangeRef.current = onSortingChange

  // Track if this is the initial render (skip notifying parent on mount)
  const isInitialMount = useRef(true)

  // Notify parent when sorting changes (after render, not during)
  useEffect(() => {
    // Skip the initial mount - we don't want to notify on first render
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }

    console.log('[FolderTableView] Sorting changed:', sorting)

    if (onSortingChangeRef.current) {
      onSortingChangeRef.current(sortingStateToOrderConfig(sorting))
    }
  }, [sorting]) // Only depend on sorting, not onSortingChange

  // Handle sorting change - just update local state, useEffect handles parent notification
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      setSorting(updater)
    },
    []
  )

  // Memoized cell renderer for title column
  const renderTitleCell = useCallback(
    (info: CellContext<NoteWithProperties, unknown>) => {
      const note = info.row.original
      return (
        <TitleCell
          title={note.title}
          emoji={note.emoji}
          onClick={() => onNoteOpen?.(note.id)}
          highlightQuery={highlightQuery}
        />
      )
    },
    [onNoteOpen, highlightQuery]
  )

  // Memoized cell renderer for folder column
  const renderFolderCell = useCallback(
    (info: CellContext<NoteWithProperties, unknown>) => {
      const note = info.row.original
      return (
        <FolderCell
          path={note.folder}
          onClick={() => {
            if (note.folder && note.folder !== '/') {
              onFolderClick?.(note.folder)
            }
          }}
        />
      )
    },
    [onFolderClick]
  )

  // Memoized cell renderer for tags column
  const renderTagsCell = useCallback(
    (info: CellContext<NoteWithProperties, unknown>) => {
      const note = info.row.original
      return <TagsCell tags={note.tags} onTagClick={onTagClick} highlightQuery={highlightQuery} />
    },
    [onTagClick, highlightQuery]
  )

  // Memoized cell renderer for date columns
  const renderDateCell = useCallback((info: CellContext<NoteWithProperties, unknown>) => {
    const value = info.getValue()
    if (!value) return <span className="text-muted-foreground/50">—</span>
    return <DateCell value={String(value)} />
  }, [])

  // Memoized cell renderer for word count column
  const renderWordCountCell = useCallback((info: CellContext<NoteWithProperties, unknown>) => {
    const value = info.getValue()
    if (typeof value !== 'number') return <span className="text-muted-foreground/50">—</span>
    return <WordCountCell value={value} />
  }, [])

  // Memoized cell renderer for generic properties
  const renderPropertyCell = useCallback(
    (columnId: string) => (info: CellContext<NoteWithProperties, unknown>) => {
      const value = info.getValue()
      const type = getColumnType(columnId)
      return <PropertyCell value={value} type={type} highlightQuery={highlightQuery} />
    },
    [highlightQuery]
  )

  // Get properties used in sorting that aren't in visible columns
  const sortOnlyColumns = useMemo(() => {
    const visibleIds = new Set(columnConfig.map((c) => c.id))
    const sortIds = (initialSorting || []).map((s) => s.property)
    return sortIds.filter((id) => !visibleIds.has(id))
  }, [columnConfig, initialSorting])

  // Build TanStack column definitions from config
  const columns = useMemo<ColumnDef<NoteWithProperties>[]>(() => {
    // Helper to create accessor for built-in properties
    const getBuiltInAccessor = (id: string) => {
      switch (id) {
        case 'title':
          return (row: NoteWithProperties) => row.title
        case 'folder':
          return (row: NoteWithProperties) => row.folder
        case 'tags':
          return (row: NoteWithProperties) => row.tags.join(', ')
        case 'created':
          return (row: NoteWithProperties) => row.created
        case 'modified':
          return (row: NoteWithProperties) => row.modified
        case 'wordCount':
          return (row: NoteWithProperties) => row.wordCount
        default:
          return (row: NoteWithProperties) => row.properties[id] ?? ''
      }
    }

    // Build visible columns
    const visibleColumns = columnConfig.map((col) => {
      const baseColumn = {
        id: col.id,
        header: col.displayName ?? capitalizeFirst(col.id),
        size: col.width ?? 150,
        minSize: 50,
        maxSize: 800
      }

      // Built-in columns with specialized renderers
      switch (col.id) {
        case 'title':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.title,
            cell: renderTitleCell,
            size: col.width ?? 250
          }

        case 'folder':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.folder,
            cell: renderFolderCell,
            size: col.width ?? 120
          }

        case 'tags':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.tags.join(', '),
            cell: renderTagsCell,
            size: col.width ?? 150
          }

        case 'created':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.created,
            cell: renderDateCell,
            size: col.width ?? 130
          }

        case 'modified':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.modified,
            cell: renderDateCell,
            size: col.width ?? 130
          }

        case 'wordCount':
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.wordCount,
            cell: renderWordCountCell,
            size: col.width ?? 80
          }

        default:
          // Custom property column
          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.properties[col.id] ?? '',
            cell: renderPropertyCell(col.id)
          }
      }
    })

    // Add hidden accessor-only columns for sorting by non-visible properties
    const hiddenSortColumns: ColumnDef<NoteWithProperties>[] = sortOnlyColumns.map((id) => ({
      id,
      accessorFn: getBuiltInAccessor(id),
      // These columns won't be rendered, just used for sorting
      enableHiding: true
    }))

    return [...visibleColumns, ...hiddenSortColumns]
  }, [
    columnConfig,
    sortOnlyColumns,
    renderTitleCell,
    renderFolderCell,
    renderTagsCell,
    renderDateCell,
    renderWordCountCell,
    renderPropertyCell
  ])

  // Create column visibility state - hide sort-only columns
  const columnVisibility = useMemo(() => {
    const visibility: Record<string, boolean> = {}
    for (const id of sortOnlyColumns) {
      visibility[id] = false
    }
    return visibility
  }, [sortOnlyColumns])

  const table = useReactTable({
    data: notes,
    columns,
    state: {
      sorting,
      globalFilter: globalFilter ?? '',
      columnVisibility
    },
    onSortingChange: handleSortingChange,
    globalFilterFn: globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange'
  })

  // ============================================================================
  // Drag and Drop for Column Reordering
  // ============================================================================

  // Configure sensors for drag detection
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5 // Require 5px movement before drag starts
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  // Get column IDs for SortableContext
  const columnIds = useMemo(() => columnConfig.map((col) => col.id), [columnConfig])

  /**
   * Handle drag end - reorder columns and persist
   */
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      if (!over || active.id === over.id) {
        return
      }

      const oldIndex = columnConfig.findIndex((col) => col.id === active.id)
      const newIndex = columnConfig.findIndex((col) => col.id === over.id)

      if (oldIndex === -1 || newIndex === -1) {
        return
      }

      // Reorder columns using arrayMove
      const newColumns = arrayMove(columnConfig, oldIndex, newIndex)

      // Persist the new order
      if (onColumnsChange) {
        onColumnsChange(newColumns)
      }
    },
    [columnConfig, onColumnsChange]
  )

  // Get sorted columns count for multi-sort display
  const sortedColumnsCount = sorting.length

  // Get sort index for a column (1-based)
  const getSortIndex = useCallback(
    (columnId: string): number | undefined => {
      const index = sorting.findIndex((s) => s.id === columnId)
      return index >= 0 ? index + 1 : undefined
    },
    [sorting]
  )

  // ============================================================================
  // Keyboard Navigation (Phase 17)
  // ============================================================================

  /**
   * Handle row selection (single click on row, not on interactive cells)
   */
  const handleRowClick = useCallback(
    (rowId: string, event: React.MouseEvent) => {
      // Don't handle if clicking on interactive elements (buttons, links)
      const target = event.target as HTMLElement
      if (target.closest('button, a, [role="button"]')) {
        return
      }

      setFocusedRowId(rowId)
      setSelectedRowIds(new Set([rowId]))
      onSelectionChange?.(new Set([rowId]))
    },
    [onSelectionChange]
  )

  /**
   * Keyboard event handler for table navigation
   * - ArrowDown/ArrowUp: Navigate rows (with wrap-around)
   * - Enter/Cmd+Enter: Open selected note
   * - Escape: Clear selection
   * - Cmd/Ctrl+A: Select all rows
   * - Space: Jump to last row
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const rows = table.getRowModel().rows
      if (rows.length === 0) return

      const currentIndex = focusedRowId ? rows.findIndex((r) => r.original.id === focusedRowId) : -1

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          // Wrap around: if at last row or no selection, go to first
          let nextIndex: number
          if (currentIndex === -1 || currentIndex >= rows.length - 1) {
            nextIndex = 0
          } else {
            nextIndex = currentIndex + 1
          }
          const nextRow = rows[nextIndex]
          setFocusedRowId(nextRow.original.id)
          setSelectedRowIds(new Set([nextRow.original.id]))
          onSelectionChange?.(new Set([nextRow.original.id]))
          break
        }

        case 'ArrowUp': {
          e.preventDefault()
          // Wrap around: if at first row or no selection, go to last
          let prevIndex: number
          if (currentIndex === -1 || currentIndex <= 0) {
            prevIndex = rows.length - 1
          } else {
            prevIndex = currentIndex - 1
          }
          const prevRow = rows[prevIndex]
          setFocusedRowId(prevRow.original.id)
          setSelectedRowIds(new Set([prevRow.original.id]))
          onSelectionChange?.(new Set([prevRow.original.id]))
          break
        }

        case ' ': {
          // Space: Jump to last row
          e.preventDefault()
          const lastRow = rows[rows.length - 1]
          setFocusedRowId(lastRow.original.id)
          setSelectedRowIds(new Set([lastRow.original.id]))
          onSelectionChange?.(new Set([lastRow.original.id]))
          break
        }

        case 'Enter': {
          // Enter or Cmd/Ctrl+Enter: Open selected note
          if (focusedRowId) {
            e.preventDefault()
            onNoteOpen?.(focusedRowId)
          }
          break
        }

        case 'Escape': {
          // Clear selection
          e.preventDefault()
          setFocusedRowId(null)
          setSelectedRowIds(new Set())
          onSelectionChange?.(new Set())
          break
        }

        case 'a': {
          // Cmd/Ctrl+A: Select all rows
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            const allIds = new Set(rows.map((r) => r.original.id))
            setSelectedRowIds(allIds)
            onSelectionChange?.(allIds)
            // Keep focus on current row, or set to first if none
            if (!focusedRowId && rows.length > 0) {
              setFocusedRowId(rows[0].original.id)
            }
          }
          break
        }
      }
    },
    [focusedRowId, table, onNoteOpen, onSelectionChange]
  )

  /**
   * Scroll focused row into view when it changes
   */
  useEffect(() => {
    if (focusedRowId) {
      const rowElement = document.querySelector(`[data-row-id="${focusedRowId}"]`)
      rowElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [focusedRowId])

  /**
   * Clear selection when notes data changes (filter applied, data refreshed)
   */
  useEffect(() => {
    setFocusedRowId(null)
    setSelectedRowIds(new Set())
  }, [notes])

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-64', className)}>
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (notes.length === 0) {
    return (
      <div className={cn('flex items-center justify-center h-64', className)}>
        <div className="text-center">
          <div className="text-muted-foreground mb-2">No notes in this folder</div>
          <p className="text-sm text-muted-foreground/60">Create a new note to get started</p>
        </div>
      </div>
    )
  }

  // Check if global filter resulted in no matches
  const filteredRowCount = table.getFilteredRowModel().rows.length
  if (filteredRowCount === 0 && globalFilter) {
    return (
      <div className={cn('flex items-center justify-center h-64', className)}>
        <div className="text-center">
          <div className="text-muted-foreground mb-2">No notes match "{globalFilter}"</div>
          <p className="text-sm text-muted-foreground/60">Try a different search term</p>
        </div>
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={handleDragEnd}
    >
      {/* Table container with keyboard navigation support */}
      <div
        ref={tableContainerRef}
        className={cn('w-full overflow-auto outline-none', className)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background border-b">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                  {headerGroup.headers.map((header) => {
                    const config = columnConfigMap.get(header.column.id) || {
                      id: header.column.id
                    }
                    return (
                      <SortableColumnHeader
                        key={header.id}
                        header={header}
                        columnConfig={config}
                        sortIndex={getSortIndex(header.column.id)}
                        totalSortedColumns={sortedColumnsCount}
                        onWidthChange={handleWidthChange}
                        onDisplayNameChange={onDisplayNameChange}
                        isHighlighted={highlightedColumns.includes(header.column.id)}
                      />
                    )
                  })}
                </SortableContext>
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const isSelected = selectedRowIds.has(row.original.id)
              const isFocused = focusedRowId === row.original.id

              return (
                <tr
                  key={row.id}
                  data-row-id={row.original.id}
                  className={cn(
                    'border-b border-border/50',
                    'transition-colors',
                    'cursor-pointer',
                    // Hover styling (only when not selected)
                    !isSelected && 'hover:bg-muted/30',
                    // Selected row styling
                    isSelected && 'bg-muted/50',
                    // Focused row styling (keyboard navigation cursor)
                    isFocused && 'ring-2 ring-primary ring-inset'
                  )}
                  onClick={(e) => handleRowClick(row.original.id, e)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-3 py-2"
                      style={{
                        width: cell.column.getSize(),
                        maxWidth: cell.column.getSize()
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </DndContext>
  )
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  if (!str) return str
  // Handle camelCase by adding space before capitals
  const spaced = str.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export default FolderTableView
