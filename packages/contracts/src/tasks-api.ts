/**
 * Tasks IPC API Contract
 *
 * Handles task and project CRUD operations.
 * Tasks are stored in SQLite (data.db), not as files.
 */

import { z } from 'zod'
import type { ProjectWithStats, Task, TaskListItem } from '@memry/domain-tasks'
export type {
  RepeatConfig,
  Task,
  TaskListItem,
  Project,
  ProjectWithStats,
  ProjectWithStatuses,
  Status,
  Reminder,
  TaskStats,
  TaskListOptions
} from '@memry/domain-tasks'

// ============================================================================
// Request Schemas
// ============================================================================

/**
 * RepeatConfigSchema - Zod schema matching frontend RepeatConfig interface
 */
export const RepeatConfigSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).default(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  monthlyType: z.enum(['dayOfMonth', 'weekPattern']).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  weekOfMonth: z.number().int().min(1).max(5).optional(),
  dayOfWeekForMonth: z.number().int().min(0).max(6).optional(),
  endType: z.enum(['never', 'date', 'count']),
  endDate: z.string().nullable().optional(),
  endCount: z.number().int().min(1).optional(),
  completedCount: z.number().int().min(0).default(0),
  createdAt: z.string()
})

export const TaskCreateSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(4).default(0),
  statusId: z.string().nullish(),
  parentId: z.string().nullish(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  dueTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  isRepeating: z.boolean().default(false),
  repeatConfig: RepeatConfigSchema.nullish(),
  repeatFrom: z.enum(['due', 'completion']).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  linkedNoteIds: z.array(z.string()).optional(),
  sourceNoteId: z.string().nullish(),
  position: z.number().int().optional()
})

export const TaskUpdateSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(4).optional(),
  projectId: z.string().optional(),
  statusId: z.string().nullish(),
  parentId: z.string().nullish(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  dueTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  isRepeating: z.boolean().optional(),
  repeatConfig: RepeatConfigSchema.nullish(),
  repeatFrom: z.enum(['due', 'completion']).nullish(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  linkedNoteIds: z.array(z.string()).optional()
})

export const TaskCompleteSchema = z.object({
  id: z.string(),
  completedAt: z.string().datetime().optional() // Defaults to now
})

export const TaskMoveSchema = z.object({
  taskId: z.string(),
  targetProjectId: z.string().optional(),
  targetStatusId: z.string().nullish(),
  targetParentId: z.string().nullish(),
  position: z.number().int()
})

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
  offset: z.number().int().min(0).default(0)
})

export const StatusInputSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6b7280'),
  type: z.enum(['todo', 'in_progress', 'done']),
  order: z.number().int().min(0)
})

export const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  icon: z.string().nullish(),
  statuses: z.array(StatusInputSchema).min(2).optional()
})

export const StatusUpsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6b7280'),
  type: z.enum(['todo', 'in_progress', 'done']),
  order: z.number().int().min(0)
})

export const ProjectUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z.string().nullish(),
  statuses: z.array(StatusUpsertSchema).min(2).optional()
})

export const StatusCreateSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6b7280'),
  isDone: z.boolean().default(false)
})

export const StatusUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  position: z.number().int().optional(),
  isDefault: z.boolean().optional(),
  isDone: z.boolean().optional()
})

// ============================================================================
// Reorder and Bulk Schemas
// ============================================================================

export const TaskReorderSchema = z.object({
  taskIds: z.array(z.string()),
  positions: z.array(z.number().int())
})

export const ConvertToSubtaskSchema = z.object({
  taskId: z.string(),
  parentId: z.string()
})

export const ProjectReorderSchema = z.object({
  projectIds: z.array(z.string()),
  positions: z.array(z.number().int())
})

export const StatusReorderSchema = z.object({
  statusIds: z.array(z.string()),
  positions: z.array(z.number().int())
})

export const BulkIdsSchema = z.object({
  ids: z.array(z.string())
})

export const BulkMoveSchema = z.object({
  ids: z.array(z.string()),
  projectId: z.string()
})

export const GetUpcomingSchema = z.object({
  days: z.number().int().min(1).max(365).default(7)
})

// ============================================================================
// Folder Schemas (for notes handlers)
// ============================================================================

export const RenameFolderSchema = z.object({
  oldPath: z.string(),
  newPath: z.string()
})

// ============================================================================
// Response Types
// ============================================================================

export interface TaskCreateResponse {
  success: boolean
  task: Task | null
  error?: string
}

export interface TaskListResponse {
  tasks: TaskListItem[]
  total: number
  hasMore: boolean
}

export interface ProjectListResponse {
  projects: ProjectWithStats[]
}

// ============================================================================
// Type inference
// ============================================================================

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>
export type TaskCompleteInput = z.infer<typeof TaskCompleteSchema>
export type TaskMoveInput = z.infer<typeof TaskMoveSchema>
export type TaskListInput = z.infer<typeof TaskListSchema>
export type StatusInput = z.infer<typeof StatusInputSchema>
export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateSchema>
export type StatusCreateInput = z.infer<typeof StatusCreateSchema>
export type StatusUpdateInput = z.infer<typeof StatusUpdateSchema>
export type TaskReorderInput = z.infer<typeof TaskReorderSchema>
export type ConvertToSubtaskInput = z.infer<typeof ConvertToSubtaskSchema>
export type ProjectReorderInput = z.infer<typeof ProjectReorderSchema>
export type StatusReorderInput = z.infer<typeof StatusReorderSchema>
export type BulkIdsInput = z.infer<typeof BulkIdsSchema>
export type BulkMoveInput = z.infer<typeof BulkMoveSchema>
export type GetUpcomingInput = z.infer<typeof GetUpcomingSchema>
export type RenameFolderInput = z.infer<typeof RenameFolderSchema>
