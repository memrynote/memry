import type { TFunction } from 'i18next'
import { getI18n } from 'react-i18next'

const tasksT = (): TFunction<'tasks'> | null => {
  const i18n = getI18n()
  return i18n ? i18n.getFixedT(null, 'tasks') : null
}

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
  linkedCanvasIds?: string[] // connections to canvases
  sourceNoteId: string | null // if extracted from a note

  // Tags — case-preserving, case-insensitive identity. Shared with notes/inbox
  // via the global tag_definitions store.
  tags: string[]

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

/**
 * `priorityConfig` is a module-level constant, so it is evaluated before
 * `createRendererI18n` runs in `main.tsx`. Resolve each label lazily so it
 * follows the active locale, and fall back to English while i18n is booting.
 */
const priorityLabels: Record<Priority, () => string> = {
  none: () => tasksT()?.('task.priorityLabels.none') ?? 'No Priority',
  low: () => tasksT()?.('task.priorityLabels.low') ?? 'Low',
  medium: () => tasksT()?.('task.priorityLabels.medium') ?? 'Medium',
  high: () => tasksT()?.('task.priorityLabels.high') ?? 'High',
  urgent: () => tasksT()?.('task.priorityLabels.urgent') ?? 'Urgent'
}

export const priorityConfig: Record<
  Priority,
  { color: string | null; bgColor: string | null; label: string | null; order: number }
> = {
  none: {
    color: 'var(--task-priority-none)',
    bgColor: 'var(--task-priority-none-bg)',
    get label() {
      return priorityLabels.none()
    },
    order: 4
  },
  low: {
    color: 'var(--task-priority-low)',
    bgColor: 'var(--task-priority-low-bg)',
    get label() {
      return priorityLabels.low()
    },
    order: 3
  },
  medium: {
    color: 'var(--task-priority-medium)',
    bgColor: 'var(--task-priority-medium-bg)',
    get label() {
      return priorityLabels.medium()
    },
    order: 2
  },
  high: {
    color: 'var(--task-priority-high)',
    bgColor: 'var(--task-priority-high-bg)',
    get label() {
      return priorityLabels.high()
    },
    order: 1
  },
  urgent: {
    color: 'var(--task-priority-urgent)',
    bgColor: 'var(--task-priority-urgent-bg)',
    get label() {
      return priorityLabels.urgent()
    },
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
// PRIORITY CSS VARIABLE MAPPING
// ============================================================================

export const PRIORITY_CSS_VARS: Record<Priority, { text: string; bg: string } | null> = {
  none: null,
  low: { text: 'var(--task-priority-low)', bg: 'var(--task-priority-medium-bg)' },
  medium: { text: 'var(--task-priority-medium)', bg: 'var(--task-priority-medium-bg)' },
  high: { text: 'var(--task-priority-high)', bg: 'var(--task-priority-high-bg)' },
  urgent: { text: 'var(--task-priority-urgent)', bg: 'var(--task-priority-urgent-bg)' }
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
  linkedCanvasIds: [],
  sourceNoteId: null,
  tags: [],
  parentId,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})
