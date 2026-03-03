import { Calendar, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface UpcomingEmptyStateProps {
  hasOverdue: boolean
  onAddTask: () => void
  className?: string
}

// ============================================================================
// UPCOMING EMPTY STATE COMPONENT
// ============================================================================

export const UpcomingEmptyState = ({
  hasOverdue,
  onAddTask,
  className
}: UpcomingEmptyStateProps): React.JSX.Element => {
  // If there are overdue tasks but nothing upcoming
  if (hasOverdue) {
    return (
      <div className={cn('text-center py-12', className)}>
        <div className="mb-4 rounded-full bg-muted p-4 inline-block">
          <Calendar className="size-8 text-text-tertiary" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">
          Nothing scheduled for the next 7 days
        </h3>
        <p className="text-sm text-text-tertiary mb-6 max-w-xs mx-auto">
          You have overdue tasks above. Plan ahead by adding tasks for the coming week.
        </p>
        <Button onClick={onAddTask} size="sm">
          <Plus className="size-4" aria-hidden="true" />
          Add task
        </Button>
      </div>
    )
  }

  // Completely clear
  return (
    <div className={cn('text-center py-16', className)}>
      {/* Icon */}
      <div className="mb-4 rounded-full bg-muted p-4 inline-block">
        <Calendar className="size-8 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="text-lg font-medium text-text-primary mb-2">No upcoming tasks</h3>

      {/* Description */}
      <p className="text-sm text-text-tertiary mb-6 max-w-sm mx-auto">
        Tasks due in the next 7 days will appear here. Plan your week by adding some tasks.
      </p>

      {/* Action button */}
      <Button onClick={onAddTask} size="default">
        <Plus className="size-4" aria-hidden="true" />
        Add task
      </Button>
    </div>
  )
}

export default UpcomingEmptyState
