import { getI18n } from 'react-i18next'
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
import { DEFAULT_COLUMNS, BUILT_IN_COLUMNS, scopeKey } from '@memry/contracts/folder-view-api'
import type {
  FilterExpression,
  SummaryConfig,
  GroupByConfig,
  ViewScope,
  ViewConfig as ContractViewConfig
} from '@memry/contracts/folder-view-api'
import { evaluateFilter } from '@/lib/filter-evaluator'
import { getColumnLabel } from '@/lib/contract-display-names'
import { propertiesService } from '@/services/properties-service'
import { notesService, onTagsChanged } from '@/services/notes-service'
import { onTagNotesChanged } from '@/services/tags-service'

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
  type: 'table' | 'grid' | 'list'
  default?: boolean
  columns?: ColumnConfig[]
  filters?: unknown // Allow unknown for API compatibility
  order?: Array<{ property: string; direction: 'asc' | 'desc' }>
  groupBy?: unknown // Allow unknown for API compatibility
  limit?: number
  showSummaries?: boolean
  columnBorders?: boolean
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
  /** Row kind. Absent means 'note' — folder views only ever contain notes. */
  kind?: 'note' | 'task' | 'inbox'
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
  folderExists: (scope: ViewScope) => [...folderViewKeys.all, 'exists', scopeKey(scope)] as const,
  views: (scope: ViewScope) => [...folderViewKeys.all, 'views', scopeKey(scope)] as const,
  availableProperties: (scope: ViewScope) =>
    [...folderViewKeys.all, 'available-properties', scopeKey(scope)] as const,
  // Stable notes key - does NOT include propertyIds to avoid refetch on column change
  notes: (scope: ViewScope) => [...folderViewKeys.all, 'notes', scopeKey(scope)] as const
}

/**
 * Resolves a saved view NAME against the folder's current views.
 *
 * Callers persist the name rather than the index on purpose: indices shift the
 * moment a view is added, deleted or reordered in `.folder.md` — possibly by
 * another device, or by hand — and a stale index silently lands on someone
 * else's view. A stale name simply fails to match, and the folder's own
 * `defaultIndex` takes over. An out-of-range `defaultIndex` (a `.folder.md`
 * edited down to fewer views) falls back to the first view rather than to
 * `null`, which would render an empty table with no way back.
 */
export function resolveViewIndex(
  views: readonly { name: string }[],
  storedName: string | null | undefined,
  defaultIndex: number
): number {
  const fallback = defaultIndex >= 0 && defaultIndex < views.length ? defaultIndex : 0
  if (typeof storedName !== 'string') return fallback
  const named = views.findIndex((view) => view.name === storedName)
  return named >= 0 ? named : fallback
}

// ============================================================================
// Types
// ============================================================================

interface UseFolderViewOptions {
  /** What this view is scoped to — a folder directory or a tag. */
  scope: ViewScope
  /** Initial page size */
  pageSize?: number
  /** Saved view name to activate on load, preferred over the folder default (e.g. Home widget config). */
  initialViewName?: string
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
  /** Rename a view in place by index */
  renameView: (index: number, newName: string) => Promise<void>
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
  scope,
  pageSize = 100,
  initialViewName
}: UseFolderViewOptions): UseFolderViewResult {
  const queryClient = useQueryClient()

  // Local state for user's current view selection
  const [activeViewIndex, setActiveViewIndex] = useState(0)

  // Debounce timer for column updates
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // Debounce timer for in-place renames (live, per-keystroke)
  const renameTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // ============================================================================
  // Queries
  // ============================================================================

  /**
   * T115: Folder existence query - checks if folder exists.
   * Tags have no directory, so this is gated to folder scope only — asking
   * for a tag would always answer "no" and render the missing-folder empty
   * state over a perfectly valid tag.
   */
  const folderExistsQuery = useQuery({
    queryKey: folderViewKeys.folderExists(scope),
    queryFn: async (): Promise<boolean> => {
      if (scope.kind !== 'folder') return true
      return window.api.folderView.folderExists(scope.path)
    },
    enabled: scope.kind === 'folder',
    staleTime: 60_000, // 60 seconds
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true
  })

  /**
   * Views query - fetches view configurations and summaries.
   * Summaries live in .folder.md, which only folders have, so tag scope
   * gets an empty summaries map instead of a getConfig call.
   */
  const viewsQuery = useQuery({
    queryKey: folderViewKeys.views(scope),
    queryFn: async (): Promise<ViewsQueryData> => {
      const [viewsResult, configResult] = await Promise.all([
        window.api.folderView.getViews(scope),
        scope.kind === 'folder' ? window.api.folderView.getConfig(scope.path) : null
      ])
      return {
        views: viewsResult.views,
        defaultIndex: viewsResult.defaultIndex,
        summaries: configResult?.config.summaries ?? {}
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
    queryKey: folderViewKeys.availableProperties(scope),
    queryFn: async (): Promise<PropertiesQueryData> => {
      const result = await window.api.folderView.getAvailableProperties(scope)
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
  const views = useMemo(() => viewsQuery.data?.views ?? [DEFAULT_VIEW], [viewsQuery.data?.views])
  const summaries = viewsQuery.data?.summaries ?? {}

  // Sync activeViewIndex when views load (only on initial load or invalidation).
  // Done during render via the React-recommended "adjusting state when a prop changes"
  // pattern instead of an effect, so we avoid no-derived-state warnings.
  // When initialViewName is provided (the Home widget, and a folder tab restoring
  // the view it was left on), prefer the named view over the default. A name that
  // no longer matches — renamed, deleted, or reordered away since it was
  // recorded — falls back to the folder's own default rather than an arbitrary
  // index.
  const [initKey, setInitKey] = useState<string | null>(null)
  const desiredInitKey = `${scopeKey(scope)}::${initialViewName ?? ''}`
  if (viewsQuery.data && initKey !== desiredInitKey) {
    setInitKey(desiredInitKey)
    setActiveViewIndex(
      resolveViewIndex(viewsQuery.data.views, initialViewName, viewsQuery.data.defaultIndex)
    )
  }

  // Get active view
  const activeView = views[activeViewIndex] ?? null

  /**
   * Notes infinite query - fetches notes with pagination
   *
   * Note: Query key is stable (based only on scope) to prevent
   * full refetch when columns are added/removed. We fetch all properties
   * so column changes don't require a refetch.
   */
  const notesQuery = useInfiniteQuery({
    queryKey: folderViewKeys.notes(scope),
    queryFn: async ({ pageParam = 0 }): Promise<ListWithPropertiesResponse> => {
      // Fetch all available properties to avoid refetch when columns change
      // This is a trade-off: slightly larger payload vs better UX
      const result = await window.api.folderView.listWithProperties({
        scope,
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
  const rawBuiltInColumns: Array<{ id: string; displayName: string; type: string }> =
    propertiesQuery.data?.builtIn ??
    BUILT_IN_COLUMNS.map((id) => ({
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      type: 'text'
    }))
  // The `displayName` above is a mechanical capitalization of the English column
  // id, never a user value — so it is only the fallback for the translated label.
  const builtInColumns = rawBuiltInColumns.map((col) => ({
    ...col,
    displayName: getColumnLabel(col.id, col.displayName)
  }))
  const formulas = useMemo(
    () => propertiesQuery.data?.formulas ?? [],
    [propertiesQuery.data?.formulas]
  )

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
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(scope), (old) => {
        if (!old) return old
        const newViews = [...old.views]
        newViews[activeViewIndex] = updatedView
        return { ...old, views: newViews }
      })

      // Debounce the save to avoid too many writes
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }

      updateTimeoutRef.current = setTimeout(() => {
        void (async () => {
          try {
            const result = await window.api.folderView.setView(
              scope,
              updatedView as unknown as ContractViewConfig
            )

            if (!result.success) {
              throw new Error(result.error || 'Failed to save view')
            }
          } catch (err) {
            log.error('updateView failed:', err)
            // Revert on error
            void queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })
          }
        })()
      }, 300)
    },
    [activeView, activeViewIndex, scope, queryClient]
  )

  /**
   * Add a new view
   */
  const addView = useCallback(
    async (view: ViewConfig) => {
      try {
        const result = await window.api.folderView.setView(
          scope,
          view as unknown as ContractViewConfig
        )

        if (!result.success) {
          throw new Error(result.error || 'Failed to save view')
        }

        // Invalidate to refetch views
        await queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })

        // Find and set the new view as active
        const newData = queryClient.getQueryData<ViewsQueryData>(folderViewKeys.views(scope))
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
    [scope, queryClient]
  )

  /**
   * Delete a view by name
   */
  const deleteView = useCallback(
    async (viewName: string) => {
      try {
        const result = await window.api.folderView.deleteView(scope, viewName)

        if (!result.success) {
          throw new Error(result.error || 'Failed to delete view')
        }

        // Invalidate to refetch views
        await queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })

        // Adjust active index if needed
        const newData = queryClient.getQueryData<ViewsQueryData>(folderViewKeys.views(scope))
        if (newData && activeViewIndex >= newData.views.length) {
          setActiveViewIndex(Math.max(0, newData.views.length - 1))
        }
      } catch (err) {
        log.error('deleteView failed:', err)
        throw err
      }
    },
    [scope, queryClient, activeViewIndex]
  )

  /**
   * Rename a view in place by index. Safe to call on every keystroke: the cache
   * updates optimistically right away and the disk write is debounced.
   *
   * `setView` keys by name and would push a duplicate on a name change, so a
   * rename rewrites the whole views array via `setConfig` to preserve order.
   * Empty names and names that collide with another view are skipped.
   */
  const renameView = useCallback(
    async (index: number, newName: string) => {
      // Whole-array rewrite goes through folderView.setConfig, which only
      // folders have (a tag has no .folder.md to rewrite). Tag-scoped
      // rename isn't wired up yet, so bail rather than apply an optimistic
      // update that would silently revert on the next fetch.
      if (scope.kind !== 'folder') {
        log.warn('renameView is not supported for tag scope yet')
        return
      }
      const folderPath = scope.path

      const target = views[index]
      if (!target) return
      const name = newName.trim()
      if (!name || name === target.name) return
      const collides = views.some(
        (v, i) => i !== index && v.name.toLowerCase() === name.toLowerCase()
      )
      if (collides) return

      const newViews = views.map((v, i) => (i === index ? { ...v, name } : v))

      // Optimistic update to cache
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(scope), (old) =>
        old ? { ...old, views: newViews } : old
      )

      // Debounce the disk write to avoid thrashing on every keystroke
      if (renameTimeoutRef.current) {
        clearTimeout(renameTimeoutRef.current)
      }
      renameTimeoutRef.current = setTimeout(() => {
        void (async () => {
          try {
            const result = await window.api.folderView.setConfig(folderPath, {
              views: newViews
            } as unknown as Record<string, unknown>)

            if (!result.success) {
              throw new Error(result.error || 'Failed to rename view')
            }
          } catch (err) {
            log.error('renameView failed:', err)
            // Revert on error
            void queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })
          }
        })()
      }, 300)
    },
    [views, scope, queryClient]
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
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(scope), (old) => {
        if (!old) return old
        return {
          ...old,
          views: old.views.map((v, i) => ({ ...v, default: i === index })),
          defaultIndex: index
        }
      })

      try {
        const result = await window.api.folderView.setView(scope, {
          ...targetView,
          default: true
        } as unknown as ContractViewConfig)

        if (!result.success) {
          throw new Error(result.error || 'Failed to set default view')
        }

        setActiveViewIndex(index)
      } catch (err) {
        log.error('setViewAsDefault failed:', err)
        // Revert on error
        void queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })
        throw err
      }
    },
    [views, scope, queryClient]
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
      // Summaries live in .folder.md, which only folders have.
      if (scope.kind !== 'folder') {
        log.warn('updateSummaryConfig is not supported for tag scope yet')
        return
      }
      try {
        const configResult = await window.api.folderView.getConfig(scope.path)
        const existingConfig = configResult.config

        const updatedSummaries = {
          ...(existingConfig.summaries ?? {})
        }
        if (config) {
          updatedSummaries[columnId] = config
        } else {
          delete updatedSummaries[columnId]
        }

        await window.api.folderView.setConfig(scope.path, {
          ...existingConfig,
          summaries: Object.keys(updatedSummaries).length > 0 ? updatedSummaries : undefined
        })

        // Update cache
        queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(scope), (old) => {
          if (!old) return old
          return { ...old, summaries: updatedSummaries }
        })
      } catch (err) {
        log.error('updateSummaryConfig failed:', err)
      }
    },
    [scope, queryClient]
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
      queryClient.setQueryData<ViewsQueryData>(folderViewKeys.views(scope), (old) => {
        if (!old) return old
        const newViews = [...old.views]
        newViews[activeViewIndex] = updatedView
        return { ...old, views: newViews }
      })

      // Debounce the save
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current)
      }

      updateTimeoutRef.current = setTimeout(() => {
        void (async () => {
          try {
            await window.api.folderView.setView(scope, updatedView as unknown as ContractViewConfig)

            // The properties.{id}.displayName record lives in .folder.md,
            // which only folders have — the per-view column override above
            // is all a tag scope gets for now.
            if (scope.kind === 'folder') {
              const configResult = await window.api.folderView.getConfig(scope.path)
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

              await window.api.folderView.setConfig(scope.path, updatedConfig)
            }
          } catch (err) {
            log.error('Failed to save display name:', err)
            void queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) })
          }
        })()
      }, 300)
    },
    [activeView, activeViewIndex, scope, queryClient]
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
        folderViewKeys.notes(scope),
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
    [queryClient, scope]
  )

  /**
   * Update a single property on a note with optimistic cache update.
   */
  const updateNoteProperty = useCallback(
    async (noteId: string, propertyId: string, value: unknown) => {
      const previousData = queryClient.getQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(scope)
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
        folderViewKeys.notes(scope),
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
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToUpdateProperty'))
        if (previousData) {
          queryClient.setQueryData(folderViewKeys.notes(scope), previousData)
        }
      }
    },
    [scope, queryClient]
  )

  /**
   * Update tags for a note with optimistic cache update.
   */
  const updateNoteTags = useCallback(
    async (noteId: string, tags: string[]) => {
      const previousData = queryClient.getQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(scope)
      )

      queryClient.setQueryData<InfiniteData<ListWithPropertiesResponse>>(
        folderViewKeys.notes(scope),
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
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToUpdateTags'))
        if (previousData) {
          queryClient.setQueryData(folderViewKeys.notes(scope), previousData)
        }
      }
    },
    [scope, queryClient]
  )

  /**
   * Refresh all data by invalidating queries
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: folderViewKeys.views(scope) }),
      queryClient.invalidateQueries({ queryKey: folderViewKeys.availableProperties(scope) }),
      queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(scope) })
    ])
  }, [queryClient, scope])

  // ============================================================================
  // Formula Methods
  // ============================================================================

  /**
   * Add a new formula
   */
  const addFormula = useCallback(
    async (name: string, expression: string) => {
      // Formulas live in .folder.md, which only folders have.
      if (scope.kind !== 'folder') {
        throw new Error('Formulas are not supported for tag scope yet')
      }
      try {
        const configResult = await window.api.folderView.getConfig(scope.path)
        const existingConfig = configResult.config

        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        await window.api.folderView.setConfig(scope.path, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Invalidate to refetch
        void queryClient.invalidateQueries({
          queryKey: folderViewKeys.availableProperties(scope)
        })
      } catch (err) {
        log.error('addFormula failed:', err)
        throw err
      }
    },
    [scope, queryClient]
  )

  /**
   * Update an existing formula
   */
  const updateFormula = useCallback(
    async (name: string, expression: string) => {
      // Formulas live in .folder.md, which only folders have.
      if (scope.kind !== 'folder') {
        throw new Error('Formulas are not supported for tag scope yet')
      }
      try {
        const configResult = await window.api.folderView.getConfig(scope.path)
        const existingConfig = configResult.config

        const updatedFormulas = {
          ...existingConfig.formulas,
          [name]: expression
        }

        await window.api.folderView.setConfig(scope.path, {
          ...existingConfig,
          formulas: updatedFormulas
        })

        // Invalidate to refetch
        void queryClient.invalidateQueries({
          queryKey: folderViewKeys.availableProperties(scope)
        })
      } catch (err) {
        log.error('updateFormula failed:', err)
        throw err
      }
    },
    [scope, queryClient]
  )

  /**
   * Delete a formula
   */
  const deleteFormula = useCallback(
    async (name: string) => {
      // Formulas live in .folder.md, which only folders have.
      if (scope.kind !== 'folder') {
        throw new Error('Formulas are not supported for tag scope yet')
      }
      try {
        const configResult = await window.api.folderView.getConfig(scope.path)
        const existingConfig = configResult.config

        const updatedFormulas = { ...existingConfig.formulas }
        delete updatedFormulas[name]

        await window.api.folderView.setConfig(scope.path, {
          ...existingConfig,
          formulas: Object.keys(updatedFormulas).length > 0 ? updatedFormulas : undefined
        })

        // Invalidate to refetch
        void queryClient.invalidateQueries({
          queryKey: folderViewKeys.availableProperties(scope)
        })
      } catch (err) {
        log.error('deleteFormula failed:', err)
        throw err
      }
    },
    [scope, queryClient]
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

  // Ported from the deleted `useTagItems` — tag scope only, a folder has no
  // tag to match against. `tags:notes-changed` carries the tag (pin/unpin,
  // tag added or removed on a note, task/inbox tag changes); `notes:tags-changed`
  // carries none — inline tag editing fires it — so it invalidates
  // unconditionally.
  //
  // Callers pass an object literal for `scope`, a new reference every
  // render, so the effects depend on `scopeKey(scope)` (stable per logical
  // scope) instead of `scope` itself to avoid resubscribing on every render.
  useEffect(() => {
    if (scope.kind !== 'tag') return
    const currentTag = scope.tag
    const unsubscribe = onTagNotesChanged((event) => {
      if (event.tag.toLowerCase() === currentTag.toLowerCase()) {
        void queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(scope) })
      }
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(scope), queryClient])

  useEffect(() => {
    if (scope.kind !== 'tag') return
    const unsubscribe = onTagsChanged(() => {
      void queryClient.invalidateQueries({ queryKey: folderViewKeys.notes(scope) })
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey(scope), queryClient])

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
    renameView,
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
