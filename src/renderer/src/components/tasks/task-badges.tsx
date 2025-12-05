import { Repeat, Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDueDate, type DueDateStatus } from "@/lib/task-utils"
import { priorityConfig, type Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"

// ============================================================================
// PROJECT BADGE
// ============================================================================

interface ProjectBadgeProps {
  project: Project
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const ProjectBadge = ({
  project,
  fixedWidth = false,
  className,
}: ProjectBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
        "bg-muted text-text-secondary",
        fixedWidth && "w-[120px] justify-start",
        className
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

// ============================================================================
// PRIORITY BADGE
// ============================================================================

export type PriorityBadgeVariant = "dot" | "label" | "full"

/** Short labels for compact display in grid columns */
const priorityShortLabels: Record<Priority, string | null> = {
  none: null,
  low: "Low",
  medium: "Med",
  high: "High",
  urgent: "Urgent",
}

interface PriorityBadgeProps {
  priority: Priority
  variant?: PriorityBadgeVariant
  size?: "sm" | "md"
  showTooltip?: boolean
  /** Use compact short labels (Med instead of Medium) */
  compact?: boolean
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

export const PriorityBadge = ({
  priority,
  variant = "full",
  size = "md",
  showTooltip = false,
  compact = false,
  fixedWidth = false,
  className,
}: PriorityBadgeProps): React.JSX.Element | null => {
  const config = priorityConfig[priority]

  // Don't render anything for "none" priority
  if (priority === "none" || !config.color) {
    // Return empty placeholder if fixedWidth to maintain grid alignment
    if (fixedWidth) {
      return <span className="w-[70px]" aria-hidden="true" />
    }
    return null
  }

  const displayLabel = compact ? priorityShortLabels[priority] : config.label

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        size === "sm" && "text-xs",
        size === "md" && "text-xs",
        fixedWidth && "w-[70px] justify-start",
        className
      )}
      aria-label={`${config.label} priority`}
    >
      {/* Priority dot */}
      {(variant === "dot" || variant === "full") && (
        <span
          className={cn(
            "shrink-0 rounded-full",
            size === "sm" && "size-1.5",
            size === "md" && "size-2"
          )}
          style={{ backgroundColor: config.color }}
          aria-hidden="true"
        />
      )}

      {/* Priority label */}
      {(variant === "label" || variant === "full") && (
        <span
          className={cn(
            "font-medium",
            size === "sm" && "text-[10px]",
            size === "md" && "text-xs"
          )}
          style={{ color: config.color }}
        >
          {displayLabel}
        </span>
      )}
    </span>
  )

  // Wrap with tooltip if needed (only useful for dot variant or compact mode)
  if (showTooltip && (variant === "dot" || compact)) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {content}
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {config.label} priority
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return content
}

// ============================================================================
// DUE DATE BADGE
// ============================================================================

interface DueDateBadgeProps {
  dueDate: Date | null
  dueTime: string | null
  isRepeating?: boolean
  variant?: "default" | "compact"
  /** Use fixed width for grid alignment */
  fixedWidth?: boolean
  className?: string
}

const dueDateStatusStyles: Record<DueDateStatus, string> = {
  overdue: "text-red-600 dark:text-red-400",
  today: "text-amber-600 dark:text-amber-500",
  tomorrow: "text-blue-600 dark:text-blue-400",
  upcoming: "text-foreground",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
}

const dueDateBackgroundStyles: Record<DueDateStatus, string> = {
  overdue: "bg-red-50 dark:bg-red-950/50",
  today: "bg-amber-50 dark:bg-amber-950/50",
  tomorrow: "",
  upcoming: "",
  later: "",
  none: "",
}

export const DueDateBadge = ({
  dueDate,
  dueTime,
  isRepeating = false,
  variant = "default",
  fixedWidth = false,
  className,
}: DueDateBadgeProps): React.JSX.Element => {
  const formatted = formatDueDate(dueDate, dueTime)

  if (!formatted) {
    return (
      <span
        className={cn(
          "text-xs text-muted-foreground",
          fixedWidth && "w-[110px] text-right",
          className
        )}
      >
        —
      </span>
    )
  }

  const isOverdue = formatted.status === "overdue"
  const isToday = formatted.status === "today"
  const showBackground = isOverdue || isToday

  const badgeContent = (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        dueDateStatusStyles[formatted.status],
        showBackground && variant === "default" && cn(
          "rounded-md px-1.5 py-0.5",
          dueDateBackgroundStyles[formatted.status]
        )
      )}
    >
      {isRepeating && (
        <Repeat className="size-3 shrink-0" aria-label="Repeating task" />
      )}
      <span className="truncate">{formatted.label}</span>
      {isOverdue && variant === "default" && (
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80 shrink-0">
          Overdue
        </span>
      )}
    </span>
  )

  // If fixedWidth, wrap in a container for grid alignment
  if (fixedWidth) {
    return (
      <span className={cn("w-[110px] flex justify-end", className)}>
        {badgeContent}
      </span>
    )
  }

  return <span className={className}>{badgeContent}</span>
}

// ============================================================================
// TASK CHECKBOX
// ============================================================================

interface TaskCheckboxProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  priority?: Priority
  className?: string
}

export const TaskCheckbox = ({
  checked,
  onChange,
  disabled = false,
  priority,
  className,
}: TaskCheckboxProps): React.JSX.Element => {
  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
  }

  const handleCheckedChange = (): void => {
    if (!disabled) {
      onChange()
    }
  }

  // Get border color based on priority
  const getPriorityBorderColor = (): string | undefined => {
    if (checked) return undefined
    if (!priority || priority === "none") return undefined
    return priorityConfig[priority]?.color ?? undefined
  }

  const priorityBorderColor = getPriorityBorderColor()

  return (
    <div
      className="group/checkbox relative"
      onClick={handleClick}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={handleCheckedChange}
        disabled={disabled}
        className={cn(
          "size-[18px] rounded-[4px] border-[1.5px] transition-all duration-200",
          "data-[state=unchecked]:border-muted-foreground/40",
          "data-[state=unchecked]:hover:border-primary/70 data-[state=unchecked]:hover:bg-primary/8",
          "data-[state=checked]:border-primary data-[state=checked]:bg-primary",
          className
        )}
        style={priorityBorderColor ? { borderColor: priorityBorderColor } : undefined}
        aria-label={checked ? "Mark as incomplete" : "Mark as complete"}
      />
      {/* Hover state - soft checkmark preview */}
      {!checked && !disabled && (
        <Check
          className="absolute inset-0 m-auto size-3 text-primary/25 opacity-0 group-hover/checkbox:opacity-100 transition-opacity duration-200 pointer-events-none"
          strokeWidth={3}
        />
      )}
    </div>
  )
}

// ============================================================================
// STATUS BADGE
// ============================================================================

interface StatusBadgeProps {
  label: string
  color: string
  type?: "todo" | "in_progress" | "done"
  className?: string
}

export const StatusBadge = ({
  label,
  color,
  type,
  className,
}: StatusBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        type === "done" && "opacity-70",
        className
      )}
      style={{
        backgroundColor: `${color}20`,
        color: color,
      }}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  )
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  ProjectBadge,
  PriorityBadge,
  DueDateBadge,
  TaskCheckbox,
  StatusBadge,
}
