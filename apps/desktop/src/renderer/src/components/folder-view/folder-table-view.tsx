/**
 * Folder Table View Component
 *
 * TanStack Table-based view for displaying notes in a folder.
 * Supports column resizing, sorting, property display, keyboard navigation,
 * and row virtualization for performance with large folders.
 *
 * Phase 17: Keyboard Navigation
 * - Arrow keys: Navigate up/down (with wrap-around)
 * - Enter / Cmd+Enter: Open selected note in new tab
 * - Escape: Clear selection
 * - Cmd/Ctrl+A: Select all rows
 * - Space: Jump to last row
 *
 * Phase 19: Row Virtualization
 * - Uses @tanstack/react-virtual for efficient rendering of 1000+ notes
 * - Only renders visible rows + overscan buffer
 * - Supports dynamic row heights with measureElement
 * - Shift+click range selection works across virtualized rows
 */

import { useMemo, useCallback, useState, useRef } from 'react'
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
import { useVirtualizer } from '@tanstack/react-virtual'
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
import {
  AlignLeft,
  Calendar,
  CheckSquare,
  FileText,
  Folder,
  Hash,
  Link,
  List,
  Sigma,
  Star,
  Tag,
  Tags,
  type AppIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { evaluateFormula } from '@/lib/expression-evaluator'
import type {
  NoteWithProperties,
  ColumnConfig,
  SummaryConfig
} from '@memry/contracts/folder-view-api'
import {
  TitleCell,
  FolderCell,
  TagsCell,
  DateCell,
  WordCountCell,
  EditablePropertyCell,
  CheckboxCell,
  NumberCell,
  TextCell,
  type PropertyType
} from './property-cell'
import { SortableColumnHeader } from './sortable-column-header'
import { RowContextMenu } from './row-context-menu'
import { FolderViewEmptyState } from './folder-view-empty-state'
import { SummaryRow } from './summary-row'

/**
 * Sort order configuration (matches .folder.md format)
 */
export interface OrderConfig {
  property: string
  direction: 'asc' | 'desc'
}

const EMPTY_FORMULAS: Record<string, string> = {}
const EMPTY_PROPERTY_TYPES: Record<string, PropertyType> = {}
const EMPTY_HIGHLIGHTED: string[] = []
const EMPTY_SUMMARIES: Record<string, SummaryConfig> = {}

interface FolderTableViewProps {
  /** Notes to display */
  notes: NoteWithProperties[]
  /** Column configuration */
  columns: ColumnConfig[]
  /** Formula definitions (name -> expression) for computed columns */
  formulas?: Record<string, string>
  /** Property types map (columnId -> PropertyType) for correct cell rendering - T116 */
  propertyTypes?: Record<string, PropertyType>
  /** Initial sort order from saved config */
  initialSorting?: OrderConfig[]
  /** Global search filter string */
  globalFilter?: string
  /** Query string to highlight in cells */
  highlightQuery?: string
  /** Selected row IDs (controlled mode - lifted to parent for persistence across views) */
  selectedRowIds?: Set<string>
  /** Called when a note is clicked to open it */
  onNoteOpen?: (noteId: string) => void
  /** Called when a note should be opened in a new tab */
  onOpenInNewTab?: (noteId: string) => void
  /** Called when a folder cell is clicked */
  onFolderClick?: (folderPath: string) => void
  /** Called when a tag is clicked */
  onTagClick?: (tag: string) => void
  /** Called when a tag is removed */
  onTagRemove?: (noteId: string, tag: string) => void
  /** Called when a property value is updated */
  onPropertyUpdate?: (noteId: string, propertyId: string, value: unknown) => void
  /** Called when column config changes (resize, reorder) */
  onColumnsChange?: (columns: ColumnConfig[]) => void
  /** Called when display name changes for a column */
  onDisplayNameChange?: (columnId: string, displayName: string) => void
  /** Called when sort order changes */
  onSortingChange?: (sorting: OrderConfig[]) => void
  /** Called when selection changes (for bulk operations) */
  onSelectionChange?: (selectedIds: Set<string>) => void
  /** Called when note(s) should be deleted */
  onDelete?: (noteIds: string[]) => void
  /** Called when note(s) should be moved to a folder */
  onMoveToFolder?: (noteIds: string[]) => void
  /** Called when user wants to create a new note (from empty state) */
  onCreateNote?: () => void
  /** Called when user wants to clear all search/filters (from no-results state) */
  onClearAll?: () => void
  /** Column IDs to highlight (from column selector search) */
  highlightedColumns?: string[]
  /** Loading state */
  isLoading?: boolean
  /** Display density (comfortable/compact) - T099 */
  density?: 'comfortable' | 'compact'
  /** Show borders between columns - T099 */
  showColumnBorders?: boolean
  /** Whether to show summary footer row - Phase 23 */
  showSummaries?: boolean
  /** Summary configurations per column - Phase 23 */
  summaries?: Record<string, SummaryConfig>
  /** Row IDs that are currently exiting (for T121 animation) */
  exitingRowIds?: Set<string>
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

const PROPERTY_TYPE_ICONS: Record<PropertyType, AppIcon> = {
  text: AlignLeft,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  url: Link,
  rating: Star
}

const BUILT_IN_COLUMN_ICONS: Record<string, AppIcon> = {
  title: FileText,
  folder: Folder,
  tags: Tag,
  created: Calendar,
  modified: Calendar,
  wordCount: Hash
}

function getColumnIcon(
  columnId: string,
  propertyTypes: Record<string, PropertyType>
): AppIcon | undefined {
  const builtInIcon = BUILT_IN_COLUMN_ICONS[columnId]
  if (builtInIcon) return builtInIcon
  if (columnId.startsWith('formula.')) return Sigma
  const type = propertyTypes[columnId] ?? getColumnType(columnId)
  return PROPERTY_TYPE_ICONS[type]
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
  formulas = EMPTY_FORMULAS,
  propertyTypes = EMPTY_PROPERTY_TYPES,
  initialSorting,
  globalFilter,
  highlightQuery,
  selectedRowIds: externalSelectedRowIds,
  onNoteOpen,
  onOpenInNewTab,
  onFolderClick,
  onTagClick,
  onTagRemove,
  onPropertyUpdate,
  onColumnsChange,
  onDisplayNameChange,
  onSortingChange,
  onSelectionChange,
  onDelete,
  onMoveToFolder,
  onCreateNote,
  onClearAll,
  highlightedColumns = EMPTY_HIGHLIGHTED,
  isLoading,
  density = 'comfortable',
  showColumnBorders = true,
  showSummaries = false,
  summaries = EMPTY_SUMMARIES,
  exitingRowIds = new Set<string>(),
  className
}: FolderTableViewProps): React.JSX.Element {
  // Convert initial sorting from OrderConfig[] to SortingState
  const [sorting, setSorting] = useState<SortingState>(() =>
    orderConfigToSortingState(initialSorting)
  )

  // ============================================================================
  // Keyboard Navigation State (Phase 17) & Selection (Phase 19)
  // ============================================================================

  /** Currently focused row for keyboard navigation */
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)

  /**
   * Internal selected rows state (used when not controlled externally).
   * When externalSelectedRowIds is provided, this is ignored and the external state is used.
   * This allows selection to be lifted to the page for persistence across view switches.
   */
  const [internalSelectedRowIds, setInternalSelectedRowIds] = useState<Set<string>>(new Set())

  /**
   * Controlled/uncontrolled selection pattern:
   * - If parent provides selectedRowIds prop, use that (controlled)
   * - Otherwise, use internal state (uncontrolled)
   */
  const selectedRowIds = externalSelectedRowIds ?? internalSelectedRowIds

  // Use refs to avoid recreating setSelectedRowIds on every render
  const selectedRowIdsRef = useRef(selectedRowIds)
  selectedRowIdsRef.current = selectedRowIds

  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  const externalSelectedRowIdsRef = useRef(externalSelectedRowIds)
  externalSelectedRowIdsRef.current = externalSelectedRowIds

  /**
   * Stable setter for selection state.
   * Uses refs to avoid dependency on selectedRowIds which would cause infinite loops.
   */
  const setSelectedRowIds = useCallback(
    (newSelection: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const resolved =
        typeof newSelection === 'function' ? newSelection(selectedRowIdsRef.current) : newSelection

      // Always notify parent if callback provided
      onSelectionChangeRef.current?.(resolved)

      // Only update internal state if not controlled
      if (!externalSelectedRowIdsRef.current) {
        setInternalSelectedRowIds(resolved)
      }
    },
    [] // Stable - no dependencies, uses refs
  )

  /** Ref to table container for focus management and virtualization */
  const tableContainerRef = useRef<HTMLDivElement>(null)

  /** Track last selected row index for Shift+click range selection */
  const lastSelectedIndexRef = useRef<number | null>(null)

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

  // Keep a stable ref to onSortingChange to avoid stale closures
  const onSortingChangeRef = useRef(onSortingChange)
  onSortingChangeRef.current = onSortingChange

  // Handle sorting change and notify parent directly in the handler
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      setSorting((prevSorting) => {
        const newSorting = typeof updater === 'function' ? updater(prevSorting) : updater
        // Notify parent of change directly in the handler, not in useEffect
        onSortingChangeRef.current?.(sortingStateToOrderConfig(newSorting))
        return newSorting
      })
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
      return (
        <TagsCell
          tags={note.tags}
          onTagClick={onTagClick}
          onTagRemove={
            onTagRemove
              ? (tag) => {
                  onTagRemove(note.id, tag)
                }
              : undefined
          }
          highlightQuery={highlightQuery}
        />
      )
    },
    [onTagClick, onTagRemove, highlightQuery]
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
  // T116: Uses propertyTypes map for correct type rendering
  const renderPropertyCell = useCallback(
    (columnId: string) => {
      return (info: CellContext<NoteWithProperties, unknown>): React.JSX.Element => {
        const note = info.row.original
        const value = info.getValue()
        const type = propertyTypes[columnId] ?? getColumnType(columnId)
        return (
          <EditablePropertyCell
            value={value}
            type={type}
            highlightQuery={highlightQuery}
            onSave={
              onPropertyUpdate
                ? (nextValue) => {
                    onPropertyUpdate(note.id, columnId, nextValue)
                  }
                : undefined
            }
          />
        )
      }
    },
    [highlightQuery, onPropertyUpdate, propertyTypes]
  )

  const renderFormulaCell = useCallback(
    (_formulaName: string, expression: string) => {
      return (info: CellContext<NoteWithProperties, unknown>): React.JSX.Element => {
        const note = info.row.original
        const result = evaluateFormula(expression, note)

        if (result === null || result === undefined) {
          return <span className="text-muted-foreground/50">—</span>
        }

        if (typeof result === 'boolean') return <CheckboxCell value={result} />
        if (typeof result === 'number') return <NumberCell value={result} />
        if (result instanceof Date) return <DateCell value={result.toISOString()} />
        if (Array.isArray(result))
          return <TextCell value={result.join(', ')} highlightQuery={highlightQuery} />
        return <TextCell value={String(result)} highlightQuery={highlightQuery} />
      }
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
          // Check if this is a formula column (id starts with "formula.")
          if (col.id.startsWith('formula.')) {
            const formulaName = col.id.slice(8) // Remove "formula." prefix
            const expression = formulas[formulaName]

            if (!expression) {
              // Formula not found - show empty
              return {
                ...baseColumn,
                header: col.displayName ?? formulaName,
                accessorFn: () => null,
                cell: () => <span className="text-muted-foreground/50">—</span>
              }
            }

            return {
              ...baseColumn,
              header: col.displayName ?? formulaName,
              // Accessor evaluates formula for sorting/filtering
              accessorFn: (row: NoteWithProperties) => {
                const result = evaluateFormula(expression, row)
                return result
              },
              cell: renderFormulaCell(formulaName, expression)
            }
          }

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
    formulas,
    sortOnlyColumns,
    renderTitleCell,
    renderFolderCell,
    renderTagsCell,
    renderDateCell,
    renderWordCountCell,
    renderPropertyCell,
    renderFormulaCell
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
  // Row Virtualization (Phase 19)
  // ============================================================================

  /** Get filtered/sorted rows from table for virtualization */
  const { rows } = table.getRowModel()

  /**
   * Row virtualizer for efficient rendering of large datasets.
   * Only renders visible rows plus overscan buffer for smooth scrolling.
   */
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 40, // Estimated row height in px
    // Dynamic row height measurement (disabled in Firefox due to measurement issues)
    measureElement:
      typeof window !== 'undefined' && !navigator.userAgent.includes('Firefox')
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 10 // Render 10 extra rows above/below viewport for smooth scrolling
  })

  /** Get virtual items to render */
  const virtualRows = rowVirtualizer.getVirtualItems()

  /** Total height of all rows (for scroll container sizing) */
  const totalSize = rowVirtualizer.getTotalSize()

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
   * - Single click: Select single row, deselect others
   * - Cmd/Ctrl+click: Toggle selection (multi-select)
   * - Shift+click: Range selection from last selected to current
   */
  const handleRowClick = useCallback(
    (rowIndex: number, rowId: string, event: React.MouseEvent) => {
      // Don't handle if clicking on interactive elements (buttons, links)
      const target = event.target as HTMLElement
      if (target.closest('button, a, [role="button"]')) {
        return
      }

      setFocusedRowId(rowId)

      // Shift+click: Range selection
      if (event.shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, rowIndex)
        const end = Math.max(lastSelectedIndexRef.current, rowIndex)

        // Select all rows in range
        const newSelection = new Set(selectedRowIds)
        for (let i = start; i <= end; i++) {
          if (rows[i]) {
            newSelection.add(rows[i].original.id)
          }
        }
        setSelectedRowIds(newSelection)
        // Note: setSelectedRowIds already calls onSelectionChange internally
        // Don't update lastSelectedIndexRef on shift-click to allow extending range
      } else if (event.metaKey || event.ctrlKey) {
        // Cmd/Ctrl+click: Toggle selection (multi-select)
        setSelectedRowIds((prev) => {
          const newSet = new Set(prev)
          if (newSet.has(rowId)) {
            newSet.delete(rowId)
          } else {
            newSet.add(rowId)
          }
          return newSet
        })
        lastSelectedIndexRef.current = rowIndex
      } else {
        // Single click: Select single row only
        const newSelection = new Set([rowId])
        setSelectedRowIds(newSelection)
        lastSelectedIndexRef.current = rowIndex
      }
    },
    [rows, selectedRowIds, setSelectedRowIds]
  )

  const scrollToRowById = useCallback(
    (rowId: string) => {
      const rowIndex = rows.findIndex((r) => r.original.id === rowId)
      if (rowIndex >= 0) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: 'auto', behavior: 'smooth' })
      }
    },
    [rows, rowVirtualizer]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const rows = table.getRowModel().rows
      if (rows.length === 0) return

      const currentIndex = focusedRowId ? rows.findIndex((r) => r.original.id === focusedRowId) : -1

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          let nextIndex: number
          if (currentIndex === -1) {
            nextIndex = 0
          } else if (currentIndex >= rows.length - 1) {
            if (e.shiftKey) return
            nextIndex = 0
          } else {
            nextIndex = currentIndex + 1
          }

          const nextRow = rows[nextIndex]
          setFocusedRowId(nextRow.original.id)
          scrollToRowById(nextRow.original.id)

          if (e.shiftKey) {
            setSelectedRowIds((prev) => {
              const newSet = new Set(prev)
              newSet.add(nextRow.original.id)
              return newSet
            })
          } else {
            setSelectedRowIds(new Set([nextRow.original.id]))
            lastSelectedIndexRef.current = nextIndex
          }
          break
        }

        case 'ArrowUp': {
          e.preventDefault()
          let prevIndex: number
          if (currentIndex === -1) {
            prevIndex = rows.length - 1
          } else if (currentIndex <= 0) {
            if (e.shiftKey) return
            prevIndex = rows.length - 1
          } else {
            prevIndex = currentIndex - 1
          }

          const prevRow = rows[prevIndex]
          setFocusedRowId(prevRow.original.id)
          scrollToRowById(prevRow.original.id)

          if (e.shiftKey) {
            setSelectedRowIds((prev) => {
              const newSet = new Set(prev)
              newSet.add(prevRow.original.id)
              return newSet
            })
          } else {
            setSelectedRowIds(new Set([prevRow.original.id]))
            lastSelectedIndexRef.current = prevIndex
          }
          break
        }

        case ' ': {
          e.preventDefault()
          const lastRow = rows[rows.length - 1]
          setFocusedRowId(lastRow.original.id)
          scrollToRowById(lastRow.original.id)
          setSelectedRowIds(new Set([lastRow.original.id]))
          lastSelectedIndexRef.current = rows.length - 1
          break
        }

        case 'Enter': {
          if (focusedRowId) {
            e.preventDefault()
            onNoteOpen?.(focusedRowId)
          }
          break
        }

        case 'Escape': {
          e.preventDefault()
          setFocusedRowId(null)
          setSelectedRowIds(new Set())
          lastSelectedIndexRef.current = null
          break
        }

        case 'a': {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault()
            const allIds = new Set(rows.map((r) => r.original.id))
            setSelectedRowIds(allIds)
            if (!focusedRowId && rows.length > 0) {
              setFocusedRowId(rows[0].original.id)
              scrollToRowById(rows[0].original.id)
            }
          }
          break
        }

        case 'm':
        case 'M': {
          if ((e.metaKey || e.ctrlKey) && e.shiftKey && selectedRowIds.size > 0) {
            e.preventDefault()
            onMoveToFolder?.(Array.from(selectedRowIds))
          }
          break
        }
      }
    },
    [
      focusedRowId,
      table,
      onNoteOpen,
      onMoveToFolder,
      selectedRowIds,
      setSelectedRowIds,
      scrollToRowById
    ]
  )

  // Calculate total width of all columns for table min-width
  // (Must be before early returns to satisfy React hook rules)
  const totalColumnsWidth = useMemo(() => {
    return columnConfig.reduce((sum, col) => sum + (col.width ?? 150), 0)
  }, [columnConfig])

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-64', className)}>
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  // Phase 20 (T095): Empty state when folder has no notes
  if (notes.length === 0) {
    return (
      <FolderViewEmptyState
        variant="empty"
        onCreateNote={onCreateNote}
        className={cn('h-full', className)}
      />
    )
  }

  // Phase 20 (T096): Check if global filter or filters resulted in no matches
  const filteredRowCount = table.getFilteredRowModel().rows.length
  if (filteredRowCount === 0 && globalFilter) {
    return (
      <FolderViewEmptyState
        variant="no-results"
        onClearAll={onClearAll}
        className={cn('h-full', className)}
      />
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis]}
      onDragEnd={handleDragEnd}
    >
      {/* Table container with keyboard navigation and virtualization support */}
      {/* max-w-full ensures container stays within parent bounds while overflow-auto enables independent horizontal scroll */}
      <div
        ref={tableContainerRef}
        role="grid"
        aria-label="Notes table"
        className={cn('w-full max-w-full overflow-auto outline-none', className)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {/* Table with CSS Grid layout for virtualization compatibility */}
        {/* Use minWidth to allow horizontal scroll when columns exceed viewport */}
        {/* width: 100% ensures table fills container when columns are narrower than viewport */}
        <table
          style={{
            display: 'grid',
            width: '100%',
            minWidth: Math.max(totalColumnsWidth, 100)
          }}
          className="text-sm"
        >
          {/* Sticky header */}
          <thead
            style={{
              display: 'grid',
              position: 'sticky',
              top: 0,
              zIndex: 10
            }}
            className="bg-background border-b"
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} style={{ display: 'flex', width: '100%' }}>
                <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                  {headerGroup.headers.map((header) => {
                    const config = columnConfigMap.get(header.column.id) || {
                      id: header.column.id
                    }
                    const icon = getColumnIcon(header.column.id, propertyTypes)
                    return (
                      <SortableColumnHeader
                        key={header.id}
                        header={header}
                        columnConfig={config}
                        icon={icon}
                        sortIndex={getSortIndex(header.column.id)}
                        totalSortedColumns={sortedColumnsCount}
                        onWidthChange={handleWidthChange}
                        onDisplayNameChange={onDisplayNameChange}
                        isHighlighted={highlightedColumns.includes(header.column.id)}
                        density={density}
                        showColumnBorders={showColumnBorders}
                        isLastColumn={
                          headerGroup.headers.indexOf(header) === headerGroup.headers.length - 1
                        }
                      />
                    )
                  })}
                </SortableContext>
              </tr>
            ))}
          </thead>

          {/* Virtualized table body */}
          <tbody
            style={{
              display: 'grid',
              height: `${totalSize}px`,
              position: 'relative'
            }}
          >
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index]
              const isSelected = selectedRowIds.has(row.original.id)
              const isFocused = focusedRowId === row.original.id
              const isPartOfSelection = isSelected && selectedRowIds.size > 1
              // T121: Check if this row is currently exiting (being deleted)
              const isExiting = exitingRowIds.has(row.original.id)

              return (
                <RowContextMenu
                  key={row.id}
                  note={row.original}
                  isPartOfSelection={isPartOfSelection}
                  selectedCount={selectedRowIds.size}
                  selectedNoteIds={Array.from(selectedRowIds)}
                  onNoteOpen={onNoteOpen}
                  onOpenInNewTab={onOpenInNewTab}
                  onMoveToFolder={onMoveToFolder}
                  onDelete={onDelete}
                >
                  <tr
                    data-index={virtualRow.index}
                    data-row-id={row.original.id}
                    ref={(node) => rowVirtualizer.measureElement(node)}
                    style={{
                      display: 'flex',
                      width: '100%',
                      position: 'absolute',
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    className={cn(
                      'border-b border-border/50',
                      'transition-colors',
                      'items-center',
                      'cursor-pointer',
                      // Hover styling (only when not selected)
                      !isSelected && 'hover:bg-muted/50',
                      // Selected row styling - thin warm border
                      isSelected && 'border-l-2',
                      // Focused row styling (keyboard navigation cursor)
                      isFocused && 'ring-2x ring-inset',
                      // T121: Exit animation - simple opacity fade
                      isExiting && 'opacity-0 transition-opacity duration-200'
                    )}
                    onClick={(e) => handleRowClick(virtualRow.index, row.original.id, e)}
                    onDoubleClick={() => onNoteOpen?.(row.original.id)}
                  >
                    {row.getVisibleCells().map((cell, cellIndex) => {
                      const isLastCell = cellIndex === row.getVisibleCells().length - 1
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            'flex-shrink-0 overflow-hidden',
                            // T099: Density-aware padding
                            density === 'compact' ? 'px-2 py-1' : 'px-3 py-2',
                            // T099: Column borders (not on last column)
                            showColumnBorders && !isLastCell && 'border-r border-border/30'
                          )}
                          style={
                            isLastCell
                              ? {
                                  minWidth: cell.column.getSize(),
                                  flex: 1
                                }
                              : {
                                  width: cell.column.getSize(),
                                  maxWidth: cell.column.getSize()
                                }
                          }
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })}
                  </tr>
                </RowContextMenu>
              )
            })}
          </tbody>

          {/* Summary Row - Phase 23 */}
          {showSummaries && Object.keys(summaries).length > 0 && (
            <SummaryRow
              columns={columnConfig}
              notes={notes}
              summaries={summaries}
              formulas={formulas}
              density={density}
              showColumnBorders={showColumnBorders}
              columnWidths={Object.fromEntries(
                table.getAllColumns().map((col) => [col.id, col.getSize()])
              )}
            />
          )}
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
