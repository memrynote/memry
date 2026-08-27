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
  linkedCanvasIds?: string[]
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
  homeNoteId?: string | null
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

export interface ProjectLink {
  id: string
  projectId: string
  itemType: string
  itemId: string
  position: number
  createdAt: string
}

export interface ProjectLinkItemInput {
  projectId: string
  itemType: string
  itemId: string
}

export interface ProjectSetHomeNoteInput {
  projectId: string
  noteId: string | null
}

export interface ProjectSetLinkPinnedInput {
  projectId: string
  itemId: string
  pinned: boolean
}

export interface ProjectRef {
  id: string
  name: string
  color: string
  icon: string | null
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

// ============================================================================
// Project hub contents
// ============================================================================

/**
 * A markdown note linked to a project, resolved for the project hub.
 * `pinned` means the note is also shown in the hub's overview rail.
 */
export interface ProjectLinkedNote {
  id: string
  title: string
  emoji: string | null
  modifiedAt: string
  pinned: boolean
}

/** A non-markdown file linked to a project, resolved for the project hub. */
export interface ProjectLinkedFile {
  id: string
  title: string
  fileType: string
  mimeType: string | null
  fileSize: number | null
  modifiedAt: string
}

/** A calendar event linked to a project, resolved for the project hub. */
export interface ProjectLinkedEvent {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
}

/**
 * Everything a project links to, resolved in one pass. Links whose target no
 * longer exists are dropped by the join, so every entry here is renderable.
 */
export interface ProjectContents {
  notes: ProjectLinkedNote[]
  files: ProjectLinkedFile[]
  events: ProjectLinkedEvent[]
  counts: { notes: number; files: number; events: number }
}
