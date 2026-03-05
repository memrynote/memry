/**
 * Filter Row Component
 *
 * A single filter condition row with property, operator, and value selectors.
 * Used within FilterBuilder to create filter expressions.
 */

import { useCallback, useMemo } from 'react'
import { X, Calendar as CalendarIcon } from 'lucide-react'
import { format } from 'date-fns'
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
  /** Visual nesting level (0-2) */
  nestingLevel?: number
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Built-in Properties
// ============================================================================

const BUILT_IN_PROPERTIES: PropertyInfo[] = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'folder', name: 'Folder', type: 'text' },
  { id: 'tags', name: 'Tags', type: 'multiselect' },
  { id: 'created', name: 'Created', type: 'date' },
  { id: 'modified', name: 'Modified', type: 'date' },
  { id: 'wordCount', name: 'Word Count', type: 'number' }
]

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
  nestingLevel = 0,
  className
}: FilterRowProps): React.JSX.Element {
  // Combine built-in and custom properties
  const allProperties = useMemo(() => {
    const customProps = availableProperties.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type
    }))
    return [...BUILT_IN_PROPERTIES, ...customProps]
  }, [availableProperties])

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

  // Indentation based on nesting level
  const indentClass = nestingLevel > 0 ? `ml-${nestingLevel * 4}` : ''

  return (
    <div className={cn('flex items-center gap-2 py-1.5', indentClass, className)}>
      {/* Property Selector */}
      <Select value={condition.property} onValueChange={handlePropertyChange}>
        <SelectTrigger className="w-[140px] h-8 text-xs">
          <SelectValue placeholder="Property" />
        </SelectTrigger>
        <SelectContent>
          {/* Built-in properties */}
          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase">
            Built-in
          </div>
          {BUILT_IN_PROPERTIES.map((prop) => (
            <SelectItem key={prop.id} value={prop.id} className="text-xs">
              {prop.name}
            </SelectItem>
          ))}

          {/* Custom properties */}
          {availableProperties.length > 0 && (
            <>
              <div className="px-2 py-1 mt-1 text-[10px] font-medium text-muted-foreground uppercase border-t">
                Properties
              </div>
              {availableProperties.map((prop) => (
                <SelectItem key={prop.id} value={prop.id} className="text-xs">
                  {prop.name}
                </SelectItem>
              ))}
            </>
          )}
        </SelectContent>
      </Select>

      {/* Operator Selector */}
      <Select value={condition.operator} onValueChange={handleOperatorChange}>
        <SelectTrigger className="w-[130px] h-8 text-xs">
          <SelectValue placeholder="Operator" />
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

      {/* Remove Button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="h-4 w-4" />
      </Button>
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
  switch (type) {
    case 'number':
    case 'rating':
      return (
        <Input
          type="number"
          value={(value as number) ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          className="w-[100px] h-8 text-xs"
          placeholder="Value"
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
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 h-8 text-xs min-w-[100px]"
          placeholder="Value"
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
            'w-[130px] h-8 justify-start text-left text-xs font-normal',
            !dateValue && 'text-muted-foreground'
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {dateValue ? format(dateValue, 'MMM d, yyyy') : 'Pick a date'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[296px] p-3" align="start">
        <DatePickerCalendar selected={dateValue} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  )
}

export default FilterRow
