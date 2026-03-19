import { CalendarDays, Plus, Check } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface TodayEmptyStateProps {
  hasOverdue: boolean
  onAddTask: () => void
  className?: string
}

// ============================================================================
// TODAY EMPTY STATE COMPONENT
// ============================================================================

export const TodayEmptyState = ({
  hasOverdue,
  onAddTask,
  className
}: TodayEmptyStateProps): React.JSX.Element => {
  // If there are overdue tasks but nothing for today
  if (hasOverdue) {
    return (
      <div className={cn('text-center py-12', className)}>
        <div className="mb-4 mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
          <CalendarDays className="size-5 text-text-tertiary" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">Nothing scheduled for today</h3>
        <p className="text-sm text-text-tertiary mb-6 max-w-xs mx-auto">
          You have overdue tasks above. Add some tasks for today or check your upcoming list.
        </p>
        <Button onClick={onAddTask} size="sm" variant="outline">
          <Plus className="size-4" aria-hidden="true" />
          Add task for today
        </Button>
      </div>
    )
  }

  // Completely clear - calm, quiet satisfaction state
  return (
    <div className={cn('text-center py-20', className)}>
      {/* Subtle checkmark icon */}
      <div className="mb-6 mx-auto w-16 h-16 rounded-full bg-task-complete/[0.08] flex items-center justify-center">
        <Check className="size-7 text-task-complete" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="text-lg font-medium text-text-primary mb-2">All caught up for today</h3>

      {/* Subtitle */}
      <p className="text-sm text-text-tertiary mb-8 max-w-xs mx-auto">
        You have nothing scheduled. Enjoy the clarity.
      </p>

      {/* Action buttons */}
      <div className="flex flex-col items-center gap-3">
        <Button onClick={onAddTask} variant="outline" size="sm">
          <Plus className="size-4" aria-hidden="true" />
          Add task for today
        </Button>
      </div>
    </div>
  )
}

export default TodayEmptyState
