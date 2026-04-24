import { useMemo } from 'react'
import { Clock, X } from '@/lib/icons'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface TimePickerProps {
  value: string | null
  onChange: (value: string | null) => void
  className?: string
}

// ============================================================================
// TIME OPTIONS GENERATOR
// ============================================================================

interface TimeOption {
  value: string // "HH:MM" in 24hr format
  label: string // Display label in 12hr format
}

/**
 * Generate time options in 30-minute increments
 */
const generateTimeOptions = (): TimeOption[] => {
  const options: TimeOption[] = []

  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30]) {
      const hourStr = hour.toString().padStart(2, '0')
      const minuteStr = minute.toString().padStart(2, '0')
      const value = `${hourStr}:${minuteStr}`

      // Format for display (12-hour)
      const displayHour = hour % 12 || 12
      const period = hour < 12 ? 'AM' : 'PM'
      const label = `${displayHour}:${minuteStr} ${period}`

      options.push({ value, label })
    }
  }

  return options
}

// ============================================================================
// TIME PICKER COMPONENT
// ============================================================================

export const TimePicker = ({ value, onChange, className }: TimePickerProps): React.JSX.Element => {
  const timeOptions = useMemo(() => generateTimeOptions(), [])

  // Find current option
  const currentOption = value ? timeOptions.find((opt) => opt.value === value) : null

  const handleValueChange = (newValue: string): void => {
    onChange(newValue)
  }

  const handleClear = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onChange(null)
  }

  return (
    <div className={cn('relative flex items-center gap-1', className)}>
      <Select value={value || ''} onValueChange={handleValueChange}>
        <SelectTrigger className="w-full" aria-label="Select time">
          <SelectValue>
            {currentOption ? (
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>{currentOption.label}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="size-4" aria-hidden="true" />
                <span>Select time</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-60">
          {timeOptions.map((option) => (
            <SelectItem key={option.value} value={option.value} className="cursor-pointer">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear button */}
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={handleClear}
          aria-label="Clear time"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  )
}

export default TimePicker
