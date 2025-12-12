/**
 * JournalMonthView Component
 * Displays all journal entries for a specific month in a simple list
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { getDaysInMonth, formatDateParts, getTodayString } from '@/lib/journal-utils'
import { JournalEntryListItem } from './journal-entry-list-item'
import type { HeatmapEntry } from './calendar-heatmap'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalEntryData {
  /** Preview text for the entry */
  preview?: string
  /** Character count */
  characterCount: number
}

export interface JournalMonthViewProps {
  /** Year to display */
  year: number
  /** Month index (0-11) */
  month: number
  /** Map of date string to entry data */
  entries: Map<string, JournalEntryData>
  /** Heatmap data for activity levels */
  heatmapData: HeatmapEntry[]
  /** Callback when a day is clicked */
  onDayClick: (date: string) => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// COMPONENT
// =============================================================================

export function JournalMonthView({
  year,
  month,
  entries,
  heatmapData,
  onDayClick,
  className,
}: JournalMonthViewProps): React.JSX.Element {
  const today = getTodayString()

  // Build heatmap lookup
  const heatmapLookup = useMemo(() => {
    const lookup = new Map<string, HeatmapEntry>()
    heatmapData.forEach(entry => lookup.set(entry.date, entry))
    return lookup
  }, [heatmapData])

  // Get all days in the month
  const days = useMemo(() => getDaysInMonth(year, month), [year, month])

  // Reverse to show most recent first
  const reversedDays = useMemo(() => [...days].reverse(), [days])

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {/* Day List */}
      <div className="flex flex-col">
        {reversedDays.map(dayData => {
          const dateParts = formatDateParts(dayData.date)
          const entryData = entries.get(dayData.date)
          const heatmapEntry = heatmapLookup.get(dayData.date)
          const heatmapLevel = heatmapEntry?.level ?? 0

          return (
            <JournalEntryListItem
              key={dayData.date}
              day={dateParts.day}
              dayName={dateParts.dayName}
              date={dayData.date}
              preview={entryData?.preview}
              heatmapLevel={heatmapLevel}
              isToday={dayData.date === today}
              isFuture={dayData.isFuture}
              onClick={() => onDayClick(dayData.date)}
            />
          )
        })}
      </div>

      {/* Empty State */}
      {days.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-muted-foreground">No days in this month</p>
        </div>
      )}
    </div>
  )
}

export default JournalMonthView
