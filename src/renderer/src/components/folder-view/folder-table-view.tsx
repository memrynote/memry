/**
 * Folder Table View Component
 *
 * TanStack Table-based view for displaying notes in a folder.
 * Supports column resizing, sorting, and property display.
 */

import { useMemo, useCallback, useState } from 'react'
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
  highlightedColumns = [],
  isLoading,
  className
}: FolderTableViewProps): React.JSX.Element {
  // Convert initial sorting from OrderConfig[] to SortingState
  const [sorting, setSorting] = useState<SortingState>(() =>
    orderConfigToSortingState(initialSorting)
  )

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

  // Handle sorting change - update local state and notify parent
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      setSorting((oldSorting) => {
        const newSorting = typeof updater === 'function' ? updater(oldSorting) : updater

        // Notify parent of sorting change (for persistence)
        if (onSortingChange) {
          onSortingChange(sortingStateToOrderConfig(newSorting))
        }

        return newSorting
      })
    },
    [onSortingChange]
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

  // Build TanStack column definitions from config
  const columns = useMemo<ColumnDef<NoteWithProperties>[]>(() => {
    return columnConfig.map((col) => {
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
  }, [
    columnConfig,
    renderTitleCell,
    renderFolderCell,
    renderTagsCell,
    renderDateCell,
    renderWordCountCell,
    renderPropertyCell
  ])

  const table = useReactTable({
    data: notes,
    columns,
    state: {
      sorting,
      globalFilter: globalFilter ?? ''
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
      <div className={cn('w-full overflow-auto', className)}>
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
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b border-border/50',
                  'hover:bg-muted/30',
                  'transition-colors'
                )}
                onDoubleClick={() => onNoteOpen?.(row.original.id)}
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
            ))}
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
