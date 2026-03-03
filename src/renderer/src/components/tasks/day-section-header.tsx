import { cn } from '@/lib/utils'
import { getDayHeaderText, isSameDay, startOfDay } from '@/lib/task-utils'

// ============================================================================
// TYPES
// ============================================================================

interface DaySectionHeaderProps {
  date: Date
  taskCount: number
  className?: string
}

// ============================================================================
// DAY SECTION HEADER COMPONENT
// ============================================================================

export const DaySectionHeader = ({
  date,
  taskCount,
  className
}: DaySectionHeaderProps): React.JSX.Element => {
  const { primary, secondary } = getDayHeaderText(date)
  const isToday = isSameDay(date, startOfDay(new Date()))
  const isTomorrow = isSameDay(date, new Date(Date.now() + 86400000))

  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-2.5 border-b border-border/50',
        isToday && 'bg-amber-50/50 dark:bg-amber-950/20',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'font-semibold text-sm uppercase tracking-wide',
            isToday && 'text-amber-700 dark:text-amber-500',
            isTomorrow && 'text-blue-600 dark:text-blue-400',
            !isToday && !isTomorrow && 'text-text-secondary'
          )}
        >
          {primary}
        </span>
        <span className="text-sm text-text-tertiary">· {secondary}</span>
      </div>

      <span
        className={cn(
          'text-xs px-2 py-0.5 rounded-full font-medium',
          taskCount > 0
            ? isToday
              ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-500'
              : 'bg-muted text-text-secondary'
            : 'text-text-tertiary'
        )}
      >
        {taskCount}
      </span>
    </div>
  )
}

export default DaySectionHeader
