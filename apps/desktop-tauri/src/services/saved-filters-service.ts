/**
 * Saved Filters service client.
 * Thin wrapper around Tauri invoke commands for type-safe access.
 *
 * @module services/saved-filters-service
 */

import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

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
  field: 'dueDate' | 'priority' | 'status' | 'createdAt' | 'title' | 'project' | 'completedAt'
  direction: 'asc' | 'desc'
}

export interface SavedFilterConfig {
  filters: TaskFiltersConfig
  sort?: TaskSortConfig
  starred?: boolean
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

interface SavedFiltersClientAPI {
  list(): Promise<{ savedFilters: SavedFilter[] }>
  create(
    input: SavedFilterCreateInput
  ): Promise<{ success: boolean; savedFilter: SavedFilter | null; error?: string }>
  update(
    input: SavedFilterUpdateInput
  ): Promise<{ success: boolean; savedFilter: SavedFilter | null; error?: string }>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  reorder(ids: string[], positions: number[]): Promise<{ success: boolean; error?: string }>
}

// ============================================================================
// Service Methods
// ============================================================================

export const savedFiltersService: SavedFiltersClientAPI =
  createInvokeForwarder<SavedFiltersClientAPI>('saved_filters')

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to saved filter created events
 */
export function onSavedFilterCreated(
  callback: (event: { savedFilter: SavedFilter }) => void
): () => void {
  return subscribeEvent<{ savedFilter: SavedFilter }>('saved-filter-created', callback)
}

/**
 * Subscribe to saved filter updated events
 */
export function onSavedFilterUpdated(
  callback: (event: { id: string; savedFilter: SavedFilter }) => void
): () => void {
  return subscribeEvent<{ id: string; savedFilter: SavedFilter }>('saved-filter-updated', callback)
}

/**
 * Subscribe to saved filter deleted events
 */
export function onSavedFilterDeleted(callback: (event: { id: string }) => void): () => void {
  return subscribeEvent<{ id: string }>('saved-filter-deleted', callback)
}

// Default export
export default savedFiltersService
