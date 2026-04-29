/**
 * JournalEntryListItem Component
 * Displays a single journal entry in the month list view
 */

import { cn } from '@/lib/utils'
import { createJournalDateLabels, parseISODate } from '@/lib/journal-utils'
import { useT } from '@memry/i18n/renderer'
import { useMemo } from 'react'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalEntryListItemProps {
  /** Day number (1-31) */
  day: number
  /** Day name (Monday, Tuesday, etc.) */
  dayName: string
  /** ISO date string for the entry */
  date: string
  /** Preview text (truncated content) */
  preview?: string
  /** Heatmap activity level (0-4) */
  heatmapLevel: 0 | 1 | 2 | 3 | 4
  /** Whether this is today */
  isToday?: boolean
  /** Whether this is in the future */
  isFuture?: boolean
  /** Click handler */
  onClick: () => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// HEATMAP COLORS (from calendar-heatmap.tsx)
// =============================================================================

const HEATMAP_COLORS = {
  0: 'transparent',
  1: '#9be9a8', // Very light green
  2: '#40c463', // Light green
  3: '#30a14e', // Medium green
  4: '#216e39' // Dark green
} as const

// =============================================================================
// COMPONENT
// =============================================================================

export function JournalEntryListItem({
  day,
  dayName: _dayName,
  date,
  preview,
  heatmapLevel,
  isToday = false,
  isFuture = false,
  onClick,
  className
}: JournalEntryListItemProps): React.JSX.Element {
  const { t, i18n } = useT('journal')
  const dateLabels = useMemo(() => createJournalDateLabels(t), [t, i18n.language])
  const hasEntry = heatmapLevel > 0
  const weekdayShort = dateLabels.weekdaysShort[parseISODate(date).getDay()]

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Base styling
        'w-full flex items-center gap-3 px-3 py-2.5 text-left',
        'rounded-md transition-all duration-150',
        // Hover state
        'hover:bg-muted/60',
        // Focus state
        'focus-visible:outline-none',
        // Today highlight
        isToday && 'bg-accent-purple/5 ring-1 ring-accent-purple/20',
        // Future styling
        isFuture && !isToday && 'opacity-60',
        // No entry muted
        !hasEntry && !isFuture && 'opacity-50',
        className
      )}
    >
      {/* Activity Dot */}
      <div className="flex-shrink-0 w-3 flex items-center justify-center">
        {hasEntry ? (
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: HEATMAP_COLORS[heatmapLevel] }}
          />
        ) : (
          <span className="size-2 rounded-full border border-border/50" />
        )}
      </div>

      {/* Day Number + Name */}
      <div className="flex-shrink-0 w-24 flex items-baseline gap-2">
        <span
          className={cn(
            'text-lg font-medium tabular-nums',
            isToday ? 'text-accent-purple' : 'text-foreground'
          )}
        >
          {day}
        </span>
        <span className="text-sm text-muted-foreground truncate">{weekdayShort}</span>
      </div>

      {/* Preview Text */}
      <div className="flex-1 min-w-0">
        {hasEntry && preview ? (
          <p className="text-sm text-muted-foreground truncate">{preview}</p>
        ) : isFuture ? (
          <p className="text-sm text-muted-foreground/60 italic">{t('date.relative.future')}</p>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic">{t('empty.noEntry')}</p>
        )}
      </div>

      {/* Today Badge */}
      {isToday && (
        <span className="flex-shrink-0 text-xs font-medium text-accent-purple px-2 py-0.5 rounded-full bg-accent-purple/10">
          {t('date.relative.today')}
        </span>
      )}
    </button>
  )
}

export default JournalEntryListItem
