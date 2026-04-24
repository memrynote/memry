import { cn } from '@/lib/utils'
import type { SubtaskProgress } from '@/lib/subtask-utils'

// ============================================================================
// TYPES
// ============================================================================

interface MiniProgressBarProps {
  progress: SubtaskProgress
  className?: string
}

// ============================================================================
// MINI PROGRESS BAR COMPONENT
// Ultra-compact progress indicator for calendar cells (20-24px wide)
// ============================================================================

export const MiniProgressBar = ({
  progress,
  className
}: MiniProgressBarProps): React.JSX.Element | null => {
  const { total, percentage } = progress

  // Don't render if no subtasks
  if (total === 0) return null

  const isComplete = percentage === 100

  return (
    <div
      className={cn('w-5 h-1 rounded-full overflow-hidden bg-surface-active shrink-0', className)}
      role="progressbar"
      aria-valuenow={percentage}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${progress.completed} of ${total} subtasks completed`}
    >
      <div
        className={cn(
          'h-full rounded-full transition-all duration-300',
          isComplete ? 'bg-task-complete' : 'bg-task-progress'
        )}
        style={{ width: `${percentage}%` }}
      />
    </div>
  )
}

export default MiniProgressBar
