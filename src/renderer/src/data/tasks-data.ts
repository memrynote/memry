import type { Priority } from "./sample-tasks"

// ============================================================================
// STATUS TYPES AND INTERFACES
// ============================================================================

export type StatusType = "todo" | "in_progress" | "done"

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
  icon: string // Lucide icon name
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
  icon: "list" | "star" | "calendar" | "check"
  count: number
}

// ============================================================================
// VIEW MODE TYPES
// ============================================================================

export type ViewMode = "list" | "kanban" | "calendar"

export const viewModes: { id: ViewMode; label: string }[] = [
  { id: "list", label: "List" },
  { id: "kanban", label: "Kanban" },
  { id: "calendar", label: "Calendar" },
]

// Views that only support List mode (no Kanban/Calendar)
export const LIST_ONLY_VIEWS = ["today", "upcoming", "completed"]

// ============================================================================
// PROJECT COLORS
// ============================================================================

export const projectColors = [
  { id: "gray", value: "#6b7280", label: "Gray" },
  { id: "red", value: "#ef4444", label: "Red" },
  { id: "orange", value: "#f59e0b", label: "Orange" },
  { id: "yellow", value: "#eab308", label: "Yellow" },
  { id: "green", value: "#10b981", label: "Green" },
  { id: "teal", value: "#14b8a6", label: "Teal" },
  { id: "blue", value: "#3b82f6", label: "Blue" },
  { id: "indigo", value: "#6366f1", label: "Indigo" },
  { id: "purple", value: "#8b5cf6", label: "Purple" },
  { id: "pink", value: "#ec4899", label: "Pink" },
] as const

// ============================================================================
// STATUS COLORS
// ============================================================================

export const statusColors = [
  { id: "gray", value: "#6b7280" },
  { id: "red", value: "#ef4444" },
  { id: "orange", value: "#f59e0b" },
  { id: "yellow", value: "#eab308" },
  { id: "green", value: "#10b981" },
  { id: "teal", value: "#14b8a6" },
  { id: "blue", value: "#3b82f6" },
  { id: "indigo", value: "#6366f1" },
  { id: "purple", value: "#8b5cf6" },
  { id: "pink", value: "#ec4899" },
] as const

// ============================================================================
// STATUS TYPE OPTIONS
// ============================================================================

export const statusTypeOptions: { value: StatusType; label: string }[] = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
]

// ============================================================================
// DEFAULT STATUSES FOR NEW PROJECTS
// ============================================================================

export const defaultStatuses: Status[] = [
  { id: "todo", name: "To Do", color: "#6b7280", type: "todo", order: 0 },
  { id: "in-progress", name: "In Progress", color: "#3b82f6", type: "in_progress", order: 1 },
  { id: "done", name: "Done", color: "#10b981", type: "done", order: 2 },
]

// ============================================================================
// SAMPLE DATA - TASK VIEWS
// ============================================================================

export const taskViews: TaskView[] = [
  { id: "all", label: "All Tasks", icon: "list", count: 23 },
  { id: "today", label: "Today", icon: "star", count: 3 },
  { id: "upcoming", label: "Upcoming", icon: "calendar", count: 8 },
  { id: "completed", label: "Completed", icon: "check", count: 45 },
]

// ============================================================================
// SAMPLE DATA - PROJECTS (Empty - data loaded from database)
// ============================================================================

export const initialProjects: Project[] = []

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique ID for new projects/statuses
 */
export const generateId = (prefix: string = "id"): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * Create a new status with default values
 */
export const createDefaultStatus = (order: number): Status => ({
  id: generateId("status"),
  name: "",
  color: "#6b7280",
  type: "todo",
  order,
})

/**
 * Create a new project with default values
 */
export const createDefaultProject = (): Omit<Project, "id" | "createdAt"> => ({
  name: "",
  description: "",
  icon: "Folder",
  color: "#6366f1",
  isDefault: false,
  isArchived: false,
  statuses: [...defaultStatuses.map((s, i) => ({ ...s, id: generateId("status"), order: i }))],
  taskCount: 0,
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
export const validateProject = (
  name: string,
  statuses: Status[]
): ProjectValidationErrors => {
  const errors: ProjectValidationErrors = {}

  // Name validation
  if (!name.trim()) {
    errors.name = "Project name is required"
  } else if (name.length > 50) {
    errors.name = "Project name must be 50 characters or less"
  }

  // Status validation
  if (statuses.length < 2) {
    errors.statuses = "Projects need at least 2 statuses"
  } else {
    const hasTodo = statuses.some((s) => s.type === "todo")
    const hasDone = statuses.some((s) => s.type === "done")

    if (!hasTodo) {
      errors.statuses = "Projects need at least one 'To Do' status for new tasks"
    } else if (!hasDone) {
      errors.statuses = "Projects need at least one 'Done' status for completed tasks"
    }

    // Check for empty status names
    const hasEmptyName = statuses.some((s) => !s.name.trim())
    if (hasEmptyName && !errors.statuses) {
      errors.statuses = "All statuses must have a name"
    }

    // Check for duplicate status names
    const names = statuses.map((s) => s.name.toLowerCase().trim()).filter((n) => n)
    const hasDuplicates = names.length !== new Set(names).size
    if (hasDuplicates && !errors.statuses) {
      errors.statuses = "Status names must be unique"
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
    return { canDelete: false, reason: "Projects need at least 2 statuses" }
  }

  const status = statuses.find((s) => s.id === statusId)
  if (!status) {
    return { canDelete: false, reason: "Status not found" }
  }

  // Check if this is the only status of its type (for todo and done)
  if (status.type === "todo") {
    const todoCount = statuses.filter((s) => s.type === "todo").length
    if (todoCount <= 1) {
      return { canDelete: false, reason: "Projects need at least one 'To Do' status" }
    }
  }

  if (status.type === "done") {
    const doneCount = statuses.filter((s) => s.type === "done").length
    if (doneCount <= 1) {
      return { canDelete: false, reason: "Projects need at least one 'Done' status" }
    }
  }

  return { canDelete: true }
}

// ============================================================================
// FILTER TYPES AND INTERFACES
// ============================================================================

export type DueDateFilterType =
  | "any"
  | "none"
  | "overdue"
  | "today"
  | "tomorrow"
  | "this-week"
  | "next-week"
  | "this-month"
  | "custom"

export type CompletionFilterType = "active" | "completed" | "all"

export type RepeatFilterType = "all" | "repeating" | "one-time"

export type HasTimeFilterType = "all" | "with-time" | "without-time"

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
  | "dueDate"
  | "priority"
  | "createdAt"
  | "title"
  | "project"
  | "completedAt"

export type SortDirection = "asc" | "desc"

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
  createdAt: Date
}

// ============================================================================
// DEFAULT FILTER/SORT VALUES
// ============================================================================

export const defaultDueDateFilter: DueDateFilter = {
  type: "any",
  customStart: null,
  customEnd: null,
}

export const defaultFilters: TaskFilters = {
  search: "",
  projectIds: [],
  priorities: [],
  dueDate: defaultDueDateFilter,
  statusIds: [],
  completion: "active",
  repeatType: "all",
  hasTime: "all",
}

export const defaultSort: TaskSort = {
  field: "dueDate",
  direction: "asc",
}

// ============================================================================
// FILTER OPTIONS CONFIGURATION
// ============================================================================

export const dueDateFilterOptions: { value: DueDateFilterType; label: string }[] = [
  { value: "any", label: "Any due date" },
  { value: "none", label: "No due date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "this-week", label: "This week" },
  { value: "next-week", label: "Next week" },
  { value: "this-month", label: "This month" },
  { value: "custom", label: "Custom range..." },
]

export const sortFieldOptions: { value: SortField; label: string }[] = [
  { value: "dueDate", label: "Due Date" },
  { value: "priority", label: "Priority" },
  { value: "createdAt", label: "Created" },
  { value: "title", label: "Title (A-Z)" },
  { value: "project", label: "Project" },
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
    id: "overdue",
    label: "Overdue",
    icon: "AlertTriangle",
    filters: {
      dueDate: { type: "overdue", customStart: null, customEnd: null },
    },
  },
  {
    id: "high-priority",
    label: "High Priority",
    icon: "Flag",
    filters: {
      priorities: ["urgent", "high"],
    },
  },
  {
    id: "due-this-week",
    label: "Due This Week",
    icon: "Calendar",
    filters: {
      dueDate: { type: "this-week", customStart: null, customEnd: null },
    },
  },
  {
    id: "repeating",
    label: "Repeating",
    icon: "Repeat",
    filters: {
      repeatType: "repeating",
    },
  },
  {
    id: "no-due-date",
    label: "No Due Date",
    icon: "HelpCircle",
    filters: {
      dueDate: { type: "none", customStart: null, customEnd: null },
    },
  },
]
