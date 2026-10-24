import { Check, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export { SimpleEmptyState } from './simple-empty-state'
export { PlanningEmptyState } from './planning-empty-state'

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
