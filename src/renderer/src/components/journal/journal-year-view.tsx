/**
 * JournalYearView Component
 * Displays all months in a year as a 3x4 grid of cards
 */

import { cn } from '@/lib/utils'
import type { MonthStat } from '@/lib/journal-utils'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalYearViewProps {
  /** Year to display */
  year: number
  /** Month statistics for the year */
  monthStats: MonthStat[]
  /** Current month (0-11) for highlighting */
  currentMonth?: number
  /** Callback when a month is clicked */
  onMonthClick: (month: number) => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// HEATMAP COLORS
// =============================================================================

const HEATMAP_COLORS = {
  0: 'bg-border/30',
  1: 'bg-[#9be9a8]',
  2: 'bg-[#40c463]',
  3: 'bg-[#30a14e]',
  4: 'bg-[#216e39]',
} as const

// =============================================================================
// MONTH CARD COMPONENT
// =============================================================================

interface MonthCardProps {
  stat: MonthStat
  isCurrent: boolean
  onClick: () => void
}

function MonthCard({ stat, isCurrent, onClick }: MonthCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // Base styling
        "flex flex-col items-center gap-2 p-4 rounded-xl",
        "border border-border/40 bg-card",
        "transition-all duration-150",
        // Hover state
        "hover:border-accent-purple/40 hover:bg-accent-purple/5 hover:shadow-sm",
        // Focus state
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-purple/50",
        // Active state
        "active:scale-[0.98]",
        // Current month highlight
        isCurrent && "ring-1 ring-accent-purple/30 bg-accent-purple/5"
      )}
    >
      {/* Month Name */}
      <span
        className={cn(
          "text-base font-medium",
          isCurrent ? "text-accent-purple" : "text-foreground"
        )}
      >
        {stat.monthName.slice(0, 3)}
      </span>

      {/* Entry Count */}
      <span className="text-xs text-muted-foreground">
        {stat.entryCount} {stat.entryCount === 1 ? 'day' : 'days'}
      </span>

      {/* Activity Dots */}
      <div className="flex items-center gap-1">
        {stat.activityDots.map((level, index) => (
          <span
            key={index}
            className={cn(
              "size-2 rounded-full",
              HEATMAP_COLORS[level]
            )}
          />
        ))}
        {/* Fill remaining dots if less than 5 */}
        {Array.from({ length: Math.max(0, 5 - stat.activityDots.length) }).map((_, index) => (
          <span
            key={`empty-${index}`}
            className="size-2 rounded-full bg-border/30"
          />
        ))}
      </div>
    </button>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function JournalYearView({
  year,
  monthStats,
  currentMonth,
  onMonthClick,
  className,
}: JournalYearViewProps): React.JSX.Element {
  // Get current month from date if not provided
  const currentMonthIndex = currentMonth ?? new Date().getMonth()
  const currentYear = new Date().getFullYear()
  const isCurrentYear = year === currentYear

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {/* Month Grid - 3x4 */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
        {monthStats.map(stat => (
          <MonthCard
            key={stat.month}
            stat={stat}
            isCurrent={isCurrentYear && stat.month === currentMonthIndex}
            onClick={() => onMonthClick(stat.month)}
          />
        ))}
      </div>

      {/* Year Summary */}
      <div className="flex items-center justify-center gap-6 pt-4 border-t border-border/40">
        <div className="text-center">
          <p className="text-2xl font-medium text-foreground">
            {monthStats.reduce((sum, s) => sum + s.entryCount, 0)}
          </p>
          <p className="text-xs text-muted-foreground">days with entries</p>
        </div>
        <div className="w-px h-8 bg-border/40" />
        <div className="text-center">
          <p className="text-2xl font-medium text-foreground">
            {Math.round(monthStats.reduce((sum, s) => sum + s.totalChars, 0) / 1000)}k
          </p>
          <p className="text-xs text-muted-foreground">characters written</p>
        </div>
      </div>
    </div>
  )
}

export default JournalYearView
