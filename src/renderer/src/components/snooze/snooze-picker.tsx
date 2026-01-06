/**
 * Snooze Picker Component
 *
 * A dropdown picker for selecting snooze time with presets and custom date/time.
 *
 * @module components/snooze/snooze-picker
 */

import * as React from 'react'
import { Clock, CalendarDays, ChevronRight, Moon, Sun, CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { snoozePresets, formatSnoozeTime } from './snooze-presets'

// ============================================================================
// Types
// ============================================================================

export interface SnoozePickerProps {
  /** Called when a snooze time is selected */
  onSnooze: (snoozeUntil: string, reason?: string) => void
  /** Optional trigger element (defaults to icon button) */
  trigger?: React.ReactNode
  /** Whether the picker is disabled */
  disabled?: boolean
  /** Size of the trigger button */
  size?: 'sm' | 'default' | 'lg' | 'icon'
  /** Variant of the trigger button */
  variant?: 'default' | 'secondary' | 'ghost' | 'outline'
  /** Additional class names for the trigger */
  className?: string
}

// ============================================================================
// Component
// ============================================================================

export function SnoozePicker({
  onSnooze,
  trigger,
  disabled = false,
  size = 'icon',
  variant = 'ghost',
  className
}: SnoozePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false)
  const [selectedDate, setSelectedDate] = React.useState<Date | undefined>(undefined)
  const [selectedTime, setSelectedTime] = React.useState('09:00')
  const [showCustomPicker, setShowCustomPicker] = React.useState(false)

  // Handle preset selection
  const handlePresetSelect = (preset: (typeof snoozePresets)[0]) => {
    const snoozeTime = preset.getTime()
    onSnooze(snoozeTime.toISOString())
    setIsOpen(false)
  }

  // Track if selected time is valid (in the future)
  const [timeError, setTimeError] = React.useState<string | null>(null)

  // Handle custom date/time selection
  const handleCustomSnooze = () => {
    if (!selectedDate) return

    const [hours, minutes] = selectedTime.split(':').map(Number)
    const snoozeTime = new Date(selectedDate)
    snoozeTime.setHours(hours, minutes, 0, 0)

    // Validate that the time is in the future
    if (snoozeTime <= new Date()) {
      setTimeError('Please select a future time')
      return
    }

    setTimeError(null)
    onSnooze(snoozeTime.toISOString())
    setIsOpen(false)
    setShowCustomPicker(false)
    setSelectedDate(undefined)
  }

  // Validate time when date or time changes
  React.useEffect(() => {
    if (!selectedDate) {
      setTimeError(null)
      return
    }

    const [hours, minutes] = selectedTime.split(':').map(Number)
    const snoozeTime = new Date(selectedDate)
    snoozeTime.setHours(hours, minutes, 0, 0)

    if (snoozeTime <= new Date()) {
      setTimeError('Please select a future time')
    } else {
      setTimeError(null)
    }
  }, [selectedDate, selectedTime])

  // Reset custom picker when closing
  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    if (!open) {
      setShowCustomPicker(false)
      setSelectedDate(undefined)
      setTimeError(null)
    }
  }

  // Get icon for preset
  const getPresetIcon = (presetId: string) => {
    switch (presetId) {
      case 'later-today':
        return <Moon className="h-4 w-4" />
      case 'tomorrow':
        return <Sun className="h-4 w-4" />
      case 'this-weekend':
        return <CalendarDays className="h-4 w-4" />
      case 'next-week':
        return <CalendarClock className="h-4 w-4" />
      default:
        return <Clock className="h-4 w-4" />
    }
  }

  // Default trigger
  const defaultTrigger = (
    <Button variant={variant} size={size} className={className} disabled={disabled} title="Snooze">
      <Clock className="h-4 w-4" />
      {size !== 'icon' && <span className="ml-2">Snooze</span>}
    </Button>
  )

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>{trigger || defaultTrigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
        {!showCustomPicker ? (
          <>
            {/* Preset Options */}
            {snoozePresets.map((preset) => {
              const time = preset.getTime()
              return (
                <DropdownMenuItem
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset)}
                  className="flex items-center gap-2"
                >
                  {getPresetIcon(preset.id)}
                  <div className="flex flex-col flex-1">
                    <span>{preset.label}</span>
                    <span className="text-xs text-muted-foreground">{formatSnoozeTime(time)}</span>
                  </div>
                </DropdownMenuItem>
              )
            })}

            <DropdownMenuSeparator />

            {/* Custom Date/Time Option */}
            <DropdownMenuItem
              onClick={(e) => {
                e.preventDefault()
                setShowCustomPicker(true)
              }}
              className="flex items-center gap-2"
            >
              <CalendarDays className="h-4 w-4" />
              <span>Pick Date & Time</span>
              <ChevronRight className="h-4 w-4 ml-auto" />
            </DropdownMenuItem>
          </>
        ) : (
          /* Custom Date/Time Picker */
          <div className="p-2 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustomPicker(false)}
                className="h-6 px-2"
              >
                &larr; Back
              </Button>
              <span>Pick Date & Time</span>
            </div>

            {/* Calendar */}
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              disabled={(date) => {
                // Compare only date portion (ignore time) to allow today
                const today = new Date()
                today.setHours(0, 0, 0, 0)
                const compareDate = new Date(date)
                compareDate.setHours(0, 0, 0, 0)
                return compareDate < today
              }}
              initialFocus
              className="rounded-md border"
            />

            {/* Time Picker */}
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <Input
                type="time"
                value={selectedTime}
                onChange={(e) => setSelectedTime(e.target.value)}
                className="flex-1"
              />
            </div>

            {/* Preview & Error */}
            {selectedDate && (
              <div
                className={`text-xs text-center ${timeError ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {timeError ||
                  (() => {
                    const [hours, minutes] = selectedTime.split(':').map(Number)
                    const previewDate = new Date(selectedDate)
                    previewDate.setHours(hours, minutes, 0, 0)
                    return formatSnoozeTime(previewDate)
                  })()}
              </div>
            )}

            <Button
              onClick={handleCustomSnooze}
              disabled={!selectedDate || !!timeError}
              className="w-full"
              size="sm"
            >
              Snooze
            </Button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// Quick Snooze Button (for inline use)
// ============================================================================

export interface QuickSnoozeButtonProps {
  /** Called when snooze is triggered */
  onSnooze: (snoozeUntil: string) => void
  /** Button label */
  label?: string
  /** Whether to show the label text (default: true) */
  showLabel?: boolean
  /** Whether the button is disabled */
  disabled?: boolean
}

/**
 * A snooze button that opens a dropdown with preset options
 * Click to open the dropdown and select a snooze time
 */
export function QuickSnoozeButton({
  onSnooze,
  label = 'Snooze',
  showLabel = true,
  disabled = false
}: QuickSnoozeButtonProps) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={(e) => {
        // Stop propagation to prevent row selection
        e.stopPropagation()
      }}
      className={showLabel ? undefined : 'p-1.5 h-auto'}
      aria-label="Snooze"
    >
      <Clock className={showLabel ? 'h-4 w-4 mr-1' : 'h-4 w-4'} />
      {showLabel && label}
    </Button>
  )

  // When showing label, just use the button directly
  // When icon-only, wrap the entire SnoozePicker in a Tooltip
  if (showLabel) {
    return <SnoozePicker onSnooze={onSnooze} disabled={disabled} trigger={button} />
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <SnoozePicker onSnooze={onSnooze} disabled={disabled} trigger={button} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Snooze</TooltipContent>
    </Tooltip>
  )
}

export default SnoozePicker
