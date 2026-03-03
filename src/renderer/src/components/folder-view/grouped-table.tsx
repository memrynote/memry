/**
 * Grouped Table View Component
 *
 * Extends the folder table view with row grouping capabilities.
 * Supports grouping by any property, collapsible group headers,
 * group counts, and per-group summaries.
 *
 * Phase 24: Group By
 * - T111: Group rows by property value
 * - T111: Collapsible group headers with expand/collapse
 * - T111: Show group count in headers
 * - T114: Per-group summaries (when showSummary is enabled)
 */

import { useMemo, useCallback, useState, useEffect, useRef, memo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getExpandedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type GroupingState,
  type ExpandedState,
  type CellContext,
  type FilterFn,
  type Row
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
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  Hash,
  Link,
  List,
  Sigma,
  Star,
  Tag,
  Tags,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { evaluateFormula } from '@/lib/expression-evaluator'
import {
  getColumnValues,
  computeSummary,
  formatSummaryValue,
  getSummaryTypeSymbol
} from '@/lib/summary-evaluator'
import type {
  NoteWithProperties,
  ColumnConfig,
  SummaryConfig,
  GroupByConfig
} from '@shared/contracts/folder-view-api'
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

// ============================================================================
// Types
// ============================================================================

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

interface GroupedTableProps {
  /** Notes to display */
  notes: NoteWithProperties[]
  /** Column configuration */
  columns: ColumnConfig[]
  /** Formula definitions (name -> expression) for computed columns */
  formulas?: Record<string, string>
  /** Property types map (columnId -> PropertyType) for correct cell rendering - T116 */
  propertyTypes?: Record<string, PropertyType>
  /** Group by configuration */
  groupBy?: GroupByConfig
  /** Initial sort order from saved config */
  initialSorting?: OrderConfig[]
  /** Global search filter string */
  globalFilter?: string
  /** Query string to highlight in cells */
  highlightQuery?: string
  /** Selected row IDs (controlled mode) */
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
  /** Display density (comfortable/compact) */
  density?: 'comfortable' | 'compact'
  /** Show borders between columns */
  showColumnBorders?: boolean
  /** Whether to show summary footer row */
  showSummaries?: boolean
  /** Summary configurations per column */
  summaries?: Record<string, SummaryConfig>
  /** Row IDs that are currently exiting (for T121 animation) */
  exitingRowIds?: Set<string>
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Custom global filter function that searches across all visible columns.
 */
const globalFilterFn: FilterFn<NoteWithProperties> = (row, columnId, filterValue) => {
  const value = row.getValue(columnId)
  if (value === null || value === undefined) return false

  const searchValue = String(filterValue).toLowerCase()

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

const PROPERTY_TYPE_ICONS: Record<PropertyType, LucideIcon> = {
  text: AlignLeft,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  url: Link,
  rating: Star
}

const BUILT_IN_COLUMN_ICONS: Record<string, LucideIcon> = {
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
): LucideIcon | undefined {
  const builtInIcon = BUILT_IN_COLUMN_ICONS[columnId]
  if (builtInIcon) return builtInIcon
  if (columnId.startsWith('formula.')) return Sigma
  const type = propertyTypes[columnId] ?? getColumnType(columnId)
  return PROPERTY_TYPE_ICONS[type]
}

/**
 * Convert OrderConfig[] to TanStack SortingState
 */
function orderConfigToSortingState(order?: OrderConfig[]): SortingState {
  if (!order || order.length === 0) return []
  return order.map((o) => ({
    id: o.property,
    desc: o.direction === 'desc'
  }))
}

/**
 * Convert TanStack SortingState to OrderConfig[]
 */
function sortingStateToOrderConfig(sorting: SortingState): OrderConfig[] {
  return sorting.map((s) => ({
    property: s.id,
    direction: s.desc ? 'desc' : 'asc'
  }))
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str: string): string {
  if (!str) return str
  const spaced = str.replace(/([A-Z])/g, ' $1').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Get display value for a group
 */
function getGroupDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '(Empty)'
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : '(Empty)'
  }
  return String(value)
}

// ============================================================================
// Component
// ============================================================================

/**
 * Grouped table view for folder notes using TanStack Table with grouping.
 */
export function GroupedTable({
  notes,
  columns: columnConfig,
  formulas = EMPTY_FORMULAS,
  propertyTypes = EMPTY_PROPERTY_TYPES,
  groupBy,
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
  showColumnBorders = false,
  showSummaries = false,
  summaries = EMPTY_SUMMARIES,
  exitingRowIds = new Set<string>(),
  className
}: GroupedTableProps): React.JSX.Element {
  // ============================================================================
  // State
  // ============================================================================

  const [sorting, setSorting] = useState<SortingState>(() =>
    orderConfigToSortingState(initialSorting)
  )

  // Grouping state - derived from groupBy prop
  const grouping: GroupingState = useMemo(() => {
    if (!groupBy?.property) return []
    return [groupBy.property]
  }, [groupBy?.property])

  // Expanded state - reset when groupBy.property changes (different grouping)
  const [expanded, setExpanded] = useState<ExpandedState>(() => {
    if (groupBy?.collapsed) return {}
    return true // All expanded by default
  })

  const prevGroupProperty = useRef(groupBy?.property)
  useEffect(() => {
    // Only reset expanded state when the grouping property itself changes
    // (not when collapsed preference changes, which should be handled by user interaction)
    if (prevGroupProperty.current !== groupBy?.property) {
      prevGroupProperty.current = groupBy?.property
      setExpanded(groupBy?.collapsed ? {} : true)
    }
  }, [groupBy?.property, groupBy?.collapsed])

  // Selection state
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)
  const [internalSelectedRowIds, setInternalSelectedRowIds] = useState<Set<string>>(new Set())
  const selectedRowIds = externalSelectedRowIds ?? internalSelectedRowIds

  const selectedRowIdsRef = useRef(selectedRowIds)
  selectedRowIdsRef.current = selectedRowIds

  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange

  const externalSelectedRowIdsRef = useRef(externalSelectedRowIds)
  externalSelectedRowIdsRef.current = externalSelectedRowIds

  const setSelectedRowIds = useCallback(
    (newSelection: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const resolved =
        typeof newSelection === 'function' ? newSelection(selectedRowIdsRef.current) : newSelection
      onSelectionChangeRef.current?.(resolved)
      if (!externalSelectedRowIdsRef.current) {
        setInternalSelectedRowIds(resolved)
      }
    },
    []
  )

  const tableContainerRef = useRef<HTMLDivElement>(null)
  const lastSelectedIndexRef = useRef<number | null>(null)

  // ============================================================================
  // Column Config
  // ============================================================================

  const columnConfigMap = useMemo(() => {
    const map = new Map<string, ColumnConfig>()
    columnConfig.forEach((col) => map.set(col.id, col))
    return map
  }, [columnConfig])

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

  // ============================================================================
  // Sorting
  // ============================================================================

  const onSortingChangeRef = useRef(onSortingChange)
  onSortingChangeRef.current = onSortingChange

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

  // ============================================================================
  // Cell Renderers
  // ============================================================================

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

  const renderDateCell = useCallback((info: CellContext<NoteWithProperties, unknown>) => {
    const value = info.getValue()
    if (!value) return <span className="text-muted-foreground/50">—</span>
    return <DateCell value={String(value)} />
  }, [])

  const renderWordCountCell = useCallback((info: CellContext<NoteWithProperties, unknown>) => {
    const value = info.getValue()
    if (typeof value !== 'number') return <span className="text-muted-foreground/50">—</span>
    return <WordCountCell value={value} />
  }, [])

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

  // ============================================================================
  // Column Definitions
  // ============================================================================

  // Get columns needed for sorting that aren't visible
  const sortOnlyColumns = useMemo(() => {
    const visibleIds = new Set(columnConfig.map((c) => c.id))
    const sortIds = (initialSorting || []).map((s) => s.property)
    return sortIds.filter((id) => !visibleIds.has(id))
  }, [columnConfig, initialSorting])

  // Get columns needed for grouping that aren't visible or in sort-only columns
  const groupOnlyColumns = useMemo(() => {
    if (!groupBy?.property) return []
    const visibleIds = new Set(columnConfig.map((c) => c.id))
    const sortOnlyIds = new Set(sortOnlyColumns)
    // If groupBy property is not visible and not already in sortOnlyColumns, add it
    if (!visibleIds.has(groupBy.property) && !sortOnlyIds.has(groupBy.property)) {
      return [groupBy.property]
    }
    return []
  }, [columnConfig, sortOnlyColumns, groupBy?.property])

  const columns = useMemo<ColumnDef<NoteWithProperties>[]>(() => {
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

    const visibleColumns = columnConfig.map((col) => {
      const baseColumn = {
        id: col.id,
        header: col.displayName ?? capitalizeFirst(col.id),
        size: col.width ?? 150,
        minSize: 50,
        maxSize: 800
      }

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
          if (col.id.startsWith('formula.')) {
            const formulaName = col.id.slice(8)
            const expression = formulas[formulaName]

            if (!expression) {
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
              accessorFn: (row: NoteWithProperties) => evaluateFormula(expression, row),
              cell: renderFormulaCell(formulaName, expression)
            }
          }

          return {
            ...baseColumn,
            accessorFn: (row: NoteWithProperties) => row.properties[col.id] ?? '',
            cell: renderPropertyCell(col.id)
          }
      }
    })

    // Hidden columns for sorting by non-visible properties
    const hiddenSortColumns: ColumnDef<NoteWithProperties>[] = sortOnlyColumns.map((id) => ({
      id,
      accessorFn: getBuiltInAccessor(id),
      enableHiding: true
    }))

    // Hidden columns for grouping by non-visible properties
    const hiddenGroupColumns: ColumnDef<NoteWithProperties>[] = groupOnlyColumns.map((id) => ({
      id,
      accessorFn: getBuiltInAccessor(id),
      enableHiding: true
    }))

    return [...visibleColumns, ...hiddenSortColumns, ...hiddenGroupColumns]
  }, [
    columnConfig,
    formulas,
    sortOnlyColumns,
    groupOnlyColumns,
    renderTitleCell,
    renderFolderCell,
    renderTagsCell,
    renderDateCell,
    renderWordCountCell,
    renderPropertyCell,
    renderFormulaCell
  ])

  const columnVisibility = useMemo(() => {
    const visibility: Record<string, boolean> = {}
    // Hide sort-only columns
    for (const id of sortOnlyColumns) {
      visibility[id] = false
    }
    // Hide group-only columns
    for (const id of groupOnlyColumns) {
      visibility[id] = false
    }
    return visibility
  }, [sortOnlyColumns, groupOnlyColumns])

  // ============================================================================
  // Table Instance
  // ============================================================================

  const table = useReactTable({
    data: notes,
    columns,
    state: {
      sorting,
      globalFilter: globalFilter ?? '',
      columnVisibility,
      grouping,
      expanded
    },
    onSortingChange: handleSortingChange,
    onExpandedChange: setExpanded,
    globalFilterFn: globalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    columnResizeMode: 'onChange',
    getRowId: (row) => row.id,
    // Custom aggregation for group rows
    aggregationFns: {},
    // Enable manual grouping control
    manualGrouping: false
  })

  // ============================================================================
  // Row Virtualization
  // ============================================================================

  const { rows } = table.getRowModel()

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      // Group headers are slightly taller
      if (row?.getIsGrouped()) return 44
      return 40
    },
    measureElement:
      typeof window !== 'undefined' && !navigator.userAgent.includes('Firefox')
        ? (element) => element?.getBoundingClientRect().height
        : undefined,
    overscan: 10
  })

  const virtualRows = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  // ============================================================================
  // Drag and Drop
  // ============================================================================

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  const columnIds = useMemo(() => columnConfig.map((col) => col.id), [columnConfig])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = columnConfig.findIndex((col) => col.id === active.id)
      const newIndex = columnConfig.findIndex((col) => col.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return

      const newColumns = arrayMove(columnConfig, oldIndex, newIndex)
      if (onColumnsChange) onColumnsChange(newColumns)
    },
    [columnConfig, onColumnsChange]
  )

  const sortedColumnsCount = sorting.length

  const getSortIndex = useCallback(
    (columnId: string): number | undefined => {
      const index = sorting.findIndex((s) => s.id === columnId)
      return index >= 0 ? index + 1 : undefined
    },
    [sorting]
  )

  // ============================================================================
  // Row Selection & Keyboard
  // ============================================================================

  const handleRowClick = useCallback(
    (rowIndex: number, rowId: string, event: React.MouseEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('button, a, [role="button"]')) return

      setFocusedRowId(rowId)

      if (event.shiftKey && lastSelectedIndexRef.current !== null) {
        const start = Math.min(lastSelectedIndexRef.current, rowIndex)
        const end = Math.max(lastSelectedIndexRef.current, rowIndex)
        const newSelection = new Set(selectedRowIds)
        for (let i = start; i <= end; i++) {
          const row = rows[i]
          if (row && !row.getIsGrouped()) {
            newSelection.add(row.original.id)
          }
        }
        setSelectedRowIds(newSelection)
      } else if (event.metaKey || event.ctrlKey) {
        setSelectedRowIds((prev) => {
          const newSet = new Set(prev)
          if (newSet.has(rowId)) newSet.delete(rowId)
          else newSet.add(rowId)
          return newSet
        })
        lastSelectedIndexRef.current = rowIndex
      } else {
        setSelectedRowIds(new Set([rowId]))
        lastSelectedIndexRef.current = rowIndex
      }
    },
    [rows, selectedRowIds, setSelectedRowIds]
  )

  const scrollToRowById = useCallback(
    (rowId: string) => {
      const rowIndex = rows.findIndex((r) => r.original?.id === rowId)
      if (rowIndex >= 0) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: 'auto', behavior: 'smooth' })
      }
    },
    [rows, rowVirtualizer]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const rows = table.getRowModel().rows.filter((r) => !r.getIsGrouped())
      if (rows.length === 0) return

      const currentIndex = focusedRowId ? rows.findIndex((r) => r.original.id === focusedRowId) : -1

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          let nextIndex: number
          if (currentIndex === -1) nextIndex = 0
          else if (currentIndex >= rows.length - 1) {
            if (e.shiftKey) return
            nextIndex = 0
          } else nextIndex = currentIndex + 1

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
          if (currentIndex === -1) prevIndex = rows.length - 1
          else if (currentIndex <= 0) {
            if (e.shiftKey) return
            prevIndex = rows.length - 1
          } else prevIndex = currentIndex - 1

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

  // ============================================================================
  // Rendering
  // ============================================================================

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

  if (notes.length === 0) {
    return (
      <FolderViewEmptyState
        variant="empty"
        onCreateNote={onCreateNote}
        className={cn('h-full', className)}
      />
    )
  }

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
      <div
        ref={tableContainerRef}
        role="grid"
        aria-label="Grouped notes table"
        className={cn('w-full max-w-full overflow-auto outline-none', className)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
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
              const isGroupRow = row.getIsGrouped()

              if (isGroupRow) {
                // Render group header row
                return (
                  <GroupHeaderRow
                    key={row.id}
                    row={row}
                    virtualRow={virtualRow}
                    measureElement={(node) => rowVirtualizer.measureElement(node)}
                    totalColumnsWidth={totalColumnsWidth}
                    density={density}
                    groupByProperty={groupBy?.property || ''}
                    showSummary={groupBy?.showSummary}
                    summaries={summaries}
                    formulas={formulas}
                    columns={columnConfig}
                  />
                )
              }

              // Render normal data row
              const isSelected = selectedRowIds.has(row.original.id)
              const isFocused = focusedRowId === row.original.id
              const isPartOfSelection = isSelected && selectedRowIds.size > 1
              const isInGroup = grouping.length > 0
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
                      transform: `translateY(${virtualRow.start}px)`,
                      // Add left padding when grouped to show hierarchy
                      paddingLeft: isInGroup ? '24px' : undefined
                    }}
                    className={cn(
                      'border-b border-border/50',
                      'transition-colors',
                      'items-center',
                      'cursor-pointer',
                      !isSelected && 'hover:bg-muted/50',
                      isSelected && 'border-l-2 border-amber-400 dark:border-amber-600',
                      isFocused && 'ring-2 ring-amber-400/50 ring-inset dark:ring-amber-600/50',
                      // T121: Exit animation - simple opacity fade
                      isExiting && 'opacity-0 transition-opacity duration-200'
                    )}
                    onClick={(e) => handleRowClick(virtualRow.index, row.original.id, e)}
                    onDoubleClick={() => onNoteOpen?.(row.original.id)}
                  >
                    {row.getVisibleCells().map((cell, cellIndex) => {
                      const isLastCell = cellIndex === row.getVisibleCells().length - 1
                      const adjustedWidth =
                        cell.column.getSize() - (isInGroup && cellIndex === 0 ? 24 : 0)
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            'flex-shrink-0 overflow-hidden',
                            density === 'compact' ? 'px-2 py-1' : 'px-3 py-2',
                            showColumnBorders && !isLastCell && 'border-r border-border/30'
                          )}
                          style={
                            isLastCell
                              ? {
                                  minWidth: adjustedWidth,
                                  flex: 1
                                }
                              : {
                                  width: adjustedWidth,
                                  maxWidth: adjustedWidth
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

          {/* Summary Row */}
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

// ============================================================================
// Group Header Row Component
// ============================================================================

interface GroupHeaderRowProps {
  row: Row<NoteWithProperties>
  virtualRow: { index: number; start: number }
  measureElement: (node: HTMLElement | null) => void
  totalColumnsWidth: number
  density: 'comfortable' | 'compact'
  groupByProperty: string
  showSummary?: boolean
  summaries: Record<string, SummaryConfig>
  formulas: Record<string, string>
  columns: ColumnConfig[]
}

const GroupHeaderRow = memo(function GroupHeaderRow({
  row,
  virtualRow,
  measureElement,
  totalColumnsWidth,
  density,
  groupByProperty,
  showSummary,
  summaries,
  formulas,
  columns
}: GroupHeaderRowProps): React.JSX.Element {
  const isExpanded = row.getIsExpanded()
  const groupValue = row.groupingValue
  const subRows = row.subRows
  const count = subRows.length

  // Calculate group summaries if enabled
  const groupSummaries = useMemo(() => {
    if (!showSummary || Object.keys(summaries).length === 0) return null

    const groupNotes = subRows.map((r) => r.original)
    const results: Record<string, string> = {}

    for (const column of columns) {
      const config = summaries[column.id]
      if (!config) continue

      const values = getColumnValues(groupNotes, column.id, formulas)
      const result = computeSummary(values, config)
      const formatted = formatSummaryValue(result, config)
      if (formatted && formatted !== '—') {
        results[column.id] = `${getSummaryTypeSymbol(config.type)} ${formatted}`
      }
    }

    return Object.keys(results).length > 0 ? results : null
  }, [showSummary, summaries, subRows, columns, formulas])

  return (
    <tr
      data-index={virtualRow.index}
      ref={measureElement}
      style={{
        display: 'flex',
        width: '100%',
        minWidth: Math.max(totalColumnsWidth, 100),
        position: 'absolute',
        transform: `translateY(${virtualRow.start}px)`
      }}
      className={cn(
        'border-b border-border',
        'bg-muted/30 hover:bg-muted/50',
        'transition-colors cursor-pointer'
      )}
      onClick={() => row.toggleExpanded()}
    >
      <td
        className={cn(
          'flex items-center gap-2 flex-1',
          density === 'compact' ? 'px-2 py-1.5' : 'px-3 py-2.5'
        )}
        style={{ minWidth: totalColumnsWidth, flex: 1 }}
      >
        {/* Expand/Collapse button */}
        <button
          type="button"
          className="flex-shrink-0 p-0.5 rounded hover:bg-muted"
          onClick={(e) => {
            e.stopPropagation()
            row.toggleExpanded()
          }}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        {/* Group property name and value */}
        <span className="text-xs text-muted-foreground font-medium">
          {capitalizeFirst(groupByProperty)}:
        </span>
        <span className="font-medium">{getGroupDisplayValue(groupValue)}</span>

        {/* Count badge */}
        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
          {count} {count === 1 ? 'note' : 'notes'}
        </span>

        {/* Group summaries (if enabled) */}
        {groupSummaries && (
          <div className="flex items-center gap-3 ml-4 text-xs text-muted-foreground">
            {Object.entries(groupSummaries)
              .slice(0, 3)
              .map(([columnId, value]) => {
                const column = columns.find((c) => c.id === columnId)
                const label = column?.displayName ?? capitalizeFirst(columnId)
                return (
                  <span key={columnId} className="flex items-center gap-1">
                    <span className="opacity-60">{label}:</span>
                    <span>{value}</span>
                  </span>
                )
              })}
            {Object.keys(groupSummaries).length > 3 && (
              <span className="opacity-60">+{Object.keys(groupSummaries).length - 3} more</span>
            )}
          </div>
        )}
      </td>
    </tr>
  )
})

export default GroupedTable
