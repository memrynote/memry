import { cn } from '@/lib/utils'
import type { SubtaskProgress } from '@/lib/subtask-utils'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskProgressBarProps {
  progress: SubtaskProgress
  size?: 'sm' | 'md'
  showLabel?: boolean
  className?: string
}

// ============================================================================
// SUBTASK PROGRESS BAR COMPONENT
// ============================================================================

export const SubtaskProgressBar = ({
  progress,
  size = 'sm',
  showLabel = true,
  className
}: SubtaskProgressBarProps): React.JSX.Element | null => {
  const { total, completed, percentage } = progress

  // Don't render if no subtasks
  if (total === 0) return null

  const isComplete = completed === total

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* Progress bar track */}
      <div
        className={cn(
          'flex-1 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700',
          size === 'sm' ? 'h-1.5 max-w-[120px]' : 'h-2 max-w-[160px]'
        )}
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${completed} of ${total} subtasks completed`}
      >
        {/* Progress bar fill */}
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            isComplete ? 'bg-green-500' : 'bg-blue-500'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Label */}
      {showLabel && (
        <span
          className={cn(
            'text-muted-foreground whitespace-nowrap',
            size === 'sm' ? 'text-xs' : 'text-sm'
          )}
        >
          {completed}/{total}
        </span>
      )}
    </div>
  )
}

export default SubtaskProgressBar
