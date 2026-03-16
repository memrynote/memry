import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskDotsProps {
  /** Number of completed subtasks */
  completed: number
  /** Total number of subtasks */
  total: number
  /** Maximum number of dots to display before falling back to fraction */
  maxDots?: number
  /** Called when clicked (optional, to toggle expand) */
  onClick?: () => void
  /** Whether the subtasks are expanded */
  isExpanded?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// SUBTASK DOTS COMPONENT
// Minimal dot indicator for low subtask counts (≤5 by default)
// ============================================================================

export const SubtaskDots = ({
  completed,
  total,
  maxDots = 5,
  onClick,
  isExpanded,
  className
}: SubtaskDotsProps): React.JSX.Element | null => {
  // Don't render if no subtasks
  if (total === 0) return null

  const percentage = Math.round((completed / total) * 100)

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Enter' || e.key === ' ') && onClick) {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    }
  }

  // For tasks with many subtasks, show condensed fraction view
  if (total > maxDots) {
    const content = (
      <button
        type="button"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={onClick ? 0 : -1}
        className={cn(
          'text-xs text-muted-foreground tabular-nums',
          'hover:text-foreground transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded',
          onClick ? 'cursor-pointer' : 'cursor-default',
          className
        )}
        aria-label={`${completed} of ${total} subtasks complete`}
      >
        {completed}/{total}
      </button>
    )

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <p>
              {completed} of {total} subtasks complete ({percentage}%)
            </p>
            {onClick && (
              <p className="text-muted-foreground">Click to {isExpanded ? 'collapse' : 'expand'}</p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  const content = (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={onClick ? 0 : -1}
      className={cn(
        'inline-flex items-center gap-1.5 px-1 py-0.5 rounded',
        'hover:bg-muted transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        onClick ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      aria-label={`${completed} of ${total} subtasks complete`}
    >
      {/* Dots */}
      <div className="flex gap-0.5">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'w-1.5 h-1.5 rounded-full transition-colors',
              i < completed
                ? 'bg-task-complete' // Completed
                : 'bg-border' // Incomplete
            )}
          />
        ))}
      </div>

      {/* Count label */}
      <span className="text-xs text-muted-foreground tabular-nums">
        {completed}/{total}
      </span>
    </button>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>
            {completed} of {total} subtasks complete
            {completed < total && ` (${percentage}%)`}
          </p>
          {onClick && (
            <p className="text-muted-foreground">Click to {isExpanded ? 'collapse' : 'expand'}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default SubtaskDots
