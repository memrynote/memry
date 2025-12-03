import { RefreshCw, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import type { RepeatConfig } from "@/data/sample-tasks"
import { addDays, formatDateShort } from "@/lib/task-utils"

// ============================================================================
// TYPES
// ============================================================================

interface TaskRepeatDisplayProps {
  isRepeating: boolean
  repeatConfig: RepeatConfig | null
  onToggle?: () => void
  className?: string
}

// ============================================================================
// REPEAT TEXT FORMATTER
// ============================================================================

const formatRepeatText = (config: RepeatConfig): string => {
  const { frequency, interval, daysOfWeek } = config

  // Day names for weekly frequency
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  const shortDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

  switch (frequency) {
    case "daily":
      if (interval === 1) return "Every day"
      return `Every ${interval} days`

    case "weekly":
      if (daysOfWeek.length === 0) {
        if (interval === 1) return "Every week"
        return `Every ${interval} weeks`
      }
      const selectedDays = daysOfWeek
        .sort((a, b) => a - b)
        .map((d) => (daysOfWeek.length > 2 ? shortDayNames[d] : dayNames[d]))
        .join(", ")
      if (interval === 1) return `Every week on ${selectedDays}`
      return `Every ${interval} weeks on ${selectedDays}`

    case "monthly":
      if (interval === 1) return "Every month"
      return `Every ${interval} months`

    case "yearly":
      if (interval === 1) return "Every year"
      return `Every ${interval} years`

    case "custom":
      return `Custom: Every ${interval} days`

    default:
      return "Repeating"
  }
}

/**
 * Calculate next occurrence date based on repeat config
 */
const getNextOccurrence = (config: RepeatConfig, baseDate: Date = new Date()): Date => {
  const { frequency, interval, daysOfWeek } = config

  switch (frequency) {
    case "daily":
      return addDays(baseDate, interval)

    case "weekly":
      if (daysOfWeek.length === 0) {
        return addDays(baseDate, 7 * interval)
      }
      // Find next occurrence day
      const currentDay = baseDate.getDay()
      let nextDay = daysOfWeek.find((d) => d > currentDay)
      if (nextDay === undefined) {
        // Wrap to next week
        nextDay = daysOfWeek[0]
        return addDays(baseDate, 7 * interval - currentDay + nextDay)
      }
      return addDays(baseDate, nextDay - currentDay)

    case "monthly":
      const nextMonth = new Date(baseDate)
      nextMonth.setMonth(nextMonth.getMonth() + interval)
      return nextMonth

    case "yearly":
      const nextYear = new Date(baseDate)
      nextYear.setFullYear(nextYear.getFullYear() + interval)
      return nextYear

    default:
      return addDays(baseDate, interval)
  }
}

// ============================================================================
// TASK REPEAT DISPLAY COMPONENT
// ============================================================================

export const TaskRepeatDisplay = ({
  isRepeating,
  repeatConfig,
  onToggle,
  className,
}: TaskRepeatDisplayProps): React.JSX.Element => {
  const repeatText = isRepeating && repeatConfig
    ? formatRepeatText(repeatConfig)
    : "Does not repeat"

  const nextOccurrence = isRepeating && repeatConfig
    ? getNextOccurrence(repeatConfig)
    : null

  const handleClick = (): void => {
    onToggle?.()
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Section label */}
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Repeat
      </h3>

      {/* Repeat toggle/display */}
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors",
          "hover:border-primary hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-ring"
        )}
        aria-label="Configure repeat settings"
      >
        <RefreshCw
          className={cn(
            "size-4",
            isRepeating ? "text-blue-500" : "text-muted-foreground"
          )}
          aria-hidden="true"
        />
        <span className={cn("flex-1 text-left", !isRepeating && "text-muted-foreground")}>
          {repeatText}
        </span>
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
      </button>

      {/* Next occurrence (only if repeating) */}
      {nextOccurrence && (
        <p className="text-xs text-muted-foreground">
          Next occurrence: {formatDateShort(nextOccurrence)}
        </p>
      )}
    </div>
  )
}

export default TaskRepeatDisplay

