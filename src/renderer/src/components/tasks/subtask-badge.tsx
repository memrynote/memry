import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskBadgeProps {
  /** Number of completed subtasks */
  completed: number
  /** Total number of subtasks */
  total: number
  /** Whether the subtasks are expanded */
  isExpanded?: boolean
  /** Called when the badge is clicked (optional, to toggle expand) */
  onClick?: () => void
  /** Size variant */
  size?: 'sm' | 'md'
  /** Additional class names */
  className?: string
}

// ============================================================================
// SUBTASK BADGE COMPONENT
// Clean boxed badge showing subtask count with color-coded progress states
// ============================================================================

export const SubtaskBadge = ({
  completed,
  total,
  isExpanded,
  onClick,
  size = 'sm',
  className
}: SubtaskBadgeProps): React.JSX.Element | null => {
  // Don't render if no subtasks
  if (total === 0) return null

  const isComplete = completed === total
  const hasProgress = completed > 0
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

  const badge = (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={onClick ? 0 : -1}
      className={cn(
        // Base styles
        'inline-flex items-center gap-1 font-medium tabular-nums',
        'rounded transition-colors',
        // Focus states
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        // Size variants
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-xs',
        // Color states based on progress
        isComplete
          ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50'
          : hasProgress
            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
        // Cursor style
        onClick ? 'cursor-pointer' : 'cursor-default',
        className
      )}
      aria-label={`${completed} of ${total} subtasks complete`}
    >
      {/* Fraction count */}
      <span>
        {completed}/{total}
      </span>

      {/* Checkmark when complete */}
      {isComplete && (
        <Check
          className={cn('shrink-0', size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5')}
          strokeWidth={3}
          aria-hidden="true"
        />
      )}
    </button>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>
            {completed} of {total} subtasks complete
            {!isComplete && ` (${percentage}%)`}
          </p>
          {onClick && (
            <p className="text-muted-foreground">Click to {isExpanded ? 'collapse' : 'expand'}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default SubtaskBadge
