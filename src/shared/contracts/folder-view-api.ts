/**
 * Folder View IPC API Contract
 *
 * Handles folder view configuration and note listing with properties.
 * Provides database-like table view for folders
 *
 * STORAGE: Configuration is stored in .folder.md files (YAML frontmatter),
 * NOT in a database table. This ensures portability and sync-friendliness.
 */

import { z } from 'zod'

// ============================================================================
// Channel Constants (to be added to src/shared/ipc-channels.ts)
// ============================================================================

export const FolderViewChannels = {
  invoke: {
    /** Get folder view configuration (reads .folder.md) */
    GET_CONFIG: 'folder-view:get-config',
    /** Set/update folder view configuration (writes .folder.md) */
    SET_CONFIG: 'folder-view:set-config',
    /** Get all views for a folder */
    GET_VIEWS: 'folder-view:get-views',
    /** Add or update a single view */
    SET_VIEW: 'folder-view:set-view',
    /** Delete a view by name */
    DELETE_VIEW: 'folder-view:delete-view',
    /** List notes in folder with property values */
    LIST_WITH_PROPERTIES: 'folder-view:list-with-properties',
    /** Get available properties for column selector */
    GET_AVAILABLE_PROPERTIES: 'folder-view:get-available-properties'
  },
  events: {
    /** Folder view config was updated (external file change) */
    CONFIG_UPDATED: 'folder-view:config-updated'
  }
} as const

export type FolderViewInvokeChannel =
  (typeof FolderViewChannels.invoke)[keyof typeof FolderViewChannels.invoke]
export type FolderViewEventChannel =
  (typeof FolderViewChannels.events)[keyof typeof FolderViewChannels.events]

// ============================================================================
// Property Types (re-exported from notes-cache for convenience)
// ============================================================================

export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  URL: 'url',
  RATING: 'rating'
} as const

export type PropertyType = (typeof PropertyTypes)[keyof typeof PropertyTypes]

// ============================================================================
// Column Configuration
// ============================================================================

/**
 * Configuration for a single column in the table view.
 * Stored in .folder.md view.columns array.
 */
export interface ColumnConfig {
  /**
   * Column identifier.
   * Built-in: 'title', 'folder', 'tags', 'created', 'modified', 'wordCount'
   * Property: any custom property name (e.g., 'status', 'priority')
   * Formula: 'formula.{name}' for computed columns
   */
  id: string

  /**
   * Column width in pixels.
   * Persisted when user resizes columns.
   */
  width?: number

  /**
   * Override display name for this column in this view.
   * Takes precedence over properties.{id}.displayName
   */
  displayName?: string

  /**
   * Show summary for this column (if showSummaries is true for view)
   */
  showSummary?: boolean
}

export const ColumnConfigSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().min(50).max(800).optional(),
  displayName: z.string().optional(),
  showSummary: z.boolean().optional()
})

/**
 * Built-in columns that are always available.
 */
export const BUILT_IN_COLUMNS = [
  'title',
  'folder',
  'tags',
  'created',
  'modified',
  'wordCount'
] as const
export type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number]

/**
 * Default columns shown when folder view is first opened.
 */
export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: 'title', width: 250 },
  { id: 'folder', width: 120 },
  { id: 'tags', width: 150 },
  { id: 'modified', width: 130 }
]

// ============================================================================
// Filter Expression (AND/OR/NOT support)
// ============================================================================

/**
 * Filter expression supporting complex nested AND/OR/NOT logic.
 * Stored in .folder.md view.filters
 *
 * Examples:
 * - Simple: 'status == "done"'
 * - AND: { and: ['status != "done"', 'priority >= 3'] }
 * - OR: { or: ['status == "urgent"', 'priority >= 5'] }
 * - NOT: { not: 'status == "archived"' }
 * - Nested: { and: ['status != "done"', { or: ['priority >= 3', 'formula.is_overdue == true'] }] }
 */
export type FilterExpression =
  | string // Simple expression: 'status == "done"'
  | { and: FilterExpression[] } // All must match
  | { or: FilterExpression[] } // Any must match
  | { not: FilterExpression } // Negate

// Zod schema for filter expression (recursive)
const baseFilterSchema = z.string()
export const FilterExpressionSchema: z.ZodType<FilterExpression> = z.lazy(() =>
  z.union([
    baseFilterSchema,
    z.object({ and: z.array(FilterExpressionSchema) }),
    z.object({ or: z.array(FilterExpressionSchema) }),
    z.object({ not: FilterExpressionSchema })
  ])
)

/**
 * Filter operators available in expressions.
 */
export const FilterOperators = {
  // Equality
  EQUALS: '==',
  NOT_EQUALS: '!=',
  // Comparison
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  // String/Array
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains',
  STARTS_WITH: 'startsWith',
  ENDS_WITH: 'endsWith',
  // Presence
  IS_EMPTY: 'isEmpty',
  IS_NOT_EMPTY: 'isNotEmpty',
  // Regex
  MATCHES: 'matches'
} as const

// ============================================================================
// Order Configuration (Multi-column sorting)
// ============================================================================

/**
 * Sort configuration for a column.
 * Stored in .folder.md view.order array
 */
export interface OrderConfig {
  /** Property or formula to sort by */
  property: string

  /** Sort direction */
  direction: 'asc' | 'desc'
}

export const OrderConfigSchema = z.object({
  property: z.string().min(1),
  direction: z.enum(['asc', 'desc'])
})

// ============================================================================
// Group By Configuration
// ============================================================================

/**
 * Grouping configuration for table/kanban views.
 * Stored in .folder.md view.groupBy
 */
export interface GroupByConfig {
  /** Property to group by */
  property: string

  /** Group sort direction */
  direction?: 'asc' | 'desc'

  /** Start with groups collapsed */
  collapsed?: boolean

  /** Show group summaries */
  showSummary?: boolean
}

export const GroupByConfigSchema = z.object({
  property: z.string().min(1),
  direction: z.enum(['asc', 'desc']).optional(),
  collapsed: z.boolean().optional(),
  showSummary: z.boolean().optional()
})

// ============================================================================
// Property Display Configuration
// ============================================================================

/**
 * Custom display settings for a property.
 * Stored in .folder.md properties.{name}
 */
export interface PropertyDisplay {
  /** Custom display name for column header */
  displayName?: string

  /** Show color for select/status properties */
  color?: boolean

  /** Date format for date properties */
  dateFormat?: string

  /** Number format */
  numberFormat?: string

  /** Hide from column selector */
  hidden?: boolean
}

export const PropertyDisplaySchema = z.object({
  displayName: z.string().optional(),
  color: z.boolean().optional(),
  dateFormat: z.string().optional(),
  numberFormat: z.string().optional(),
  hidden: z.boolean().optional()
})

// ============================================================================
// Summary Configuration
// ============================================================================

/**
 * Column aggregation configuration.
 * Stored in .folder.md summaries.{property}
 */
export interface SummaryConfig {
  /** Aggregation type */
  type: 'sum' | 'average' | 'min' | 'max' | 'count' | 'countBy' | 'countUnique' | 'custom'

  /** Display label */
  label?: string

  /** Custom expression (for type: 'custom') */
  expression?: string
}

export const SummaryConfigSchema = z.object({
  type: z.enum(['sum', 'average', 'min', 'max', 'count', 'countBy', 'countUnique', 'custom']),
  label: z.string().optional(),
  expression: z.string().optional()
})

// ============================================================================
// View Configuration
// ============================================================================

/**
 * A single view definition.
 * Stored in .folder.md views[] array
 */
export interface ViewConfig {
  /** View name (displayed in view switcher) */
  name: string

  /** View type */
  type: 'table' | 'grid' | 'list' | 'kanban'

  /** Is this the default view? */
  default?: boolean

  /** Column definitions */
  columns?: ColumnConfig[]

  /** Filter expression (supports AND/OR/NOT) */
  filters?: FilterExpression

  /** Sort order (multi-column) */
  order?: OrderConfig[]

  /** Grouping configuration */
  groupBy?: GroupByConfig

  /** Row limit */
  limit?: number

  /** Show summary row */
  showSummaries?: boolean
}

export const ViewConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['table', 'grid', 'list', 'kanban']).default('table'),
  default: z.boolean().optional(),
  columns: z.array(ColumnConfigSchema).optional(),
  filters: FilterExpressionSchema.optional(),
  order: z.array(OrderConfigSchema).optional(),
  groupBy: GroupByConfigSchema.optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  showSummaries: z.boolean().optional()
})

// ============================================================================
// Folder Config (extends existing FolderConfig)
// ============================================================================

/**
 * Complete folder configuration including views.
 * Stored in .folder.md YAML frontmatter
 */
export interface FolderViewConfig {
  /** Folder path relative to notes/ */
  path: string

  // Existing fields (from templates-api.ts)
  template?: string
  inherit?: boolean

  // View configuration
  formulas?: Record<string, string>
  properties?: Record<string, PropertyDisplay>
  summaries?: Record<string, SummaryConfig>
  views?: ViewConfig[]
}

export const FolderViewConfigSchema = z.object({
  path: z.string(),
  template: z.string().optional(),
  inherit: z.boolean().optional(),
  formulas: z.record(z.string(), z.string()).optional(),
  properties: z.record(z.string(), PropertyDisplaySchema).optional(),
  summaries: z.record(z.string(), SummaryConfigSchema).optional(),
  views: z.array(ViewConfigSchema).optional()
})

// ============================================================================
// Default View
// ============================================================================

export const DEFAULT_VIEW: ViewConfig = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: DEFAULT_COLUMNS,
  order: [{ property: 'modified', direction: 'desc' }]
}

// ============================================================================
// Note with Properties
// ============================================================================

/**
 * Note data with property values for table display.
 */
export interface NoteWithProperties {
  /** Note ID */
  id: string

  /** Full path relative to vault root (e.g., "notes/projects/2024/note.md") */
  path: string

  /** Note title */
  title: string

  /** Emoji icon (if set) */
  emoji: string | null

  /**
   * Relative folder path from the viewed folder.
   * Examples when viewing "projects":
   * - Note at "notes/projects/note.md" → "/"
   * - Note at "notes/projects/2024/note.md" → "/2024"
   */
  folder: string

  /** Tags assigned to note */
  tags: string[]

  /** Creation timestamp (ISO string) */
  created: string

  /** Last modified timestamp (ISO string) */
  modified: string

  /** Word count */
  wordCount: number

  /** Property values keyed by property name */
  properties: Record<string, unknown>
}

// ============================================================================
// Available Property
// ============================================================================

/**
 * Property available for adding as a column.
 */
export interface AvailableProperty {
  /** Property name */
  name: string

  /** Property type (from property_definitions or inferred) */
  type: PropertyType

  /** How many notes in this folder have this property */
  usageCount: number
}

// ============================================================================
// Request Schemas
// ============================================================================

export const GetConfigRequestSchema = z.object({
  folderPath: z.string()
})

export const SetConfigRequestSchema = z.object({
  folderPath: z.string(),
  config: FolderViewConfigSchema.partial()
})

export const GetViewsRequestSchema = z.object({
  folderPath: z.string()
})

export const SetViewRequestSchema = z.object({
  folderPath: z.string(),
  view: ViewConfigSchema
})

export const DeleteViewRequestSchema = z.object({
  folderPath: z.string(),
  viewName: z.string()
})

export const ListWithPropertiesRequestSchema = z.object({
  folderPath: z.string(),
  /** Property IDs to fetch (in addition to built-in fields) */
  properties: z.array(z.string()).optional(),
  /** Pagination limit */
  limit: z.number().int().min(1).max(1000).default(500),
  /** Pagination offset */
  offset: z.number().int().min(0).default(0)
})

export const GetAvailablePropertiesRequestSchema = z.object({
  folderPath: z.string()
})

// ============================================================================
// Folder Suggestions (Phase 27 - Move to Folder)
// ============================================================================

export const GetFolderSuggestionsRequestSchema = z.object({
  noteId: z.string()
})

/**
 * AI-powered folder suggestion for moving a note.
 */
export interface FolderSuggestion {
  /** Folder path relative to notes/ (empty string for root) */
  path: string
  /** Confidence score (0-1, higher = more confident) */
  confidence: number
  /** Human-readable reason for suggesting this folder */
  reason: string
}

export interface GetFolderSuggestionsResponse {
  suggestions: FolderSuggestion[]
}

// ============================================================================
// Response Types
// ============================================================================

export interface GetConfigResponse {
  config: FolderViewConfig
  /** True if this is a newly created default config */
  isDefault: boolean
}

export interface SetConfigResponse {
  success: boolean
  error?: string
}

export interface GetViewsResponse {
  views: ViewConfig[]
  /** Index of the default view */
  defaultIndex: number
}

export interface SetViewResponse {
  success: boolean
  error?: string
}

export interface DeleteViewResponse {
  success: boolean
  error?: string
}

export interface ListWithPropertiesResponse {
  notes: NoteWithProperties[]
  total: number
  hasMore: boolean
}

export interface GetAvailablePropertiesResponse {
  /** Built-in columns (always available) */
  builtIn: Array<{
    id: BuiltInColumn
    displayName: string
    type: 'text' | 'date' | 'number' | 'multiselect'
  }>

  /** Custom properties found in folder */
  properties: AvailableProperty[]

  /** Formulas defined in .folder.md */
  formulas: Array<{
    id: string
    expression: string
  }>
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface FolderViewHandlers {
  [FolderViewChannels.invoke.GET_CONFIG]: (
    input: z.infer<typeof GetConfigRequestSchema>
  ) => Promise<GetConfigResponse>

  [FolderViewChannels.invoke.SET_CONFIG]: (
    input: z.infer<typeof SetConfigRequestSchema>
  ) => Promise<SetConfigResponse>

  [FolderViewChannels.invoke.GET_VIEWS]: (
    input: z.infer<typeof GetViewsRequestSchema>
  ) => Promise<GetViewsResponse>

  [FolderViewChannels.invoke.SET_VIEW]: (
    input: z.infer<typeof SetViewRequestSchema>
  ) => Promise<SetViewResponse>

  [FolderViewChannels.invoke.DELETE_VIEW]: (
    input: z.infer<typeof DeleteViewRequestSchema>
  ) => Promise<DeleteViewResponse>

  [FolderViewChannels.invoke.LIST_WITH_PROPERTIES]: (
    input: z.infer<typeof ListWithPropertiesRequestSchema>
  ) => Promise<ListWithPropertiesResponse>

  [FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES]: (
    input: z.infer<typeof GetAvailablePropertiesRequestSchema>
  ) => Promise<GetAvailablePropertiesResponse>
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Folder view service client interface for renderer process.
 *
 * Configuration is stored in .folder.md files, ensuring portability
 * and sync-friendliness across devices.
 *
 * @example
 * ```typescript
 * const folderView = window.api.folderView;
 *
 * // Get all views for a folder (reads .folder.md)
 * const { views, defaultIndex } = await folderView.getViews('projects');
 *
 * // Add/update a view (writes .folder.md)
 * await folderView.setView('projects', {
 *   name: 'Active Only',
 *   type: 'table',
 *   columns: [{ id: 'title', width: 250 }],
 *   filters: { and: ['status != "done"', 'status != "archived"'] },
 *   order: [{ property: 'priority', direction: 'desc' }]
 * });
 *
 * // List notes with properties
 * const { notes, total } = await folderView.listWithProperties({
 *   folderPath: 'projects'
 * });
 *
 * // Get available properties for column selector
 * const { builtIn, properties, formulas } = await folderView.getAvailableProperties('projects');
 * ```
 */
export interface FolderViewClientAPI {
  getConfig(folderPath: string): Promise<GetConfigResponse>

  setConfig(folderPath: string, config: Partial<FolderViewConfig>): Promise<SetConfigResponse>

  getViews(folderPath: string): Promise<GetViewsResponse>

  setView(folderPath: string, view: ViewConfig): Promise<SetViewResponse>

  deleteView(folderPath: string, viewName: string): Promise<DeleteViewResponse>

  listWithProperties(
    options: z.infer<typeof ListWithPropertiesRequestSchema>
  ): Promise<ListWithPropertiesResponse>

  getAvailableProperties(folderPath: string): Promise<GetAvailablePropertiesResponse>

  /** Get AI-powered folder suggestions for moving a note (Phase 27) */
  getFolderSuggestions(noteId: string): Promise<GetFolderSuggestionsResponse>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface ConfigUpdatedEvent {
  /** Folder path that was updated */
  path: string

  /** Source of the update */
  source: 'internal' | 'external'
}
