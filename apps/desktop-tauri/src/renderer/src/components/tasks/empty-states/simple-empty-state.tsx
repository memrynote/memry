import { Plus } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface SimpleEmptyStateProps {
  /** Label for the section (e.g., "tomorrow") */
  label: string
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Additional class names */
  className?: string
}

/**
 * A minimal empty state for sections like TOMORROW.
 * Shows a brief message with a quick-add option.
 */
export const SimpleEmptyState = ({
  label,
  onAddTask,
  className
}: SimpleEmptyStateProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  return (
    <div className={cn('py-4 text-center', className)}>
      {/* Message */}
      <p className="text-sm text-text-tertiary mb-2">
        {tPhaseF('phaseF.componentsTasksEmptyStatesSectionEmptyStates.noTasksScheduled')}
      </p>

      {/* Add task link */}
      <button
        type="button"
        onClick={onAddTask}
        className={cn(
          'inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80',
          'transition-colors',
          'focus-visible:outline-none rounded'
        )}
        aria-label={`Add task for ${label.toLowerCase()}`}
      >
        <Plus className="size-4" aria-hidden="true" />

        {tPhaseF('phaseF.componentsTasksEmptyStatesSectionEmptyStates.addTaskFor')}
        {label.toLowerCase()}
      </button>
    </div>
  )
}
