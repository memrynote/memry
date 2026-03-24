import { Check, Calendar, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface CelebrationEmptyStateProps {
  /** Title text for the celebration message */
  title?: string
  /** Description text */
  description?: string
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Button label */
  addButtonLabel?: string
  /** Additional class names */
  className?: string
}

interface SimpleEmptyStateProps {
  /** Label for the section (e.g., "tomorrow") */
  label: string
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Additional class names */
  className?: string
}

interface PlanningEmptyStateProps {
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Optional callback to view calendar */
  onViewCalendar?: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// CELEBRATION EMPTY STATE (FOR TODAY)
// ============================================================================

/**
 * A celebratory empty state for when all tasks are completed.
 * Used primarily for the TODAY section to acknowledge accomplishment.
 */
export const CelebrationEmptyState = ({
  title = 'All clear for today!',
  description = 'Enjoy your free time or plan ahead.',
  onAddTask,
  addButtonLabel = 'Add task for today',
  className
}: CelebrationEmptyStateProps): React.JSX.Element => {
  return (
    <div className={cn('py-8 text-center', className)}>
      {/* Celebration icon */}
      <div className="mb-4 mx-auto w-14 h-14 rounded-full bg-task-complete/[0.08] flex items-center justify-center">
        <Check className="size-7 text-task-complete" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="font-medium text-text-primary mb-1">{title}</h3>

      {/* Description */}
      <p className="text-sm text-text-tertiary mb-5">{description}</p>

      {/* Action buttons */}
      <div className="flex flex-col items-center gap-3">
        <Button onClick={onAddTask} variant="outline" size="sm" className="gap-2">
          <Plus className="size-4" aria-hidden="true" />
          {addButtonLabel}
        </Button>
      </div>
    </div>
  )
}

// ============================================================================
// SIMPLE EMPTY STATE (FOR TOMORROW)
// ============================================================================

/**
 * A minimal empty state for sections like TOMORROW.
 * Shows a brief message with a quick-add option.
 */
export const SimpleEmptyState = ({
  label,
  onAddTask,
  className
}: SimpleEmptyStateProps): React.JSX.Element => {
  return (
    <div className={cn('py-4 text-center', className)}>
      {/* Message */}
      <p className="text-sm text-text-tertiary mb-2">No tasks scheduled</p>

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
        Add task for {label.toLowerCase()}
      </button>
    </div>
  )
}

// ============================================================================
// PLANNING EMPTY STATE (FOR UPCOMING)
// ============================================================================

/**
 * A planning-oriented empty state for the UPCOMING section.
 * Encourages users to plan ahead with clear call-to-actions.
 */
export const PlanningEmptyState = ({
  onAddTask,
  onViewCalendar,
  className
}: PlanningEmptyStateProps): React.JSX.Element => {
  return (
    <div className={cn('py-8 text-center', className)}>
      {/* Calendar icon */}
      <div className="mb-4 mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center">
        <Calendar className="size-7 text-text-tertiary" aria-hidden="true" />
      </div>

      {/* Title */}
      <h3 className="font-medium text-text-primary mb-1">Nothing scheduled</h3>

      {/* Description */}
      <p className="text-sm text-text-tertiary mb-5">Add tasks with due dates to plan your week.</p>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-3">
        <Button onClick={onAddTask} size="sm" className="gap-2">
          <Plus className="size-4" aria-hidden="true" />
          Add task
        </Button>

        {onViewCalendar && (
          <Button onClick={onViewCalendar} variant="outline" size="sm" className="gap-2">
            <Calendar className="size-4" aria-hidden="true" />
            View calendar
          </Button>
        )}
      </div>
    </div>
  )
}

export default {
  CelebrationEmptyState,
  SimpleEmptyState,
  PlanningEmptyState
}
