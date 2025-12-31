/**
 * Folder Table View Component
 *
 * TanStack Table-based view for displaying notes in a folder.
 * Supports column resizing, sorting, and property display.
 */

import { useMemo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table'
import { useState } from 'react'
import type { NoteWithProperties, ColumnConfig } from '@shared/contracts/folder-view-api'
import { cn } from '@/lib/utils'

interface FolderTableViewProps {
  /** Notes to display */
  notes: NoteWithProperties[]
  /** Column configuration */
  columns: ColumnConfig[]
  /** Called when a row is double-clicked */
  onNoteOpen?: (noteId: string) => void
  /** Called when column config changes (resize, reorder) */
  onColumnsChange?: (columns: ColumnConfig[]) => void
  /** Loading state */
  isLoading?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Table view for folder notes using TanStack Table.
 */
export function FolderTableView({
  notes,
  columns: columnConfig,
  onNoteOpen,
  onColumnsChange: _onColumnsChange,
  isLoading,
  className
}: FolderTableViewProps): React.JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([])

  // Build TanStack column definitions from config
  const columns = useMemo<ColumnDef<NoteWithProperties>[]>(() => {
    return columnConfig.map((col) => ({
      id: col.id,
      accessorFn: (row) => {
        // Built-in columns
        switch (col.id) {
          case 'title':
            return row.title
          case 'folder':
            return row.folder
          case 'tags':
            return row.tags.join(', ')
          case 'created':
            return row.created
          case 'modified':
            return row.modified
          case 'wordCount':
            return row.wordCount
          default:
            // Custom property
            return row.properties[col.id] ?? ''
        }
      },
      header: col.displayName ?? col.id,
      size: col.width ?? 150,
      minSize: 50,
      maxSize: 800
    }))
  }, [columnConfig])

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
        <div className="text-muted-foreground">No notes in this folder</div>
      </div>
    )
  }

  return (
    <div className={cn('w-full overflow-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-background border-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer hover:bg-muted/50 select-none"
                  style={{ width: header.getSize() }}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  <div className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{
                      asc: ' ↑',
                      desc: ' ↓'
                    }[header.column.getIsSorted() as string] ?? null}
                  </div>
                  {/* Resize handle */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
                      header.column.getIsResizing() && 'bg-primary'
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
              className="border-b hover:bg-muted/30 cursor-pointer"
              onDoubleClick={() => onNoteOpen?.(row.original.id)}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className="px-3 py-2 truncate"
                  style={{ width: cell.column.getSize() }}
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

export default FolderTableView
