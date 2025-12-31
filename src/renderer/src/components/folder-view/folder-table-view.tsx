/**
 * Folder Table View Component
 *
 * TanStack Table-based view for displaying notes in a folder.
 * Supports column resizing, sorting, and property display.
 */

import { useMemo, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type CellContext
} from '@tanstack/react-table'
import { useState } from 'react'
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

interface FolderTableViewProps {
  /** Notes to display */
  notes: NoteWithProperties[]
  /** Column configuration */
  columns: ColumnConfig[]
  /** Called when a note is clicked to open it */
  onNoteOpen?: (noteId: string) => void
  /** Called when a folder cell is clicked */
  onFolderClick?: (folderPath: string) => void
  /** Called when a tag is clicked */
  onTagClick?: (tag: string) => void
  /** Called when column config changes (resize, reorder) */
  onColumnsChange?: (columns: ColumnConfig[]) => void
  /** Loading state */
  isLoading?: boolean
  /** Additional CSS classes */
  className?: string
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
 * Table view for folder notes using TanStack Table.
 */
export function FolderTableView({
  notes,
  columns: columnConfig,
  onNoteOpen,
  onFolderClick,
  onTagClick,
  onColumnsChange: _onColumnsChange,
  isLoading,
  className
}: FolderTableViewProps): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([])

  // Memoized cell renderer for title column
  const renderTitleCell = useCallback(
    (info: CellContext<NoteWithProperties, unknown>) => {
      const note = info.row.original
      return (
        <TitleCell title={note.title} emoji={note.emoji} onClick={() => onNoteOpen?.(note.id)} />
      )
    },
    [onNoteOpen]
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
      return <TagsCell tags={note.tags} onTagClick={onTagClick} />
    },
    [onTagClick]
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
      return <PropertyCell value={value} type={type} />
    },
    []
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
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: 'onChange'
  })

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

  return (
    <div className={cn('w-full overflow-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-background border-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className={cn(
                    'px-3 py-2 text-left font-medium text-muted-foreground',
                    'cursor-pointer hover:bg-muted/50 select-none',
                    'relative group'
                  )}
                  style={{ width: header.getSize() }}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  <div className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    <span className="text-muted-foreground/50">
                      {{
                        asc: ' ↑',
                        desc: ' ↓'
                      }[header.column.getIsSorted() as string] ?? null}
                    </span>
                  </div>
                  {/* Resize handle */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
                      'opacity-0 group-hover:opacity-100 hover:bg-primary/50',
                      header.column.getIsResizing() && 'opacity-100 bg-primary'
                    )}
                  />
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={cn('border-b border-border/50', 'hover:bg-muted/30', 'transition-colors')}
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
