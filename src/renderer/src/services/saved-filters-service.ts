/**
 * Saved Filters service client.
 * Thin wrapper around window.api.savedFilters for type-safe access.
 *
 * @module services/saved-filters-service
 */

// ============================================================================
// Types
// ============================================================================

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
  customStart?: string | null
  customEnd?: string | null
}

export interface TaskFiltersConfig {
  search: string
  projectIds: string[]
  priorities: Array<'urgent' | 'high' | 'medium' | 'low' | 'none'>
  dueDate: DueDateFilter
  statusIds: string[]
  completion: 'active' | 'completed' | 'all'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
}

export interface TaskSortConfig {
  field: 'dueDate' | 'priority' | 'createdAt' | 'title' | 'project' | 'completedAt'
  direction: 'asc' | 'desc'
}

export interface SavedFilterConfig {
  filters: TaskFiltersConfig
  sort?: TaskSortConfig
}

export interface SavedFilter {
  id: string
  name: string
  config: SavedFilterConfig
  position: number
  createdAt: string
}

export interface SavedFilterCreateInput {
  name: string
  config: SavedFilterConfig
}

export interface SavedFilterUpdateInput {
  id: string
  name?: string
  config?: SavedFilterConfig
  position?: number
}

// ============================================================================
// Service Methods
// ============================================================================

export const savedFiltersService = {
  /**
   * List all saved filters
   */
  list: async (): Promise<{ savedFilters: SavedFilter[] }> => {
    return window.api.savedFilters.list()
  },

  /**
   * Create a new saved filter
   */
  create: async (
    input: SavedFilterCreateInput
  ): Promise<{ success: boolean; savedFilter: SavedFilter | null; error?: string }> => {
    return window.api.savedFilters.create(input)
  },

  /**
   * Update an existing saved filter
   */
  update: async (
    input: SavedFilterUpdateInput
  ): Promise<{ success: boolean; savedFilter: SavedFilter | null; error?: string }> => {
    return window.api.savedFilters.update(input)
  },

  /**
   * Delete a saved filter
   */
  delete: async (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.savedFilters.delete(id)
  },

  /**
   * Reorder saved filters
   */
  reorder: async (
    ids: string[],
    positions: number[]
  ): Promise<{ success: boolean; error?: string }> => {
    return window.api.savedFilters.reorder(ids, positions)
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to saved filter created events
 */
export function onSavedFilterCreated(
  callback: (event: { savedFilter: SavedFilter }) => void
): () => void {
  return window.api.onSavedFilterCreated(callback as (event: { savedFilter: unknown }) => void)
}

/**
 * Subscribe to saved filter updated events
 */
export function onSavedFilterUpdated(
  callback: (event: { id: string; savedFilter: SavedFilter }) => void
): () => void {
  return window.api.onSavedFilterUpdated(
    callback as (event: { id: string; savedFilter: unknown }) => void
  )
}

/**
 * Subscribe to saved filter deleted events
 */
export function onSavedFilterDeleted(callback: (event: { id: string }) => void): () => void {
  return window.api.onSavedFilterDeleted(callback)
}

// Default export
export default savedFiltersService
