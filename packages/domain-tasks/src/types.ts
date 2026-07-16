export interface RepeatConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  weekOfMonth?: number
  dayOfWeekForMonth?: number
  endType: 'never' | 'date' | 'count'
  endDate?: string | null
  endCount?: number
  completedCount: number
  createdAt: string
}

export interface Task {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: 0 | 1 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
  startDate: string | null
  isRepeating?: boolean
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  sourceNoteId: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
  tags?: string[]
  linkedNoteIds?: string[]
  hasSubtasks?: boolean
  subtaskCount?: number
  completedSubtaskCount?: number
}

export interface TaskListItem extends Task {
  tags: string[]
  hasSubtasks: boolean
  subtaskCount: number
  completedSubtaskCount: number
}

export interface Project {
  id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  position: number
  isInbox: boolean
  createdAt: string
  modifiedAt: string
  archivedAt: string | null
}

export interface ProjectWithStats extends Project {
  taskCount: number
  completedCount: number
  overdueCount: number
}

export interface Status {
  id: string
  projectId: string
  name: string
  color: string
  position: number
  isDefault: boolean
  isDone: boolean
  createdAt: string
}

export interface ProjectWithStatuses extends Project {
  statuses: Status[]
}

export interface Reminder {
  id: string
  taskId: string
  remindAt: string
  scheduledAt?: string | null
  dismissedAt?: string | null
}

export interface TaskStats {
  total: number
  completed: number
  overdue: number
  dueToday: number
  dueThisWeek: number
}

export interface TaskListOptions {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  includeCompleted?: boolean
  includeArchived?: boolean
  dueBefore?: string
  dueAfter?: string
  tags?: string[]
  search?: string
  sortBy?: 'position' | 'dueDate' | 'priority' | 'created' | 'modified'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}
