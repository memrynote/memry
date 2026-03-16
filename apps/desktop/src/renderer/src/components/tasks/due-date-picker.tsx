import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Calendar as CalendarIcon, Star, X, Clock, Plus, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DatePickerCalendar } from './date-picker-calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { TimePicker } from './time-picker'
import { NaturalDateInput, type NaturalDateInputRef } from './natural-date-input'
import { cn } from '@/lib/utils'
import {
  startOfDay,
  addDays,
  formatDateShort,
  formatDayName,
  formatTime,
  isSameDay,
  isBefore,
  type DueDateStatus
} from '@/lib/task-utils'
import { nextSaturday, nextMonday, type ParsedDateResult } from '@/lib/natural-date-parser'

// ============================================================================
// TYPES
// ============================================================================

interface DueDatePickerProps {
  date: Date | null
  time: string | null
  onDateChange: (date: Date | null) => void
  onTimeChange: (time: string | null) => void
  className?: string
}

// ============================================================================
// QUICK DATE OPTIONS
// ============================================================================

interface QuickDateOption {
  id: string
  label: string
  icon: React.ReactNode
  getDate: () => Date
  shortcutNumber: number // Number shortcut (1-4)
}

const getQuickDateOptions = (): QuickDateOption[] => {
  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const saturday = nextSaturday(today)
  const monday = nextMonday(today)

  // Don't show "This Weekend" if it's already Saturday or Sunday
  const isWeekend = today.getDay() === 0 || today.getDay() === 6
  const showWeekend = !isWeekend

  const options: QuickDateOption[] = [
    {
      id: 'today',
      label: 'Today',
      icon: <Star className="size-4 text-task-star" />,
      getDate: () => today,
      shortcutNumber: 1
    },
    {
      id: 'tomorrow',
      label: 'Tomorrow',
      icon: <CalendarIcon className="size-4 text-task-due-tomorrow" />,
      getDate: () => tomorrow,
      shortcutNumber: 2
    }
  ]

  if (showWeekend) {
    options.push({
      id: 'weekend',
      label: 'This Weekend',
      icon: <Sun className="size-4 text-task-due-today" />,
      getDate: () => saturday,
      shortcutNumber: 3
    })

    options.push({
      id: 'next-week',
      label: 'Next Week',
      icon: <CalendarIcon className="size-4 text-task-due-upcoming" />,
      getDate: () => monday,
      shortcutNumber: 4
    })
  } else {
    // If weekend, Next Week becomes option 3
    options.push({
      id: 'next-week',
      label: 'Next Week',
      icon: <CalendarIcon className="size-4 text-task-due-upcoming" />,
      getDate: () => monday,
      shortcutNumber: 3
    })
  }

  return options
}

// ============================================================================
// DATE DISPLAY HELPERS
// ============================================================================

/**
 * Format date for display in trigger button
 */
const formatSelectedDate = (date: Date): { text: string; status: DueDateStatus } => {
  const today = startOfDay(new Date())
  const selectedDate = startOfDay(date)

  // Overdue
  if (isBefore(selectedDate, today)) {
    return { text: formatDateShort(date), status: 'overdue' }
  }

  // Today
  if (isSameDay(selectedDate, today)) {
    return { text: 'Today', status: 'today' }
  }

  // Tomorrow
  const tomorrow = addDays(today, 1)
  if (isSameDay(selectedDate, tomorrow)) {
    return { text: 'Tomorrow', status: 'tomorrow' }
  }

  // This week (next 7 days)
  const weekFromNow = addDays(today, 7)
  if (isBefore(selectedDate, weekFromNow)) {
    return { text: formatDayName(date), status: 'upcoming' }
  }

  // Later
  return { text: formatDateShort(date), status: 'later' }
}

/**
 * Format date for quick option display (Mon, Dec 16)
 */
const formatQuickOptionDate = (date: Date): string => {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ============================================================================
// STATUS COLORS
// ============================================================================

const statusColors: Record<DueDateStatus, string> = {
  overdue: 'text-task-due-overdue',
  today: 'text-task-due-today',
  tomorrow: 'text-task-due-tomorrow',
  upcoming: 'text-foreground',
  later: 'text-muted-foreground',
  none: 'text-muted-foreground'
}

// ============================================================================
// DUE DATE PICKER COMPONENT
// ============================================================================

export const DueDatePicker = ({
  date,
  time,
  onDateChange,
  onTimeChange,
  className
}: DueDatePickerProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [showCalendar, setShowCalendar] = useState(false)
  const [showTimePicker, setShowTimePicker] = useState(!!time)
  const [inputValue, setInputValue] = useState('') // Track input value for conditional shortcuts
  const triggerRef = useRef<HTMLButtonElement>(null)
  const naturalDateInputRef = useRef<NaturalDateInputRef>(null)

  const quickOptions = useMemo(() => getQuickDateOptions(), [])

  // Determine date display status
  const dateDisplay = useMemo(() => {
    if (!date) return null
    return formatSelectedDate(date)
  }, [date])

  // Check if input is empty (for conditional shortcuts)
  const inputIsEmpty = inputValue.trim() === ''

  // Reset state when popover closes
  useEffect(() => {
    if (!isOpen) {
      setShowCalendar(false)
      setInputValue('') // Reset input tracking
    }
  }, [isOpen])

  // Reset time picker visibility when time changes
  useEffect(() => {
    setShowTimePicker(!!time)
  }, [time])

  const handleQuickSelect = useCallback(
    (getDate: () => Date): void => {
      onDateChange(getDate())
      setShowCalendar(false)
      setIsOpen(false)
    },
    [onDateChange]
  )

  const selectQuickOptionByIndex = useCallback(
    (index: number): void => {
      const option = quickOptions[index]
      if (option) {
        handleQuickSelect(option.getDate)
      }
    },
    [quickOptions, handleQuickSelect]
  )

  const handleCalendarSelect = useCallback(
    (selectedDate: Date | undefined): void => {
      if (selectedDate) {
        onDateChange(selectedDate)
        setShowCalendar(false)
        setIsOpen(false)
      }
    },
    [onDateChange]
  )

  const handleNaturalDateSelect = useCallback(
    (result: ParsedDateResult): void => {
      onDateChange(result.date)
      if (result.time) {
        onTimeChange(result.time)
      }
      setIsOpen(false)
    },
    [onDateChange, onTimeChange]
  )

  const handleRemoveDate = useCallback((): void => {
    onDateChange(null)
    onTimeChange(null)
    setShowTimePicker(false)
    setIsOpen(false)
  }, [onDateChange, onTimeChange])

  const handleToggleTimePicker = useCallback((): void => {
    if (!showTimePicker) {
      // Default to 9:00 AM when adding time
      onTimeChange('09:00')
      setShowTimePicker(true)
    } else {
      onTimeChange(null)
      setShowTimePicker(false)
    }
  }, [showTimePicker, onTimeChange])

  // Track input value changes from NaturalDateInput
  const handleInputChange = useCallback((value: string): void => {
    setInputValue(value)
  }, [])

  // Context-aware keyboard shortcuts handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!isOpen) return

      // MODIFIER SHORTCUTS - Always work (Cmd/Ctrl + Backspace to clear)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
        e.preventDefault()
        handleRemoveDate()
        return
      }

      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
        return
      }

      // NUMBER SHORTCUTS - Only when input is empty
      // This prevents shortcuts from interfering with natural language typing
      if (inputIsEmpty) {
        const key = e.key

        // 1-4 select quick options
        if (/^[1-4]$/.test(key)) {
          e.preventDefault()
          selectQuickOptionByIndex(parseInt(key, 10) - 1)
          return
        }

        // 0 clears the date
        if (key === '0') {
          e.preventDefault()
          handleRemoveDate()
          return
        }
      }

      // ALL OTHER KEYS - Let them type normally
      // Do NOT prevent default - characters will be typed into input
    },
    [isOpen, inputIsEmpty, selectQuickOptionByIndex, handleRemoveDate]
  )

  // Add keyboard listener when popover is open
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    } else {
      document.removeEventListener('keydown', handleKeyDown)
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          role="combobox"
          aria-expanded={isOpen}
          aria-label="Select due date"
          className={cn(
            'w-full justify-start text-left font-normal',
            !date && 'text-muted-foreground',
            dateDisplay && statusColors[dateDisplay.status],
            className
          )}
        >
          <CalendarIcon className="mr-2 size-4 shrink-0" />
          {date ? (
            <span className="truncate">
              {dateDisplay?.text}
              {time && <span className="ml-1 text-muted-foreground">· {formatTime(time)}</span>}
              {dateDisplay?.status === 'overdue' && (
                <span className="ml-1 text-xs opacity-80">· Overdue</span>
              )}
            </span>
          ) : (
            <span>Set due date</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0" align="start">
        {!showCalendar ? (
          <div className="flex flex-col">
            {/* Natural Language Input */}
            <div className="p-3">
              <NaturalDateInput
                ref={naturalDateInputRef}
                onSelect={handleNaturalDateSelect}
                onInputChange={handleInputChange}
              />
            </div>

            <Separator />

            {/* Quick Options */}
            <div className="p-1">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Suggestions
              </div>
              {quickOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleQuickSelect(option.getDate)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm transition-colors',
                    'hover:bg-accent focus:bg-accent focus:outline-none'
                  )}
                >
                  <span className="flex items-center gap-2">
                    {option.icon}
                    <span>{option.label}</span>
                  </span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span className="text-xs">{formatQuickOptionDate(option.getDate())}</span>
                    {/* Number hint - only show when input is empty */}
                    {inputIsEmpty && (
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 text-[10px] font-medium">
                        {option.shortcutNumber}
                      </kbd>
                    )}
                  </span>
                </button>
              ))}
            </div>

            <Separator />

            {/* Pick a Date Option */}
            <div className="p-1">
              <button
                type="button"
                onClick={() => setShowCalendar(true)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-sm transition-colors',
                  'hover:bg-accent focus:bg-accent focus:outline-none'
                )}
              >
                <CalendarIcon className="size-4 text-muted-foreground" />
                <span>Pick a date...</span>
              </button>
            </div>

            {/* Selected Date Actions */}
            {date && (
              <>
                <Separator />

                <div className="flex flex-col gap-1 p-3">
                  {/* Current selected date */}
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarIcon className="size-4 text-muted-foreground" />
                    <span className="font-medium">
                      {date.toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric'
                      })}
                    </span>
                  </div>

                  {/* Time Picker Toggle */}
                  {!showTimePicker ? (
                    <button
                      type="button"
                      onClick={handleToggleTimePicker}
                      className={cn(
                        'mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground transition-colors',
                        'hover:bg-accent hover:text-foreground focus:bg-accent focus:outline-none'
                      )}
                    >
                      <Plus className="size-4" />
                      <span>Add time</span>
                    </button>
                  ) : (
                    <div className="mt-2">
                      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <Clock className="size-3" />
                        <span>Time</span>
                      </div>
                      <TimePicker value={time} onChange={onTimeChange} />
                    </div>
                  )}
                </div>

                <Separator />

                {/* Remove Date Option */}
                <div className="p-1">
                  <button
                    type="button"
                    onClick={handleRemoveDate}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2 py-2 text-sm text-destructive transition-colors',
                      'hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none'
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <X className="size-4" />
                      <span>Clear date</span>
                    </span>
                    {/* Number hint for clear - only show when input is empty */}
                    {inputIsEmpty && (
                      <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                        0
                      </kbd>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            {/* Back button */}
            <button
              type="button"
              onClick={() => setShowCalendar(false)}
              className={cn(
                'flex items-center gap-2 border-b border-border px-3 py-2 text-sm transition-colors',
                'hover:bg-accent focus:bg-accent focus:outline-none'
              )}
            >
              <span className="text-muted-foreground">←</span>
              <span>Back to options</span>
            </button>

            {/* Calendar */}
            <DatePickerCalendar
              selected={date || undefined}
              onSelect={handleCalendarSelect}
              className="p-2"
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default DueDatePicker
