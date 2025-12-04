// ============================================================================
// TASK TYPES AND INTERFACES
// ============================================================================

export type Priority = "none" | "low" | "medium" | "high" | "urgent"

export type RepeatFrequency = "daily" | "weekly" | "monthly" | "yearly"

export type MonthlyType = "dayOfMonth" | "weekPattern"

export type RepeatEndType = "never" | "date" | "count"

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
  { color: string | null; label: string | null; order: number }
> = {
  none: { color: null, label: null, order: 4 },
  low: { color: "#6b7280", label: "Low", order: 3 },
  medium: { color: "#f59e0b", label: "Medium", order: 2 },
  high: { color: "#f97316", label: "High", order: 1 },
  urgent: { color: "#ef4444", label: "Urgent", order: 0 },
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Helper to create dates relative to today
 */
const daysFromNow = (days: number): Date => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Generate unique task ID
 */
export const generateTaskId = (): string => {
  return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// ============================================================================
// SAMPLE TASKS DATA
// ============================================================================

export const sampleTasks: Task[] = [
  // ========== Personal project tasks ==========
  {
    id: "task-1",
    title: "Review API documentation",
    description: "",
    projectId: "personal",
    statusId: "p-todo",
    priority: "high",
    dueDate: daysFromNow(0), // today
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-2",
    title: "Buy groceries",
    description: "Milk, eggs, bread, vegetables",
    projectId: "personal",
    statusId: "p-todo",
    priority: "medium",
    dueDate: daysFromNow(0), // today
    dueTime: "18:00",
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-10"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-3",
    title: "Call mom",
    description: "",
    projectId: "personal",
    statusId: "p-doing",
    priority: "none",
    dueDate: daysFromNow(1), // tomorrow
    dueTime: null,
    isRepeating: true,
    repeatConfig: {
      frequency: "weekly",
      interval: 1,
      daysOfWeek: [0], // Sunday
      endType: "never",
      completedCount: 0,
      createdAt: new Date("2024-11-01"),
    },
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-01"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-4",
    title: "Read 'Atomic Habits' chapter 5",
    description: "",
    projectId: "personal",
    statusId: "p-todo",
    priority: "low",
    dueDate: daysFromNow(3),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: ["note-123"],
    sourceNoteId: null,
    createdAt: new Date("2024-12-05"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-5",
    title: "Pay electricity bill",
    description: "",
    projectId: "personal",
    statusId: "p-todo",
    priority: "high",
    dueDate: daysFromNow(-2), // overdue
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: null,
    archivedAt: null,
  },

  // ========== Project Alpha tasks ==========
  {
    id: "task-6",
    title: "Design system color tokens",
    description: "Define primary, secondary, and semantic colors",
    projectId: "project-alpha",
    statusId: "a-progress",
    priority: "high",
    dueDate: daysFromNow(0), // today
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-7",
    title: "Component inventory audit",
    description: "",
    projectId: "project-alpha",
    statusId: "a-backlog",
    priority: "medium",
    dueDate: daysFromNow(5),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-08"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-8",
    title: "Review typography scale",
    description: "",
    projectId: "project-alpha",
    statusId: "a-review",
    priority: "none",
    dueDate: daysFromNow(1), // tomorrow
    dueTime: "14:00",
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-10"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-9",
    title: "Setup Storybook",
    description: "",
    projectId: "project-alpha",
    statusId: "a-done",
    priority: "none",
    dueDate: daysFromNow(-3),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: daysFromNow(-1),
    archivedAt: null,
  },

  // ========== Work tasks ==========
  {
    id: "task-10",
    title: "Prepare quarterly presentation",
    description: "Q4 results and Q1 planning",
    projectId: "work",
    statusId: "w-progress",
    priority: "urgent",
    dueDate: daysFromNow(2),
    dueTime: "09:00",
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-05"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-11",
    title: "Weekly team standup",
    description: "",
    projectId: "work",
    statusId: "w-todo",
    priority: "none",
    dueDate: daysFromNow(1), // tomorrow
    dueTime: "10:00",
    isRepeating: true,
    repeatConfig: {
      frequency: "weekly",
      interval: 1,
      daysOfWeek: [1], // Monday
      endType: "never",
      completedCount: 0,
      createdAt: new Date("2024-11-01"),
    },
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-01"),
    completedAt: null,
    archivedAt: null,
  },
  {
    id: "task-12",
    title: "Update project roadmap",
    description: "",
    projectId: "work",
    statusId: "w-todo",
    priority: "medium",
    dueDate: null, // no due date
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: null,
    archivedAt: null,
  },

  // ========== Sample completed tasks for testing ==========
  {
    id: "task-completed-1",
    title: "Morning planning",
    description: "",
    projectId: "personal",
    statusId: "p-done",
    priority: "none",
    dueDate: daysFromNow(0),
    dueTime: "08:00",
    isRepeating: true,
    repeatConfig: {
      frequency: "daily",
      interval: 1,
      endType: "never",
      completedCount: 5,
      createdAt: new Date("2024-11-01"),
    },
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-01"),
    completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    archivedAt: null,
  },
  {
    id: "task-completed-2",
    title: "Send project update",
    description: "",
    projectId: "work",
    statusId: "w-done",
    priority: "medium",
    dueDate: daysFromNow(0),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4 hours ago
    archivedAt: null,
  },
  {
    id: "task-completed-3",
    title: "Client presentation",
    description: "",
    projectId: "work",
    statusId: "w-done",
    priority: "high",
    dueDate: daysFromNow(-1),
    dueTime: "17:30",
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: daysFromNow(-1), // yesterday
    archivedAt: null,
  },
  {
    id: "task-completed-4",
    title: "Code review PR #42",
    description: "",
    projectId: "project-alpha",
    statusId: "a-done",
    priority: "medium",
    dueDate: daysFromNow(-1),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: daysFromNow(-1), // yesterday
    archivedAt: null,
  },
  {
    id: "task-completed-5",
    title: "Team retrospective",
    description: "",
    projectId: "work",
    statusId: "w-done",
    priority: "none",
    dueDate: daysFromNow(-3),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-12-01"),
    completedAt: daysFromNow(-3), // 3 days ago
    archivedAt: null,
  },
  {
    id: "task-completed-6",
    title: "Update documentation",
    description: "",
    projectId: "project-alpha",
    statusId: "a-done",
    priority: "low",
    dueDate: daysFromNow(-5),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-25"),
    completedAt: daysFromNow(-5), // 5 days ago
    archivedAt: null,
  },
  {
    id: "task-completed-7",
    title: "Set up CI/CD pipeline",
    description: "",
    projectId: "project-alpha",
    statusId: "a-done",
    priority: "high",
    dueDate: daysFromNow(-10),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-20"),
    completedAt: daysFromNow(-10), // 10 days ago
    archivedAt: null,
  },
  {
    id: "task-completed-8",
    title: "Initial project setup",
    description: "",
    projectId: "project-alpha",
    statusId: "a-done",
    priority: "high",
    dueDate: daysFromNow(-15),
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    createdAt: new Date("2024-11-15"),
    completedAt: daysFromNow(-15), // 15 days ago
    archivedAt: null,
  },
]

// ============================================================================
// CREATE DEFAULT TASK
// ============================================================================

export const createDefaultTask = (
  projectId: string,
  statusId: string,
  title: string = "",
  dueDate: Date | null = null
): Task => ({
  id: generateTaskId(),
  title,
  description: "",
  projectId,
  statusId,
  priority: "none",
  dueDate,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
})

