/**
 * Filter Builder Component
 *
 * Main filter popover component for building filter expressions.
 * Supports AND/OR logic, nested groups (up to 2 levels), and persists to .folder.md.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Filter, Lock, Plus, X } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { withAlpha } from '@/components/note/tags-row/tag-colors'
import {
  countFilterConditions,
  serializeCondition,
  parseExpression,
  getDefaultOperator
} from '@/lib/filter-evaluator'
import { FilterRow, type FilterCondition, type PropertyInfo } from './filter-row'
import type { FilterExpression } from '@memry/contracts/folder-view-api'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface FilterBuilderProps {
  /** Current filter expression from view config */
  filters?: FilterExpression
  /** Available custom properties */
  availableProperties: Array<{ name: string; type: string; usageCount: number }>
  /** Built-in column info */
  builtInColumns: Array<{ id: string; displayName: string; type: string }>
  /** Called when filters change (debounced) */
  onFiltersChange: (filters: FilterExpression | undefined) => void
  /**
   * A condition imposed by the view's scope (e.g. tag scope) rather than by
   * the user. Rendered as an undeletable row above the editable conditions —
   * display only. It never enters `filters`/`onFiltersChange`: the scoping
   * is already applied server-side by whatever sources the rows, so folding
   * it into the expression here would apply it twice.
   */
  lockedCondition?: { label: string; color?: string }
  /** Additional CSS classes */
  className?: string
}

/** Internal representation for UI editing */
interface FilterGroup {
  id: string
  logic: 'and' | 'or'
  conditions: FilterCondition[]
}

interface FilterUIState {
  logic: 'and' | 'or'
  conditions: FilterCondition[]
  groups: FilterGroup[]
}

// ============================================================================
// Utilities
// ============================================================================

let conditionIdCounter = 0
function generateId(): string {
  return `cond_${Date.now()}_${++conditionIdCounter}`
}

function generateGroupId(): string {
  return `group_${Date.now()}_${++conditionIdCounter}`
}

/**
 * Convert FilterExpression to UI state for editing.
 */
function filterExpressionToUIState(filter?: FilterExpression): FilterUIState {
  const defaultState: FilterUIState = {
    logic: 'and',
    conditions: [],
    groups: []
  }

  if (!filter) return defaultState

  // Simple string expression
  if (typeof filter === 'string') {
    const parsed = parseExpression(filter)
    if (parsed) {
      return {
        logic: 'and',
        conditions: [{ id: generateId(), ...parsed }],
        groups: []
      }
    }
    return defaultState
  }

  // AND group
  if ('and' in filter) {
    return extractGroupState(filter.and, 'and')
  }

  // OR group
  if ('or' in filter) {
    return extractGroupState(filter.or, 'or')
  }

  // NOT is not directly editable in UI, treat as single condition
  return defaultState
}

/**
 * Extract conditions and nested groups from an array of filter expressions.
 */
function extractGroupState(expressions: FilterExpression[], logic: 'and' | 'or'): FilterUIState {
  const conditions: FilterCondition[] = []
  const groups: FilterGroup[] = []

  for (const expr of expressions) {
    if (typeof expr === 'string') {
      const parsed = parseExpression(expr)
      if (parsed) {
        conditions.push({ id: generateId(), ...parsed })
      }
    } else if ('and' in expr) {
      // Nested AND group
      const nestedConditions = extractNestedConditions(expr.and)
      if (nestedConditions.length > 0) {
        groups.push({
          id: generateGroupId(),
          logic: 'and',
          conditions: nestedConditions
        })
      }
    } else if ('or' in expr) {
      // Nested OR group
      const nestedConditions = extractNestedConditions(expr.or)
      if (nestedConditions.length > 0) {
        groups.push({
          id: generateGroupId(),
          logic: 'or',
          conditions: nestedConditions
        })
      }
    }
  }

  return { logic, conditions, groups }
}

/**
 * Extract only simple conditions from nested expressions (max 2 levels).
 */
function extractNestedConditions(expressions: FilterExpression[]): FilterCondition[] {
  const conditions: FilterCondition[] = []
  for (const expr of expressions) {
    if (typeof expr === 'string') {
      const parsed = parseExpression(expr)
      if (parsed) {
        conditions.push({ id: generateId(), ...parsed })
      }
    }
  }
  return conditions
}

/**
 * Convert UI state back to FilterExpression for storage.
 */
function uiStateToFilterExpression(state: FilterUIState): FilterExpression | undefined {
  const expressions: FilterExpression[] = []

  // Add top-level conditions
  for (const cond of state.conditions) {
    expressions.push(serializeCondition(cond))
  }

  // Add nested groups
  for (const group of state.groups) {
    if (group.conditions.length === 0) continue

    const groupExprs = group.conditions.map((c) => serializeCondition(c))
    if (groupExprs.length === 1) {
      expressions.push(groupExprs[0])
    } else if (group.logic === 'and') {
      expressions.push({ and: groupExprs })
    } else {
      expressions.push({ or: groupExprs })
    }
  }

  // Return undefined if empty
  if (expressions.length === 0) return undefined

  // Single expression doesn't need wrapper
  if (expressions.length === 1) return expressions[0]

  // Wrap in logic group
  return state.logic === 'and' ? { and: expressions } : { or: expressions }
}

// ============================================================================
// Component
// ============================================================================

/**
 * Filter builder popover with AND/OR groups and conditions.
 */
export function FilterBuilder({
  filters,
  availableProperties,
  builtInColumns,
  onFiltersChange,
  lockedCondition,
  className
}: FilterBuilderProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const [isOpen, setIsOpen] = useState(false)
  const [state, setState] = useState<FilterUIState>(() => filterExpressionToUIState(filters))

  // Debounce timer
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Track if we're the source of the filter change (to skip unnecessary syncs)
  const [skipNextFiltersSync, setSkipNextFiltersSync] = useState(false)

  // Count active filters for badge
  const filterCount = useMemo(() => countFilterConditions(filters), [filters])

  // Convert available properties to PropertyInfo format
  const propertyInfos: PropertyInfo[] = useMemo(() => {
    return availableProperties.map((p) => ({
      id: p.name,
      name: p.name,
      type: (p.type || 'text') as PropertyInfo['type']
    }))
  }, [availableProperties])

  // Sync state when filters prop changes externally (not from our own updates).
  // Done during render via the React-recommended "adjusting state when a prop changes"
  // pattern so we avoid no-derived-state warnings.
  const [storedFilters, setStoredFilters] = useState(filters)
  if (storedFilters !== filters) {
    setStoredFilters(filters)
    if (skipNextFiltersSync) {
      setSkipNextFiltersSync(false)
    } else {
      setState(filterExpressionToUIState(filters))
    }
  }

  // Debounced save
  const saveFilters = useCallback(
    (newState: FilterUIState) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = setTimeout(() => {
        const expression = uiStateToFilterExpression(newState)
        // Mark that we're causing this change so the sync effect skips
        setSkipNextFiltersSync(true)
        onFiltersChange(expression)
      }, 200)
    },
    [onFiltersChange]
  )

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // Update state and trigger save
  const updateState = useCallback(
    (newState: FilterUIState) => {
      setState(newState)
      saveFilters(newState)
    },
    [saveFilters]
  )

  // Handle logic change (AND/OR)
  const handleLogicChange = useCallback(
    (logic: 'and' | 'or') => {
      updateState({ ...state, logic })
    },
    [state, updateState]
  )

  // Add a new condition
  const handleAddCondition = useCallback(() => {
    const defaultProperty = builtInColumns[0]?.id || 'title'
    const newCondition: FilterCondition = {
      id: generateId(),
      property: defaultProperty,
      operator: getDefaultOperator('text'),
      value: ''
    }
    updateState({
      ...state,
      conditions: [...state.conditions, newCondition]
    })
  }, [state, builtInColumns, updateState])

  // Update a condition
  const handleUpdateCondition = useCallback(
    (conditionId: string, updated: FilterCondition) => {
      updateState({
        ...state,
        conditions: state.conditions.map((c) => (c.id === conditionId ? updated : c))
      })
    },
    [state, updateState]
  )

  // Remove a condition
  const handleRemoveCondition = useCallback(
    (conditionId: string) => {
      updateState({
        ...state,
        conditions: state.conditions.filter((c) => c.id !== conditionId)
      })
    },
    [state, updateState]
  )

  // Add a new group
  const handleAddGroup = useCallback(() => {
    const defaultProperty = builtInColumns[0]?.id || 'title'
    const newGroup: FilterGroup = {
      id: generateGroupId(),
      logic: 'or', // New groups default to OR for variety
      conditions: [
        {
          id: generateId(),
          property: defaultProperty,
          operator: getDefaultOperator('text'),
          value: ''
        }
      ]
    }
    updateState({
      ...state,
      groups: [...state.groups, newGroup]
    })
  }, [state, builtInColumns, updateState])

  // Update group logic
  const handleGroupLogicChange = useCallback(
    (groupId: string, logic: 'and' | 'or') => {
      updateState({
        ...state,
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, logic } : g))
      })
    },
    [state, updateState]
  )

  // Add condition to group
  const handleAddGroupCondition = useCallback(
    (groupId: string) => {
      const defaultProperty = builtInColumns[0]?.id || 'title'
      updateState({
        ...state,
        groups: state.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                conditions: [
                  ...g.conditions,
                  {
                    id: generateId(),
                    property: defaultProperty,
                    operator: getDefaultOperator('text'),
                    value: ''
                  }
                ]
              }
            : g
        )
      })
    },
    [state, builtInColumns, updateState]
  )

  // Update condition in group
  const handleUpdateGroupCondition = useCallback(
    (groupId: string, conditionId: string, updated: FilterCondition) => {
      updateState({
        ...state,
        groups: state.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                conditions: g.conditions.map((c) => (c.id === conditionId ? updated : c))
              }
            : g
        )
      })
    },
    [state, updateState]
  )

  // Remove condition from group
  const handleRemoveGroupCondition = useCallback(
    (groupId: string, conditionId: string) => {
      updateState({
        ...state,
        groups: state.groups.map((g) =>
          g.id === groupId
            ? { ...g, conditions: g.conditions.filter((c) => c.id !== conditionId) }
            : g
        )
      })
    },
    [state, updateState]
  )

  // Remove entire group
  const handleRemoveGroup = useCallback(
    (groupId: string) => {
      updateState({
        ...state,
        groups: state.groups.filter((g) => g.id !== groupId)
      })
    },
    [state, updateState]
  )

  return (
    <TooltipProvider>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'gap-1.5 px-2 text-muted-foreground',
                  filterCount > 0 && 'text-foreground',
                  className
                )}
              >
                <Filter className="h-3.5 w-3.5" />
                {filterCount > 0 && (
                  <Badge variant="secondary" className="ms-1 h-5 px-1.5 text-[10px]">
                    {filterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {tPhaseF('phaseF.componentsFolderViewFilterBuilder.filter')}
          </TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-[344px] overflow-clip p-0">
          {/* Header — title + Match logic chip */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span className="text-xs font-semibold text-foreground">
              {tPhaseF('phaseF.componentsFolderViewFilterBuilder.filter')}
            </span>
            <div className="grow" />
            <span className="text-[11px] text-muted-foreground">
              {tPhaseF('phaseF.componentsFolderViewFilterBuilder.match')}
            </span>
            <Select value={state.logic} onValueChange={handleLogicChange}>
              <SelectTrigger className="flex h-[22px] w-auto items-center justify-start gap-1 rounded-md border-0 bg-muted px-1.5 text-[11px] font-semibold text-foreground [&>svg:last-child]:h-2.5 [&>svg:last-child]:w-2.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="and" className="text-xs">
                  {tPhaseF('phaseF.componentsFolderViewFilterBuilder.all')}
                </SelectItem>
                <SelectItem value="or" className="text-xs">
                  {tPhaseF('phaseF.componentsFolderViewFilterBuilder.any')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Conditions */}
          <div className="flex max-h-[400px] flex-col gap-1.5 overflow-y-auto px-3 py-2.5">
            {/* Locked scope condition — display only, never part of the filter expression */}
            {lockedCondition && (
              <div
                data-testid="locked-filter-row"
                className="flex h-[26px] items-center gap-1.5 rounded-md border-border bg-muted/50 px-2 text-[11.5px] font-medium text-foreground"
                style={
                  lockedCondition.color
                    ? {
                        backgroundColor: withAlpha(lockedCondition.color, 0.12),
                        color: lockedCondition.color
                      }
                    : undefined
                }
              >
                <span className="truncate">{lockedCondition.label}</span>
                <div className="grow" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/70">
                      <Lock className="h-3 w-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {tPhaseF('phaseF.componentsFolderViewFilterBuilder.lockedConditionHint')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Top-level conditions */}
            {state.conditions.map((condition) => (
              <FilterRow
                key={condition.id}
                condition={condition}
                availableProperties={propertyInfos}
                onChange={(updated) => handleUpdateCondition(condition.id, updated)}
                onRemove={() => handleRemoveCondition(condition.id)}
              />
            ))}

            {/* Nested groups */}
            {state.groups.map((group) => (
              <div key={group.id} className="flex flex-col gap-1.5 border-s-2 border-border ps-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">
                    {tPhaseF('phaseF.componentsFolderViewFilterBuilder.match2')}
                  </span>
                  <Select
                    value={group.logic}
                    onValueChange={(v) => handleGroupLogicChange(group.id, v as 'and' | 'or')}
                  >
                    <SelectTrigger className="flex h-[22px] w-auto items-center justify-start gap-1 rounded-md border-0 bg-muted px-1.5 text-[11px] font-semibold text-foreground [&>svg:last-child]:h-2.5 [&>svg:last-child]:w-2.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="and" className="text-xs">
                        {tPhaseF('phaseF.componentsFolderViewFilterBuilder.all')}
                      </SelectItem>
                      <SelectItem value="or" className="text-xs">
                        {tPhaseF('phaseF.componentsFolderViewFilterBuilder.any')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="grow" />
                  <button
                    type="button"
                    onClick={() => handleRemoveGroup(group.id)}
                    aria-label={tPhaseF('phaseF.componentsFolderViewFilterBuilder.removeGroup')}
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                {group.conditions.map((condition) => (
                  <FilterRow
                    key={condition.id}
                    condition={condition}
                    availableProperties={propertyInfos}
                    onChange={(updated) =>
                      handleUpdateGroupCondition(group.id, condition.id, updated)
                    }
                    onRemove={() => handleRemoveGroupCondition(group.id, condition.id)}
                  />
                ))}

                <button
                  type="button"
                  onClick={() => handleAddGroupCondition(group.id)}
                  className="flex items-center gap-1 text-[11.5px] font-medium text-[var(--tint)]"
                >
                  <Plus className="h-3 w-3" />
                  {tPhaseF('phaseF.componentsFolderViewFilterBuilder.addCondition')}
                </button>
              </div>
            ))}
          </div>

          {/* Footer — add buttons */}
          <div className="flex items-center gap-3.5 border-t border-border px-3 py-2.5">
            <button
              type="button"
              onClick={handleAddCondition}
              className="flex items-center gap-1 text-xs font-semibold text-[var(--tint)]"
            >
              <Plus className="h-3.5 w-3.5" />
              {tPhaseF('phaseF.componentsFolderViewFilterBuilder.addFilter')}
            </button>
            {state.groups.length < 3 && (
              <button
                type="button"
                onClick={handleAddGroup}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                {tPhaseF('phaseF.componentsFolderViewFilterBuilder.addGroup')}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

export default FilterBuilder
