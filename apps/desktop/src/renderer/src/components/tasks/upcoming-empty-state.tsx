import { Calendar, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  // If there are overdue tasks but nothing upcoming
  if (hasOverdue) {
    return (
      <div className={cn('text-center py-12', className)}>
        <div className="mb-4 rounded-full bg-muted p-4 inline-block">
          <Calendar className="size-8 text-text-tertiary" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-medium text-text-primary mb-2">
          {tPhaseF('phaseF.componentsTasksUpcomingEmptyState.nothingScheduledForTheNext7Days')}
        </h3>
        <p className="text-sm text-text-tertiary mb-6 max-w-xs mx-auto">
          {tPhaseF(
            'phaseF.componentsTasksUpcomingEmptyState.youHaveOverdueTasksAbovePlanAheadByAddingTasksForTheComi'
          )}
        </p>
        <Button onClick={onAddTask} size="sm">
          <Plus className="size-4" aria-hidden="true" />

          {tPhaseF('phaseF.componentsTasksUpcomingEmptyState.addTask')}
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
      <h3 className="text-lg font-medium text-text-primary mb-2">
        {tPhaseF('phaseF.componentsTasksUpcomingEmptyState.noUpcomingTasks')}
      </h3>

      {/* Description */}
      <p className="text-sm text-text-tertiary mb-6 max-w-sm mx-auto">
        {tPhaseF(
          'phaseF.componentsTasksUpcomingEmptyState.tasksDueInTheNext7DaysWillAppearHerePlanYourWeekByAdding'
        )}
      </p>

      {/* Action button */}
      <Button onClick={onAddTask} size="default">
        <Plus className="size-4" aria-hidden="true" />

        {tPhaseF('phaseF.componentsTasksUpcomingEmptyState.addTask2')}
      </Button>
    </div>
  )
}

export default UpcomingEmptyState
