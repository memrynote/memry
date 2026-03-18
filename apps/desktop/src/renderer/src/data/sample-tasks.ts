// ============================================================================
// TASK TYPES AND INTERFACES
// ============================================================================

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type RepeatFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export type MonthlyType = 'dayOfMonth' | 'weekPattern'

export type RepeatEndType = 'never' | 'date' | 'count'

export interface RepeatConfig {
  // Base frequency
  frequency: RepeatFrequency

  // Interval: every X days/weeks/months/years
  interval: number // 1 = every, 2 = every other, 3 = every third, etc.

  // Weekly: which days of the week
  daysOfWeek?: number[] // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  // Monthly: day of month OR week pattern
  monthlyType?: MonthlyType
  dayOfMonth?: number // 1-31, used when monthlyType = "dayOfMonth"
  weekOfMonth?: number // 1-5 (5 = last), used when monthlyType = "weekPattern"
  dayOfWeekForMonth?: number // 0-6, used with weekOfMonth

  // End condition
  endType: RepeatEndType
  endDate?: Date | null // when endType = "date"
  endCount?: number // when endType = "count" (after X occurrences)

  // Tracking
  completedCount: number // how many times completed
  createdAt: Date
}

export interface Task {
  id: string
  title: string
  description: string // optional, rich text
  projectId: string // required, references a project
  statusId: string // references a status within the project

  priority: Priority

  // Due date
  dueDate: Date | null
  dueTime: string | null // "14:30" format, optional even if dueDate set

  // Repeating
  isRepeating: boolean
  repeatConfig: RepeatConfig | null

  // Linking
  linkedNoteIds: string[] // connections to notes
  sourceNoteId: string | null // if extracted from a note

  // Subtasks
  parentId: string | null // ID of parent task (null if top-level)
  subtaskIds: string[] // Ordered list of subtask IDs

  // Metadata
  createdAt: Date
  completedAt: Date | null // set when moved to "done" type status
  archivedAt: Date | null // set when task is archived (for completed tasks)
}

// ============================================================================
// PRIORITY CONFIGURATION
// ============================================================================

export const priorityConfig: Record<
  Priority,
  { color: string | null; bgColor: string | null; label: string | null; order: number }
> = {
  none: {
    color: 'var(--task-priority-none)',
    bgColor: 'var(--task-priority-none-bg)',
    label: 'No Priority',
    order: 4
  },
  low: {
    color: 'var(--task-priority-low)',
    bgColor: 'var(--task-priority-low-bg)',
    label: 'Low',
    order: 3
  },
  medium: {
    color: 'var(--task-priority-medium)',
    bgColor: 'var(--task-priority-medium-bg)',
    label: 'Medium',
    order: 2
  },
  high: {
    color: 'var(--task-priority-high)',
    bgColor: 'var(--task-priority-high-bg)',
    label: 'High',
    order: 1
  },
  urgent: {
    color: 'var(--task-priority-urgent)',
    bgColor: 'var(--task-priority-urgent-bg)',
    label: 'Urgent',
    order: 0
  }
}

export const PRIORITY_TEXT_CLASSES: Record<Priority, string> = {
  urgent: 'text-task-priority-urgent',
  high: 'text-task-priority-high',
  medium: 'text-task-priority-medium',
  low: 'text-task-priority-low',
  none: 'text-task-priority-none'
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate unique task ID
 */
export const generateTaskId = (): string => {
  return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// ============================================================================
// SAMPLE TASKS DATA (Empty - data loaded from database)
// ============================================================================

export const sampleTasks: Task[] = []

// ============================================================================
// CREATE DEFAULT TASK
// ============================================================================

export const createDefaultTask = (
  projectId: string,
  statusId: string,
  title: string = '',
  dueDate: Date | null = null,
  parentId: string | null = null
): Task => ({
  id: generateTaskId(),
  title,
  description: '',
  projectId,
  statusId,
  priority: 'none',
  dueDate,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})
