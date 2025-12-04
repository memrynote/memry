import { Repeat } from "lucide-react"

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

// ============================================================================
// PROJECT BADGE
// ============================================================================

interface ProjectBadgeProps {
  project: Project
  className?: string
}

export const ProjectBadge = ({
  project,
  className,
}: ProjectBadgeProps): React.JSX.Element => {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
        "bg-muted text-text-secondary",
        className
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
      <span className="truncate max-w-[100px]">{project.name}</span>
    </span>
  )
}

// ============================================================================
// PRIORITY BADGE
// ============================================================================

export type PriorityBadgeVariant = "dot" | "label" | "full"

interface PriorityBadgeProps {
  priority: Priority
  variant?: PriorityBadgeVariant
  size?: "sm" | "md"
  showTooltip?: boolean
  className?: string
}

export const PriorityBadge = ({
  priority,
  variant = "full",
  size = "md",
  showTooltip = false,
  className,
}: PriorityBadgeProps): React.JSX.Element | null => {
  const config = priorityConfig[priority]

  // Don't render anything for "none" priority
  if (priority === "none" || !config.color) {
    return null
  }

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        size === "sm" && "text-xs",
        size === "md" && "text-xs",
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
          {config.label}
        </span>
      )}
    </span>
  )

  // Wrap with tooltip if needed (only useful for dot variant)
  if (showTooltip && variant === "dot") {
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
  className,
}: DueDateBadgeProps): React.JSX.Element => {
  const formatted = formatDueDate(dueDate, dueTime)

  if (!formatted) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>—</span>
    )
  }

  const isOverdue = formatted.status === "overdue"
  const isToday = formatted.status === "today"
  const showBackground = isOverdue || isToday

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        dueDateStatusStyles[formatted.status],
        showBackground && variant === "default" && cn(
          "rounded-md px-1.5 py-0.5",
          dueDateBackgroundStyles[formatted.status]
        ),
        className
      )}
    >
      {isRepeating && (
        <Repeat className="size-3 shrink-0" aria-label="Repeating task" />
      )}
      <span>{formatted.label}</span>
      {isOverdue && variant === "default" && (
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
          Overdue
        </span>
      )}
    </span>
  )
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
    if (!disabled) {
      onChange()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === "Enter" || e.key === " ") && !disabled) {
      e.preventDefault()
      e.stopPropagation()
      onChange()
    }
  }

  // Get border color based on priority
  const getPriorityBorderColor = (): string | undefined => {
    if (checked) return undefined
    if (!priority || priority === "none") return undefined
    return priorityConfig[priority]?.color
  }

  const priorityBorderColor = getPriorityBorderColor()

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      tabIndex={0}
      className={cn(
        "size-5 shrink-0 rounded-full border-2 transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        checked
          ? "border-primary bg-primary"
          : "border-muted-foreground/40 hover:border-primary",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
      style={priorityBorderColor ? { borderColor: priorityBorderColor } : undefined}
      aria-label={checked ? "Mark as incomplete" : "Mark as complete"}
    >
      {checked && (
        <svg
          className="size-full text-primary-foreground"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
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
