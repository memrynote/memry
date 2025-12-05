import { ListTodo, CheckCircle2 } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
  size?: "sm" | "md"
  /** Additional class names */
  className?: string
}

// ============================================================================
// SUBTASK BADGE COMPONENT
// Inline badge showing subtask count with visual progress indicator
// ============================================================================

export const SubtaskBadge = ({
  completed,
  total,
  isExpanded,
  onClick,
  size = "sm",
  className,
}: SubtaskBadgeProps): React.JSX.Element | null => {
  // Don't render if no subtasks
  if (total === 0) return null

  const isComplete = completed === total
  const percentage = Math.round((completed / total) * 100)

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onClick?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === "Enter" || e.key === " ") && onClick) {
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
        "inline-flex items-center gap-1 rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        // Size variants
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        // Color based on completion state
        isComplete
          ? "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
          : "bg-muted text-muted-foreground hover:bg-accent",
        // Cursor style
        onClick ? "cursor-pointer" : "cursor-default",
        className
      )}
      aria-label={`${completed} of ${total} subtasks complete`}
    >
      {/* Icon */}
      {isComplete ? (
        <CheckCircle2
          className={cn(
            "shrink-0",
            size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"
          )}
          aria-hidden="true"
        />
      ) : (
        <ListTodo
          className={cn(
            "shrink-0",
            size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"
          )}
          aria-hidden="true"
        />
      )}

      {/* Count */}
      <span className="font-medium tabular-nums">
        {completed}/{total}
      </span>

      {/* Mini progress arc (only when not complete) */}
      {!isComplete && (
        <svg
          className={cn(
            "-rotate-90 shrink-0",
            size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5"
          )}
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          {/* Background circle */}
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity="0.2"
          />
          {/* Progress circle */}
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={`${percentage * 0.377} 100`}
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badge}
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <p>
            {completed} of {total} subtasks complete
            {!isComplete && ` (${percentage}%)`}
          </p>
          {onClick && (
            <p className="text-muted-foreground">
              Click to {isExpanded ? "collapse" : "expand"}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default SubtaskBadge
