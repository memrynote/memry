import { Star, Calendar, AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"
import type { SectionType } from "@/lib/section-visibility"

// ============================================================================
// TYPES
// ============================================================================

interface CollapsedEmptySectionProps {
  /** The type of section */
  type: SectionType
  /** Display label (e.g., "TODAY", "TOMORROW") */
  label: string
  /** Short message describing the empty state */
  message: string
  /** Callback when user clicks add task */
  onAddTask: () => void
  /** Additional class names */
  className?: string
}

// ============================================================================
// SECTION ICONS
// ============================================================================

const sectionIcons: Record<SectionType, React.ElementType | null> = {
  overdue: AlertTriangle,
  today: Star,
  tomorrow: Calendar,
  upcoming: Calendar,
  "no-date": null,
}

const sectionIconColors: Record<SectionType, string> = {
  overdue: "text-red-500",
  today: "text-amber-500",
  tomorrow: "text-text-tertiary",
  upcoming: "text-text-tertiary",
  "no-date": "text-text-tertiary",
}

// ============================================================================
// COLLAPSED EMPTY SECTION
// ============================================================================

/**
 * A compact single-line representation of an empty section.
 * Alternative to full empty states for a more minimal UI.
 *
 * Format: "ICON LABEL · message [+ Add]"
 *
 * @example
 * ⭐ TODAY · All clear! [+ Add]
 * 📅 TOMORROW · No tasks [+ Add]
 */
export const CollapsedEmptySection = ({
  type,
  label,
  message,
  onAddTask,
  className,
}: CollapsedEmptySectionProps): React.JSX.Element => {
  const Icon = sectionIcons[type]
  const iconColor = sectionIconColors[type]

  return (
    <div
      className={cn(
        "flex items-center justify-between",
        "px-3 py-2.5 rounded-lg",
        "bg-muted/30 border border-border/50",
        className
      )}
    >
      {/* Label and message */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Icon */}
        {Icon && (
          <Icon
            className={cn("size-4 shrink-0", iconColor)}
            aria-hidden="true"
          />
        )}

        {/* Label */}
        <span className="text-sm font-semibold text-text-primary uppercase tracking-wide">
          {label}
        </span>

        {/* Separator */}
        <span className="text-text-tertiary" aria-hidden="true">
          ·
        </span>

        {/* Message */}
        <span className="text-sm text-text-tertiary truncate">{message}</span>
      </div>

      {/* Add task button */}
      <button
        type="button"
        onClick={onAddTask}
        className={cn(
          "shrink-0 ml-3",
          "text-xs font-medium text-primary hover:text-primary/80",
          "transition-colors",
          "focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
        )}
        aria-label={`Add task for ${label.toLowerCase()}`}
      >
        + Add
      </button>
    </div>
  )
}

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

/**
 * Get default collapsed empty section props for a section type.
 */
export const getCollapsedEmptyProps = (
  type: SectionType
): { label: string; message: string } => {
  switch (type) {
    case "today":
      return { label: "TODAY", message: "All clear!" }
    case "tomorrow":
      return { label: "TOMORROW", message: "No tasks" }
    case "upcoming":
      return { label: "UPCOMING", message: "Nothing scheduled" }
    case "overdue":
      return { label: "OVERDUE", message: "All caught up!" }
    case "no-date":
      return { label: "NO DATE", message: "No tasks" }
    default:
      return { label: type.toUpperCase(), message: "No tasks" }
  }
}

export default CollapsedEmptySection






