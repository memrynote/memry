import { Calendar, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface PlanningEmptyStateProps {
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Optional callback to view calendar */
  onViewCalendar?: () => void
  /** Additional class names */
  className?: string
}

/**
 * A planning-oriented empty state for the UPCOMING section.
 * Encourages users to plan ahead with clear call-to-actions.
 */
export const PlanningEmptyState = ({
  onAddTask,
  onViewCalendar,
  className
}: PlanningEmptyStateProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  return (
    <div className={cn('py-8 text-center', className)}>
      {/* Calendar icon */}
      <div className="mb-4 mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center">
        <Calendar className="size-7 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="font-medium text-text-primary mb-1">
        {tPhaseF('phaseF.componentsTasksEmptyStatesSectionEmptyStates.nothingScheduled')}
      </h3>

      {/* Description */}
      <p className="text-sm text-text-tertiary mb-5">
        {tPhaseF(
          'phaseF.componentsTasksEmptyStatesSectionEmptyStates.addTasksWithDueDatesToPlanYourWeek'
        )}
      </p>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-3">
        <Button onClick={onAddTask} size="sm" className="gap-2">
          <Plus className="size-4" aria-hidden="true" />

          {tPhaseF('phaseF.componentsTasksEmptyStatesSectionEmptyStates.addTask')}
        </Button>

        {onViewCalendar && (
          <Button onClick={onViewCalendar} variant="outline" size="sm" className="gap-2">
            <Calendar className="size-4" aria-hidden="true" />

            {tPhaseF('phaseF.componentsTasksEmptyStatesSectionEmptyStates.viewCalendar')}
          </Button>
        )}
      </div>
    </div>
  )
}
