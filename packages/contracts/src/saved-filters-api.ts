/**
 * Saved Filters IPC API Contract
 *
 * Handles saved filter CRUD operations.
 * Saved filters are stored in SQLite (data.db) in the saved_filters table.
 */

import type { TaskFilterGroup, TaskFilterNode } from '@memry/domain-tasks/filtering'
import { z } from 'zod'

export type { TaskFilterGroup, TaskFilterNode, TaskFilterRule } from '@memry/domain-tasks/filtering'

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
  tags: string[]
  dueDate: DueDateFilter
  statusIds: string[]
  /** `archived` is the archived-only scope; older builds never write it. */
  completion: 'active' | 'completed' | 'all' | 'archived'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
  /**
   * Vault-relative folders whose notes' tasks match, subfolders included.
   * Optional: rows written before it existed have no key, and builds that
   * predate it ignore it and show the filter without the location part.
   */
  folderPaths?: string[]
  /** Notes whose tasks match. Optional for the same reason as `folderPaths`. */
  noteIds?: string[]
}

/**
 * TaskSort config - matches frontend type
 *
 * `status` was missing here while the renderer has offered it as a grouping
 * mode all along, so saving a status-grouped filter failed validation at the
 * IPC boundary. `folder` and `note` group by the note a task came from.
 *
 * Additive, like `completion: 'archived'`: a row written by a newer build is
 * read back with a cast rather than through this schema, so an older build
 * degrades to an ungrouped list instead of losing the filter.
 */
export interface TaskSort {
  field:
    | 'dueDate'
    | 'priority'
    | 'status'
    | 'createdAt'
    | 'title'
    | 'project'
    | 'completedAt'
    | 'folder'
    | 'note'
  direction: 'asc' | 'desc'
}

/**
 * SavedFilter config stored in JSON column
 */
export interface SavedFilterConfig {
  filters: TaskFilters
  sort?: TaskSort
  starred?: boolean
}

/**
 * SavedFilter entity as returned from database
 */
export interface SavedFilter {
  id: string
  name: string
  config: SavedFilterConfig
  /**
   * Advanced rules, ANDed with `config.filters`. Kept beside `config`, not in
   * it: desktop builds before this field rebuild `config` from the keys they
   * know when they star a filter, but carry an unknown top-level payload key
   * through (docs/protocol §13.7.14). `null` when the filter has no rules.
   */
  expression: TaskFilterGroup | null
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

export const TaskFiltersSchema = z.object({
  search: z.string().default(''),
  projectIds: z.array(z.string()).default([]),
  priorities: z.array(z.enum(['urgent', 'high', 'medium', 'low', 'none'])).default([]),
  tags: z.array(z.string()).default([]),
  dueDate: DueDateFilterSchema.default({ type: 'any', customStart: null, customEnd: null }),
  statusIds: z.array(z.string()).default([]),
  // Additive: rows written before `archived` existed still parse, and a row
  // carrying it degrades to the default on builds that predate it.
  completion: z.enum(['active', 'completed', 'all', 'archived']).default('active'),
  repeatType: z.enum(['all', 'repeating', 'one-time']).default('all'),
  hasTime: z.enum(['all', 'with-time', 'without-time']).default('all'),
  // Additive and without a default, so a row that never had them is not
  // rewritten with empty arrays.
  folderPaths: z.array(z.string()).optional(),
  noteIds: z.array(z.string()).optional()
})

const PrioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none'])

const TaskFilterRuleSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('title'),
    op: z.enum(['contains', 'notContains']),
    values: z.array(z.string())
  }),
  z.object({
    field: z.literal('priority'),
    op: z.enum(['any', 'none']),
    values: z.array(PrioritySchema)
  }),
  z.object({
    field: z.literal('status'),
    op: z.enum(['any', 'none']),
    values: z.array(z.string())
  }),
  z.object({
    field: z.literal('project'),
    op: z.enum(['any', 'none']),
    values: z.array(z.string())
  }),
  z.object({
    field: z.literal('tags'),
    op: z.enum(['any', 'all', 'none', 'empty', 'notEmpty']),
    values: z.array(z.string())
  }),
  z.object({
    field: z.literal('due'),
    op: z.enum(['is', 'isNot']),
    values: z.array(
      z.enum([
        'none',
        'overdue',
        'today',
        'tomorrow',
        'this-week',
        'next-week',
        'this-month',
        'custom'
      ])
    ),
    dueStart: z.string().nullable().optional(),
    dueEnd: z.string().nullable().optional()
  }),
  z.object({
    field: z.literal('location'),
    op: z.enum(['any', 'none']),
    folderPaths: z.array(z.string()),
    noteIds: z.array(z.string())
  }),
  z.object({
    field: z.literal('repeat'),
    op: z.literal('is'),
    values: z.array(z.enum(['repeating', 'one-time']))
  }),
  z.object({
    field: z.literal('hasTime'),
    op: z.literal('is'),
    values: z.array(z.enum(['with-time', 'without-time']))
  })
])

/**
 * The rules this build writes. Reading a stored or synced tree goes through
 * no schema: a newer build's field or operator is skipped when evaluated
 * (`evaluateTaskFilterRule`) and kept verbatim when the filter is saved again.
 */
export const TaskFilterGroupSchema: z.ZodType<TaskFilterGroup> = z.lazy(() =>
  z.object({
    match: z.enum(['all', 'any', 'none']),
    rules: z.array(
      z.union([TaskFilterGroupSchema, TaskFilterRuleSchema]) as z.ZodType<TaskFilterNode>
    )
  })
)

const TaskSortSchema = z.object({
  field: z.enum([
    'dueDate',
    'priority',
    'status',
    'createdAt',
    'title',
    'project',
    'completedAt',
    'folder',
    'note'
  ]),
  direction: z.enum(['asc', 'desc'])
})

const SavedFilterConfigSchema = z.object({
  filters: TaskFiltersSchema,
  sort: TaskSortSchema.optional(),
  starred: z.boolean().optional()
})

export const SavedFilterCreateSchema = z.object({
  name: z.string().min(1).max(100),
  config: SavedFilterConfigSchema,
  expression: TaskFilterGroupSchema.nullable().optional()
})

/**
 * `config` merges key by key into the stored config, so a key this build does
 * not model (a newer build's) survives an edit (docs/protocol §13.7.14).
 * `starred` alone stars or unstars without touching the rest.
 */
export const SavedFilterUpdateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100).optional(),
  config: SavedFilterConfigSchema.optional(),
  starred: z.boolean().optional(),
  expression: TaskFilterGroupSchema.nullable().optional(),
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
