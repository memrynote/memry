/**
 * Task value types shared by the renderer and the task-parsing vectors.
 *
 * These are the shapes the desktop renderer has always used
 * (`apps/desktop/src/renderer/src/data/task-model.ts` re-exports them), moved
 * here so the pure logic that consumes them can live outside React.
 */

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

export type RepeatFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

export type MonthlyType = 'dayOfMonth' | 'weekPattern'

export type RepeatEndType = 'never' | 'date' | 'count'

/**
 * Which date the next occurrence is measured from. `due` keeps a fixed cadence
 * (a daily task completed three days late is still due tomorrow); `completion`
 * restarts the interval on the day the task was actually finished, which is what
 * Obsidian writes as `when done` and what habit tracking wants. Null means `due`,
 * so rows written before this was honored keep their existing behavior.
 */
export type RepeatAnchor = 'due' | 'completion'

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

export type StatusType = 'todo' | 'in_progress' | 'done'

/** The part of a project the quick-add parser reads. */
export interface QuickAddProject {
  id: string
  name: string
  isArchived: boolean
}

/** The part of a project the view predicates read. */
export interface ViewProject {
  id: string
  statuses: ReadonlyArray<{ id: string; type: StatusType }>
}

/** The part of a task the view predicates read. */
export interface ViewTask {
  id: string
  projectId: string
  statusId: string
  parentId: string | null
  dueDate: Date | null
  startDate?: Date | null
  completedAt: Date | null
  archivedAt: Date | null
}
