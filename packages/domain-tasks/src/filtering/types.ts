/**
 * Filter, sort and group value types (spec 004 TP015).
 *
 * `TaskFilters` and `TaskSort` are the saved-filter `config` shape desktop
 * syncs (`packages/contracts/src/saved-filters-api.ts`). The task and project
 * shapes are structural so the renderer's own types flow through unchanged.
 */
import type { Priority, StatusType } from '../parsing/types.ts'

export type DueDateFilterType =
  | 'any'
  | 'none'
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'this-week'
  | 'next-week'
  | 'this-month'
  | 'custom'

export interface DueDateFilter {
  type: DueDateFilterType
  customStart?: Date | null
  customEnd?: Date | null
}

export type CompletionFilterType = 'active' | 'completed' | 'all' | 'archived'
export type RepeatFilterType = 'all' | 'repeating' | 'one-time'
export type HasTimeFilterType = 'all' | 'with-time' | 'without-time'

export interface TaskFilters {
  search: string
  projectIds: string[]
  priorities: Priority[]
  tags: string[]
  dueDate: DueDateFilter
  statusIds: string[]
  completion: CompletionFilterType
  repeatType: RepeatFilterType
  hasTime: HasTimeFilterType
}

/**
 * A saved filter carries this value through sync, so an older build can read a
 * field it does not know: `sortTasksAdvanced` leaves the order untouched and
 * `groupTasksForSort` returns no groups. Keep that unknown-value path intact.
 */
export type SortField =
  | 'dueDate'
  | 'priority'
  | 'status'
  | 'createdAt'
  | 'title'
  | 'project'
  | 'completedAt'
  | 'folder'
  | 'note'

export type SortDirection = 'asc' | 'desc'

export interface TaskSort {
  field: SortField
  direction: SortDirection
}

/** The part of a task the filters, sorts and groups read. */
export interface FilterTask {
  id: string
  title: string
  description?: string | null
  projectId: string
  statusId: string
  parentId: string | null
  priority: Priority
  dueDate: Date | null
  dueTime: string | null
  createdAt: Date
  completedAt: Date | null
  archivedAt: Date | null
  isRepeating: boolean
  tags: string[]
  sourceNoteId: string | null
  linkedNoteIds: string[]
}

export interface FilterStatus {
  id: string
  type: StatusType
  color: string
  order: number
}

export interface FilterProject {
  id: string
  name: string
  color: string
  statuses: ReadonlyArray<FilterStatus>
}

/** A task's source note, resolved for the folder and note groupings. */
export interface TaskNoteInfo {
  id: string
  title: string
  /** Vault-relative folder, `''` for the vault root. */
  folderPath: string
}

export type TaskNoteIndex = ReadonlyMap<string, TaskNoteInfo>
