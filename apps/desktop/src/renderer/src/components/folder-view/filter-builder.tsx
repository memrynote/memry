/**
 * Filter Builder Component
 *
 * Main filter popover component for building filter expressions.
 * Supports AND/OR logic, nested groups (up to 2 levels), and persists to .folder.md.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Filter, Plus, X, Trash2 } from 'lucide-react'
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
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  countFilterConditions,
  serializeCondition,
  parseExpression,
  getDefaultOperator
} from '@/lib/filter-evaluator'
import { FilterRow, type FilterCondition, type PropertyInfo } from './filter-row'
import type { FilterExpression } from '@memry/contracts/folder-view-api'

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
  className
}: FilterBuilderProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [state, setState] = useState<FilterUIState>(() => filterExpressionToUIState(filters))

  // Debounce timer
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Track if we're the source of the filter change (to skip unnecessary syncs)
  const isInternalChangeRef = useRef(false)

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

  // Sync state when filters prop changes externally (not from our own updates)
  useEffect(() => {
    // Skip sync if we caused this change
    if (isInternalChangeRef.current) {
      isInternalChangeRef.current = false
      return
    }
    setState(filterExpressionToUIState(filters))
  }, [filters])

  // Debounced save
  const saveFilters = useCallback(
    (newState: FilterUIState) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = setTimeout(() => {
        const expression = uiStateToFilterExpression(newState)
        // Mark that we're causing this change so the sync effect skips
        isInternalChangeRef.current = true
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

  // Clear all filters
  const handleClearAll = useCallback(() => {
    updateState({
      logic: 'and',
      conditions: [],
      groups: []
    })
  }, [updateState])

  const hasFilters = state.conditions.length > 0 || state.groups.length > 0

  return (
    <TooltipProvider>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn('gap-1.5 px-2', filterCount > 0 && 'border-primary', className)}
              >
                <Filter className="h-4 w-4" />
                {filterCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                    {filterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Filter</TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-[480px] p-0">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-medium">Filters</span>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={handleClearAll}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Clear all
              </Button>
            )}
          </div>

          {/* Content */}
          <div className="p-3 max-h-[400px] overflow-y-auto">
            {!hasFilters ? (
              /* Empty state */
              <div className="text-center py-6 text-sm text-muted-foreground">
                <Filter className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No filters applied</p>
                <p className="text-xs mt-1">Add filters to narrow down your notes</p>
              </div>
            ) : (
              <>
                {/* Logic selector */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-muted-foreground">Match</span>
                  <Select value={state.logic} onValueChange={handleLogicChange}>
                    <SelectTrigger className="w-[100px] h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="and" className="text-xs">
                        All (AND)
                      </SelectItem>
                      <SelectItem value="or" className="text-xs">
                        Any (OR)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">of the following:</span>
                </div>

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
                  <div key={group.id} className="mt-2 pl-3 border-l-2 border-muted-foreground/20">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-muted-foreground">Match</span>
                      <Select
                        value={group.logic}
                        onValueChange={(v) => handleGroupLogicChange(group.id, v as 'and' | 'or')}
                      >
                        <SelectTrigger className="w-[80px] h-6 text-[10px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="and" className="text-xs">
                            All
                          </SelectItem>
                          <SelectItem value="or" className="text-xs">
                            Any
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground flex-1">of:</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveGroup(group.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
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
                        nestingLevel={1}
                      />
                    ))}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-muted-foreground ml-4 mt-1"
                      onClick={() => handleAddGroupCondition(group.id)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add condition
                    </Button>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer with add buttons */}
          <Separator />
          <div className="flex items-center gap-2 p-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleAddCondition}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add filter
            </Button>
            {state.groups.length < 3 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={handleAddGroup}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add group
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

export default FilterBuilder
