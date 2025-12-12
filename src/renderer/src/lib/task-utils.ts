import type { Task, Priority } from "@/data/sample-tasks"
import type { Project, Status } from "@/data/tasks-data"
import { priorityConfig } from "@/data/sample-tasks"

// ============================================================================
// DATE HELPERS
// ============================================================================

/**
 * Get start of day (midnight) for a date
 */
export const startOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

/**
 * Add days to a date
 */
export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Subtract days from a date
 */
export const subDays = (date: Date, days: number): Date => {
  return addDays(date, -days)
}

/**
 * Check if two dates are the same day
 */
export const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

/**
 * Check if a date is within a start/end interval (inclusive)
 */
export const isWithinInterval = (date: Date, range: { start: Date; end: Date }): boolean => {
  const time = date.getTime()
  return time >= range.start.getTime() && time <= range.end.getTime()
}

/**
 * Check if date1 is before date2
 */
export const isBefore = (date1: Date, date2: Date): boolean => {
  return date1.getTime() < date2.getTime()
}

/**
 * Check if date1 is after date2
 */
export const isAfter = (date1: Date, date2: Date): boolean => {
  return date1.getTime() > date2.getTime()
}

/**
 * Get difference in days between two dates
 */
export const differenceInDays = (date1: Date, date2: Date): number => {
  const diffTime = date1.getTime() - date2.getTime()
  return Math.floor(diffTime / (1000 * 60 * 60 * 24))
}

/**
 * Get the next Saturday (for "this weekend")
 * If today is Saturday, returns today
 * If today is Sunday, returns next Saturday
 */
export const nextSaturday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  // If today is Saturday (6), return today
  if (currentDay === 6) {
    return today
  }

  // If today is Sunday (0), return next Saturday (6 days)
  if (currentDay === 0) {
    return addDays(today, 6)
  }

  // Otherwise, find days until Saturday
  const daysUntilSaturday = 6 - currentDay
  return addDays(today, daysUntilSaturday)
}

/**
 * Get the next Monday (for "next week")
 * If today is Monday, returns next Monday (7 days)
 */
export const nextMonday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  // If today is Monday (1), return next Monday (7 days)
  if (currentDay === 1) {
    return addDays(today, 7)
  }

  // Calculate days until next Monday
  const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay
  return addDays(today, daysUntilMonday)
}

/**
 * Add weeks to a date
 */
export const addWeeks = (date: Date, weeks: number): Date => {
  return addDays(date, weeks * 7)
}

/**
 * Add months to a date
 */
export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

/**
 * Subtract months from a date
 */
export const subMonths = (date: Date, months: number): Date => {
  return addMonths(date, -months)
}

/**
 * Start of month
 */
export const startOfMonth = (date: Date): Date => {
  const result = new Date(date)
  result.setDate(1)
  return startOfDay(result)
}

/**
 * End of month
 */
export const endOfMonth = (date: Date): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + 1)
  result.setDate(0)
  return startOfDay(result)
}

/**
 * Start of week (defaults to Sunday = 0)
 */
export const startOfWeek = (date: Date, weekStartsOn: 0 | 1 = 0): Date => {
  const result = startOfDay(date)
  const day = result.getDay()
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn
  return subDays(result, diff)
}

/**
 * End of week (defaults to Sunday start)
 */
export const endOfWeek = (date: Date, weekStartsOn: 0 | 1 = 0): Date => {
  return addDays(startOfWeek(date, weekStartsOn), 6)
}

/**
 * Check if two dates are in the same month
 */
export const isSameMonth = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth()
  )
}

// ============================================================================
// DATE FORMATTING
// ============================================================================

export type DueDateStatus = "overdue" | "today" | "tomorrow" | "upcoming" | "later" | "none"

export interface FormattedDueDate {
  label: string
  status: DueDateStatus
}

/**
 * Format time string (HH:MM) to display format
 */
export const formatTime = (time: string): string => {
  const [hours, minutes] = time.split(":").map(Number)
  const period = hours >= 12 ? "PM" : "AM"
  const displayHours = hours % 12 || 12
  return `${displayHours}:${minutes.toString().padStart(2, "0")} ${period}`
}

/**
 * Format date to short format (Dec 20)
 */
export const formatDateShort = (date: Date): string => {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/**
 * Format date to day name (Wednesday)
 */
export const formatDayName = (date: Date): string => {
  return date.toLocaleDateString("en-US", { weekday: "long" })
}

/**
 * Smart format due date based on proximity to today
 */
export const formatDueDate = (
  dueDate: Date | null,
  dueTime: string | null
): FormattedDueDate | null => {
  if (!dueDate) return null

  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  const nextWeek = addDays(today, 7)
  const taskDate = startOfDay(dueDate)

  const timeStr = dueTime ? ` ${formatTime(dueTime)}` : ""

  // Overdue
  if (isBefore(taskDate, today)) {
    return { label: formatDateShort(dueDate) + timeStr, status: "overdue" }
  }

  // Today
  if (isSameDay(taskDate, today)) {
    return { label: "Today" + timeStr, status: "today" }
  }

  // Tomorrow
  if (isSameDay(taskDate, tomorrow)) {
    return { label: "Tomorrow" + timeStr, status: "tomorrow" }
  }

  // This week (next 7 days)
  if (isBefore(taskDate, nextWeek)) {
    return { label: formatDayName(dueDate) + timeStr, status: "upcoming" }
  }

  // Later
  return { label: formatDateShort(dueDate) + timeStr, status: "later" }
}

// ============================================================================
// TASK STATUS HELPERS
// ============================================================================

/**
 * Check if a task is completed (in a "done" type status)
 */
export const isTaskCompleted = (task: Task, projects: Project[]): boolean => {
  const project = projects.find((p) => p.id === task.projectId)
  if (!project) return false

  const status = project.statuses.find((s) => s.id === task.statusId)
  return status?.type === "done"
}

/**
 * Get the first "todo" type status for a project
 */
export const getDefaultTodoStatus = (project: Project): Status | undefined => {
  return project.statuses.find((s) => s.type === "todo")
}

/**
 * Get the first "done" type status for a project
 */
export const getDefaultDoneStatus = (project: Project): Status | undefined => {
  return project.statuses.find((s) => s.type === "done")
}

// ============================================================================
// TASK SORTING
// ============================================================================

/**
 * Sort tasks by priority (urgent first) then by due date
 */
export const sortTasksByPriorityAndDate = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    // Priority first (urgent > high > medium > low > none)
    const priorityA = priorityConfig[a.priority].order
    const priorityB = priorityConfig[b.priority].order

    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    // Then by due date (earlier first, no date last)
    if (a.dueDate && b.dueDate) {
      return a.dueDate.getTime() - b.dueDate.getTime()
    }
    if (a.dueDate && !b.dueDate) return -1
    if (!a.dueDate && b.dueDate) return 1

    return 0
  })
}

// ============================================================================
// TASK GROUPING - BY DUE DATE
// ============================================================================

export interface TaskGroupByDate {
  overdue: Task[]
  today: Task[]
  tomorrow: Task[]
  upcoming: Task[] // 2-7 days out
  later: Task[] // 8+ days out
  noDueDate: Task[]
}

/**
 * Group tasks by due date (for All Tasks, Today, Upcoming views)
 */
export const groupTasksByDueDate = (tasks: Task[]): TaskGroupByDate => {
  const groups: TaskGroupByDate = {
    overdue: [],
    today: [],
    tomorrow: [],
    upcoming: [],
    later: [],
    noDueDate: [],
  }

  const today = startOfDay(new Date())

  tasks.forEach((task) => {
    if (!task.dueDate) {
      groups.noDueDate.push(task)
    } else {
      const taskDate = startOfDay(task.dueDate)
      const daysUntil = differenceInDays(taskDate, today)

      if (daysUntil < 0) groups.overdue.push(task)
      else if (daysUntil === 0) groups.today.push(task)
      else if (daysUntil === 1) groups.tomorrow.push(task)
      else if (daysUntil <= 7) groups.upcoming.push(task)
      else groups.later.push(task)
    }
  })

  // Sort within groups
  Object.keys(groups).forEach((key) => {
    groups[key as keyof TaskGroupByDate] = sortTasksByPriorityAndDate(
      groups[key as keyof TaskGroupByDate]
    )
  })

  return groups
}

// ============================================================================
// TASK GROUPING - BY STATUS
// ============================================================================

export interface TaskGroupByStatus {
  status: Status
  tasks: Task[]
}

/**
 * Group tasks by status (for project view)
 */
export const groupTasksByStatus = (
  tasks: Task[],
  projectStatuses: Status[]
): TaskGroupByStatus[] => {
  const sortedStatuses = [...projectStatuses].sort((a, b) => a.order - b.order)

  return sortedStatuses.map((status) => ({
    status,
    tasks: sortTasksByPriorityAndDate(tasks.filter((t) => t.statusId === status.id)),
  }))
}

// ============================================================================
// TASK GROUPING - BY COMPLETION DATE
// ============================================================================

export interface TaskGroupByCompletion {
  today: Task[]
  yesterday: Task[]
  earlier: Task[]
}

/**
 * Group tasks by completion date (for Completed view)
 */
export const groupTasksByCompletion = (tasks: Task[]): TaskGroupByCompletion => {
  const groups: TaskGroupByCompletion = {
    today: [],
    yesterday: [],
    earlier: [],
  }

  const today = startOfDay(new Date())
  const yesterday = subDays(today, 1)

  tasks.forEach((task) => {
    if (!task.completedAt) return

    const completedDate = startOfDay(task.completedAt)

    if (isSameDay(completedDate, today)) {
      groups.today.push(task)
    } else if (isSameDay(completedDate, yesterday)) {
      groups.yesterday.push(task)
    } else {
      groups.earlier.push(task)
    }
  })

  // Sort by completion date (most recent first)
  const sortByCompletionDesc = (tasks: Task[]): Task[] => {
    return [...tasks].sort((a, b) => {
      if (!a.completedAt || !b.completedAt) return 0
      return b.completedAt.getTime() - a.completedAt.getTime()
    })
  }

  groups.today = sortByCompletionDesc(groups.today)
  groups.yesterday = sortByCompletionDesc(groups.yesterday)
  groups.earlier = sortByCompletionDesc(groups.earlier)

  return groups
}

// ============================================================================
// CALENDAR HELPERS
// ============================================================================

export interface CalendarDay {
  date: Date
  isCurrentMonth: boolean
  isToday: boolean
  isWeekend: boolean
}

/**
 * Format date to yyyy-MM-dd key
 */
export const formatDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Build visible calendar days for a month (includes overflow days)
 */
export const getCalendarDays = (
  month: Date,
  weekStartsOn: 0 | 1 = 0
): CalendarDay[] => {
  const start = startOfWeek(startOfMonth(month), weekStartsOn)
  const end = endOfWeek(endOfMonth(month), weekStartsOn)

  const days: CalendarDay[] = []
  let current = start

  while (current <= end) {
    const dayDate = new Date(current)
    days.push({
      date: dayDate,
      isCurrentMonth: isSameMonth(dayDate, month),
      isToday: isSameDay(dayDate, startOfDay(new Date())),
      isWeekend: [0, 6].includes(dayDate.getDay()),
    })
    current = addDays(current, 1)
  }

  return days
}

/**
 * Convert HH:MM to minutes since midnight
 */
const timeToMinutes = (time: string | null): number | null => {
  if (!time) return null
  const [hoursStr, minutesStr] = time.split(":")
  const hours = Number(hoursStr)
  const minutes = Number(minutesStr)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null
  return hours * 60 + minutes
}

/**
 * Sort tasks for a single day:
 * 1) Timed tasks first (chronological)
 * 2) Untimed tasks next (by priority)
 * 3) Tie-breaker by title
 */
export const sortTasksForDay = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    const aMinutes = timeToMinutes(a.dueTime)
    const bMinutes = timeToMinutes(b.dueTime)

    const aHasTime = aMinutes !== null
    const bHasTime = bMinutes !== null

    // Timed before untimed
    if (aHasTime && !bHasTime) return -1
    if (!aHasTime && bHasTime) return 1

    // Both timed: chronological
    if (aHasTime && bHasTime && aMinutes !== bMinutes) {
      return (aMinutes as number) - (bMinutes as number)
    }

    // Priority (lower order is higher priority)
    const pa = priorityConfig[a.priority].order
    const pb = priorityConfig[b.priority].order
    if (pa !== pb) return pa - pb

    // Title
    return a.title.localeCompare(b.title)
  })
}

/**
 * Group tasks by date key within a visible range
 */
export const groupTasksByCalendarDate = (
  tasks: Task[],
  visibleStart: Date,
  visibleEnd: Date
): Map<string, Task[]> => {
  const map = new Map<string, Task[]>()

  tasks.forEach((task) => {
    if (!task.dueDate) return
    const taskDate = startOfDay(task.dueDate)
    if (!isWithinInterval(taskDate, { start: visibleStart, end: visibleEnd })) return

    const key = formatDateKey(taskDate)
    if (!map.has(key)) {
      map.set(key, [])
    }
    map.get(key)!.push(task)
  })

  // Sort each bucket for consistent display
  map.forEach((value, key) => {
    map.set(key, sortTasksForDay(value))
  })

  return map
}

// ============================================================================
// TASK FILTERING
// ============================================================================

/**
 * Include subtasks when their parent matches the filter
 * When a top-level task matches, all its subtasks are included
 */
const includeSubtasksForMatchingParents = (
  matchingTopLevel: Task[],
  allTasks: Task[]
): Task[] => {
  const matchingIds = new Set(matchingTopLevel.map((t) => t.id))

  // Include all subtasks of matching parents
  return allTasks.filter(
    (t) =>
      matchingIds.has(t.id) || // Is a matching top-level task
      (t.parentId !== null && matchingIds.has(t.parentId)) // Is subtask of matching parent
  )
}

/**
 * Get filtered tasks based on current selection
 * Handles subtasks: when a parent matches, its subtasks are included
 */
export const getFilteredTasks = (
  tasks: Task[],
  selectedId: string,
  selectedType: "view" | "project",
  projects: Project[]
): Task[] => {
  // Helper to check if task is incomplete
  const isIncomplete = (task: Task): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type !== "done"
  }

  // Helper to check if task is complete
  const isComplete = (task: Task): boolean => !isIncomplete(task)

  // Helper to check if task is a subtask
  const isSubtask = (task: Task): boolean => task.parentId !== null

  // Get incomplete top-level tasks
  const incompleteTopLevel = tasks.filter((t) => isIncomplete(t) && !isSubtask(t))

  // Get completed top-level tasks
  const completedTopLevel = tasks.filter((t) => isComplete(t) && !isSubtask(t))

  if (selectedType === "view") {
    const today = startOfDay(new Date())
    const weekFromNow = addDays(today, 7)

    switch (selectedId) {
      case "all":
        // All incomplete tasks - include subtasks of incomplete parents
        return includeSubtasksForMatchingParents(incompleteTopLevel, tasks)

      case "today": {
        // Filter top-level tasks by due date
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          // Include overdue and today
          return isSameDay(taskDate, today) || isBefore(taskDate, today)
        })
        // Include subtasks of matching parents
        return includeSubtasksForMatchingParents(matchingTopLevel, tasks)
      }

      case "upcoming": {
        // Filter top-level tasks by due date
        const matchingTopLevel = incompleteTopLevel.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          // Tomorrow through next 7 days
          return isAfter(taskDate, today) && !isAfter(taskDate, weekFromNow)
        })
        // Include subtasks of matching parents
        return includeSubtasksForMatchingParents(matchingTopLevel, tasks)
      }

      case "completed":
        // All completed tasks - include subtasks of completed parents
        return includeSubtasksForMatchingParents(completedTopLevel, tasks)

      default:
        return includeSubtasksForMatchingParents(incompleteTopLevel, tasks)
    }
  }

  if (selectedType === "project") {
    // Return all tasks for the project (both complete and incomplete)
    // Filter to project first, then include subtasks
    const projectTasks = tasks.filter((task) => task.projectId === selectedId)
    return projectTasks
  }

  return includeSubtasksForMatchingParents(incompleteTopLevel, tasks)
}

// ============================================================================
// TASK COUNTS
// ============================================================================

export interface TaskCounts {
  total: number
  dueToday: number
  overdue: number
  completed: number
}

/**
 * Calculate task counts for display
 */
export const getTaskCounts = (
  tasks: Task[],
  selectedId: string,
  selectedType: "view" | "project",
  projects: Project[]
): TaskCounts => {
  const filteredTasks = getFilteredTasks(tasks, selectedId, selectedType, projects)
  const today = startOfDay(new Date())

  let total = 0
  let dueToday = 0
  let overdue = 0
  let completed = 0

  filteredTasks.forEach((task) => {
    const isTaskDone = isTaskCompleted(task, projects)

    if (isTaskDone) {
      completed++
    } else {
      total++

      if (task.dueDate) {
        const taskDate = startOfDay(task.dueDate)
        if (isBefore(taskDate, today)) {
          overdue++
        } else if (isSameDay(taskDate, today)) {
          dueToday++
        }
      }
    }
  })

  return { total, dueToday, overdue, completed }
}

/**
 * Format subtitle based on task counts and current selection
 */
export const formatTaskSubtitle = (
  counts: TaskCounts,
  selectedId: string,
  selectedType: "view" | "project"
): string => {
  if (selectedType === "view") {
    switch (selectedId) {
      case "all": {
        const parts = [`${counts.total} tasks`]
        if (counts.dueToday > 0) parts.push(`${counts.dueToday} due today`)
        if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`)
        return parts.join(" · ")
      }

      case "today": {
        const parts = [`${counts.total + counts.overdue} tasks due`]
        if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`)
        return parts.join(" · ")
      }

      case "upcoming":
        return `${counts.total} tasks in the next 7 days`

      case "completed":
        return `${counts.completed} tasks completed`

      default:
        return `${counts.total} tasks`
    }
  }

  // Project view
  const parts = [`${counts.total} tasks`]
  if (counts.dueToday > 0) parts.push(`${counts.dueToday} due today`)
  return parts.join(" · ")
}

// ============================================================================
// GROUP HEADER CONFIGURATION
// ============================================================================

/**
 * Urgency levels for visual hierarchy
 * - critical: Demands immediate attention (OVERDUE)
 * - high: Important, should be addressed (TODAY)
 * - normal: Standard importance (TOMORROW, UPCOMING)
 * - low: Informational, least urgent (LATER, NO DUE DATE)
 */
export type UrgencyLevel = "critical" | "high" | "normal" | "low"

export interface GroupHeaderConfig {
  id: string
  label: string
  urgency: UrgencyLevel
  accentColor?: string
  isMuted?: boolean
}

export const dueDateGroupConfig: Record<keyof TaskGroupByDate, GroupHeaderConfig> = {
  overdue: { id: "overdue", label: "OVERDUE", urgency: "critical", accentColor: "#ef4444" },
  today: { id: "today", label: "TODAY", urgency: "high", accentColor: "#3b82f6" },
  tomorrow: { id: "tomorrow", label: "TOMORROW", urgency: "normal" },
  upcoming: { id: "upcoming", label: "UPCOMING", urgency: "normal" },
  later: { id: "later", label: "LATER", urgency: "low", isMuted: true },
  noDueDate: { id: "noDueDate", label: "NO DUE DATE", urgency: "low", isMuted: true },
}

export const completionGroupConfig: Record<keyof TaskGroupByCompletion, GroupHeaderConfig> = {
  today: { id: "today", label: "TODAY", accentColor: "#10b981" },
  yesterday: { id: "yesterday", label: "YESTERDAY" },
  earlier: { id: "earlier", label: "EARLIER", isMuted: true },
}

// ============================================================================
// TODAY & UPCOMING VIEW HELPERS
// ============================================================================

/**
 * Get end of day (23:59:59.999) for a date
 */
export const endOfDay = (date: Date): Date => {
  const result = new Date(date)
  result.setHours(23, 59, 59, 999)
  return result
}

/**
 * Priority order for sorting (lower = higher priority)
 */
const priorityOrder: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

/**
 * Sort tasks by time first (if available), then by priority
 */
export const sortTasksByTimeAndPriority = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    // Tasks with time come first
    if (a.dueTime && !b.dueTime) return -1
    if (!a.dueTime && b.dueTime) return 1

    // Both have time: sort by time
    if (a.dueTime && b.dueTime) {
      const timeCompare = a.dueTime.localeCompare(b.dueTime)
      if (timeCompare !== 0) return timeCompare
    }

    // Same time or no time: sort by priority
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

/**
 * Sort overdue tasks by date (oldest first), then by priority
 */
export const sortOverdueTasks = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    // Date compare (oldest first)
    if (a.dueDate && b.dueDate) {
      const dateCompare = a.dueDate.getTime() - b.dueDate.getTime()
      if (dateCompare !== 0) return dateCompare
    }

    // Then by priority
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

/**
 * Result type for Today view filtering
 */
export interface TodayViewTasks {
  overdue: Task[]
  today: Task[]
}

/**
 * Get tasks for Today view: overdue and today's tasks
 * Filters out completed tasks
 */
export const getTodayTasks = (
  tasks: Task[],
  projects: Project[]
): TodayViewTasks => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)

  const overdue: Task[] = []
  const today: Task[] = []

  tasks.forEach((task) => {
    // Skip completed tasks
    if (isTaskCompleted(task, projects)) return

    // Skip tasks without due date
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      // Overdue: due before today
      overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: todayStart, end: todayEnd })) {
      // Today: due today
      today.push(task)
    }
  })

  // Return tasks preserving the order they came in (from user's sort preference)
  // Don't re-sort here - the caller controls sort order
  return {
    overdue,
    today,
  }
}

/**
 * Result type for Upcoming view filtering
 */
export interface UpcomingViewTasks {
  overdue: Task[]
  byDay: Map<string, Task[]>
}

/**
 * Get tasks for Upcoming view: overdue and tasks grouped by day for the next N days
 * Filters out completed tasks
 */
export const getUpcomingTasks = (
  tasks: Task[],
  projects: Project[],
  daysAhead: number = 7
): UpcomingViewTasks => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const rangeEnd = endOfDay(addDays(now, daysAhead - 1))

  const overdue: Task[] = []
  const byDay = new Map<string, Task[]>()

  // Initialize days
  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(todayStart, i)
    const key = formatDateKey(date)
    byDay.set(key, [])
  }

  tasks.forEach((task) => {
    // Skip completed tasks
    if (isTaskCompleted(task, projects)) return

    // Skip tasks without due date
    if (!task.dueDate) return

    const dueDate = startOfDay(task.dueDate)

    if (isBefore(dueDate, todayStart)) {
      // Overdue
      overdue.push(task)
    } else if (isWithinInterval(task.dueDate, { start: todayStart, end: rangeEnd })) {
      // Within range
      const key = formatDateKey(dueDate)
      if (byDay.has(key)) {
        byDay.get(key)!.push(task)
      }
    }
  })

  // Return tasks preserving the order they came in (from user's sort preference)
  // Don't re-sort here - the caller controls sort order
  return { overdue, byDay }
}

/**
 * Day header text format for Upcoming view
 */
export interface DayHeaderText {
  primary: string    // "TODAY", "TOMORROW", or weekday name
  secondary: string  // Full date like "Monday, Dec 16"
}

/**
 * Format day header text for Upcoming view sections
 */
export const getDayHeaderText = (date: Date): DayHeaderText => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const tomorrowStart = addDays(todayStart, 1)

  // Format the secondary string (full date)
  const secondary = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  })

  if (isSameDay(date, todayStart)) {
    return {
      primary: "TODAY",
      secondary,
    }
  }

  if (isSameDay(date, tomorrowStart)) {
    return {
      primary: "TOMORROW",
      secondary,
    }
  }

  // Other days: show day name
  const dayName = date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase()
  const shortDate = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })

  return {
    primary: dayName,
    secondary: shortDate,
  }
}

/**
 * Parse a date key (yyyy-MM-dd) back to a Date object
 */
export const parseDateKey = (key: string): Date => {
  const [year, month, day] = key.split("-").map(Number)
  return new Date(year, month - 1, day)
}

// ============================================================================
// COMPLETED VIEW & ARCHIVE HELPERS
// ============================================================================

/**
 * Get completed tasks that are NOT archived
 */
export const getCompletedTasks = (tasks: Task[]): Task[] => {
  return tasks.filter((task) => task.completedAt !== null && task.archivedAt === null)
}

/**
 * Get archived tasks
 */
export const getArchivedTasks = (tasks: Task[]): Task[] => {
  return tasks.filter((task) => task.archivedAt !== null)
}

/**
 * Completion period labels
 */
export type CompletionPeriod =
  | "today"
  | "yesterday"
  | "earlierThisWeek"
  | "lastWeek"
  | "older"

/**
 * Enhanced grouping for completed tasks by period
 */
export interface CompletedTaskGroups {
  today: Task[]
  yesterday: Task[]
  earlierThisWeek: Task[]
  lastWeek: Task[]
  older: Task[]
}

/**
 * Group completed tasks by period:
 * - Today
 * - Yesterday
 * - Earlier This Week
 * - Last Week
 * - Older
 */
export const groupCompletedByPeriod = (tasks: Task[]): CompletedTaskGroups => {
  const groups: CompletedTaskGroups = {
    today: [],
    yesterday: [],
    earlierThisWeek: [],
    lastWeek: [],
    older: [],
  }

  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = subDays(todayStart, 1)
  const weekStart = startOfWeek(todayStart, 1) // Monday
  const lastWeekStart = subDays(weekStart, 7)
  const lastWeekEnd = subDays(weekStart, 1)

  tasks.forEach((task) => {
    if (!task.completedAt) return

    const completedDate = startOfDay(task.completedAt)

    if (isSameDay(completedDate, todayStart)) {
      groups.today.push(task)
    } else if (isSameDay(completedDate, yesterdayStart)) {
      groups.yesterday.push(task)
    } else if (isWithinInterval(completedDate, { start: weekStart, end: subDays(yesterdayStart, 1) })) {
      groups.earlierThisWeek.push(task)
    } else if (isWithinInterval(completedDate, { start: lastWeekStart, end: lastWeekEnd })) {
      groups.lastWeek.push(task)
    } else {
      groups.older.push(task)
    }
  })

  // Sort each group by completion time (most recent first)
  const sortByCompletionDesc = (taskList: Task[]): Task[] => {
    return [...taskList].sort((a, b) => {
      if (!a.completedAt || !b.completedAt) return 0
      return b.completedAt.getTime() - a.completedAt.getTime()
    })
  }

  groups.today = sortByCompletionDesc(groups.today)
  groups.yesterday = sortByCompletionDesc(groups.yesterday)
  groups.earlierThisWeek = sortByCompletionDesc(groups.earlierThisWeek)
  groups.lastWeek = sortByCompletionDesc(groups.lastWeek)
  groups.older = sortByCompletionDesc(groups.older)

  return groups
}

/**
 * Config for completion period headers
 */
export const completionPeriodConfig: Record<CompletionPeriod, GroupHeaderConfig> = {
  today: { id: "today", label: "TODAY", accentColor: "#10b981" },
  yesterday: { id: "yesterday", label: "YESTERDAY" },
  earlierThisWeek: { id: "earlierThisWeek", label: "EARLIER THIS WEEK" },
  lastWeek: { id: "lastWeek", label: "LAST WEEK", isMuted: true },
  older: { id: "older", label: "OLDER", isMuted: true },
}

/**
 * Group archived tasks by month (e.g., "December 2024")
 */
export interface ArchivedByMonth {
  monthKey: string // "2024-12" format for sorting
  label: string    // "December 2024" for display
  tasks: Task[]
}

/**
 * Group archived tasks by month they were archived
 */
export const groupArchivedByMonth = (tasks: Task[]): ArchivedByMonth[] => {
  const monthMap = new Map<string, Task[]>()

  tasks.forEach((task) => {
    if (!task.archivedAt) return

    const archivedDate = new Date(task.archivedAt)
    const year = archivedDate.getFullYear()
    const month = archivedDate.getMonth()
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`

    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, [])
    }
    monthMap.get(monthKey)!.push(task)
  })

  // Convert to array and sort by month (most recent first)
  const result: ArchivedByMonth[] = []

  monthMap.forEach((monthTasks, monthKey) => {
    const [year, month] = monthKey.split("-").map(Number)
    const date = new Date(year, month - 1, 1)
    const label = date.toLocaleDateString("en-US", { month: "long", year: "numeric" })

    // Sort tasks within month by archived date (most recent first)
    const sortedTasks = [...monthTasks].sort((a, b) => {
      if (!a.archivedAt || !b.archivedAt) return 0
      return b.archivedAt.getTime() - a.archivedAt.getTime()
    })

    result.push({ monthKey, label, tasks: sortedTasks })
  })

  // Sort months (most recent first)
  result.sort((a, b) => b.monthKey.localeCompare(a.monthKey))

  return result
}

/**
 * Completion statistics
 */
export interface CompletionStats {
  today: number
  thisWeek: number
  thisMonth: number
  streak: number
}

/**
 * Calculate completion statistics
 */
export const getCompletionStats = (tasks: Task[]): CompletionStats => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const weekStart = startOfWeek(todayStart, 1) // Monday
  const monthStart = startOfMonth(todayStart)

  let today = 0
  let thisWeek = 0
  let thisMonth = 0

  tasks.forEach((task) => {
    if (!task.completedAt) return

    const completedDate = startOfDay(task.completedAt)

    if (isSameDay(completedDate, todayStart)) {
      today++
      thisWeek++
      thisMonth++
    } else if (isWithinInterval(completedDate, { start: weekStart, end: todayStart })) {
      thisWeek++
      if (isWithinInterval(completedDate, { start: monthStart, end: todayStart })) {
        thisMonth++
      }
    } else if (isWithinInterval(completedDate, { start: monthStart, end: todayStart })) {
      thisMonth++
    }
  })

  const streak = calculateStreak(tasks)

  return { today, thisWeek, thisMonth, streak }
}

/**
 * Calculate consecutive days with at least one completed task
 */
export const calculateStreak = (tasks: Task[]): number => {
  // Get all unique completion dates (normalized to start of day)
  const completionDatesSet = new Set<string>()

  tasks.forEach((task) => {
    if (task.completedAt) {
      const dateKey = formatDateKey(startOfDay(task.completedAt))
      completionDatesSet.add(dateKey)
    }
  })

  if (completionDatesSet.size === 0) return 0

  // Check from today backwards
  let streak = 0
  let checkDate = startOfDay(new Date())

  // If nothing completed today, check if yesterday had completions
  // (streak continues if we completed yesterday)
  const todayKey = formatDateKey(checkDate)
  if (!completionDatesSet.has(todayKey)) {
    // Check yesterday
    checkDate = subDays(checkDate, 1)
    const yesterdayKey = formatDateKey(checkDate)
    if (!completionDatesSet.has(yesterdayKey)) {
      return 0 // No streak
    }
  }

  // Count consecutive days
  while (completionDatesSet.has(formatDateKey(checkDate))) {
    streak++
    checkDate = subDays(checkDate, 1)
  }

  return streak
}

/**
 * Search/filter completed tasks by title
 */
export const filterCompletedBySearch = (tasks: Task[], query: string): Task[] => {
  if (!query.trim()) return tasks

  const lowerQuery = query.toLowerCase().trim()
  return tasks.filter((task) => task.title.toLowerCase().includes(lowerQuery))
}

/**
 * Get tasks that are older than N days (for bulk archive)
 */
export const getTasksOlderThan = (tasks: Task[], days: number): Task[] => {
  const cutoffDate = subDays(startOfDay(new Date()), days)

  return tasks.filter((task) => {
    if (!task.completedAt) return false
    return isBefore(startOfDay(task.completedAt), cutoffDate)
  })
}

// ============================================================================
// ADVANCED FILTER FUNCTIONS
// ============================================================================

import type {
  TaskFilters,
  TaskSort,
  DueDateFilter,
  CompletionFilterType,
  RepeatFilterType,
  HasTimeFilterType,
} from "@/data/tasks-data"

/**
 * Filter tasks by search query (title and description)
 */
export const filterBySearch = (tasks: Task[], query: string): Task[] => {
  if (!query.trim()) return tasks

  const lowerQuery = query.toLowerCase().trim()

  return tasks.filter((task) => {
    const titleMatch = task.title.toLowerCase().includes(lowerQuery)
    const descMatch = task.description?.toLowerCase().includes(lowerQuery)
    return titleMatch || descMatch
  })
}

/**
 * Filter tasks by project IDs (multi-select)
 */
export const filterByProjects = (tasks: Task[], projectIds: string[]): Task[] => {
  if (projectIds.length === 0) return tasks
  return tasks.filter((task) => projectIds.includes(task.projectId))
}

/**
 * Filter tasks by priorities (multi-select)
 */
export const filterByPriorities = (tasks: Task[], priorities: Priority[]): Task[] => {
  if (priorities.length === 0) return tasks
  return tasks.filter((task) => priorities.includes(task.priority))
}

/**
 * Filter tasks by due date range/preset
 */
export const filterByDueDateRange = (
  tasks: Task[],
  filter: DueDateFilter
): Task[] => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const todayEnd = endOfDay(now)

  switch (filter.type) {
    case "any":
      return tasks

    case "none":
      return tasks.filter((t) => !t.dueDate)

    case "overdue":
      return tasks.filter((t) =>
        t.dueDate &&
        isBefore(startOfDay(t.dueDate), todayStart) &&
        !t.completedAt
      )

    case "today":
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: todayEnd })
      )

    case "tomorrow": {
      const tomorrowStart = startOfDay(addDays(now, 1))
      const tomorrowEnd = endOfDay(addDays(now, 1))
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, { start: tomorrowStart, end: tomorrowEnd })
      )
    }

    case "this-week": {
      const weekEnd = endOfWeek(now, 0) // Sunday = 0
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: weekEnd })
      )
    }

    case "next-week": {
      const nextWeekStart = startOfWeek(addWeeks(now, 1), 0)
      const nextWeekEnd = endOfWeek(addWeeks(now, 1), 0)
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, { start: nextWeekStart, end: nextWeekEnd })
      )
    }

    case "this-month": {
      const monthEnd = endOfMonth(now)
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, { start: todayStart, end: monthEnd })
      )
    }

    case "custom":
      if (!filter.customStart || !filter.customEnd) return tasks
      return tasks.filter((t) =>
        t.dueDate && isWithinInterval(t.dueDate, {
          start: startOfDay(filter.customStart!),
          end: endOfDay(filter.customEnd!),
        })
      )

    default:
      return tasks
  }
}

/**
 * Filter tasks by status IDs (for Kanban view)
 */
export const filterByStatuses = (tasks: Task[], statusIds: string[]): Task[] => {
  if (statusIds.length === 0) return tasks
  return tasks.filter((t) => statusIds.includes(t.statusId))
}

/**
 * Filter tasks by completion state
 */
export const filterByCompletion = (
  tasks: Task[],
  completion: CompletionFilterType,
  projects: Project[]
): Task[] => {
  const isComplete = (task: Task): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    const status = project?.statuses.find((s) => s.id === task.statusId)
    return status?.type === "done"
  }

  switch (completion) {
    case "active":
      return tasks.filter((t) => !isComplete(t))
    case "completed":
      return tasks.filter((t) => isComplete(t) && !t.archivedAt)
    case "all":
    default:
      return tasks
  }
}

/**
 * Filter tasks by repeat type
 */
export const filterByRepeatType = (
  tasks: Task[],
  type: RepeatFilterType
): Task[] => {
  switch (type) {
    case "repeating":
      return tasks.filter((t) => t.isRepeating)
    case "one-time":
      return tasks.filter((t) => !t.isRepeating)
    case "all":
    default:
      return tasks
  }
}

/**
 * Filter tasks by whether they have a time set
 */
export const filterByHasTime = (
  tasks: Task[],
  type: HasTimeFilterType
): Task[] => {
  switch (type) {
    case "with-time":
      return tasks.filter((t) => t.dueTime !== null)
    case "without-time":
      return tasks.filter((t) => t.dueTime === null)
    case "all":
    default:
      return tasks
  }
}

/**
 * Sort tasks by specified field and direction
 */
export const sortTasksAdvanced = (
  tasks: Task[],
  sort: TaskSort,
  projects: Project[]
): Task[] => {
  const priorityOrder: Record<Priority, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
    none: 4,
  }

  const sorted = [...tasks].sort((a, b) => {
    let comparison = 0

    switch (sort.field) {
      case "dueDate":
        // Tasks without due date go to end
        if (!a.dueDate && !b.dueDate) comparison = 0
        else if (!a.dueDate) comparison = 1
        else if (!b.dueDate) comparison = -1
        else comparison = a.dueDate.getTime() - b.dueDate.getTime()
        break

      case "priority":
        comparison = priorityOrder[a.priority] - priorityOrder[b.priority]
        break

      case "createdAt":
        comparison = a.createdAt.getTime() - b.createdAt.getTime()
        break

      case "title":
        comparison = a.title.localeCompare(b.title)
        break

      case "project": {
        const projectA = projects.find((p) => p.id === a.projectId)?.name || ""
        const projectB = projects.find((p) => p.id === b.projectId)?.name || ""
        comparison = projectA.localeCompare(projectB)
        break
      }

      case "completedAt":
        if (!a.completedAt && !b.completedAt) comparison = 0
        else if (!a.completedAt) comparison = 1
        else if (!b.completedAt) comparison = -1
        else comparison = a.completedAt.getTime() - b.completedAt.getTime()
        break
    }

    return sort.direction === "desc" ? -comparison : comparison
  })

  return sorted
}

/**
 * Apply all filters and sort to tasks
 */
export const applyFiltersAndSort = (
  tasks: Task[],
  filters: TaskFilters,
  sort: TaskSort,
  projects: Project[]
): Task[] => {
  let result = [...tasks]

  // 1. Search filter
  if (filters.search) {
    result = filterBySearch(result, filters.search)
  }

  // 2. Project filter
  if (filters.projectIds.length > 0) {
    result = filterByProjects(result, filters.projectIds)
  }

  // 3. Priority filter
  if (filters.priorities.length > 0) {
    result = filterByPriorities(result, filters.priorities)
  }

  // 4. Due date filter
  result = filterByDueDateRange(result, filters.dueDate)

  // 5. Status filter
  if (filters.statusIds.length > 0) {
    result = filterByStatuses(result, filters.statusIds)
  }

  // 6. Completion filter
  result = filterByCompletion(result, filters.completion, projects)

  // 7. Repeat type filter
  result = filterByRepeatType(result, filters.repeatType)

  // 8. Has time filter
  result = filterByHasTime(result, filters.hasTime)

  // 9. Apply sort
  result = sortTasksAdvanced(result, sort, projects)

  return result
}

/**
 * Check if any filters are active (different from defaults)
 */
export const hasActiveFilters = (filters: TaskFilters): boolean => {
  return (
    filters.search !== "" ||
    filters.projectIds.length > 0 ||
    filters.priorities.length > 0 ||
    filters.dueDate.type !== "any" ||
    filters.statusIds.length > 0 ||
    filters.completion !== "active" ||
    filters.repeatType !== "all" ||
    filters.hasTime !== "all"
  )
}

/**
 * Count active filters for badge display
 */
export const countActiveFilters = (filters: TaskFilters): number => {
  let count = 0
  if (filters.search) count++
  if (filters.projectIds.length > 0) count++
  if (filters.priorities.length > 0) count++
  if (filters.dueDate.type !== "any") count++
  if (filters.statusIds.length > 0) count++
  if (filters.completion !== "active") count++
  if (filters.repeatType !== "all") count++
  if (filters.hasTime !== "all") count++
  return count
}

