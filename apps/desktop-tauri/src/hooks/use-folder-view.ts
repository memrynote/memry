/**
 * Folder View Hook
 *
 * Data fetching and state management for folder view (Bases-like database view).
 * Handles view configuration, note listing with properties, and column management.
 *
 * Uses TanStack Query for caching - data persists across tab switches for instant loading.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData
} from '@tanstack/react-query'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'

const log = createLogger('Hook:FolderView')
import { DEFAULT_COLUMNS, BUILT_IN_COLUMNS } from '@memry/contracts/folder-view-api'
import type {
  FilterExpression,
  SummaryConfig,
  GroupByConfig
} from '@memry/contracts/folder-view-api'
import { evaluateFilter } from '@/lib/filter-evaluator'
import { propertiesService } from '@/services/properties-service'
import { notesService } from '@/services/notes-service'

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
  order: [{ property: 'title', direction: 'asc' }]
}

// ============================================================================
// Query Keys
// ============================================================================

export const folderViewKeys = {
  all: ['folder-view'] as const,
  folderExists: (folderPath: string) => [...folderViewKeys.all, 'exists', folderPath] as const,
  views: (folderPath: string) => [...folderViewKeys.all, 'views', folderPath] as const,
  availableProperties: (folderPath: string) =>
    [...folderViewKeys.all, 'available-properties', folderPath] as const,
  // Stable notes key - does NOT include propertyIds to avoid refetch on column change
  notes: (folderPath: string) => [...folderViewKeys.all, 'notes', folderPath] as const
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

/** Response from listWithProperties API */
interface ListWithPropertiesResponse {
  notes: NoteWithProperties[]
  hasMore: boolean
  total: number
}

/** Combined views and config data */
interface ViewsQueryData {
  views: ViewConfig[]
  defaultIndex: number
  summaries: Record<string, SummaryConfig>
}

/** Available properties query data */
interface PropertiesQueryData {
  properties: AvailableProperty[]
  builtIn: Array<{ id: string; displayName: string; type: string }>
  formulas: FormulaInfo[]
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
  /** Whether the folder was not found (T115) */
  folderNotFound: boolean

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
  /** Optimistically remove notes from local state (for immediate UI feedback) */
  removeNotesOptimistically: (noteIds: string[]) => void
  /** Update a property value on a note */
  updateNoteProperty: (noteId: string, propertyId: string, value: unknown) => Promise<void>
  /** Update tags on a note */
  updateNoteTags: (noteId: string, tags: string[]) => Promise<void>
  /** Total unfiltered note count (for "showing X of Y") */
  unfilteredCount: number
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook for managing folder view data and state.
 * Uses TanStack Query for caching - data persists across tab switches.
 */
export function useFolderView({
  folderPath,
  pageSize = 100
}: UseFolderViewOptions): UseFolderViewResult {
  const queryClient = useQueryClient()

  // Local state for user's current view selection
  const [activeViewIndex, setActiveViewIndex] = useState(0)

  // Debounce timer for column updates
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // ============================================================================
  // Queries
  // ============================================================================

  /**
   * T115: Folder existence query - checks if folder exists
   */
  const folderExistsQuery = useQuery({
    queryKey: folderViewKeys.folderExists(folderPath),
    queryFn: async (): Promise<boolean> => {
      return window.api.folderView.folderExists(folderPath)
    },
    staleTime: 60_000, // 60 seconds
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true
  })

  /**
   * Views query - fetches view configurations and summaries
   */
  const viewsQuery = useQuery({
    queryKey: folderViewKeys.views(folderPath),
    queryFn: async (): Promise<ViewsQueryData> => {
      const [viewsResult, configResult] = await Promise.all([
        window.api.folderView.getViews(folderPath),
        window.api.folderView.getConfig(folderPath)
      ])
      return {
        views: viewsResult.views,
        defaultIndex: viewsResult.defaultIndex,
        summaries: (configResult.config.summaries ?? {}) as Record<string, SummaryConfig>
      }
    },
    staleTime: 30_000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    // T122: Refetch when window gains focus to pick up external .folder.md changes
    refetchOnWindowFocus: true
  })

  /**
   * Available properties query - fetches column metadata and formulas
   */
  const propertiesQuery = useQuery({
    queryKey: folderViewKeys.availableProperties(folderPath),
    queryFn: async (): Promise<PropertiesQueryData> => {
      const result = await window.api.folderView.getAvailableProperties(folderPath)
      return {
        properties: result.properties,
        builtIn: result.builtIn,
        formulas: result.formulas || []
      }
    },
    staleTime: 60_000, // 60 seconds - metadata changes less frequently
    gcTime: 5 * 60 * 1000,
    // T122: Refetch when window gains focus to pick up external .folder.md changes
    refetchOnWindowFocus: true
  })

  // Get views from query data
  const views = viewsQuery.data?.views ?? [DEFAULT_VIEW]
  const summaries = viewsQuery.data?.summaries ?? {}

  // Sync activeViewIndex when views load (only on initial load or invalidation)
  const hasInitializedRef = useRef(false)
  useEffect(() => {
    if (viewsQuery.data && !hasInitializedRef.current) {
      setActiveViewIndex(viewsQuery.data.defaultIndex)
      hasInitializedRef.current = true
    }
  }, [viewsQuery.data])

  // Reset initialization flag when folder changes
  useEffect(() => {
    hasInitializedRef.current = false
  }, [folderPath])

  // Get active view
  const activeView = views[activeViewIndex] ?? null

  /**
   * Notes infinite query - fetches notes with pagination
   *
   * Note: Query key is stable (based only on folderPath) to prevent
   * full refetch when columns are added/removed. We fetch all properties
   * so column changes don't require a refetch.
   */
  const notesQuery = useInfiniteQuery({
    queryKey: folderViewKeys.notes(folderPath),
    queryFn: async ({ pageParam = 0 }): Promise<ListWithPropertiesResponse> => {
      // Fetch all available properties to avoid refetch when columns change
      // This is a trade-off: slightly larger payload vs better UX
      const result = await window.api.folderView.listWithProperties({
        folderPath,
        // Don't filter properties - fetch all so column changes don't need refetch
        properties: undefined,
        limit: pageSize,
        offset: pageParam
      })
      return {
        notes: result.notes,
        hasMore: result.hasMore,
        total: result.total
      }
    },
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce((acc, page) => acc + page.notes.length, 0)
      return lastPage.hasMore ? totalFetched : undefined
    },
    initialPageParam: 0,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000
  })

  // Flatten notes from infinite query pages
  const notes = useMemo(() => {
    return notesQuery.data?.pages.flatMap((page) => page.notes) ?? []
  }, [notesQuery.data])

  // Client-side filtered notes
  const filteredNotes = useMemo(() => {
    const filters = activeView?.filters as FilterExpression | undefined
    if (!filters) return notes

    try {
      return notes.filter((note) => evaluateFilter(note, filters))
    } catch (err) {
      log.error('Filter evaluation error:', err)
      return notes
    }
  }, [notes, activeView?.filters])

  // Get properties data from query
  const availableProperties = propertiesQuery.data?.properties ?? []
  const builtInColumns =
    propertiesQuery.data?.builtIn ??
    BUILT_IN_COLUMNS.map((id) => ({
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      type: 'text'
    }))
  const formulas = propertiesQuery.data?.formulas ?? []

  // Formulas map for table rendering
  const formulasMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const formula of formulas) {
      map[formula.id] = formula.expression
    }
    return map
  }, [formulas])

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
   * Update current view configuration with optimistic update
   */
  const updateView = useCallback(
    async (updates: Partial<ViewConfig>) => {
      if (!activeView) return

      const updatedView: ViewConfig = cleanUndefinedValues({ ...activeView, ...updates })

      // Optimistic update to cache
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(folderPath), (old) => {
        if (!old) return old
        const newViews = [...old.views]
        newViews[activeViewIndex] = updatedView
        return { ...old, views: newViews }
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
          log.error('updateView failed:', err)
          // Revert on error
          queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) })
        }
      }, 300)
    },
    [activeView, activeViewIndex, folderPath, queryClient]
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

        // Invalidate to refetch views
        await queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) })

        // Find and set the new view as active
        const newData = queryClient.getQueryData<ViewsQueryData>(folderViewKeys.views(folderPath))
        if (newData) {
          const newIndex = newData.views.findIndex((v) => v.name === view.name)
          if (newIndex >= 0) {
            setActiveViewIndex(newIndex)
          }
        }
      } catch (err) {
        log.error('addView failed:', err)
        throw err
      }
    },
    [folderPath, queryClient]
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

        // Invalidate to refetch views
        await queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) })

        // Adjust active index if needed
        const newData = queryClient.getQueryData<ViewsQueryData>(folderViewKeys.views(folderPath))
        if (newData && activeViewIndex >= newData.views.length) {
          setActiveViewIndex(Math.max(0, newData.views.length - 1))
        }
      } catch (err) {
        log.error('deleteView failed:', err)
        throw err
      }
    },
    [folderPath, queryClient, activeViewIndex]
  )

  /**
   * Set a specific view as default by index
   */
  const setViewAsDefault = useCallback(
    async (index: number) => {
      const targetView = views[index]
      if (!targetView) {
        log.error('setViewAsDefault invalid index:', index)
        return
      }

      // Optimistic update to cache
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(folderPath), (old) => {
        if (!old) return old
        return {
          ...old,
          views: old.views.map((v, i) => ({ ...v, default: i === index })),
          defaultIndex: index
        }
      })

      try {
        const result = await window.api.folderView.setView(folderPath, {
          ...targetView,
          default: true
        } as unknown as Record<string, unknown>)

        if (!result.success) {
          throw new Error(result.error || 'Failed to set default view')
        }

        setActiveViewIndex(index)
      } catch (err) {
        log.error('setViewAsDefault failed:', err)
        // Revert on error
        queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) })
        throw err
      }
    },
    [views, folderPath, queryClient]
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
   * Update summary configuration for a column
   */
  const updateSummaryConfig = useCallback(
    async (columnId: string, config: SummaryConfig | undefined) => {
      try {
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        const updatedSummaries = {
          ...((existingConfig.summaries ?? {}) as Record<string, SummaryConfig>)
        }
        if (config) {
          updatedSummaries[columnId] = config
        } else {
          delete updatedSummaries[columnId]
        }

        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          summaries: Object.keys(updatedSummaries).length > 0 ? updatedSummaries : undefined
        })

        // Update cache
        queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(folderPath), (old) => {
          if (!old) return old
          return { ...old, summaries: updatedSummaries }
        })
      } catch (err) {
        log.error('updateSummaryConfig failed:', err)
      }
    },
    [folderPath, queryClient]
  )

  /**
   * Toggle showSummaries for current view
   */
  const toggleShowSummaries = useCallback(async () => {
    await updateView({ showSummaries: !activeView?.showSummaries })
  }, [updateView, activeView?.showSummaries])

  /**
   * Update group by configuration for current view
   */
  const updateGroupBy = useCallback(
    async (groupBy: GroupByConfig | undefined) => {
      await updateView({ groupBy })
    },
    [updateView]
  )

  /**
   * Update display name for a property/column
   */
  const updateDisplayName = useCallback(
    async (columnId: string, displayName: string) => {
      if (!activeView) return

      const updatedColumns = (activeView.columns || []).map((col) =>
        col.id === columnId ? { ...col, displayName } : col
      )

      const updatedView: ViewConfig = { ...activeView, columns: updatedColumns }

      // Optimistic update
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(folderPath), (old) => {
        if (!old) return old
        const newViews = [...old.views]
        newViews[activeViewIndex] = updatedView
        return { ...old, views: newViews }
      })

      // Debounce the save
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }

      updateTimeoutRef.current = setTimeout(async () => {
        try {
          await window.api.folderView.setView(
            folderPath,
            updatedView as unknown as Record<string, unknown>
          )

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
          log.error('Failed to save display name:', err)
          queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) })
        }
      }, 300)
    },
    [activeView, activeViewIndex, folderPath, queryClient]
  )

  /**
   * Load more notes (pagination)
   */
  const loadMore = useCallback(async () => {
    if (notesQuery.hasNextPage && !notesQuery.isFetchingNextPage) {
      await notesQuery.fetchNextPage()
    }
  }, [notesQuery])

  /**
   * Optimistically remove notes from the query cache
   */
  const removeNotesOptimistically = useCallback(
    (noteIds: string[]) => {
      const idSet = new Set(noteIds)

      queryClient.setQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(folderPath),
        (old) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              notes: page.notes.filter((note) => !idSet.has(note.id))
            }))
          }
        }
      )
    },
    [queryClient, folderPath]
  )

  /**
   * Update a single property on a note with optimistic cache update.
   */
  const updateNoteProperty = useCallback(
    async (noteId: string, propertyId: string, value: unknown) => {
      const previousData = queryClient.getQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(folderPath)
      )

      const currentProperties = (() => {
        if (!previousData) return {}
        for (const page of previousData.pages) {
          const note = page.notes.find((item) => item.id === noteId)
          if (note) return note.properties ?? {}
        }
        return {}
      })()

      const nextProperties: Record<string, unknown> = { ...currentProperties }
      if (value === undefined) {
        delete nextProperties[propertyId]
      } else {
        nextProperties[propertyId] = value
      }

      queryClient.setQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(folderPath),
        (old) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              notes: page.notes.map((note) =>
                note.id === noteId ? { ...note, properties: nextProperties } : note
              )
            }))
          }
        }
      )

      try {
        const result = await propertiesService.set(noteId, nextProperties)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update property')
        }
      } catch (err) {
        log.error('Failed to update property:', err)
        toast.error('Failed to update property')
        if (previousData) {
          queryClient.setQueryData(folderViewKeys.notes(folderPath), previousData)
        }
      }
    },
    [folderPath, queryClient]
  )

  /**
   * Update tags for a note with optimistic cache update.
   */
  const updateNoteTags = useCallback(
    async (noteId: string, tags: string[]) => {
      const previousData = queryClient.getQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(folderPath)
      )

      queryClient.setQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(folderPath),
        (old) => {
          if (!old) return old
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              notes: page.notes.map((note) => (note.id === noteId ? { ...note, tags } : note))
            }))
          }
        }
      )

      try {
        const result = await notesService.update({ id: noteId, tags })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update tags')
        }
      } catch (err) {
        log.error('Failed to update tags:', err)
        toast.error('Failed to update tags')
        if (previousData) {
          queryClient.setQueryData(folderViewKeys.notes(folderPath), previousData)
        }
      }
    },
    [folderPath, queryClient]
  )

  /**
   * Refresh all data by invalidating queries
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: folderViewKeys.views(folderPath) }),
      queryClient.invalidateQueries({ queryKey: folderViewKeys.availableProperties(folderPath) }),
      queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(folderPath) })
    ])
  }, [queryClient, folderPath])

  // ============================================================================
  // Formula Methods
  // ============================================================================

  /**
   * Add a new formula
   */
  const addFormula = useCallback(
    async (name: string, expression: string) => {
      try {
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Invalidate to refetch
        queryClient.invalidateQueries({ queryKey: folderViewKeys.availableProperties(folderPath) })
      } catch (err) {
        log.error('addFormula failed:', err)
        throw err
      }
    },
    [folderPath, queryClient]
  )

  /**
   * Update an existing formula
   */
  const updateFormula = useCallback(
    async (name: string, expression: string) => {
      try {
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Invalidate to refetch
        queryClient.invalidateQueries({ queryKey: folderViewKeys.availableProperties(folderPath) })
      } catch (err) {
        log.error('updateFormula failed:', err)
        throw err
      }
    },
    [folderPath, queryClient]
  )

  /**
   * Delete a formula
   */
  const deleteFormula = useCallback(
    async (name: string) => {
      try {
        const configResult = await window.api.folderView.getConfig(folderPath)
        const existingConfig = configResult.config

        const updatedFormulas = { ...existingConfig.formulas }
        delete updatedFormulas[name]

        await window.api.folderView.setConfig(folderPath, {
          ...existingConfig,
          formulas: Object.keys(updatedFormulas).length > 0 ? updatedFormulas : undefined
        })

        // Invalidate to refetch
        queryClient.invalidateQueries({ queryKey: folderViewKeys.availableProperties(folderPath) })
      } catch (err) {
        log.error('deleteFormula failed:', err)
        throw err
      }
    },
    [folderPath, queryClient]
  )

  // ============================================================================
  // Effects
  // ============================================================================

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }
    }
  }, [])

  // Note: Event listeners for cache sync are handled globally in useFolderViewEvents()
  // This ensures all folder-view tabs stay in sync even when unmounted

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
    hasMore: notesQuery.hasNextPage ?? false,
    availableProperties,
    builtInColumns,
    formulas,
    formulasMap,
    summaries,

    // State - use query states for proper caching behavior
    isLoading: viewsQuery.isLoading || propertiesQuery.isLoading || notesQuery.isLoading,
    error:
      viewsQuery.error?.message ??
      propertiesQuery.error?.message ??
      notesQuery.error?.message ??
      null,
    // T115: Folder not found detection
    folderNotFound: folderExistsQuery.data === false,

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
    refresh,
    removeNotesOptimistically,
    updateNoteProperty,
    updateNoteTags
  }
}

export default useFolderView
