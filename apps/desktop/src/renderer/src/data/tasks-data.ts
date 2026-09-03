import type { TFunction } from 'i18next'
import { getI18n } from 'react-i18next'

import type { Priority } from './task-model'

// ============================================================================
// LOCALIZATION
// ============================================================================

/**
 * The label tables below are module-level constants, so they are evaluated
 * before `createRendererI18n` runs in `main.tsx`. Resolve each label lazily so
 * it follows the active locale, and fall back to English while i18n is still
 * booting.
 */
const tasksT = (): TFunction<'tasks'> | null => {
  const i18n = getI18n()
  return i18n ? i18n.getFixedT(null, 'tasks') : null
}

// ============================================================================
// STATUS TYPES AND INTERFACES
// ============================================================================

export type StatusType = 'todo' | 'in_progress' | 'done'

export interface Status {
  id: string
  name: string
  color: string
  type: StatusType
  order: number
}

// ============================================================================
// PROJECT TYPES AND INTERFACES
// ============================================================================

export interface Project {
  id: string
  name: string
  description: string
  icon: string // Icon name
  color: string // hex color for project indicator
  statuses: Status[]
  isDefault: boolean // true only for "Personal"
  isArchived: boolean
  createdAt: Date
  taskCount: number // computed from tasks, but stored for display
}

// ============================================================================
// TASK VIEW TYPES AND INTERFACES
// ============================================================================

export interface TaskView {
  id: string
  label: string
  icon: 'list' | 'star' | 'calendar' | 'check'
  count: number
}

// ============================================================================
// VIEW MODE TYPES
// ============================================================================

export type ViewMode = 'list' | 'kanban'

export const viewModes: { id: ViewMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' }
]

export const LIST_ONLY_VIEWS = ['today', 'completed']

// ============================================================================
// PROJECT COLORS
// ============================================================================

export const projectColors = [
  { id: 'gray', value: '#6b7280', label: 'Gray' },
  { id: 'red', value: '#ef4444', label: 'Red' },
  { id: 'orange', value: '#f59e0b', label: 'Orange' },
  { id: 'yellow', value: '#eab308', label: 'Yellow' },
  { id: 'green', value: '#10b981', label: 'Green' },
  { id: 'teal', value: '#14b8a6', label: 'Teal' },
  { id: 'blue', value: '#3b82f6', label: 'Blue' },
  { id: 'indigo', value: '#6366f1', label: 'Indigo' },
  { id: 'purple', value: '#8b5cf6', label: 'Purple' },
  { id: 'pink', value: '#ec4899', label: 'Pink' }
] as const

// ============================================================================
// STATUS COLORS
// ============================================================================

export const statusColors = [
  { id: 'gray', value: '#6b7280' },
  { id: 'red', value: '#ef4444' },
  { id: 'orange', value: '#f59e0b' },
  { id: 'yellow', value: '#eab308' },
  { id: 'green', value: '#10b981' },
  { id: 'teal', value: '#14b8a6' },
  { id: 'blue', value: '#3b82f6' },
  { id: 'indigo', value: '#6366f1' },
  { id: 'purple', value: '#8b5cf6' },
  { id: 'pink', value: '#ec4899' }
] as const

// ============================================================================
// STATUS TYPE OPTIONS
// ============================================================================

export const statusTypeOptions: { value: StatusType; label: string }[] = [
  {
    value: 'todo',
    get label() {
      return tasksT()?.('project.statusTypes.todo') ?? 'To Do'
    }
  },
  {
    value: 'in_progress',
    get label() {
      return tasksT()?.('project.statusTypes.inProgress') ?? 'In Progress'
    }
  },
  {
    value: 'done',
    get label() {
      return tasksT()?.('project.statusTypes.done') ?? 'Done'
    }
  }
]

// ============================================================================
// DEFAULT STATUSES FOR NEW PROJECTS
// ============================================================================

/**
 * `name` here is a PERSISTED value: `createDefaultProject` copies it into new
 * projects, and it is written to the data DB and synced. Do not localize it —
 * only `statusTypeOptions` above (display-only) is translated.
 */
export const defaultStatuses: Status[] = [
  { id: 'todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
  { id: 'in-progress', name: 'In Progress', color: '#F59E0B', type: 'in_progress', order: 1 },
  { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 2 }
]

// ============================================================================
// TASK VIEWS
// ============================================================================

export const taskViews: TaskView[] = [
  { id: 'all', label: 'All Tasks', icon: 'list', count: 23 },
  { id: 'today', label: 'Today', icon: 'star', count: 3 },
  { id: 'completed', label: 'Completed', icon: 'check', count: 45 }
]

// ============================================================================
// INITIAL PROJECTS
// ============================================================================

export const initialProjects: Project[] = []

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique ID for new projects/statuses
 */
export const generateId = (prefix: string = 'id'): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Create a new status with default values
 */
export const createDefaultStatus = (order: number): Status => ({
  id: generateId('status'),
  name: '',
  color: '#6b7280',
  type: 'todo',
  order
})

/**
 * Create a new project with default values
 */
export const createDefaultProject = (): Omit<Project, 'id' | 'createdAt'> => ({
  name: '',
  description: '',
  icon: 'Folder',
  color: '#6366f1',
  isDefault: false,
  isArchived: false,
  statuses: [...defaultStatuses.map((s, i) => ({ ...s, id: generateId('status'), order: i }))],
  taskCount: 0
})

// ============================================================================
// VALIDATION TYPES
// ============================================================================

export interface ProjectValidationErrors {
  name?: string
  statuses?: string
}

/**
 * Validate project form data
 */
export const validateProject = (name: string, statuses: Status[]): ProjectValidationErrors => {
  const errors: ProjectValidationErrors = {}

  // Name validation
  if (!name.trim()) {
    errors.name = tasksT()?.('project.validation.nameRequired') ?? 'Project name is required'
  } else if (name.length > 50) {
    errors.name =
      tasksT()?.('project.validation.nameTooLong') ?? 'Project name must be 50 characters or less'
  }

  // Status validation
  if (statuses.length < 2) {
    errors.statuses =
      tasksT()?.('project.validation.minStatuses') ?? 'Projects need at least 2 statuses'
  } else {
    const hasTodo = statuses.some((s) => s.type === 'todo')
    const hasDone = statuses.some((s) => s.type === 'done')

    if (!hasTodo) {
      errors.statuses =
        tasksT()?.('project.validation.needsTodoStatusForNewTasks') ??
        "Projects need at least one 'To Do' status for new tasks"
    } else if (!hasDone) {
      errors.statuses =
        tasksT()?.('project.validation.needsDoneStatusForCompletedTasks') ??
        "Projects need at least one 'Done' status for completed tasks"
    }

    // Check for empty status names
    const hasEmptyName = statuses.some((s) => !s.name.trim())
    if (hasEmptyName && !errors.statuses) {
      errors.statuses =
        tasksT()?.('project.validation.statusNameRequired') ?? 'All statuses must have a name'
    }

    // Check for duplicate status names
    const names = statuses.map((s) => s.name.toLowerCase().trim()).filter((n) => n)
    const hasDuplicates = names.length !== new Set(names).size
    if (hasDuplicates && !errors.statuses) {
      errors.statuses =
        tasksT()?.('project.validation.statusNamesUnique') ?? 'Status names must be unique'
    }
  }

  return errors
}

/**
 * Check if a status can be deleted
 */
export const canDeleteStatus = (
  statuses: Status[],
  statusId: string
): { canDelete: boolean; reason?: string } => {
  if (statuses.length <= 2) {
    return {
      canDelete: false,
      reason: tasksT()?.('project.validation.minStatuses') ?? 'Projects need at least 2 statuses'
    }
  }

  const status = statuses.find((s) => s.id === statusId)
  if (!status) {
    return {
      canDelete: false,
      reason: tasksT()?.('project.validation.statusNotFound') ?? 'Status not found'
    }
  }

  // Check if this is the only status of its type (for todo and done)
  if (status.type === 'todo') {
    const todoCount = statuses.filter((s) => s.type === 'todo').length
    if (todoCount <= 1) {
      return {
        canDelete: false,
        reason:
          tasksT()?.('project.validation.needsTodoStatus') ??
          "Projects need at least one 'To Do' status"
      }
    }
  }

  if (status.type === 'done') {
    const doneCount = statuses.filter((s) => s.type === 'done').length
    if (doneCount <= 1) {
      return {
        canDelete: false,
        reason:
          tasksT()?.('project.validation.needsDoneStatus') ??
          "Projects need at least one 'Done' status"
      }
    }
  }

  return { canDelete: true }
}

// ============================================================================
// FILTER TYPES AND INTERFACES
// ============================================================================

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

export type CompletionFilterType = 'active' | 'completed' | 'all'

export type RepeatFilterType = 'all' | 'repeating' | 'one-time'

export type HasTimeFilterType = 'all' | 'with-time' | 'without-time'

export interface DueDateFilter {
  type: DueDateFilterType
  customStart?: Date | null
  customEnd?: Date | null
}

export interface TaskFilters {
  // Text search
  search: string

  // Project filter (multi-select)
  projectIds: string[] // empty = all projects

  // Priority filter (multi-select)
  priorities: Priority[] // empty = all priorities

  // Tag filter (multi-select, OR semantics)
  tags: string[] // empty = all tags

  // Due date filter
  dueDate: DueDateFilter

  // Status filter (for Kanban view)
  statusIds: string[] // empty = all statuses

  // Completion filter
  completion: CompletionFilterType

  // Repeat filter
  repeatType: RepeatFilterType

  // Has time set
  hasTime: HasTimeFilterType
}

// ============================================================================
// SORT TYPES AND INTERFACES
// ============================================================================

export type SortField =
  'dueDate' | 'priority' | 'status' | 'createdAt' | 'title' | 'project' | 'completedAt'

export type SortDirection = 'asc' | 'desc'

export interface TaskSort {
  field: SortField
  direction: SortDirection
}

// ============================================================================
// SAVED FILTER TYPES
// ============================================================================

export interface SavedFilter {
  id: string
  name: string
  filters: TaskFilters
  sort?: TaskSort
  starred: boolean
  createdAt: Date
}

// ============================================================================
// DEFAULT FILTER/SORT VALUES
// ============================================================================

export const defaultDueDateFilter: DueDateFilter = {
  type: 'any',
  customStart: null,
  customEnd: null
}

export const defaultFilters: TaskFilters = {
  search: '',
  projectIds: [],
  priorities: [],
  tags: [],
  dueDate: defaultDueDateFilter,
  statusIds: [],
  completion: 'active',
  repeatType: 'all',
  hasTime: 'all'
}

export const defaultSort: TaskSort = {
  field: 'dueDate',
  direction: 'asc'
}

// ============================================================================
// FILTER OPTIONS CONFIGURATION
// ============================================================================

/**
 * Single source of truth for due date filter labels. Anything that renders a
 * `DueDateFilterType` reads it from here instead of keeping its own table.
 * Declaration order is also the order the options are offered in.
 */
const dueDateFilterLabels: Record<DueDateFilterType, () => string> = {
  any: () => tasksT()?.('filters.dueDate.any') ?? 'Any due date',
  none: () => tasksT()?.('filters.dueDate.none') ?? 'No due date',
  overdue: () => tasksT()?.('filters.dueDate.overdue') ?? 'Overdue',
  today: () => tasksT()?.('filters.dueDate.today') ?? 'Today',
  tomorrow: () => tasksT()?.('filters.dueDate.tomorrow') ?? 'Tomorrow',
  'this-week': () => tasksT()?.('filters.dueDate.thisWeek') ?? 'This week',
  'next-week': () => tasksT()?.('filters.dueDate.nextWeek') ?? 'Next week',
  'this-month': () => tasksT()?.('filters.dueDate.thisMonth') ?? 'This month',
  custom: () => tasksT()?.('filters.dueDate.custom') ?? 'Custom range...'
}

/**
 * `type` reaches this function from persisted + synced saved filters, so it can
 * hold a value this build does not know about. Fall back to the raw type rather
 * than throwing, which is what the previous `.find()` lookup effectively did.
 */
export const dueDateFilterLabel = (type: DueDateFilterType): string => {
  const label = dueDateFilterLabels[type] as (() => string) | undefined
  return label ? label() : type
}

export const dueDateFilterOptions: { value: DueDateFilterType; label: string }[] = (
  Object.keys(dueDateFilterLabels) as DueDateFilterType[]
).map((value) => ({
  value,
  get label() {
    return dueDateFilterLabel(value)
  }
}))

export const sortFieldOptions: { value: SortField; label: string }[] = [
  { value: 'dueDate', label: 'Due Date' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'createdAt', label: 'Created' },
  { value: 'title', label: 'Title (A-Z)' },
  { value: 'project', label: 'Project' }
]

// ============================================================================
// QUICK FILTER PRESETS
// ============================================================================

export interface QuickFilterPreset {
  id: string
  label: string
  icon: string
  filters: Partial<TaskFilters>
}

export const quickFilterPresets: QuickFilterPreset[] = [
  {
    id: 'overdue',
    get label() {
      return tasksT()?.('filters.quickPresets.overdue') ?? 'Overdue'
    },
    icon: 'AlertTriangle',
    filters: {
      dueDate: { type: 'overdue', customStart: null, customEnd: null }
    }
  },
  {
    id: 'high-priority',
    get label() {
      return tasksT()?.('filters.quickPresets.highPriority') ?? 'High Priority'
    },
    icon: 'Flag',
    filters: {
      priorities: ['urgent', 'high']
    }
  },
  {
    id: 'due-this-week',
    get label() {
      return tasksT()?.('filters.quickPresets.dueThisWeek') ?? 'Due This Week'
    },
    icon: 'Calendar',
    filters: {
      dueDate: { type: 'this-week', customStart: null, customEnd: null }
    }
  },
  {
    id: 'repeating',
    get label() {
      return tasksT()?.('filters.quickPresets.repeating') ?? 'Repeating'
    },
    icon: 'Repeat',
    filters: {
      repeatType: 'repeating'
    }
  },
  {
    id: 'no-due-date',
    get label() {
      return tasksT()?.('filters.quickPresets.noDueDate') ?? 'No Due Date'
    },
    icon: 'HelpCircle',
    filters: {
      dueDate: { type: 'none', customStart: null, customEnd: null }
    }
  }
]
