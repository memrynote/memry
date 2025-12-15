/**
 * Snooze Menu Component
 *
 * A warm, elegant time selection dropdown for deferring items.
 * Features preset options with calculated times and a custom date picker.
 *
 * Aesthetic: Warm amber tones with soft gradients and refined typography.
 */

import { useState, useCallback } from 'react'
import {
  Sun,
  Sunrise,
  Coffee,
  Calendar,
  CalendarDays,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Calendar as CalendarPicker } from '@/components/ui/calendar'
import { Separator } from '@/components/ui/separator'
import {
  getSnoozeOptions,
  calculateSnoozeTime,
  type SnoozeOption,
} from '@/lib/snooze-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface SnoozeMenuProps {
  /** Controlled open state */
  open?: boolean
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void
  /** Callback when a snooze time is selected */
  onSnooze: (until: Date) => void
  /** Trigger element (defaults to Clock button) */
  trigger?: React.ReactNode
  /** Number of items being snoozed (for display) */
  itemCount?: number
  /** Alignment of popover */
  align?: 'start' | 'center' | 'end'
  /** Side of popover */
  side?: 'top' | 'right' | 'bottom' | 'left'
}

// ============================================================================
// ICON MAP
// ============================================================================

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Sun,
  Sunrise,
  Coffee,
  Calendar,
  CalendarDays,
}

// ============================================================================
// SNOOZE OPTION ROW
// ============================================================================

interface SnoozeOptionRowProps {
  option: SnoozeOption
  onClick: () => void
  index: number
}

function SnoozeOptionRow({
  option,
  onClick,
  index,
}: SnoozeOptionRowProps): React.JSX.Element {
  const Icon = iconMap[option.icon] || Clock

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 px-3 py-2.5',
        'rounded-lg transition-all duration-200',
        // Base state
        'bg-transparent',
        // Hover state with warm amber glow
        'hover:bg-gradient-to-r hover:from-amber-500/8 hover:to-orange-500/5',
        // Focus state
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40',
        // Animation stagger
        'animate-in fade-in-0 slide-in-from-left-2',
        option.id === 'custom' && 'mt-1'
      )}
      style={{
        animationDelay: `${index * 40}ms`,
        animationFillMode: 'backwards',
      }}
    >
      {/* Icon with amber accent */}
      <div
        className={cn(
          'flex size-8 items-center justify-center rounded-lg',
          'bg-gradient-to-br from-amber-500/10 to-orange-500/5',
          'border border-amber-500/10',
          'transition-all duration-200',
          'group-hover:from-amber-500/20 group-hover:to-orange-500/10',
          'group-hover:border-amber-500/20',
          'group-hover:shadow-sm group-hover:shadow-amber-500/10'
        )}
      >
        <Icon
          className={cn(
            'size-4 text-amber-600/80 dark:text-amber-400/80',
            'transition-colors duration-200',
            'group-hover:text-amber-600 dark:group-hover:text-amber-400'
          )}
        />
      </div>

      {/* Label and description */}
      <div className="flex flex-1 flex-col items-start">
        <span
          className={cn(
            'text-sm font-medium text-foreground/90',
            'transition-colors duration-200',
            'group-hover:text-foreground'
          )}
        >
          {option.label}
        </span>
        <span
          className={cn(
            'text-xs text-muted-foreground/70',
            'transition-colors duration-200',
            'group-hover:text-muted-foreground'
          )}
        >
          {option.description}
        </span>
      </div>

      {/* Subtle chevron indicator on hover */}
      <div
        className={cn(
          'size-4 opacity-0 transition-all duration-200',
          'group-hover:opacity-100 group-hover:translate-x-0.5',
          'text-amber-500/50'
        )}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
          <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </div>
    </button>
  )
}

// ============================================================================
// CUSTOM DATE PICKER VIEW
// ============================================================================

interface CustomDatePickerProps {
  onSelect: (date: Date) => void
  onBack: () => void
}

function CustomDatePicker({
  onSelect,
  onBack,
}: CustomDatePickerProps): React.JSX.Element {
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [selectedHour, setSelectedHour] = useState(9)

  const handleConfirm = useCallback(() => {
    if (selectedDate) {
      const finalDate = new Date(selectedDate)
      finalDate.setHours(selectedHour, 0, 0, 0)
      onSelect(finalDate)
    }
  }, [selectedDate, selectedHour, onSelect])

  const timeOptions = [
    { hour: 6, label: '6 AM' },
    { hour: 9, label: '9 AM' },
    { hour: 12, label: '12 PM' },
    { hour: 15, label: '3 PM' },
    { hour: 18, label: '6 PM' },
    { hour: 21, label: '9 PM' },
  ]

  return (
    <div className="animate-in fade-in-0 slide-in-from-right-4 duration-200">
      {/* Header */}
      <div className="flex items-center gap-2 px-1 pb-3">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            'flex size-7 items-center justify-center rounded-md',
            'text-muted-foreground hover:text-foreground',
            'hover:bg-accent transition-colors'
          )}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
            <path d="M9.78 11.78a.75.75 0 0 1-1.06 0L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 1.06L7.06 8l2.72 2.72a.75.75 0 0 1 0 1.06Z" />
          </svg>
        </button>
        <span className="text-sm font-medium text-foreground">
          Pick date & time
        </span>
      </div>

      {/* Calendar */}
      <div className="rounded-lg border border-border/50 bg-accent/30 p-1">
        <CalendarPicker
          mode="single"
          selected={selectedDate}
          onSelect={setSelectedDate}
          disabled={(date) => date < new Date()}
          className="mx-auto"
        />
      </div>

      {/* Time Selection */}
      <div className="mt-4 space-y-2">
        <label className="text-xs font-medium text-muted-foreground px-1">
          Time
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          {timeOptions.map(({ hour, label }) => (
            <button
              key={hour}
              type="button"
              onClick={() => setSelectedHour(hour)}
              className={cn(
                'px-3 py-2 rounded-md text-sm font-medium',
                'transition-all duration-150',
                'border',
                selectedHour === hour
                  ? [
                      'bg-gradient-to-br from-amber-500/20 to-orange-500/10',
                      'border-amber-500/30',
                      'text-amber-700 dark:text-amber-300',
                      'shadow-sm shadow-amber-500/10',
                    ]
                  : [
                      'bg-background/50 border-border/50',
                      'text-foreground/70',
                      'hover:bg-accent hover:border-border',
                    ]
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Confirm Button */}
      <Button
        onClick={handleConfirm}
        disabled={!selectedDate}
        className={cn(
          'w-full mt-4',
          'bg-gradient-to-r from-amber-500 to-orange-500',
          'hover:from-amber-600 hover:to-orange-600',
          'text-white font-medium',
          'shadow-md shadow-amber-500/20',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'transition-all duration-200'
        )}
      >
        <Clock className="size-4 mr-2" />
        {selectedDate
          ? `Snooze until ${selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${timeOptions.find((t) => t.hour === selectedHour)?.label}`
          : 'Select a date'}
      </Button>
    </div>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
  trigger,
  itemCount = 1,
  align = 'end',
  side = 'top',
}: SnoozeMenuProps): React.JSX.Element {
  const [showCustomPicker, setShowCustomPicker] = useState(false)
  const options = getSnoozeOptions()

  const handleOptionClick = useCallback(
    (option: SnoozeOption) => {
      if (option.id === 'custom') {
        setShowCustomPicker(true)
        return
      }

      const snoozeTime = calculateSnoozeTime(option.id)
      onSnooze(snoozeTime)
      onOpenChange?.(false)
    },
    [onSnooze, onOpenChange]
  )

  const handleCustomSelect = useCallback(
    (date: Date) => {
      onSnooze(date)
      setShowCustomPicker(false)
      onOpenChange?.(false)
    },
    [onSnooze, onOpenChange]
  )

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      onOpenChange?.(isOpen)
      if (!isOpen) {
        // Reset to main view when closing
        setTimeout(() => setShowCustomPicker(false), 200)
      }
    },
    [onOpenChange]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" className="size-8">
            <Clock className="size-4" />
          </Button>
        )}
      </PopoverTrigger>

      <PopoverContent
        align={align}
        side={side}
        sideOffset={8}
        className={cn(
          'w-72 p-0 overflow-hidden',
          // Warm gradient border effect
          'border-amber-500/10',
          // Subtle inner glow
          'shadow-lg shadow-amber-500/5',
          'bg-gradient-to-b from-background to-background/95'
        )}
      >
        <div className="p-3">
          {showCustomPicker ? (
            <CustomDatePicker
              onSelect={handleCustomSelect}
              onBack={() => setShowCustomPicker(false)}
            />
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-2 px-1 pb-3">
                <div
                  className={cn(
                    'flex size-7 items-center justify-center rounded-lg',
                    'bg-gradient-to-br from-amber-500/15 to-orange-500/10',
                    'border border-amber-500/20'
                  )}
                >
                  <Clock className="size-3.5 text-amber-600 dark:text-amber-400" />
                </div>
                <span className="text-sm font-semibold text-foreground">
                  Snooze {itemCount > 1 ? `${itemCount} items` : 'until...'}
                </span>
              </div>

              {/* Divider with gradient */}
              <div
                className={cn(
                  'h-px mx-1 mb-2',
                  'bg-gradient-to-r from-transparent via-amber-500/20 to-transparent'
                )}
              />

              {/* Options */}
              <div className="space-y-0.5">
                {options.slice(0, 4).map((option, index) => (
                  <SnoozeOptionRow
                    key={option.id}
                    option={option}
                    onClick={() => handleOptionClick(option)}
                    index={index}
                  />
                ))}

                {/* Divider before custom */}
                <Separator className="my-2 bg-border/50" />

                {/* Custom option */}
                <SnoozeOptionRow
                  option={options[4]}
                  onClick={() => handleOptionClick(options[4])}
                  index={4}
                />
              </div>
            </>
          )}
        </div>

        {/* Bottom accent bar */}
        <div
          className={cn(
            'h-0.5',
            'bg-gradient-to-r from-amber-500/40 via-orange-500/30 to-amber-500/40'
          )}
        />
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// COMPACT TRIGGER BUTTON
// ============================================================================

export interface SnoozeButtonProps {
  onClick: () => void
  disabled?: boolean
  className?: string
}

export function SnoozeButton({
  onClick,
  disabled,
  className,
}: SnoozeButtonProps): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-8 gap-1.5 px-2.5',
        'text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400',
        'hover:bg-amber-500/10',
        'transition-colors duration-150',
        className
      )}
    >
      <Clock className="size-3.5" />
      <span className="text-sm">Snooze</span>
    </Button>
  )
}
