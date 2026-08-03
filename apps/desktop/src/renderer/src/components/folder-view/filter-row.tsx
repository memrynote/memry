/**
 * Filter Row Component
 *
 * A single filter condition row with property, operator, and value selectors.
 * Used within FilterBuilder to create filter expressions.
 */

import { useCallback, useMemo } from 'react'
import { X, type AppIcon } from '@/lib/icons'
import { getColumnIcon } from './column-icons'
import { formatDate } from '@/lib/format-date'
import { useDateFormat } from '@/hooks/use-date-format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { getOperatorsForType, getDefaultOperator, type PropertyType } from '@/lib/filter-evaluator'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import { getColumnLabel } from '@/lib/contract-display-names'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

export interface FilterCondition {
  id: string
  property: string
  operator: string
  value: unknown
}

export interface PropertyInfo {
  id: string
  name: string
  type: PropertyType
}

interface FilterRowProps {
  /** The filter condition data */
  condition: FilterCondition
  /** Available properties for selection */
  availableProperties: PropertyInfo[]
  /** Called when the condition changes */
  onChange: (condition: FilterCondition) => void
  /** Called when the condition should be removed */
  onRemove: () => void
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Built-in Properties
// ============================================================================

/** Built-in filterable columns. `id` is the persisted contract identifier; the
 *  visible name is resolved per render so it follows the active language. */
const BUILT_IN_PROPERTY_TYPES: Array<{ id: string; type: PropertyType }> = [
  { id: 'title', type: 'text' },
  { id: 'folder', type: 'text' },
  { id: 'tags', type: 'multiselect' },
  { id: 'created', type: 'date' },
  { id: 'modified', type: 'date' },
  { id: 'wordCount', type: 'number' }
]

/** Shared chip styling for the property + operator selectors. */
const CHIP =
  'flex h-[26px] w-auto items-center gap-1 whitespace-nowrap rounded-md border-border bg-muted/50 px-2 text-[11.5px]'

/** Leading property icon (receives a pre-resolved icon as a prop). */
function PropertyIcon({
  icon: Icon,
  className
}: {
  icon: AppIcon
  className?: string
}): React.JSX.Element {
  return <Icon className={cn('h-3 w-3 shrink-0 text-muted-foreground', className)} />
}

// ============================================================================
// Component
// ============================================================================

/**
 * A single filter condition row with property, operator, and value inputs.
 */
export function FilterRow({
  condition,
  availableProperties,
  onChange,
  onRemove,
  className
}: FilterRowProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  // Built-in properties: `id` is the persisted contract identifier; the visible
  // name is resolved on every render so it follows the active language.
  const builtInProperties: PropertyInfo[] = BUILT_IN_PROPERTY_TYPES.map((p) => ({
    id: p.id,
    name: getColumnLabel(p.id),
    type: p.type
  }))

  // Combine built-in and custom properties
  const allProperties = useMemo(() => {
    const customProps = availableProperties.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type
    }))
    return [...builtInProperties, ...customProps]
  }, [builtInProperties, availableProperties])

  // Get current property info
  const currentProperty = useMemo(() => {
    return allProperties.find((p) => p.id === condition.property) || allProperties[0]
  }, [allProperties, condition.property])

  // Get operators for current property type
  const operators = useMemo(() => {
    return getOperatorsForType(currentProperty?.type || 'text')
  }, [currentProperty])

  // Check if current operator needs a value
  const currentOperator = useMemo(() => {
    return operators.find((o) => o.value === condition.operator)
  }, [operators, condition.operator])

  const needsValue = currentOperator?.needsValue ?? true

  // Handle property change
  const handlePropertyChange = useCallback(
    (propertyId: string) => {
      const property = allProperties.find((p) => p.id === propertyId)
      const newType = property?.type || 'text'
      const newOperator = getDefaultOperator(newType)

      onChange({
        ...condition,
        property: propertyId,
        operator: newOperator,
        value: ''
      })
    },
    [allProperties, condition, onChange]
  )

  // Handle operator change
  const handleOperatorChange = useCallback(
    (operator: string) => {
      const op = operators.find((o) => o.value === operator)
      onChange({
        ...condition,
        operator,
        // Clear value if operator doesn't need one
        value: op?.needsValue ? condition.value : null
      })
    },
    [operators, condition, onChange]
  )

  // Handle value change
  const handleValueChange = useCallback(
    (value: unknown) => {
      onChange({
        ...condition,
        value
      })
    },
    [condition, onChange]
  )

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* Property Selector — chip with a leading type icon */}
      <Select value={condition.property} onValueChange={handlePropertyChange}>
        <SelectTrigger
          className={cn(
            CHIP,
            // SelectValue renders the selected item (icon + name); hide only the chevron.
            'justify-start font-medium text-foreground [&>svg:last-child]:hidden'
          )}
        >
          <SelectValue
            placeholder={tPhaseF('phaseF.componentsFolderViewFilterRow.placeholderProperty')}
          />
        </SelectTrigger>
        <SelectContent>
          {/* Built-in properties */}
          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase">
            {tPhaseF('phaseF.componentsFolderViewFilterRow.builtIn')}
          </div>
          {builtInProperties.map((prop) => (
            <SelectItem key={prop.id} value={prop.id} className="text-xs">
              <span className="flex items-center gap-2">
                <PropertyIcon icon={getColumnIcon(prop.id)} className="h-3.5 w-3.5" />
                {prop.name}
              </span>
            </SelectItem>
          ))}

          {/* Custom properties */}
          {availableProperties.length > 0 && (
            <>
              <div className="px-2 py-1 mt-1 text-[10px] font-medium text-muted-foreground uppercase border-t">
                {tPhaseF('phaseF.componentsFolderViewFilterRow.properties')}
              </div>
              {availableProperties.map((prop) => (
                <SelectItem key={prop.id} value={prop.id} className="text-xs">
                  <span className="flex items-center gap-2">
                    <PropertyIcon icon={getColumnIcon(prop.id)} className="h-3.5 w-3.5" />
                    {prop.name}
                  </span>
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>

      {/* Operator Selector — chip with a trailing chevron */}
      <Select value={condition.operator} onValueChange={handleOperatorChange}>
        <SelectTrigger
          className={cn(
            CHIP,
            'justify-start text-muted-foreground [&>svg:last-child]:h-3 [&>svg:last-child]:w-3'
          )}
        >
          <SelectValue
            placeholder={tPhaseF('phaseF.componentsFolderViewFilterRow.placeholderOperator')}
          />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op.value} value={op.value} className="text-xs">
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value Input - type depends on property type */}
      {needsValue && (
        <ValueInput
          type={currentProperty?.type || 'text'}
          value={condition.value}
          onChange={handleValueChange}
        />
      )}

      {/* Spacer when no value needed */}
      {!needsValue && <div className="flex-1" />}

      {/* Remove */}
      <button
        type="button"
        onClick={onRemove}
        aria-label={tPhaseF('phaseF.componentsFolderViewFilterRow.removeFilter')}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

// ============================================================================
// Value Input Component
// ============================================================================

interface ValueInputProps {
  type: PropertyType
  value: unknown
  onChange: (value: unknown) => void
}

function ValueInput({ type, value, onChange }: ValueInputProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  switch (type) {
    case 'number':
    case 'rating':
      return (
        <Input
          type="number"
          value={(value as number) ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          className="h-[26px] flex-1 min-w-0 rounded-md border-border bg-transparent px-2 text-[11.5px] text-foreground [font-variant-numeric:tabular-nums]"
          placeholder={tPhaseF('phaseF.componentsFolderViewFilterRow.placeholderValue')}
        />
      )

    case 'date':
      return <DateValueInput value={value} onChange={onChange} />

    case 'checkbox':
      // Checkbox operators don't need value input
      return <div className="flex-1" />

    case 'text':
    case 'url':
    case 'select':
    case 'multiselect':
    default:
      return (
        <Input
          type="text"
          value={stringifyUnknown(value)}
          onChange={(e) => onChange(e.target.value)}
          className="h-[26px] flex-1 min-w-0 rounded-md border-border bg-transparent px-2 text-[11.5px] text-foreground"
          placeholder={tPhaseF('phaseF.componentsFolderViewFilterRow.placeholderValue')}
        />
      )
  }
}

// ============================================================================
// Date Value Input
// ============================================================================

interface DateValueInputProps {
  value: unknown
  onChange: (value: unknown) => void
}

function DateValueInput({ value, onChange }: DateValueInputProps): React.JSX.Element {
  const dateFormat = useDateFormat()
  // Parse the value to a Date
  const dateValue = useMemo(() => {
    if (!value) return undefined
    if (value instanceof Date) return value
    const parsed = new Date(value as string)
    return isNaN(parsed.getTime()) ? undefined : parsed
  }, [value])

  const handleSelect = useCallback(
    (date: Date | undefined) => {
      onChange(date?.toISOString() ?? '')
    },
    [onChange]
  )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-[26px] flex-1 justify-start rounded-md border-border bg-transparent px-2 text-start text-[11.5px] font-normal text-foreground',
            !dateValue && 'text-muted-foreground'
          )}
        >
          {dateValue ? formatDate(dateValue, dateFormat) : 'Pick a date'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[296px] p-3" align="start">
        <DatePickerCalendar selected={dateValue} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  )
}

export default FilterRow
