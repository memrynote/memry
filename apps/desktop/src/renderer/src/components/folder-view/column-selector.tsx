/**
 * Column Selector Component
 *
 * Dropdown component for adding/removing columns from the folder table view.
 * Features:
 * - Search input to filter columns
 * - Flat list of all columns (built-in + properties)
 * - Separate section for formulas with management actions
 * - Checkboxes to toggle column visibility
 * - Usage count for property columns
 * - Formula management (add, edit, delete)
 */

import { useState, useMemo, useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
import { SlidersHorizontal, Search, Plus, Pencil, Trash2, Lock, type AppIcon } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getColumnIcon } from './column-icons'
import { FormulaEditorModal } from './formula-editor-modal'
import { getSummaryTypesForColumn, getSummaryTypeLabel } from '@/lib/summary-evaluator'
import type {
  ColumnConfig,
  NoteWithProperties,
  SummaryConfig
} from '@memry/contracts/folder-view-api'

// ============================================================================
// Types
// ============================================================================

export interface AvailableProperty {
  name: string
  type: string
  usageCount: number
}

export interface BuiltInColumnInfo {
  id: string
  displayName: string
  type: string
}

export interface FormulaInfo {
  id: string
  expression: string
}

interface ColumnSelectorProps {
  /** Currently visible columns */
  columns: ColumnConfig[]
  /** Built-in columns info */
  builtInColumns: BuiltInColumnInfo[]
  /** Available custom properties */
  availableProperties: AvailableProperty[]
  /** Formulas defined in folder config */
  formulas?: FormulaInfo[]
  /** Called when columns change */
  onColumnsChange: (columns: ColumnConfig[]) => void
  /** Called when search query changes (for table highlighting) */
  onSearchChange?: (query: string) => void
  /** Called when a formula is added */
  onFormulaAdd?: (name: string, expression: string) => Promise<void>
  /** Called when a formula is updated */
  onFormulaEdit?: (name: string, expression: string) => Promise<void>
  /** Called when a formula is deleted */
  onFormulaDelete?: (name: string) => Promise<void>
  /** Sample note for formula preview */
  sampleNote?: NoteWithProperties | null
  /** Summary configurations per column */
  summaries?: Record<string, SummaryConfig>
  /** Called when summary config changes for a column */
  onSummaryChange?: (columnId: string, config: SummaryConfig | undefined) => void
  /** Whether the summary row is shown for the current view */
  showSummaries?: boolean
  /** Toggle the summary row for the current view */
  onToggleSummaries?: () => void
  /** Whether vertical column borders are shown for the current view */
  columnBorders?: boolean
  /** Toggle vertical column borders for the current view */
  onToggleColumnBorders?: () => void
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Default column widths by column ID */
const DEFAULT_WIDTHS: Record<string, number> = {
  title: 250,
  folder: 120,
  tags: 150,
  created: 130,
  modified: 130,
  wordCount: 80
}

/** Default width for property and formula columns */
const DEFAULT_PROPERTY_WIDTH = 120
const DEFAULT_FORMULA_WIDTH = 120

const EMPTY_FORMULAS: FormulaInfo[] = []
const EMPTY_SUMMARIES: Record<string, SummaryConfig> = {}

// ============================================================================
// Component
// ============================================================================

/**
 * Column selector dropdown for toggling column visibility.
 */
export function ColumnSelector({
  columns,
  builtInColumns,
  availableProperties,
  formulas = EMPTY_FORMULAS,
  onColumnsChange,
  onSearchChange,
  onFormulaAdd,
  onFormulaEdit,
  onFormulaDelete,
  sampleNote,
  summaries = EMPTY_SUMMARIES,
  onSummaryChange,
  showSummaries = false,
  onToggleSummaries,
  columnBorders = false,
  onToggleColumnBorders,
  className
}: ColumnSelectorProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('common')
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Formula editor modal state
  const [isFormulaEditorOpen, setIsFormulaEditorOpen] = useState(false)
  const [editingFormula, setEditingFormula] = useState<FormulaInfo | null>(null)

  // Delete confirmation dialog state
  const [formulaToDelete, setFormulaToDelete] = useState<string | null>(null)

  // Create a set of visible column IDs for quick lookup
  const visibleColumnIds = useMemo(() => {
    return new Set(columns.map((col) => col.id))
  }, [columns])

  // Check if a column is visible
  const isColumnVisible = useCallback(
    (columnId: string) => visibleColumnIds.has(columnId),
    [visibleColumnIds]
  )

  // Filter items based on search query
  const filteredBuiltIn = useMemo(() => {
    if (!searchQuery) return builtInColumns
    const query = searchQuery.toLowerCase()
    return builtInColumns.filter((col) => col.displayName.toLowerCase().includes(query))
  }, [builtInColumns, searchQuery])

  const filteredProperties = useMemo(() => {
    if (!searchQuery) return availableProperties
    const query = searchQuery.toLowerCase()
    return availableProperties.filter((prop) => prop.name.toLowerCase().includes(query))
  }, [availableProperties, searchQuery])

  const filteredFormulas = useMemo(() => {
    if (!searchQuery) return formulas
    const query = searchQuery.toLowerCase()
    return formulas.filter(
      (f) => f.id.toLowerCase().includes(query) || f.expression.toLowerCase().includes(query)
    )
  }, [formulas, searchQuery])

  // Merge all columns into a single flat list (built-in + properties)
  const allColumns = useMemo(() => {
    const items: Array<{
      id: string
      label: string
      subtitle?: string
      type: string
      isFormula?: boolean
      formula?: FormulaInfo
    }> = []

    // Add built-in columns
    filteredBuiltIn.forEach((col) => {
      items.push({
        id: col.id,
        label: col.displayName,
        type: col.type
      })
    })

    // Add property columns
    filteredProperties.forEach((prop) => {
      items.push({
        id: prop.name,
        label: prop.name,
        subtitle: t('count.note', { count: prop.usageCount }),
        type: prop.type
      })
    })

    return items
  }, [filteredBuiltIn, filteredProperties, t])

  // Check if there are any search results
  const hasResults = allColumns.length > 0 || filteredFormulas.length > 0

  // Show formulas section even if empty (for add button)
  const showFormulasSection = !searchQuery || filteredFormulas.length > 0

  // Handle search input change
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value)
      onSearchChange?.(value)
    },
    [onSearchChange]
  )

  // Handle popover open/close
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open)
      if (!open) {
        // Clear search and highlights when closing
        setSearchQuery('')
        onSearchChange?.('')
      }
    },
    [onSearchChange]
  )

  // Toggle column visibility
  const toggleColumn = useCallback(
    (columnId: string, checked: boolean) => {
      if (checked) {
        // Add column to end with default width
        const isFormula = columnId.startsWith('formula.')
        const width = isFormula
          ? DEFAULT_FORMULA_WIDTH
          : (DEFAULT_WIDTHS[columnId] ?? DEFAULT_PROPERTY_WIDTH)
        const newColumn: ColumnConfig = { id: columnId, width }
        onColumnsChange([...columns, newColumn])
      } else {
        // Remove column
        onColumnsChange(columns.filter((col) => col.id !== columnId))
      }
    },
    [columns, onColumnsChange]
  )

  // Open formula editor for creating new formula
  const handleAddFormula = useCallback(() => {
    setEditingFormula(null)
    setIsFormulaEditorOpen(true)
    // Don't close the popover - let user come back after creating
  }, [])

  // Open formula editor for editing existing formula
  const handleEditFormula = useCallback((formula: FormulaInfo) => {
    setEditingFormula(formula)
    setIsFormulaEditorOpen(true)
  }, [])

  // Handle formula save (create or update)
  const handleSaveFormula = useCallback(
    async (name: string, expression: string) => {
      if (editingFormula) {
        // Editing existing formula
        await onFormulaEdit?.(name, expression)
      } else {
        // Creating new formula
        await onFormulaAdd?.(name, expression)
      }
    },
    [editingFormula, onFormulaAdd, onFormulaEdit]
  )

  // Handle formula delete confirmation
  const handleConfirmDelete = useCallback(async () => {
    if (formulaToDelete) {
      // Remove from columns if visible
      const formulaColumnId = `formula.${formulaToDelete}`
      if (isColumnVisible(formulaColumnId)) {
        onColumnsChange(columns.filter((col) => col.id !== formulaColumnId))
      }
      // Delete the formula
      await onFormulaDelete?.(formulaToDelete)
      setFormulaToDelete(null)
    }
  }, [formulaToDelete, isColumnVisible, columns, onColumnsChange, onFormulaDelete])

  // Existing formula names for validation
  const existingFormulaNames = useMemo(() => formulas.map((f) => f.id), [formulas])

  // Check if formula management is enabled
  const canManageFormulas = Boolean(onFormulaAdd && onFormulaEdit && onFormulaDelete)

  return (
    <TooltipProvider>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn('gap-1.5 px-2 text-muted-foreground', className)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {tPhaseF('phaseF.componentsFolderViewColumnSelector.properties')}
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-72 overflow-hidden p-0">
          {/* Display header */}
          <div className="border-b px-3 py-2">
            <span className="text-xs font-semibold text-foreground">
              {tPhaseF('phaseF.componentsFolderViewColumnSelector.display')}
            </span>
          </div>

          {/* Display toggles */}
          {(onToggleSummaries || onToggleColumnBorders) && (
            <div className="flex flex-col gap-2.5 border-b px-3 py-2.5">
              {onToggleSummaries && (
                <ToggleRow
                  label={tPhaseF('phaseF.componentsFolderViewColumnSelector.showSummaries')}
                  checked={showSummaries}
                  onToggle={onToggleSummaries}
                />
              )}
              {onToggleColumnBorders && (
                <ToggleRow
                  label={tPhaseF('phaseF.componentsFolderViewColumnSelector.columnBorders')}
                  checked={columnBorders}
                  onToggle={onToggleColumnBorders}
                />
              )}
            </div>
          )}

          {/* Search input */}
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={tPhaseF('phaseF.componentsFolderViewColumnSelector.searchColumns')}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="h-8 ps-8 text-sm"
              />
            </div>
          </div>

          {/* Column list */}
          <div className="max-h-80 overflow-y-auto">
            {!hasResults && !showFormulasSection ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {tPhaseF('phaseF.componentsFolderViewColumnSelector.noMatchingColumns')}
              </div>
            ) : (
              <>
                {/* All columns (built-in + properties) in a flat list */}
                {allColumns.length > 0 && (
                  <div className="px-1.5 py-1.5">
                    <div className="px-1.5 pb-1 pt-1">
                      <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                        {tPhaseF('phaseF.componentsFolderViewColumnSelector.properties')}
                      </span>
                    </div>
                    {allColumns.map((col) => (
                      <ColumnItem
                        key={col.id}
                        id={col.id}
                        icon={getColumnIcon(col.id)}
                        label={col.label}
                        subtitle={col.subtitle}
                        checked={isColumnVisible(col.id)}
                        onCheckedChange={(checked) => toggleColumn(col.id, checked)}
                        columnType={col.type}
                        summaryConfig={summaries[col.id]}
                        onSummaryChange={
                          onSummaryChange ? (config) => onSummaryChange(col.id, config) : undefined
                        }
                      />
                    ))}
                  </div>
                )}

                {/* Formulas section - keep separate since they have edit/delete actions */}
                {showFormulasSection && (
                  <ColumnGroup
                    title={tPhaseF('phaseF.componentsFolderViewColumnSelector.formulas')}
                  >
                    {filteredFormulas.length > 0 ? (
                      filteredFormulas.map((formula) => (
                        <FormulaItem
                          key={formula.id}
                          formula={formula}
                          checked={isColumnVisible(`formula.${formula.id}`)}
                          onCheckedChange={(checked) =>
                            toggleColumn(`formula.${formula.id}`, checked)
                          }
                          onEdit={canManageFormulas ? () => handleEditFormula(formula) : undefined}
                          onDelete={
                            canManageFormulas ? () => setFormulaToDelete(formula.id) : undefined
                          }
                        />
                      ))
                    ) : (
                      <div className="px-3 py-2 text-xs text-muted-foreground italic">
                        {tPhaseF('phaseF.componentsFolderViewColumnSelector.noFormulasDefined')}
                      </div>
                    )}
                    {/* Add formula button */}
                    {canManageFormulas && (
                      <button
                        type="button"
                        onClick={handleAddFormula}
                        className={cn(
                          'flex items-center gap-2 w-full px-3 py-1.5 text-sm',
                          'text-primary hover:bg-muted/50 transition-colors',
                          'focus:outline-none focus:bg-muted/50'
                        )}
                      >
                        <Plus className="h-4 w-4" />
                        <span>
                          {tPhaseF('phaseF.componentsFolderViewColumnSelector.addFormula')}
                        </span>
                      </button>
                    )}
                  </ColumnGroup>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Formula Editor Modal */}
      <FormulaEditorModal
        open={isFormulaEditorOpen}
        onOpenChange={setIsFormulaEditorOpen}
        initialName={editingFormula?.id ?? ''}
        initialExpression={editingFormula?.expression ?? ''}
        sampleNote={sampleNote}
        onSave={handleSaveFormula}
        existingNames={
          editingFormula
            ? existingFormulaNames.filter((n) => n !== editingFormula.id)
            : existingFormulaNames
        }
        availableProperties={availableProperties}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={Boolean(formulaToDelete)} onOpenChange={() => setFormulaToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsFolderViewColumnSelector.deleteFormula')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tPhaseF('phaseF.componentsFolderViewColumnSelector.deleteFormulaBody', {
                name: formulaToDelete
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {tPhaseF('phaseF.componentsFolderViewColumnSelector.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tPhaseF('phaseF.componentsFolderViewColumnSelector.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Section header for column groups
 */
function ColumnGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b last:border-b-0">
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50">
        {title}
      </div>
      <div className="py-1">{children}</div>
    </div>
  )
}

/**
 * Individual column item with checkbox and optional summary selector
 */
function ColumnItem({
  id,
  label,
  subtitle,
  checked,
  onCheckedChange,
  columnType,
  summaryConfig,
  onSummaryChange,
  icon: Icon
}: {
  id: string
  label: string
  subtitle?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  columnType?: string
  summaryConfig?: SummaryConfig
  onSummaryChange?: (config: SummaryConfig | undefined) => void
  icon: AppIcon
}): React.JSX.Element {
  const showSummarySelector = checked && onSummaryChange && columnType
  // Title is always visible — show a lock instead of a toggle.
  const locked = id === 'title'

  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
      <label
        htmlFor={locked ? undefined : `col-${id}`}
        className={cn('flex min-w-0 flex-1 items-center gap-2', !locked && 'cursor-pointer')}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span
            className={cn('block truncate text-xs', !checked && 'text-muted-foreground')}
            title={label}
          >
            {label}
          </span>
          {subtitle && (
            <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
          )}
        </div>
      </label>
      {showSummarySelector && (
        <SummarySelect columnType={columnType} value={summaryConfig} onChange={onSummaryChange} />
      )}
      {locked ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      ) : (
        <Checkbox
          id={`col-${id}`}
          checked={checked}
          onCheckedChange={(checked) => onCheckedChange(checked === true)}
          className="shrink-0"
        />
      )}
    </div>
  )
}

/**
 * Display option toggle row (label + switch)
 */
function ToggleRow({
  label,
  checked,
  onToggle
}: {
  label: string
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onToggle} />
    </div>
  )
}

/**
 * Summary type selector dropdown
 */
function SummarySelect({
  columnType,
  value,
  onChange
}: {
  columnType: string
  value?: SummaryConfig
  onChange: (config: SummaryConfig | undefined) => void
}): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const availableTypes = getSummaryTypesForColumn(columnType)

  const handleChange = useCallback(
    (selectedType: string) => {
      if (selectedType === 'none') {
        onChange(undefined)
      } else {
        onChange({ type: selectedType as SummaryConfig['type'] })
      }
    },
    [onChange]
  )

  return (
    <Select value={value?.type ?? 'none'} onValueChange={handleChange}>
      <SelectTrigger className="h-6 w-[72px] text-xs px-2">
        <SelectValue placeholder={tPhaseF('phaseF.componentsFolderViewColumnSelector.none')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none" className="text-xs">
          {tPhaseF('phaseF.componentsFolderViewColumnSelector.none')}
        </SelectItem>
        {availableTypes.map((type) => (
          <SelectItem key={type} value={type} className="text-xs">
            {getSummaryTypeLabel(type)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Formula item with checkbox, edit, and delete buttons
 */
function FormulaItem({
  formula,
  checked,
  onCheckedChange,
  onEdit,
  onDelete
}: {
  formula: FormulaInfo
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onEdit?: () => void
  onDelete?: () => void
}): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5',
        'hover:bg-muted/50 transition-colors group'
      )}
    >
      <Checkbox
        id={`col-formula-${formula.id}`}
        checked={checked}
        onCheckedChange={(checked) => onCheckedChange(checked === true)}
      />
      <label htmlFor={`col-formula-${formula.id}`} className="flex-1 min-w-0 cursor-pointer">
        <span className="text-sm truncate block" title={formula.id}>
          {formula.id}
        </span>
        <span
          className="text-xs text-muted-foreground truncate block font-mono"
          title={formula.expression}
        >
          {formula.expression}
        </span>
      </label>
      {/* Action buttons (visible on hover) */}
      {(onEdit || onDelete) && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEdit && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit()
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {tPhaseF('phaseF.componentsFolderViewColumnSelector.edit')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onDelete && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete()
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {tPhaseF('phaseF.componentsFolderViewColumnSelector.delete2')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      )}
    </div>
  )
}

export default ColumnSelector
