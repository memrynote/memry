/**
 * Folder View Hook
 *
 * Data fetching and state management for folder view (Bases-like database view).
 * Handles view configuration, note listing with properties, and column management.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { DEFAULT_COLUMNS, BUILT_IN_COLUMNS } from '@shared/contracts/folder-view-api'
import type {
  FilterExpression,
  SummaryConfig,
  GroupByConfig
} from '@shared/contracts/folder-view-api'
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
  groupBy?: GroupByConfig | unknown // Allow unknown for API compatibility
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

/** Formula info for column selector */
export interface FormulaInfo {
  id: string
  expression: string
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
  /** Formulas defined in folder config */
  formulas: FormulaInfo[]
  /** Formulas as a map (name -> expression) for table rendering */
  formulasMap: Record<string, string>
  /** Summary configurations per column */
  summaries: Record<string, SummaryConfig>

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
  /** Set a specific view as default by index */
  setViewAsDefault: (index: number) => Promise<void>
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
  /** Update summary configuration for a column */
  updateSummaryConfig: (columnId: string, config: SummaryConfig | undefined) => Promise<void>
  /** Toggle showSummaries for current view */
  toggleShowSummaries: () => Promise<void>
  /** Update group by configuration for current view - Phase 24 */
  updateGroupBy: (groupBy: GroupByConfig | undefined) => Promise<void>
  /** Add a new formula */
  addFormula: (name: string, expression: string) => Promise<void>
  /** Update an existing formula */
  updateFormula: (name: string, expression: string) => Promise<void>
  /** Delete a formula */
  deleteFormula: (name: string) => Promise<void>
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
  const [formulas, setFormulas] = useState<FormulaInfo[]>([])
  const [summaries, setSummaries] = useState<Record<string, SummaryConfig>>({})
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
      const result = await window.api.folderView.getViews(folderPath)
      setViews(result.views)
      setActiveViewIndex(result.defaultIndex)

      // Also fetch summaries from folder config
      const configResult = await window.api.folderView.getConfig(folderPath)
      setSummaries((configResult.config.summaries ?? {}) as Record<string, SummaryConfig>)
    } catch (err) {
      console.error('[useFolderView.fetchViews] Failed:', err)
      setViews([DEFAULT_VIEW])
      setActiveViewIndex(0)
      setSummaries({})
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
      // Also fetch formulas from the result
      setFormulas(result.formulas || [])
    } catch (err) {
      console.error('Failed to fetch available properties:', err)
      setAvailableProperties([])
      setFormulas([])
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
   * Remove undefined values from an object (for YAML serialization)
   */
  const cleanUndefinedValues = <T extends Record<string, unknown>>(obj: T): T => {
    const cleaned = { ...obj }
    for (const key of Object.keys(cleaned)) {
      if (cleaned[key] === undefined) {
        delete cleaned[key]
      }
    }
    return cleaned
  }

  /**
   * Update current view configuration
   */
  const updateView = useCallback(
    async (updates: Partial<ViewConfig>) => {
      if (!activeView) return

      const updatedView: ViewConfig = cleanUndefinedValues({ ...activeView, ...updates })

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
          const result = await window.api.folderView.setView(
            folderPath,
            updatedView as unknown as Record<string, unknown>
          )

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
        const result = await window.api.folderView.setView(
          folderPath,
          view as unknown as Record<string, unknown>
        )

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
        const result = await window.api.folderView.deleteView(folderPath, viewName)

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
   * Set a specific view as default by index.
   * This clears default from all other views and sets the specified view as default.
   */
  const setViewAsDefault = useCallback(
    async (index: number) => {
      const targetView = views[index]
      if (!targetView) {
        console.error('[useFolderView.setViewAsDefault] Invalid index:', index)
        return
      }

      // Update local state immediately - clear default from all, set on target
      setViews((prev) => {
        return prev.map((v, i) => ({
          ...v,
          default: i === index
        }))
      })

      // Save to backend - the backend handler will also clear default from others
      try {
        const result = await window.api.folderView.setView(folderPath, {
          ...targetView,
          default: true
        } as unknown as Record<string, unknown>)

        if (!result.success) {
          throw new Error(result.error || 'Failed to set default view')
        }

        // Switch to the new default view
        setActiveViewIndex(index)
      } catch (err) {
        console.error('[useFolderView.setViewAsDefault] Failed:', err)
        // Revert on error
        await fetchViews()
        throw err
      }
    },
    [views, folderPath, fetchViews]
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
   * Update summary configuration for a column.
   * Persists to .folder.md summaries section.
   */
  const updateSummaryConfig = useCallback(
    async (columnId: string, config: SummaryConfig | undefined) => {
      try {
        // Get current folder config
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        // Update summaries
        const updatedSummaries = {
          ...((existingConfig.summaries ?? {}) as Record<string, SummaryConfig>)
        }
        if (config) {
          updatedSummaries[columnId] = config
        } else {
          delete updatedSummaries[columnId]
        }

        // Save updated config
        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          summaries: Object.keys(updatedSummaries).length > 0 ? updatedSummaries : undefined
        })

        // Update local state
        setSummaries(updatedSummaries)
      } catch (err) {
        console.error('[useFolderView.updateSummaryConfig] Failed:', err)
      }
    },
    [folderPath]
  )

  /**
   * Toggle showSummaries for current view.
   */
  const toggleShowSummaries = useCallback(async () => {
    await updateView({ showSummaries: !activeView?.showSummaries })
  }, [updateView, activeView?.showSummaries])

  /**
   * Update group by configuration for current view.
   * Phase 24: T113 - Persist groupBy to .folder.md view.groupBy
   */
  const updateGroupBy = useCallback(
    async (groupBy: GroupByConfig | undefined) => {
      await updateView({ groupBy })
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
  // Formula Methods
  // ============================================================================

  /**
   * Convert formulas array to map for table rendering
   */
  const formulasMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const formula of formulas) {
      map[formula.id] = formula.expression
    }
    return map
  }, [formulas])

  /**
   * Add a new formula
   */
  const addFormula = useCallback(
    async (name: string, expression: string) => {
      try {
        // Get current folder config
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        // Add the new formula
        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        // Save updated config
        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Update local state
        setFormulas((prev) => [...prev, { id: name, expression }])
      } catch (err) {
        console.error('[useFolderView.addFormula] Failed:', err)
        throw err
      }
    },
    [folderPath]
  )

  /**
   * Update an existing formula
   */
  const updateFormula = useCallback(
    async (name: string, expression: string) => {
      try {
        // Get current folder config
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        // Update the formula
        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        // Save updated config
        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Update local state
        setFormulas((prev) => prev.map((f) => (f.id === name ? { id: name, expression } : f)))
      } catch (err) {
        console.error('[useFolderView.updateFormula] Failed:', err)
        throw err
      }
    },
    [folderPath]
  )

  /**
   * Delete a formula
   */
  const deleteFormula = useCallback(
    async (name: string) => {
      try {
        // Get current folder config
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        // Remove the formula
        const updatedFormulas = { ...existingConfig.formulas }
        delete updatedFormulas[name]

        // Save updated config
        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: Object.keys(updatedFormulas).length > 0 ? updatedFormulas : undefined
        })

        // Update local state
        setFormulas((prev) => prev.filter((f) => f.id !== name))
      } catch (err) {
        console.error('[useFolderView.deleteFormula] Failed:', err)
        throw err
      }
    },
    [folderPath]
  )

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
    formulas,
    formulasMap,
    summaries,

    // State
    isLoading,
    error,

    // Actions
    setActiveViewIndex,
    updateView,
    setViewAsDefault,
    addView,
    deleteView,
    updateColumns,
    updateSorting,
    updateFilters,
    updateSummaryConfig,
    toggleShowSummaries,
    updateGroupBy,
    updateDisplayName,
    addFormula,
    updateFormula,
    deleteFormula,
    loadMore,
    refresh
  }
}

export default useFolderView
