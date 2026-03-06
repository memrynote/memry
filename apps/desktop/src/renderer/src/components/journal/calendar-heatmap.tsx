/**
 * Journal Calendar with Heatmap
 * Extends shadcn Calendar with GitHub-style activity dots
 */

import { useMemo, useState, useCallback } from 'react'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, getDefaultClassNames } from 'react-day-picker'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

import { parseISODate, getTodayString } from '@/lib/journal-utils'

// =============================================================================
// TYPES
// =============================================================================

export interface HeatmapEntry {
  date: string // "2024-12-15"
  characterCount: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface JournalCalendarProps {
  /** Currently selected/active date */
  selectedDate: string
  /** Callback when a day is clicked */
  onDayClick: (date: string) => void
  /** Heatmap data for displaying activity */
  heatmapData?: HeatmapEntry[]
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// HEATMAP UTILS
// =============================================================================

const HEATMAP_COLORS = {
  0: 'transparent',
  1: '#9be9a8', // Very light green
  2: '#40c463', // Light green
  3: '#30a14e', // Medium green
  4: '#216e39' // Dark green
} as const

export function getHeatmapLevel(charCount: number): 0 | 1 | 2 | 3 | 4 {
  if (charCount === 0) return 0
  if (charCount <= 100) return 1
  if (charCount <= 500) return 2
  if (charCount <= 1000) return 3
  return 4
}

// =============================================================================
// COMPONENT
// =============================================================================

const EMPTY_HEATMAP: HeatmapEntry[] = []

export function JournalCalendar({
  selectedDate,
  onDayClick,
  heatmapData = EMPTY_HEATMAP,
  className
}: JournalCalendarProps): React.JSX.Element {
  const today = getTodayString()
  const selectedDateObj = parseISODate(selectedDate)

  // Track displayed month
  const [displayMonth, setDisplayMonth] = useState<Date>(selectedDateObj)

  // Build heatmap lookup
  const heatmapLookup = useMemo(() => {
    const lookup = new Map<string, HeatmapEntry>()
    heatmapData.forEach((entry) => lookup.set(entry.date, entry))
    return lookup
  }, [heatmapData])

  // Handle day click - receives ISO date string directly from custom DayButton
  const handleDayClickWithISODate = useCallback(
    (isoDate: string) => {
      onDayClick(isoDate)
    },
    [onDayClick]
  )

  // Handle month navigation
  const handlePrevMonth = useCallback(() => {
    setDisplayMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  }, [])

  const handleNextMonth = useCallback(() => {
    setDisplayMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
  }, [])

  // Get month/year display
  const monthYearDisplay = displayMonth.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  })

  const defaultClassNames = getDefaultClassNames()

  // Activity level descriptions for accessibility
  const getActivityDescription = (level: number, charCount: number): string => {
    if (level === 0) return 'No journal entry'
    if (level === 1) return `Light activity (${charCount} characters)`
    if (level === 2) return `Moderate activity (${charCount} characters)`
    if (level === 3) return `Good activity (${charCount} characters)`
    return `High activity (${charCount} characters)`
  }

  return (
    <div
      className={cn('rounded-lg border border-border/40 bg-card', className)}
      role="region"
      aria-label="Journal calendar with activity heatmap"
    >
      {/* Custom Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium" id="calendar-heading">
            {monthYearDisplay}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handlePrevMonth}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleNextMonth}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Calendar Grid */}
      <div className="p-3">
        <DayPicker
          mode="single"
          month={displayMonth}
          onMonthChange={setDisplayMonth}
          selected={selectedDateObj}
          showOutsideDays
          fixedWeeks
          weekStartsOn={1} // Monday
          hideNavigation
          classNames={{
            root: 'w-full',
            months: 'flex flex-col',
            month: 'flex flex-col gap-2',
            month_caption: 'hidden', // We use custom header
            nav: 'hidden', // We use custom nav
            weekdays: 'flex',
            weekday: cn(
              'text-muted-foreground flex-1 text-center text-[0.7rem] font-normal select-none',
              defaultClassNames.weekday
            ),
            week: 'flex mt-1',
            day: cn(
              'group/day relative flex-1 aspect-square p-0 text-center select-none',
              defaultClassNames.day
            ),
            outside: 'text-muted-foreground/40',
            disabled: 'text-muted-foreground opacity-50',
            hidden: 'invisible',
            today: '' // We handle today styling in custom component
          }}
          components={{
            DayButton: ({ day, modifiers, ...buttonProps }) => {
              // Use day.isoDate directly - this is the stable yyyy-MM-dd format
              // provided by react-day-picker, avoiding timezone issues
              const dateStr = day.isoDate
              const isToday = dateStr === today
              const isSelected = dateStr === selectedDate
              const heatmapEntry = heatmapLookup.get(dateStr)
              const heatmapLevel = heatmapEntry?.level ?? 0

              // Generate accessible label for the day
              const dateLabel = day.date.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric'
              })
              const activityLabel = getActivityDescription(
                heatmapLevel,
                heatmapEntry?.characterCount ?? 0
              )
              const ariaLabel = isToday
                ? `${dateLabel} (Today). ${activityLabel}`
                : `${dateLabel}. ${activityLabel}`

              return (
                <button
                  {...buttonProps}
                  type="button"
                  className={cn(
                    'flex flex-col items-center justify-center gap-0.5 w-full h-full rounded-md',
                    'text-xs font-normal transition-colors',
                    'hover:bg-accent/50',
                    // Today ring
                    isToday && !isSelected && 'ring-1 ring-primary/50',
                    // Selected filled
                    isSelected && 'bg-primary text-primary-foreground hover:bg-primary/90',
                    // Outside month
                    modifiers.outside && 'text-muted-foreground/40'
                  )}
                  onClick={(e) => {
                    // Call DayPicker's built-in handler first
                    buttonProps.onClick?.(e)
                    // Then trigger our custom navigation
                    handleDayClickWithISODate(dateStr)
                  }}
                  aria-selected={isSelected}
                  aria-label={ariaLabel}
                  aria-current={isToday ? 'date' : undefined}
                >
                  <span aria-hidden="true">{day.date.getDate()}</span>
                  {/* Heatmap dot */}
                  {heatmapLevel > 0 && (
                    <span
                      className="size-1.5 rounded-full"
                      style={{ backgroundColor: HEATMAP_COLORS[heatmapLevel] }}
                      aria-hidden="true"
                    />
                  )}
                </button>
              )
            }
          }}
        />
      </div>
    </div>
  )
}

export default JournalCalendar
