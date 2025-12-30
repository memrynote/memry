/**
 * Folder View IPC API Contract
 *
 * Handles folder view configuration and note listing with properties.
 * Provides database-like table view for folders similar to Obsidian Bases.
 */

import { z } from 'zod'

// ============================================================================
// Channel Constants (to be added to src/shared/ipc-channels.ts)
// ============================================================================

export const FolderViewChannels = {
  invoke: {
    /** Get folder view configuration */
    GET_CONFIG: 'folder-view:get-config',
    /** Set/update folder view configuration */
    SET_CONFIG: 'folder-view:set-config',
    /** List notes in folder with property values */
    LIST_WITH_PROPERTIES: 'folder-view:list-with-properties',
    /** Get available properties for column selector */
    GET_AVAILABLE_PROPERTIES: 'folder-view:get-available-properties'
  },
  events: {
    /** Folder view config was updated */
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
 */
export interface ColumnConfig {
  /**
   * Column identifier.
   * Built-in: 'title', 'folder', 'tags', 'created', 'modified', 'wordCount'
   * Property: any custom property name (e.g., 'status', 'priority')
   */
  id: string

  /**
   * Display name shown in column header.
   * User-customizable (e.g., "release_date" → "Release Date")
   */
  displayName: string

  /**
   * Column width in pixels.
   * Persisted when user resizes columns.
   */
  width: number

  /**
   * Whether column is visible in the view.
   */
  visible: boolean

  /**
   * Column order (0 = leftmost).
   * Persisted when user reorders columns.
   */
  order: number
}

export const ColumnConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  width: z.number().int().min(50).max(800).default(150),
  visible: z.boolean().default(true),
  order: z.number().int().min(0)
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
  { id: 'title', displayName: 'Title', width: 250, visible: true, order: 0 },
  { id: 'folder', displayName: 'Folder', width: 120, visible: true, order: 1 },
  { id: 'tags', displayName: 'Tags', width: 150, visible: true, order: 2 },
  { id: 'modified', displayName: 'Modified', width: 130, visible: true, order: 3 },
  { id: 'created', displayName: 'Created', width: 130, visible: false, order: 4 },
  { id: 'wordCount', displayName: 'Words', width: 80, visible: false, order: 5 }
]

// ============================================================================
// Filter Configuration
// ============================================================================

/**
 * Filter operators by property type.
 */
export const FilterOperators = {
  // Text operators
  equals: 'equals',
  notEquals: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',

  // Number/Date operators
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',

  // Presence operators
  isEmpty: 'isEmpty',
  isNotEmpty: 'isNotEmpty',

  // Checkbox operators
  isChecked: 'isChecked',
  isUnchecked: 'isUnchecked'
} as const

export type FilterOperator = (typeof FilterOperators)[keyof typeof FilterOperators]

/**
 * Operators available for each property type.
 */
export const OperatorsByType: Record<PropertyType, FilterOperator[]> = {
  text: [
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'startsWith',
    'endsWith',
    'isEmpty',
    'isNotEmpty'
  ],
  number: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  checkbox: ['isChecked', 'isUnchecked'],
  date: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  select: ['equals', 'notEquals', 'isEmpty', 'isNotEmpty'],
  multiselect: ['contains', 'notContains', 'isEmpty', 'isNotEmpty'],
  url: ['equals', 'contains', 'isEmpty', 'isNotEmpty'],
  rating: ['equals', 'gte', 'lte', 'isEmpty', 'isNotEmpty']
}

/**
 * Configuration for a single filter condition.
 */
export interface FilterConfig {
  /** Property to filter on (built-in or custom property name) */
  property: string

  /** Filter operator */
  operator: FilterOperator

  /** Value to compare against (type depends on property type) */
  value: unknown
}

export const FilterConfigSchema = z.object({
  property: z.string().min(1),
  operator: z.enum([
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'startsWith',
    'endsWith',
    'gt',
    'gte',
    'lt',
    'lte',
    'isEmpty',
    'isNotEmpty',
    'isChecked',
    'isUnchecked'
  ]),
  value: z.unknown()
})

// ============================================================================
// View Types
// ============================================================================

export const ViewTypes = {
  TABLE: 'table',
  GRID: 'grid',
  LIST: 'list',
  KANBAN: 'kanban'
} as const

export type ViewType = (typeof ViewTypes)[keyof typeof ViewTypes]

// ============================================================================
// Folder View Configuration
// ============================================================================

/**
 * Full configuration for a folder view.
 */
export interface FolderViewConfig {
  /** Folder path relative to notes/ (e.g., "projects", "projects/2024") */
  path: string

  /** View mode (currently only 'table' is implemented) */
  viewType: ViewType

  /** Column configurations */
  columns: ColumnConfig[]

  /** Column to sort by (null = default modified desc) */
  sortColumn: string | null

  /** Sort direction */
  sortOrder: 'asc' | 'desc'

  /** Active filters */
  filters: FilterConfig[]

  /** Property to group by (for future kanban view) */
  groupBy: string | null

  /** When config was created */
  createdAt: string

  /** When config was last modified */
  updatedAt: string
}

export const FolderViewConfigSchema = z.object({
  path: z.string(),
  viewType: z.enum(['table', 'grid', 'list', 'kanban']).default('table'),
  columns: z.array(ColumnConfigSchema),
  sortColumn: z.string().nullable(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  filters: z.array(FilterConfigSchema),
  groupBy: z.string().nullable(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
})

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

export const SetConfigRequestSchema = FolderViewConfigSchema

export const ListWithPropertiesRequestSchema = z.object({
  folderPath: z.string(),
  /** Property IDs to fetch (in addition to built-in fields) */
  properties: z.array(z.string()).optional(),
  /** Sort by column */
  sortColumn: z.string().optional(),
  /** Sort direction */
  sortOrder: z.enum(['asc', 'desc']).optional(),
  /** Active filters */
  filters: z.array(FilterConfigSchema).optional(),
  /** Pagination limit */
  limit: z.number().int().min(1).max(1000).default(500),
  /** Pagination offset */
  offset: z.number().int().min(0).default(0)
})

export const GetAvailablePropertiesRequestSchema = z.object({
  folderPath: z.string()
})

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
  config: FolderViewConfig
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
 * @example
 * ```typescript
 * const folderView = window.api.folderView;
 *
 * // Get config for a folder
 * const { config, isDefault } = await folderView.getConfig('projects');
 *
 * // List notes with properties
 * const { notes, total } = await folderView.listWithProperties({
 *   folderPath: 'projects',
 *   sortColumn: 'modified',
 *   sortOrder: 'desc'
 * });
 *
 * // Update column configuration
 * await folderView.setConfig({
 *   ...config,
 *   columns: [...config.columns, newColumn]
 * });
 * ```
 */
export interface FolderViewClientAPI {
  getConfig(folderPath: string): Promise<GetConfigResponse>

  setConfig(config: FolderViewConfig): Promise<SetConfigResponse>

  listWithProperties(
    options: z.infer<typeof ListWithPropertiesRequestSchema>
  ): Promise<ListWithPropertiesResponse>

  getAvailableProperties(folderPath: string): Promise<GetAvailablePropertiesResponse>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface ConfigUpdatedEvent {
  path: string
  config: FolderViewConfig
}
