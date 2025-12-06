import { Check } from "lucide-react"

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

interface SubtaskProgressBadgeProps {
    /** Number of completed subtasks */
    completed: number
    /** Total number of subtasks */
    total: number
    /** Whether the subtasks are expanded */
    isExpanded?: boolean
    /** Called when the badge is clicked (optional, to toggle expand) */
    onClick?: () => void
    /** Additional class names */
    className?: string
}

// ============================================================================
// SUBTASK PROGRESS BADGE COMPONENT
// Badge with mini horizontal progress bar showing completion visually
// ============================================================================

export const SubtaskProgressBadge = ({
    completed,
    total,
    isExpanded,
    onClick,
    className,
}: SubtaskProgressBadgeProps): React.JSX.Element | null => {
    // Don't render if no subtasks
    if (total === 0) return null

    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0
    const isComplete = completed === total

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
                "inline-flex items-center gap-2 px-2 py-1 rounded",
                "hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                onClick ? "cursor-pointer" : "cursor-default",
                className
            )}
            aria-label={`${completed} of ${total} subtasks complete (${percentage}%)`}
        >
            {/* Mini progress bar */}
            <div className="w-12 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                    className={cn(
                        "h-full rounded-full transition-all duration-300 ease-out",
                        isComplete ? "bg-green-500" : "bg-blue-500"
                    )}
                    style={{ width: `${percentage}%` }}
                />
            </div>

            {/* Count */}
            <span
                className={cn(
                    "text-xs font-medium tabular-nums",
                    isComplete
                        ? "text-green-600 dark:text-green-400"
                        : "text-gray-600 dark:text-gray-400"
                )}
            >
                {completed}/{total}
            </span>

            {/* Checkmark when complete */}
            {isComplete && (
                <Check
                    className="w-3 h-3 text-green-600 dark:text-green-400"
                    strokeWidth={3}
                    aria-hidden="true"
                />
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
                        {completed} of {total} subtasks complete ({percentage}%)
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

export default SubtaskProgressBadge
