/**
 * Saved Filters IPC API Contract
 *
 * Handles saved filter CRUD operations.
 * Saved filters are stored in SQLite (data.db) in the saved_filters table.
 */

import { z } from 'zod'

// ============================================================================
// Types
// ============================================================================

/**
 * DueDateFilter config - matches frontend type
 */
export interface DueDateFilter {
  type:
    | 'any'
    | 'none'
    | 'overdue'
    | 'today'
    | 'tomorrow'
    | 'this-week'
    | 'next-week'
    | 'this-month'
    | 'custom'
  customStart?: string | null // ISO date string
  customEnd?: string | null // ISO date string
}

/**
 * TaskFilters config - matches frontend type
 */
export interface TaskFilters {
  search: string
  projectIds: string[]
  priorities: Array<'urgent' | 'high' | 'medium' | 'low' | 'none'>
  dueDate: DueDateFilter
  statusIds: string[]
  completion: 'active' | 'completed' | 'all'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
}

/**
 * TaskSort config - matches frontend type
 */
export interface TaskSort {
  field: 'dueDate' | 'priority' | 'createdAt' | 'title' | 'project' | 'completedAt'
  direction: 'asc' | 'desc'
}

/**
 * SavedFilter config stored in JSON column
 */
export interface SavedFilterConfig {
  filters: TaskFilters
  sort?: TaskSort
}

/**
 * SavedFilter entity as returned from database
 */
export interface SavedFilter {
  id: string
  name: string
  config: SavedFilterConfig
  position: number
  createdAt: string
}

// ============================================================================
// Request Schemas
// ============================================================================

const DueDateFilterSchema = z.object({
  type: z.enum([
    'any',
    'none',
    'overdue',
    'today',
    'tomorrow',
    'this-week',
    'next-week',
    'this-month',
    'custom'
  ]),
  customStart: z.string().nullable().optional(),
  customEnd: z.string().nullable().optional()
})

const TaskFiltersSchema = z.object({
  search: z.string().default(''),
  projectIds: z.array(z.string()).default([]),
  priorities: z.array(z.enum(['urgent', 'high', 'medium', 'low', 'none'])).default([]),
  dueDate: DueDateFilterSchema.default({ type: 'any', customStart: null, customEnd: null }),
  statusIds: z.array(z.string()).default([]),
  completion: z.enum(['active', 'completed', 'all']).default('active'),
  repeatType: z.enum(['all', 'repeating', 'one-time']).default('all'),
  hasTime: z.enum(['all', 'with-time', 'without-time']).default('all')
})

const TaskSortSchema = z.object({
  field: z.enum(['dueDate', 'priority', 'createdAt', 'title', 'project', 'completedAt']),
  direction: z.enum(['asc', 'desc'])
})

const SavedFilterConfigSchema = z.object({
  filters: TaskFiltersSchema,
  sort: TaskSortSchema.optional()
})

export const SavedFilterCreateSchema = z.object({
  name: z.string().min(1).max(100),
  config: SavedFilterConfigSchema
})

export const SavedFilterUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  config: SavedFilterConfigSchema.optional(),
  position: z.number().int().min(0).optional()
})

export const SavedFilterDeleteSchema = z.object({
  id: z.string()
})

export const SavedFilterReorderSchema = z.object({
  ids: z.array(z.string()),
  positions: z.array(z.number().int())
})

// ============================================================================
// Response Types
// ============================================================================

export interface SavedFilterListResponse {
  savedFilters: SavedFilter[]
}

export interface SavedFilterCreateResponse {
  success: boolean
  savedFilter: SavedFilter | null
  error?: string
}

export interface SavedFilterUpdateResponse {
  success: boolean
  savedFilter: SavedFilter | null
  error?: string
}

export interface SavedFilterDeleteResponse {
  success: boolean
  error?: string
}

// ============================================================================
// Type inference
// ============================================================================

export type SavedFilterCreateInput = z.infer<typeof SavedFilterCreateSchema>
export type SavedFilterUpdateInput = z.infer<typeof SavedFilterUpdateSchema>
export type SavedFilterDeleteInput = z.infer<typeof SavedFilterDeleteSchema>
export type SavedFilterReorderInput = z.infer<typeof SavedFilterReorderSchema>
