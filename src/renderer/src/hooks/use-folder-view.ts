/**
 * Folder View Hook
 *
 * Data fetching and state management for folder view (Bases-like database view).
 * Handles view configuration, note listing with properties, and column management.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { DEFAULT_COLUMNS, BUILT_IN_COLUMNS } from '@shared/contracts/folder-view-api'
import type { FilterExpression } from '@shared/contracts/folder-view-api'
import { evaluateFilter } from '@/lib/filter-evaluator'

// ============================================================================
// Types (mirrored from preload for renderer use)
// ============================================================================

export interface ColumnConfig {
  id: string
  width?: number
  displayName?: string
  showSummary?: boolean
}

export interface ViewConfig {
  name: string
  type: 'table' | 'grid' | 'list' | 'kanban'
  default?: boolean
  columns?: ColumnConfig[]
  filters?: FilterExpression | unknown // Allow unknown for API compatibility
  order?: Array<{ property: string; direction: 'asc' | 'desc' }>
  groupBy?: unknown
  limit?: number
  showSummaries?: boolean
}

export interface NoteWithProperties {
  id: string
  path: string
  title: string
  emoji: string | null
  folder: string
  tags: string[]
  created: string
  modified: string
  wordCount: number
  properties: Record<string, unknown>
}

export interface AvailableProperty {
  name: string
  type: string
  usageCount: number
}

// Default view configuration
const DEFAULT_VIEW: ViewConfig = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: DEFAULT_COLUMNS,
  order: [{ property: 'modified', direction: 'desc' }]
}

// ============================================================================
// Types
// ============================================================================

interface UseFolderViewOptions {
  /** Folder path relative to notes/ */
  folderPath: string
  /** Initial page size */
  pageSize?: number
}

interface UseFolderViewResult {
  // Data
  /** All views for this folder */
  views: ViewConfig[]
  /** Currently active view index */
  activeViewIndex: number
  /** Active view config */
  activeView: ViewConfig | null
  /** Notes with properties for current view */
  notes: NoteWithProperties[]
  /** Total note count */
  totalNotes: number
  /** Whether there are more notes to load */
  hasMore: boolean
  /** Available properties for column selector */
  availableProperties: AvailableProperty[]
  /** Built-in columns info */
  builtInColumns: Array<{ id: string; displayName: string; type: string }>

  // State
  /** Loading state */
  isLoading: boolean
  /** Error message if any */
  error: string | null

  // Actions
  /** Set active view by index */
  setActiveViewIndex: (index: number) => void
  /** Update current view configuration */
  updateView: (view: Partial<ViewConfig>) => Promise<void>
  /** Add a new view */
  addView: (view: ViewConfig) => Promise<void>
  /** Delete a view by name */
  deleteView: (viewName: string) => Promise<void>
  /** Update column configuration for current view */
  updateColumns: (columns: ColumnConfig[]) => Promise<void>
  /** Update sort order for current view */
  updateSorting: (order: Array<{ property: string; direction: 'asc' | 'desc' }>) => Promise<void>
  /** Update display name for a property/column */
  updateDisplayName: (columnId: string, displayName: string) => Promise<void>
  /** Update filter expression for current view */
  updateFilters: (filters: FilterExpression | undefined) => Promise<void>
  /** Load more notes (pagination) */
  loadMore: () => Promise<void>
  /** Refresh all data */
  refresh: () => Promise<void>
  /** Total unfiltered note count (for "showing X of Y") */
  unfilteredCount: number
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing folder view data and state.
 */
export function useFolderView({
  folderPath,
  pageSize = 100
}: UseFolderViewOptions): UseFolderViewResult {
  // State
  const [views, setViews] = useState<ViewConfig[]>([DEFAULT_VIEW])
  const [activeViewIndex, setActiveViewIndex] = useState(0)
  const [notes, setNotes] = useState<NoteWithProperties[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [availableProperties, setAvailableProperties] = useState<AvailableProperty[]>([])
  const [builtInColumns, setBuiltInColumns] = useState<
    Array<{ id: string; displayName: string; type: string }>
  >([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Track current offset for pagination
  const offsetRef = useRef(0)

  // Debounce timer for column updates
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Get active view
  const activeView = views[activeViewIndex] ?? null

  // ============================================================================
  // Data Fetching
  // ============================================================================

  /**
   * Fetch views for folder
   */
  const fetchViews = useCallback(async () => {
    try {
      console.log('[useFolderView.fetchViews] Fetching views for:', folderPath)
      const result = await window.api.folderView.getViews(folderPath)
      console.log(
        '[useFolderView.fetchViews] Got views:',
        result.views.map((v) => v.name)
      )
      setViews(result.views)
      setActiveViewIndex(result.defaultIndex)
    } catch (err) {
      console.error('[useFolderView.fetchViews] Failed:', err)
      setViews([DEFAULT_VIEW])
      setActiveViewIndex(0)
    }
  }, [folderPath])

  /**
   * Fetch available properties for column selector
   */
  const fetchAvailableProperties = useCallback(async () => {
    try {
      const result = await window.api.folderView.getAvailableProperties(folderPath)
      setAvailableProperties(result.properties)
      setBuiltInColumns(result.builtIn)
    } catch (err) {
      console.error('Failed to fetch available properties:', err)
      setAvailableProperties([])
      setBuiltInColumns(
        BUILT_IN_COLUMNS.map((id) => ({
          id,
          displayName: id.charAt(0).toUpperCase() + id.slice(1),
          type: 'text'
        }))
      )
    }
  }, [folderPath])

  /**
   * Fetch notes with properties
   */
  const fetchNotes = useCallback(
    async (append = false) => {
      const offset = append ? offsetRef.current : 0

      try {
        const columns = activeView?.columns ?? DEFAULT_COLUMNS
        const propertyIds = columns
          .filter((c) => !BUILT_IN_COLUMNS.includes(c.id as (typeof BUILT_IN_COLUMNS)[number]))
          .map((c) => c.id)

        const result = await window.api.folderView.listWithProperties({
          folderPath,
          properties: propertyIds,
          limit: pageSize,
          offset
        })

        if (append) {
          setNotes((prev) => [...prev, ...result.notes])
        } else {
          setNotes(result.notes)
        }

        setHasMore(result.hasMore)
        offsetRef.current = offset + result.notes.length
      } catch (err) {
        console.error('[useFolderView] Failed to fetch notes:', err)
        setError(err instanceof Error ? err.message : 'Failed to load notes')
      }
    },
    [folderPath, activeView, pageSize]
  )

  /**
   * Refresh all data
   */
  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    offsetRef.current = 0

    try {
      await Promise.all([fetchViews(), fetchAvailableProperties()])
      await fetchNotes(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folder view')
    } finally {
      setIsLoading(false)
    }
  }, [fetchViews, fetchAvailableProperties, fetchNotes])

  // ============================================================================
  // Actions
  // ============================================================================

  /**
   * Update current view configuration
   */
  const updateView = useCallback(
    async (updates: Partial<ViewConfig>) => {
      if (!activeView) return

      const updatedView: ViewConfig = { ...activeView, ...updates }

      console.log(
        '[useFolderView.updateView] Updating view:',
        updatedView.name,
        'updates:',
        updates
      )

      // Update local state immediately
      setViews((prev) => {
        const next = [...prev]
        next[activeViewIndex] = updatedView
        return next
      })

      // Debounce the save to avoid too many writes
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }

      updateTimeoutRef.current = setTimeout(async () => {
        try {
          console.log('[useFolderView.updateView] Saving to backend...')
          const result = await window.api.folderView.setView(
            folderPath,
            updatedView as unknown as Record<string, unknown>
          )

          console.log('[useFolderView.updateView] Result:', result)

          if (!result.success) {
            throw new Error(result.error || 'Failed to save view')
          }
        } catch (err) {
          console.error('[useFolderView.updateView] Failed:', err)
          // Revert on error
          await fetchViews()
        }
      }, 300)
    },
    [activeView, activeViewIndex, folderPath, fetchViews]
  )

  /**
   * Add a new view
   */
  const addView = useCallback(
    async (view: ViewConfig) => {
      try {
        console.log('[useFolderView.addView] Adding view:', view.name, 'to folder:', folderPath)

        const result = await window.api.folderView.setView(
          folderPath,
          view as unknown as Record<string, unknown>
        )

        console.log('[useFolderView.addView] Result:', result)

        if (!result.success) {
          throw new Error(result.error || 'Failed to save view')
        }

        // Fetch updated views from backend
        await fetchViews()

        // Find the index of the newly added view
        // Note: We need to use the callback form to get the latest views
        setViews((currentViews) => {
          const newIndex = currentViews.findIndex((v) => v.name === view.name)
          if (newIndex >= 0) {
            setActiveViewIndex(newIndex)
          }
          return currentViews
        })
      } catch (err) {
        console.error('[useFolderView.addView] Failed:', err)
        setError(err instanceof Error ? err.message : 'Failed to add view')
        throw err // Re-throw so the UI can handle it
      }
    },
    [folderPath, fetchViews]
  )

  /**
   * Delete a view by name
   */
  const deleteView = useCallback(
    async (viewName: string) => {
      try {
        console.log('[useFolderView.deleteView] Deleting view:', viewName)

        const result = await window.api.folderView.deleteView(folderPath, viewName)

        console.log('[useFolderView.deleteView] Result:', result)

        if (!result.success) {
          throw new Error(result.error || 'Failed to delete view')
        }

        await fetchViews()

        // Adjust active index if needed - use callback to get latest views
        setViews((currentViews) => {
          if (activeViewIndex >= currentViews.length) {
            setActiveViewIndex(Math.max(0, currentViews.length - 1))
          }
          return currentViews
        })
      } catch (err) {
        console.error('[useFolderView.deleteView] Failed:', err)
        setError(err instanceof Error ? err.message : 'Failed to delete view')
        throw err
      }
    },
    [folderPath, fetchViews, activeViewIndex]
  )

  /**
   * Update column configuration for current view
   */
  const updateColumns = useCallback(
    async (columns: ColumnConfig[]) => {
      await updateView({ columns })
    },
    [updateView]
  )

  /**
   * Update sort order for current view
   */
  const updateSorting = useCallback(
    async (order: Array<{ property: string; direction: 'asc' | 'desc' }>) => {
      await updateView({ order })
    },
    [updateView]
  )

  /**
   * Update filter expression for current view
   */
  const updateFilters = useCallback(
    async (filters: FilterExpression | undefined) => {
      await updateView({ filters })
    },
    [updateView]
  )

  /**
   * Client-side filtered notes based on active view's filters
   */
  const filteredNotes = useMemo(() => {
    const filters = activeView?.filters as FilterExpression | undefined
    if (!filters) return notes

    try {
      return notes.filter((note) => evaluateFilter(note, filters))
    } catch (err) {
      console.error('[useFolderView] Filter evaluation error:', err)
      return notes // Return all notes on error
    }
  }, [notes, activeView?.filters])

  /**
   * Update display name for a property/column.
   * Updates both the column config displayName and properties.{id}.displayName
   */
  const updateDisplayName = useCallback(
    async (columnId: string, displayName: string) => {
      if (!activeView) return

      // Update column displayName in the current view
      const updatedColumns = (activeView.columns || []).map((col) =>
        col.id === columnId ? { ...col, displayName } : col
      )

      // Update view with new columns
      const updatedView: ViewConfig = { ...activeView, columns: updatedColumns }

      // Update local state immediately
      setViews((prev) => {
        const next = [...prev]
        next[activeViewIndex] = updatedView
        return next
      })

      // Debounce the save
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }

      updateTimeoutRef.current = setTimeout(async () => {
        try {
          // Save view with updated column displayName
          await window.api.folderView.setView(
            folderPath,
            updatedView as unknown as Record<string, unknown>
          )

          // Also update the properties.{id}.displayName in folder config
          // This ensures the displayName persists even if column is removed/re-added
          const configResult = await window.api.folderView.getConfig(folderPath)
          const existingConfig = configResult.config

          const updatedConfig = {
            ...existingConfig,
            properties: {
              ...existingConfig.properties,
              [columnId]: {
                ...(existingConfig.properties?.[columnId] || {}),
                displayName
              }
            }
          }

          await window.api.folderView.setConfig(folderPath, updatedConfig)
        } catch (err) {
          console.error('Failed to save display name:', err)
          // Revert on error
          await fetchViews()
        }
      }, 300)
    },
    [activeView, activeViewIndex, folderPath, fetchViews]
  )

  /**
   * Load more notes (pagination)
   */
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading) return
    await fetchNotes(true)
  }, [hasMore, isLoading, fetchNotes])

  // ============================================================================
  // Effects
  // ============================================================================

  // Initial load and refresh on folder change
  useEffect(() => {
    refresh()
  }, [folderPath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch notes when active view changes
  useEffect(() => {
    if (!isLoading) {
      offsetRef.current = 0
      fetchNotes(false)
    }
  }, [activeViewIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }
    }
  }, [])

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // Data
    views,
    activeViewIndex,
    activeView,
    notes: filteredNotes,
    totalNotes: filteredNotes.length,
    unfilteredCount: notes.length,
    hasMore,
    availableProperties,
    builtInColumns,

    // State
    isLoading,
    error,

    // Actions
    setActiveViewIndex,
    updateView,
    addView,
    deleteView,
    updateColumns,
    updateSorting,
    updateFilters,
    updateDisplayName,
    loadMore,
    refresh
  }
}

export default useFolderView
