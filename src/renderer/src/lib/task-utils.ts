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
// TASK FILTERING
// ============================================================================

/**
 * Get filtered tasks based on current selection
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

  // Get incomplete tasks
  const incompleteTasks = tasks.filter(isIncomplete)

  // Get completed tasks
  const completedTasks = tasks.filter(isComplete)

  if (selectedType === "view") {
    const today = startOfDay(new Date())
    const weekFromNow = addDays(today, 7)

    switch (selectedId) {
      case "all":
        return incompleteTasks

      case "today":
        return incompleteTasks.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          // Include overdue and today
          return isSameDay(taskDate, today) || isBefore(taskDate, today)
        })

      case "upcoming":
        return incompleteTasks.filter((task) => {
          if (!task.dueDate) return false
          const taskDate = startOfDay(task.dueDate)
          // Tomorrow through next 7 days
          return isAfter(taskDate, today) && !isAfter(taskDate, weekFromNow)
        })

      case "completed":
        return completedTasks

      default:
        return incompleteTasks
    }
  }

  if (selectedType === "project") {
    // Return all tasks for the project (both complete and incomplete)
    return tasks.filter((task) => task.projectId === selectedId)
  }

  return incompleteTasks
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

export interface GroupHeaderConfig {
  id: string
  label: string
  accentColor?: string
  isMuted?: boolean
}

export const dueDateGroupConfig: Record<keyof TaskGroupByDate, GroupHeaderConfig> = {
  overdue: { id: "overdue", label: "OVERDUE", accentColor: "#ef4444" },
  today: { id: "today", label: "TODAY", accentColor: "#f59e0b" },
  tomorrow: { id: "tomorrow", label: "TOMORROW" },
  upcoming: { id: "upcoming", label: "UPCOMING" },
  later: { id: "later", label: "LATER", isMuted: true },
  noDueDate: { id: "noDueDate", label: "NO DUE DATE", isMuted: true },
}

export const completionGroupConfig: Record<keyof TaskGroupByCompletion, GroupHeaderConfig> = {
  today: { id: "today", label: "TODAY", accentColor: "#10b981" },
  yesterday: { id: "yesterday", label: "YESTERDAY" },
  earlier: { id: "earlier", label: "EARLIER", isMuted: true },
}

