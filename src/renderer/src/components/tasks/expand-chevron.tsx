import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

// ============================================================================
// TYPES
// ============================================================================

interface ExpandChevronProps {
  /** Whether the subtasks are expanded */
  isExpanded: boolean
  /** Whether this task has subtasks */
  hasSubtasks: boolean
  /** Called when the chevron is clicked */
  onClick: () => void
  /** Size variant */
  size?: "sm" | "md"
  /** Additional class names */
  className?: string
}

// ============================================================================
// EXPAND CHEVRON COMPONENT
// Larger, more visible expand/collapse button with animation feedback
// ============================================================================

export const ExpandChevron = ({
  isExpanded,
  hasSubtasks,
  onClick,
  size = "md",
  className,
}: ExpandChevronProps): React.JSX.Element => {
  const [isAnimating, setIsAnimating] = useState(false)

  // Return empty spacer to maintain alignment when no subtasks
  if (!hasSubtasks) {
    return (
      <div
        className={cn(
          "shrink-0",
          size === "sm" ? "w-5 h-5" : "w-6 h-6"
        )}
        aria-hidden="true"
      />
    )
  }

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setIsAnimating(true)
    onClick()
    setTimeout(() => setIsAnimating(false), 200)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      e.stopPropagation()
      setIsAnimating(true)
      onClick()
      setTimeout(() => setIsAnimating(false), 200)
    }
  }

  return (
    <button
      type="button"
      data-expand-button
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      className={cn(
        "flex items-center justify-center rounded shrink-0",
        "transition-all duration-150",
        // Enhanced hover and active states for better visibility
        "text-gray-400 hover:text-gray-600 hover:bg-gray-100",
        "active:bg-gray-200",
        "dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-gray-800",
        "dark:active:bg-gray-700",
        // Focus states for accessibility
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        // Size variants
        size === "sm" ? "w-5 h-5" : "w-6 h-6",
        // Animation feedback on click
        isAnimating && "scale-110 bg-gray-100 dark:bg-gray-800",
        className
      )}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? "Collapse subtasks" : "Expand subtasks"}
    >
      <ChevronRight
        className={cn(
          "transition-transform duration-200 ease-out",
          size === "sm" ? "w-4 h-4" : "w-5 h-5",
          isExpanded && "rotate-90"
        )}
        strokeWidth={2.5}
        aria-hidden="true"
      />
    </button>
  )
}

export default ExpandChevron
