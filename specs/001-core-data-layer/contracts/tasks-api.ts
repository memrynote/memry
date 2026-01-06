/**
 * Tasks IPC API Contract
 *
 * Handles task and project CRUD operations.
 * Tasks are stored in SQLite (data.db), not as files.
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export interface RepeatConfig {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  interval: number;
  days?: number[]; // For weekly: 0=Sun, 1=Mon, etc.
  dayOfMonth?: number;
  endDate?: string;
}

export interface Task {
  id: string;
  projectId: string;
  statusId: string | null;
  parentId: string | null;

  title: string;
  description: string | null;
  priority: 0 | 1 | 2 | 3;
  position: number;

  dueDate: string | null;
  dueTime: string | null;
  startDate: string | null;

  repeatConfig: RepeatConfig | null;
  repeatFrom: 'due' | 'completion' | null;

  completedAt: string | null;
  archivedAt: string | null;

  createdAt: string;
  modifiedAt: string;

  // Optionally loaded relations
  subtasks?: Task[];
  linkedNoteIds?: string[];
  tags?: string[];
}

export interface TaskListItem {
  id: string;
  projectId: string;
  statusId: string | null;
  parentId: string | null;
  title: string;
  priority: 0 | 1 | 2 | 3;
  position: number;
  dueDate: string | null;
  dueTime: string | null;
  completedAt: string | null;
  hasSubtasks: boolean;
  subtaskCount: number;
  completedSubtaskCount: number;
  tags: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  position: number;
  isInbox: boolean;
  createdAt: string;
  modifiedAt: string;
  archivedAt: string | null;
}

export interface ProjectWithStats extends Project {
  taskCount: number;
  completedCount: number;
  overdueCount: number;
}

export interface Status {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  isDefault: boolean;
  isDone: boolean;
  createdAt: string;
}

// ============================================================================
// Request Schemas
// ============================================================================

export const TaskCreateSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).default(0),
  statusId: z.string().nullish(),
  parentId: z.string().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  linkedNoteIds: z.array(z.string()).optional(),
  position: z.number().int().optional(),
});

export const TaskUpdateSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  projectId: z.string().optional(),
  statusId: z.string().nullish(),
  parentId: z.string().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  repeatConfig: z
    .object({
      type: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'custom']),
      interval: z.number().int().min(1),
      days: z.array(z.number().int().min(0).max(6)).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      endDate: z.string().optional(),
    })
    .nullish(),
  repeatFrom: z.enum(['due', 'completion']).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  linkedNoteIds: z.array(z.string()).optional(),
});

export const TaskCompleteSchema = z.object({
  id: z.string(),
  completedAt: z.string().datetime().optional(), // Defaults to now
});

export const TaskMoveSchema = z.object({
  taskId: z.string(),
  targetProjectId: z.string().optional(),
  targetStatusId: z.string().nullish(),
  targetParentId: z.string().nullish(),
  position: z.number().int(),
});

export const TaskListSchema = z.object({
  projectId: z.string().optional(),
  statusId: z.string().nullish(),
  parentId: z.string().nullish(),
  includeCompleted: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  tags: z.array(z.string()).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['position', 'dueDate', 'priority', 'created', 'modified']).default('position'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});

export const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  icon: z.string().nullish(),
});

export const ProjectUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().nullish(),
});

export const StatusCreateSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6b7280'),
  isDone: z.boolean().default(false),
});

// ============================================================================
// IPC Channel Definitions
// ============================================================================

export const TasksChannels = {
  invoke: {
    // Task operations
    CREATE: 'tasks:create',
    GET: 'tasks:get',
    UPDATE: 'tasks:update',
    DELETE: 'tasks:delete',
    LIST: 'tasks:list',
    COMPLETE: 'tasks:complete',
    UNCOMPLETE: 'tasks:uncomplete',
    ARCHIVE: 'tasks:archive',
    UNARCHIVE: 'tasks:unarchive',
    MOVE: 'tasks:move',
    REORDER: 'tasks:reorder',
    DUPLICATE: 'tasks:duplicate',

    // Subtask operations
    GET_SUBTASKS: 'tasks:get-subtasks',
    CONVERT_TO_SUBTASK: 'tasks:convert-to-subtask',
    CONVERT_TO_TASK: 'tasks:convert-to-task',

    // Project operations
    PROJECT_CREATE: 'tasks:project-create',
    PROJECT_GET: 'tasks:project-get',
    PROJECT_UPDATE: 'tasks:project-update',
    PROJECT_DELETE: 'tasks:project-delete',
    PROJECT_LIST: 'tasks:project-list',
    PROJECT_ARCHIVE: 'tasks:project-archive',
    PROJECT_REORDER: 'tasks:project-reorder',

    // Status operations
    STATUS_CREATE: 'tasks:status-create',
    STATUS_UPDATE: 'tasks:status-update',
    STATUS_DELETE: 'tasks:status-delete',
    STATUS_REORDER: 'tasks:status-reorder',

    // Tag operations
    GET_TAGS: 'tasks:get-tags',

    // Bulk operations
    BULK_COMPLETE: 'tasks:bulk-complete',
    BULK_DELETE: 'tasks:bulk-delete',
    BULK_MOVE: 'tasks:bulk-move',
    BULK_ARCHIVE: 'tasks:bulk-archive',

    // Stats
    GET_STATS: 'tasks:get-stats',
    GET_TODAY: 'tasks:get-today',
    GET_UPCOMING: 'tasks:get-upcoming',
    GET_OVERDUE: 'tasks:get-overdue',
  },

  events: {
    CREATED: 'tasks:created',
    UPDATED: 'tasks:updated',
    DELETED: 'tasks:deleted',
    COMPLETED: 'tasks:completed',
    MOVED: 'tasks:moved',
    PROJECT_CREATED: 'tasks:project-created',
    PROJECT_UPDATED: 'tasks:project-updated',
    PROJECT_DELETED: 'tasks:project-deleted',
  },
} as const;

// ============================================================================
// Response Types
// ============================================================================

export interface TaskCreateResponse {
  success: boolean;
  task: Task | null;
  error?: string;
}

export interface TaskListResponse {
  tasks: TaskListItem[];
  total: number;
  hasMore: boolean;
}

export interface ProjectListResponse {
  projects: ProjectWithStats[];
}

export interface TaskStats {
  total: number;
  completed: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface TasksHandlers {
  [TasksChannels.invoke.CREATE]: (
    input: z.infer<typeof TaskCreateSchema>
  ) => Promise<TaskCreateResponse>;

  [TasksChannels.invoke.GET]: (id: string) => Promise<Task | null>;

  [TasksChannels.invoke.UPDATE]: (
    input: z.infer<typeof TaskUpdateSchema>
  ) => Promise<TaskCreateResponse>;

  [TasksChannels.invoke.DELETE]: (id: string) => Promise<{ success: boolean; error?: string }>;

  [TasksChannels.invoke.LIST]: (
    input: z.infer<typeof TaskListSchema>
  ) => Promise<TaskListResponse>;

  [TasksChannels.invoke.COMPLETE]: (
    input: z.infer<typeof TaskCompleteSchema>
  ) => Promise<TaskCreateResponse>;

  [TasksChannels.invoke.UNCOMPLETE]: (id: string) => Promise<TaskCreateResponse>;

  [TasksChannels.invoke.ARCHIVE]: (id: string) => Promise<{ success: boolean }>;

  [TasksChannels.invoke.UNARCHIVE]: (id: string) => Promise<{ success: boolean }>;

  [TasksChannels.invoke.MOVE]: (
    input: z.infer<typeof TaskMoveSchema>
  ) => Promise<TaskCreateResponse>;

  [TasksChannels.invoke.REORDER]: (
    taskIds: string[],
    positions: number[]
  ) => Promise<{ success: boolean }>;

  [TasksChannels.invoke.PROJECT_CREATE]: (
    input: z.infer<typeof ProjectCreateSchema>
  ) => Promise<{ success: boolean; project: Project | null; error?: string }>;

  [TasksChannels.invoke.PROJECT_LIST]: () => Promise<ProjectListResponse>;

  [TasksChannels.invoke.GET_STATS]: () => Promise<TaskStats>;

  [TasksChannels.invoke.GET_TODAY]: () => Promise<TaskListResponse>;

  [TasksChannels.invoke.GET_UPCOMING]: (days?: number) => Promise<TaskListResponse>;

  [TasksChannels.invoke.GET_OVERDUE]: () => Promise<TaskListResponse>;
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Tasks service client interface for renderer process
 *
 * @example
 * ```typescript
 * const tasks = window.api.tasks;
 *
 * // Create a task
 * const result = await tasks.create({
 *   projectId: 'inbox',
 *   title: 'Buy groceries',
 *   dueDate: '2025-12-20',
 *   priority: 2
 * });
 *
 * // Get today's tasks
 * const { tasks: todayTasks } = await tasks.getToday();
 *
 * // Complete a task
 * await tasks.complete({ id: taskId });
 *
 * // Listen for task changes
 * window.api.on('tasks:completed', ({ id, task }) => {
 *   playCompletionSound();
 *   updateTaskList();
 * });
 * ```
 */
export interface TasksClientAPI {
  // Task CRUD
  create(input: z.infer<typeof TaskCreateSchema>): Promise<TaskCreateResponse>;
  get(id: string): Promise<Task | null>;
  update(input: z.infer<typeof TaskUpdateSchema>): Promise<TaskCreateResponse>;
  delete(id: string): Promise<{ success: boolean; error?: string }>;
  list(options?: z.infer<typeof TaskListSchema>): Promise<TaskListResponse>;

  // Task actions
  complete(input: z.infer<typeof TaskCompleteSchema>): Promise<TaskCreateResponse>;
  uncomplete(id: string): Promise<TaskCreateResponse>;
  archive(id: string): Promise<{ success: boolean }>;
  unarchive(id: string): Promise<{ success: boolean }>;
  move(input: z.infer<typeof TaskMoveSchema>): Promise<TaskCreateResponse>;
  reorder(taskIds: string[], positions: number[]): Promise<{ success: boolean }>;
  duplicate(id: string): Promise<TaskCreateResponse>;

  // Project operations
  createProject(input: z.infer<typeof ProjectCreateSchema>): Promise<{
    success: boolean;
    project: Project | null;
    error?: string;
  }>;
  getProject(id: string): Promise<Project | null>;
  updateProject(input: z.infer<typeof ProjectUpdateSchema>): Promise<{
    success: boolean;
    project: Project | null;
    error?: string;
  }>;
  deleteProject(id: string): Promise<{ success: boolean; error?: string }>;
  listProjects(): Promise<ProjectListResponse>;

  // Status operations
  createStatus(input: z.infer<typeof StatusCreateSchema>): Promise<{
    success: boolean;
    status: Status | null;
  }>;
  updateStatus(id: string, updates: Partial<Status>): Promise<{ success: boolean }>;
  deleteStatus(id: string): Promise<{ success: boolean }>;
  reorderStatuses(statusIds: string[], positions: number[]): Promise<{ success: boolean }>;

  // Views
  getStats(): Promise<TaskStats>;
  getToday(): Promise<TaskListResponse>;
  getUpcoming(days?: number): Promise<TaskListResponse>;
  getOverdue(): Promise<TaskListResponse>;

  // Tags
  getTags(): Promise<{ tag: string; count: number }[]>;

  // Bulk operations
  bulkComplete(ids: string[]): Promise<{ success: boolean; count: number }>;
  bulkDelete(ids: string[]): Promise<{ success: boolean; count: number }>;
  bulkMove(ids: string[], projectId: string): Promise<{ success: boolean; count: number }>;
  bulkArchive(ids: string[]): Promise<{ success: boolean; count: number }>;
}
