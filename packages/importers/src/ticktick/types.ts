import type { ImportMessage } from '../messages'

export interface TickTickRow {
  folderName: string
  listName: string
  title: string
  kind: string
  tags: string[]
  content: string
  isCheckList: boolean
  startDate: string
  dueDate: string
  reminder: string
  repeat: string
  priority: number
  status: number
  createdTime: string
  completedTime: string
  order: string
  timezone: string
  isAllDay: boolean
  isFloating: boolean
  columnName: string
  columnOrder: string
  viewMode: string
  taskId: string
  parentId: string
  projectKind: string
}

// Mirrors apps/desktop .../data/task-model.ts + @memry/domain-tasks RepeatConfig,
// pre-serialized for the service layer (dates as 'YYYY-MM-DD' strings, createdAt ISO).
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

export type MemryPriority = 0 | 1 | 2 | 3 | 4
export type StatusType = 'todo' | 'in_progress' | 'done'

export interface StatusPlan {
  tempId: string
  name: string
  color: string
  type: StatusType
  order: number
  isDone: boolean
}

export interface ProjectPlan {
  tempId: string
  name: string
  useExistingInbox: boolean
  statuses: StatusPlan[]
}

export interface ReminderPlan {
  remindAt: string
}

export interface TaskPlan {
  tempId: string
  projectTempId: string
  parentTempId: string | null
  statusTempId: string | null
  title: string
  description: string | null
  priority: MemryPriority
  position: number
  startDate: string | null
  dueDate: string | null
  dueTime: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string | null
  tags: string[]
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  reminders: ReminderPlan[]
}

export interface ImportWarning extends ImportMessage {
  row?: number
}

export interface ImportStats {
  rows: number
  projects: number
  tasks: number
  subtasks: number
  reminders: number
}

export interface ImportPlan {
  projects: ProjectPlan[]
  tasks: TaskPlan[]
  warnings: ImportWarning[]
  stats: ImportStats
}
