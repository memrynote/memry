import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'
import { priorityConfig } from '@/data/sample-tasks'
import { startOfDay, differenceInDays } from './task-date-utils'

// ============================================================================
// TASK STATUS HELPERS
// ============================================================================

export const isTaskCompleted = (task: Task, projects: Project[]): boolean => {
  const project = projects.find((p) => p.id === task.projectId)
  if (!project) return false

  const status = project.statuses.find((s) => s.id === task.statusId)
  return status?.type === 'done'
}

export const getDefaultTodoStatus = (project: Project): Status | undefined => {
  return project.statuses.find((s) => s.type === 'todo')
}

export const getDefaultDoneStatus = (project: Project): Status | undefined => {
  return project.statuses.find((s) => s.type === 'done')
}

// ============================================================================
// TASK SORTING
// ============================================================================

export const sortTasksByPriorityAndDate = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    const priorityA = priorityConfig[a.priority].order
    const priorityB = priorityConfig[b.priority].order

    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    if (a.dueDate && b.dueDate) {
      return a.dueDate.getTime() - b.dueDate.getTime()
    }
    if (a.dueDate && !b.dueDate) return -1
    if (!a.dueDate && b.dueDate) return 1

    return 0
  })
}

const priorityOrder: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
}

export const sortTasksByTimeAndPriority = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    if (a.dueTime && !b.dueTime) return -1
    if (!a.dueTime && b.dueTime) return 1

    if (a.dueTime && b.dueTime) {
      const timeCompare = a.dueTime.localeCompare(b.dueTime)
      if (timeCompare !== 0) return timeCompare
    }

    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

export const sortOverdueTasks = (tasks: Task[]): Task[] => {
  return [...tasks].sort((a, b) => {
    if (a.dueDate && b.dueDate) {
      const dateCompare = a.dueDate.getTime() - b.dueDate.getTime()
      if (dateCompare !== 0) return dateCompare
    }

    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}

// ============================================================================
// TASK GROUPING - BY DUE DATE
// ============================================================================

export interface TaskGroupByDate {
  overdue: Task[]
  today: Task[]
  tomorrow: Task[]
  upcoming: Task[]
  later: Task[]
  noDueDate: Task[]
}

export const groupTasksByDueDate = (
  tasks: Task[],
  preserveOrder: boolean = false
): TaskGroupByDate => {
  const groups: TaskGroupByDate = {
    overdue: [],
    today: [],
    tomorrow: [],
    upcoming: [],
    later: [],
    noDueDate: []
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

  if (!preserveOrder) {
    Object.keys(groups).forEach((key) => {
      groups[key as keyof TaskGroupByDate] = sortTasksByPriorityAndDate(
        groups[key as keyof TaskGroupByDate]
      )
    })
  }

  return groups
}

// ============================================================================
// TASK GROUPING - BY STATUS
// ============================================================================

export interface TaskGroupByStatus {
  status: Status
  tasks: Task[]
}

export const groupTasksByStatus = (
  tasks: Task[],
  projectStatuses: Status[],
  preserveOrder: boolean = false
): TaskGroupByStatus[] => {
  const sortedStatuses = [...projectStatuses].sort((a, b) => a.order - b.order)

  return sortedStatuses.map((status) => {
    const statusTasks = tasks.filter((t) => t.statusId === status.id)
    return {
      status,
      tasks: preserveOrder ? statusTasks : sortTasksByPriorityAndDate(statusTasks)
    }
  })
}

// ============================================================================
// GROUP HEADER CONFIGURATION
// ============================================================================

export type UrgencyLevel = 'critical' | 'high' | 'normal' | 'low'

export interface GroupHeaderConfig {
  id: string
  label: string
  urgency: UrgencyLevel
  accentColor?: string
  isMuted?: boolean
}

export const dueDateGroupConfig: Record<keyof TaskGroupByDate, GroupHeaderConfig> = {
  overdue: { id: 'overdue', label: 'OVERDUE', urgency: 'critical', accentColor: '#ef4444' },
  today: { id: 'today', label: 'TODAY', urgency: 'high', accentColor: '#3b82f6' },
  tomorrow: { id: 'tomorrow', label: 'TOMORROW', urgency: 'normal' },
  upcoming: { id: 'upcoming', label: 'UPCOMING', urgency: 'normal' },
  later: { id: 'later', label: 'LATER', urgency: 'low', isMuted: true },
  noDueDate: { id: 'noDueDate', label: 'NO DUE DATE', urgency: 'low', isMuted: true }
}
