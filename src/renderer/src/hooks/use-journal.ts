/**
 * Journal Hooks
 * React hooks for journal operations in the renderer process.
 * Uses TanStack Query for caching and data fetching.
 *
 * @module hooks/use-journal
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  JournalEntry,
  HeatmapEntry,
  MonthEntryPreview,
  MonthStats,
  DayContext,
  DayTask
} from '../../../preload/index.d'
import {
  journalService,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  onJournalEntryCreated
} from '@/services/journal-service'
import { addDays, formatDateToISO, parseISODate } from '@/lib/journal-utils'

// =============================================================================
// Query Keys
// =============================================================================

export const journalKeys = {
  all: ['journal'] as const,
  entries: () => [...journalKeys.all, 'entries'] as const,
  entry: (date: string) => [...journalKeys.entries(), date] as const,
  heatmaps: () => [...journalKeys.all, 'heatmaps'] as const,
  heatmap: (year: number) => [...journalKeys.heatmaps(), year] as const,
  monthEntries: () => [...journalKeys.all, 'monthEntries'] as const,
  monthEntriesForMonth: (year: number, month: number) =>
    [...journalKeys.monthEntries(), year, month] as const,
  yearStats: () => [...journalKeys.all, 'yearStats'] as const,
  yearStatsForYear: (year: number) => [...journalKeys.yearStats(), year] as const,
  dayContext: () => [...journalKeys.all, 'dayContext'] as const,
  dayContextForDate: (date: string) => [...journalKeys.dayContext(), date] as const
}

// =============================================================================
// Types
// =============================================================================

export interface UseJournalEntryResult {
  /** The current journal entry, or null if not loaded/doesn't exist */
  entry: JournalEntry | null
  /** Loading state */
  isLoading: boolean
  /** The date that the current entry/null state was loaded for (null if not yet loaded) */
  loadedForDate: string | null
  /** Error message if loading failed */
  error: string | null
  /** Whether the entry is being saved */
  isSaving: boolean
  /** Whether there are unsaved changes */
  isDirty: boolean
  /** Error message if last save failed (e.g., disk full) */
  saveError: string | null
  /** Counter that increments when external updates are received (for editor remounting) */
  externalUpdateCount: number
  /** Update the entry content (triggers auto-save) */
  updateContent: (content: string) => void
  /** Update the entry tags */
  updateTags: (tags: string[]) => void
  /** Force save now (bypasses debounce) */
  saveNow: () => Promise<void>
  /** Reload the entry from server */
  reload: () => Promise<void>
  /** Force reload from server, discarding any pending changes (for version restore) */
  forceReload: () => Promise<void>
  /** Delete the entry */
  deleteEntry: () => Promise<boolean>
  /** Retry the last failed save operation */
  retrySave: () => Promise<void>
  /** Dismiss the save error */
  dismissSaveError: () => void
}

// =============================================================================
// Constants
// =============================================================================

/** Debounce delay for auto-save (1 second as per spec FR-004) */
const AUTO_SAVE_DELAY_MS = 1000

/** Stale time for journal entries (30 seconds) */
const ENTRY_STALE_TIME = 30 * 1000

/** Number of adjacent dates to prefetch */
const PREFETCH_DAYS = 1

// =============================================================================
// useJournalEntry Hook
// =============================================================================

/**
 * Hook for loading and managing a journal entry.
 * Uses TanStack Query for caching - revisiting a date within staleTime is instant.
 *
 * @param date - Date in YYYY-MM-DD format
 * @returns Journal entry state and operations
 */
export function useJournalEntry(date: string): UseJournalEntryResult {
  const queryClient = useQueryClient()

  // Local state for mutations
  const [isSaving, setIsSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)

  // Refs for pending changes and debounce timer
  const pendingContentRef = useRef<string | null>(null)
  const pendingTagsRef = useRef<string[] | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentDateRef = useRef(date)
  const isDirtyRef = useRef(isDirty)
  // Track if we're currently saving to ignore our own update events
  const isSavingRef = useRef(false)

  // Keep refs in sync
  useEffect(() => {
    isDirtyRef.current = isDirty
  }, [isDirty])

  // Ref to track the previous date for save-before-navigation
  const previousDateRef = useRef<string | null>(null)

  // Update current date ref when date changes
  // IMPORTANT: This effect handles navigation by:
  // 1. Saving any pending content for the OLD date (prevents data loss)
  // 2. Clearing state for the new date
  useEffect(() => {
    const oldDate = previousDateRef.current
    const pendingContent = pendingContentRef.current
    const pendingTags = pendingTagsRef.current

    // Clear the timer first
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    // If there are pending changes for the old date, save them before switching
    if (oldDate && oldDate !== date && (pendingContent !== null || pendingTags !== null)) {
      // Save pending content for the old date (fire-and-forget)
      const saveInput: { date: string; content?: string; tags?: string[] } = { date: oldDate }
      if (pendingContent !== null) saveInput.content = pendingContent
      if (pendingTags !== null) saveInput.tags = pendingTags

      // Perform save for the old date asynchronously using the service directly
      journalService.updateEntry(saveInput).catch((err) => {
        console.error(`[useJournalEntry] Failed to save pending changes for ${oldDate}:`, err)
        // Note: We don't set save error here as we've already navigated away
      })
    }

    // Update refs for the new date
    currentDateRef.current = date
    previousDateRef.current = date
    pendingContentRef.current = null
    pendingTagsRef.current = null
    setIsDirty(false)
    setSaveError(null) // Clear any save errors from previous date
  }, [date])

  // Main query for fetching journal entry
  const {
    data: entry = null,
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.entry(date),
    queryFn: () => journalService.getEntry(date),
    staleTime: ENTRY_STALE_TIME,
    // Keep in cache for 5 minutes after unmount
    gcTime: 5 * 60 * 1000
  })

  // Prefetch adjacent dates for smooth navigation
  useEffect(() => {
    const dateObj = parseISODate(date)

    for (let i = 1; i <= PREFETCH_DAYS; i++) {
      // Prefetch previous day
      const prevDate = formatDateToISO(addDays(dateObj, -i))
      queryClient.prefetchQuery({
        queryKey: journalKeys.entry(prevDate),
        queryFn: () => journalService.getEntry(prevDate),
        staleTime: ENTRY_STALE_TIME
      })

      // Prefetch next day
      const nextDate = formatDateToISO(addDays(dateObj, i))
      queryClient.prefetchQuery({
        queryKey: journalKeys.entry(nextDate),
        queryFn: () => journalService.getEntry(nextDate),
        staleTime: ENTRY_STALE_TIME
      })
    }
  }, [date, queryClient])

  // Mutation for updating entry
  const updateMutation = useMutation({
    mutationFn: async (input: { date: string; content?: string; tags?: string[] }) => {
      return journalService.updateEntry(input)
    },
    onSuccess: (updatedEntry) => {
      // Update the cache with the new entry
      queryClient.setQueryData(journalKeys.entry(updatedEntry.date), updatedEntry)
      // Invalidate heatmap for the year
      const year = parseInt(updatedEntry.date.slice(0, 4), 10)
      queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  // Mutation for deleting entry
  const deleteMutation = useMutation({
    mutationFn: async (dateToDelete: string) => {
      return journalService.deleteEntry(dateToDelete)
    },
    onSuccess: (_, dateToDelete) => {
      // Remove from cache
      queryClient.setQueryData(journalKeys.entry(dateToDelete), null)
      // Invalidate heatmap for the year
      const year = parseInt(dateToDelete.slice(0, 4), 10)
      queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
    }
  })

  // Internal save function
  const performSave = useCallback(async () => {
    const content = pendingContentRef.current
    const tags = pendingTagsRef.current
    const currentDate = currentDateRef.current

    // Nothing to save
    if (content === null && tags === null) {
      return
    }

    // Prevent re-entry
    if (isSavingRef.current) {
      return
    }

    isSavingRef.current = true
    setIsSaving(true)

    try {
      const updateInput: { date: string; content?: string; tags?: string[] } = {
        date: currentDate
      }

      if (content !== null) {
        updateInput.content = content
      }
      if (tags !== null) {
        updateInput.tags = tags
      }

      await updateMutation.mutateAsync(updateInput)

      // Only update state if we're still on the same date
      if (currentDateRef.current === currentDate) {
        setIsDirty(false)
        setSaveError(null) // Clear any previous save error
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    } catch (err) {
      // Keep the dirty state so user knows there's unsaved content
      console.error('Failed to save journal entry:', err)
      // Set save error for UI feedback
      const errorMessage = err instanceof Error ? err.message : 'Failed to save journal entry'
      // Check for disk-related errors
      const isDiskError =
        errorMessage.includes('ENOSPC') ||
        errorMessage.includes('disk') ||
        errorMessage.includes('space') ||
        errorMessage.includes('write')
      if (currentDateRef.current === currentDate) {
        setSaveError(isDiskError ? 'Unable to save: disk may be full' : errorMessage)
      }
    } finally {
      isSavingRef.current = false
      if (currentDateRef.current === currentDate) {
        setIsSaving(false)
      }
    }
  }, [updateMutation])

  // Debounced save
  const scheduleSave = useCallback(() => {
    // Clear existing timer
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }

    // Schedule new save
    saveTimerRef.current = setTimeout(() => {
      performSave()
    }, AUTO_SAVE_DELAY_MS)
  }, [performSave])

  // Update content (triggers debounced save)
  const updateContent = useCallback(
    (content: string) => {
      pendingContentRef.current = content
      setIsDirty(true)
      scheduleSave()
    },
    [scheduleSave]
  )

  // Update tags (triggers debounced save)
  const updateTags = useCallback(
    (tags: string[]) => {
      pendingTagsRef.current = tags
      setIsDirty(true)
      scheduleSave()
    },
    [scheduleSave]
  )

  // Force save now
  const saveNow = useCallback(async () => {
    // Clear pending timer
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    await performSave()
  }, [performSave])

  // Reload entry
  const reload = useCallback(async () => {
    // Save pending changes first
    if (isDirtyRef.current) {
      await saveNow()
    }
    await refetch()
  }, [saveNow, refetch])

  // Force reload entry (discard pending changes) - used after version restore
  const forceReload = useCallback(async () => {
    // Clear any pending save timer
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    // Discard pending changes
    pendingContentRef.current = null
    pendingTagsRef.current = null
    setIsDirty(false)
    // Force refetch from server
    await refetch()
  }, [refetch])

  // Delete entry
  const deleteEntry = useCallback(async (): Promise<boolean> => {
    try {
      const result = await deleteMutation.mutateAsync(date)
      if (result.success) {
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
      return result.success
    } catch (err) {
      console.error('Failed to delete journal entry:', err)
      return false
    }
  }, [date, deleteMutation])

  // Retry the last failed save
  const retrySave = useCallback(async () => {
    setSaveError(null)
    await performSave()
  }, [performSave])

  // Dismiss save error
  const dismissSaveError = useCallback(() => {
    setSaveError(null)
  }, [])

  // Cleanup on unmount - save pending changes
  useEffect(() => {
    return () => {
      // Clear timer
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

  // Subscribe to external updates - use refs to avoid re-subscribing on state changes
  useEffect(() => {
    // Listen for newly created entries (e.g., from template application)
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      if (event.date === currentDateRef.current) {
        // Update cache with the new entry
        queryClient.setQueryData(journalKeys.entry(event.date), event.entry as JournalEntry)
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const isExternal = (event as { source?: string }).source === 'external'

      // For external updates, always update (file changed outside app)
      // For internal updates, ignore if we're saving (to avoid loops)
      if (!isExternal && isSavingRef.current) {
        return
      }

      if (event.date === currentDateRef.current) {
        // For external changes, always update and remount editor
        // For internal changes, only update if not dirty
        if (isExternal) {
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry as JournalEntry)
          // Clear dirty state since external content is authoritative
          setIsDirty(false)
          pendingContentRef.current = null
          pendingTagsRef.current = null
          // Increment to trigger editor remount
          setExternalUpdateCount((c) => c + 1)
        } else if (!isDirtyRef.current) {
          queryClient.setQueryData(journalKeys.entry(event.date), event.entry as JournalEntry)
        }
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      if (event.date === currentDateRef.current) {
        queryClient.setQueryData(journalKeys.entry(event.date), null)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    })

    const unsubscribeExternal = onJournalExternalChange((event) => {
      if (event.date === currentDateRef.current) {
        if (event.type === 'deleted') {
          queryClient.setQueryData(journalKeys.entry(event.date), null)
          setIsDirty(false)
        } else if (event.type === 'modified' && !isDirtyRef.current) {
          // Invalidate to trigger refetch
          queryClient.invalidateQueries({ queryKey: journalKeys.entry(event.date) })
        }
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
      unsubscribeExternal()
    }
  }, [queryClient]) // Only depend on queryClient, use refs for other values

  // Compute loadedForDate - if not loading and we have data (or confirmed null), we're loaded
  const loadedForDate = isLoading ? null : date

  return {
    entry,
    isLoading,
    loadedForDate,
    error: queryError instanceof Error ? queryError.message : null,
    isSaving,
    isDirty,
    saveError,
    externalUpdateCount,
    updateContent,
    updateTags,
    saveNow,
    reload,
    forceReload,
    deleteEntry,
    retrySave,
    dismissSaveError
  }
}

// =============================================================================
// useJournalHeatmap Hook
// =============================================================================

export interface UseJournalHeatmapResult {
  /** Heatmap data for the year */
  data: HeatmapEntry[]
  /** Loading state */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Reload the heatmap data */
  reload: () => Promise<void>
}

/**
 * Hook for loading heatmap data for a specific year.
 * Uses TanStack Query for caching.
 * Automatically refreshes when journal entries are created/updated/deleted.
 *
 * @param year - Year to load heatmap data for (e.g., 2024)
 * @returns Heatmap data state
 */
export function useJournalHeatmap(year: number): UseJournalHeatmapResult {
  const queryClient = useQueryClient()

  // Main query for fetching heatmap data
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.heatmap(year),
    queryFn: () => journalService.getHeatmap(year),
    staleTime: ENTRY_STALE_TIME,
    gcTime: 5 * 60 * 1000
  })

  // Subscribe to entry changes to refresh heatmap
  useEffect(() => {
    // Refresh heatmap when entries are created, updated, or deleted
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.heatmap(year) })
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
    }
  }, [year, queryClient])

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data,
    isLoading,
    error: queryError instanceof Error ? queryError.message : null,
    reload
  }
}

// =============================================================================
// useMonthEntries Hook
// =============================================================================

export interface UseMonthEntriesResult {
  /** Month entries with previews */
  data: MonthEntryPreview[]
  /** Loading state */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Reload the month entries */
  reload: () => Promise<void>
}

/**
 * Hook for loading journal entries for a specific month.
 * Uses TanStack Query for caching.
 * Automatically refreshes when journal entries are created/updated/deleted.
 *
 * @param year - Year (e.g., 2024)
 * @param month - Month (1-12, NOT 0-11)
 * @returns Month entries state
 */
export function useMonthEntries(year: number, month: number): UseMonthEntriesResult {
  const queryClient = useQueryClient()

  // Main query for fetching month entries
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.monthEntriesForMonth(year, month),
    queryFn: () => journalService.getMonthEntries(year, month),
    staleTime: ENTRY_STALE_TIME,
    gcTime: 5 * 60 * 1000
  })

  // Subscribe to entry changes to refresh month entries
  useEffect(() => {
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      const eventMonth = parseInt(event.date.slice(5, 7), 10)
      if (eventYear === year && eventMonth === month) {
        queryClient.invalidateQueries({
          queryKey: journalKeys.monthEntriesForMonth(year, month)
        })
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      const eventMonth = parseInt(event.date.slice(5, 7), 10)
      if (eventYear === year && eventMonth === month) {
        queryClient.invalidateQueries({
          queryKey: journalKeys.monthEntriesForMonth(year, month)
        })
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      const eventMonth = parseInt(event.date.slice(5, 7), 10)
      if (eventYear === year && eventMonth === month) {
        queryClient.invalidateQueries({
          queryKey: journalKeys.monthEntriesForMonth(year, month)
        })
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
    }
  }, [year, month, queryClient])

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data,
    isLoading,
    error: queryError instanceof Error ? queryError.message : null,
    reload
  }
}

// =============================================================================
// useYearStats Hook
// =============================================================================

export interface UseYearStatsResult {
  /** Year statistics by month */
  data: MonthStats[]
  /** Loading state */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Reload the year stats */
  reload: () => Promise<void>
}

/**
 * Hook for loading journal statistics for each month in a year.
 * Uses TanStack Query for caching.
 * Automatically refreshes when journal entries are created/updated/deleted.
 *
 * @param year - Year (e.g., 2024)
 * @returns Year stats state
 */
export function useYearStats(year: number): UseYearStatsResult {
  const queryClient = useQueryClient()

  // Main query for fetching year stats
  const {
    data = [],
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.yearStatsForYear(year),
    queryFn: () => journalService.getYearStats(year),
    staleTime: ENTRY_STALE_TIME,
    gcTime: 5 * 60 * 1000
  })

  // Subscribe to entry changes to refresh year stats
  useEffect(() => {
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.yearStatsForYear(year) })
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.yearStatsForYear(year) })
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === year) {
        queryClient.invalidateQueries({ queryKey: journalKeys.yearStatsForYear(year) })
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
    }
  }, [year, queryClient])

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data,
    isLoading,
    error: queryError instanceof Error ? queryError.message : null,
    reload
  }
}

// =============================================================================
// useDayContext Hook
// =============================================================================

export interface UseDayContextResult {
  /** Day context with tasks and events */
  data: DayContext | null
  /** Tasks for the day (convenience accessor) */
  tasks: DayTask[]
  /** Events for the day (convenience accessor) */
  events: DayContext['events']
  /** Overdue task count */
  overdueCount: number
  /** Loading state */
  isLoading: boolean
  /** Error message if loading failed */
  error: string | null
  /** Reload the day context */
  reload: () => Promise<void>
}

/**
 * Hook for loading day context (tasks and events) for a specific date.
 * Uses TanStack Query for caching.
 * Automatically refreshes when tasks are updated/completed.
 *
 * @param date - Date in YYYY-MM-DD format
 * @returns Day context state with tasks and events
 */
export function useDayContext(date: string): UseDayContextResult {
  const queryClient = useQueryClient()

  // Main query for fetching day context
  const {
    data,
    isLoading,
    error: queryError,
    refetch
  } = useQuery({
    queryKey: journalKeys.dayContextForDate(date),
    queryFn: () => journalService.getDayContext(date),
    staleTime: ENTRY_STALE_TIME,
    gcTime: 5 * 60 * 1000
  })

  // Subscribe to task events to refresh day context
  // Note: Task events are emitted via window.api.onTaskUpdated, etc.
  useEffect(() => {
    // Refresh on task events - tasks affecting this date might be updated
    const unsubscribeTaskUpdated = window.api.onTaskUpdated((event) => {
      // Refresh if task is due on this date or was due on this date before update
      if (event.task.dueDate === date || event.changes?.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskCreated = window.api.onTaskCreated((event) => {
      if (event.task.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    const unsubscribeTaskDeleted = window.api.onTaskDeleted(() => {
      // Can't check if task was for this date since it's deleted
      // Refresh to be safe - this is infrequent
      queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
    })

    const unsubscribeTaskCompleted = window.api.onTaskCompleted((event) => {
      if (event.task.dueDate === date) {
        queryClient.invalidateQueries({ queryKey: journalKeys.dayContextForDate(date) })
      }
    })

    return () => {
      unsubscribeTaskUpdated()
      unsubscribeTaskCreated()
      unsubscribeTaskDeleted()
      unsubscribeTaskCompleted()
    }
  }, [date, queryClient])

  const reload = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    data: data ?? null,
    tasks: data?.tasks ?? [],
    events: data?.events ?? [],
    overdueCount: data?.overdueCount ?? 0,
    isLoading,
    error: queryError instanceof Error ? queryError.message : null,
    reload
  }
}

// =============================================================================
// useAIConnections Hook
// =============================================================================

export interface UseAIConnectionsResult {
  /** AI-suggested connections */
  connections: AIConnection[]
  /** Loading state (analyzing content) */
  isLoading: boolean
  /** Error message if analysis failed */
  error: string | null
  /** Force refresh connections */
  refresh: () => void
}

// Import the AI connection type from the panel component
import type { AIConnection } from '@/components/journal/ai-connections-panel'
import { getAIConnections, MIN_CONTENT_LENGTH } from '@/services/ai-connections-service'

/** Debounce delay before triggering AI analysis (2 seconds per spec) */
const AI_ANALYSIS_DEBOUNCE_MS = 2000

/**
 * Hook for loading AI-suggested connections based on journal content.
 *
 * Behavior:
 * - Waits 2 seconds after typing stops before analyzing
 * - Only analyzes content with >= 50 characters
 * - Cancels pending analysis when content changes or component unmounts
 * - Automatically clears connections when content becomes too short
 *
 * @param content - The journal entry content to analyze
 * @returns AI connections state and refresh function
 */
export function useAIConnections(content: string): UseAIConnectionsResult {
  const [connections, setConnections] = useState<AIConnection[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refs for tracking state across renders
  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAnalyzedContentRef = useRef<string | null>(null)

  // Analysis function
  const analyzeContent = useCallback(async (contentToAnalyze: string) => {
    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // Skip if content is too short
    if (contentToAnalyze.length < MIN_CONTENT_LENGTH) {
      setConnections([])
      setIsLoading(false)
      setError(null)
      lastAnalyzedContentRef.current = null
      return
    }

    // Skip if content hasn't changed since last analysis
    if (contentToAnalyze === lastAnalyzedContentRef.current) {
      return
    }

    // Create new abort controller for this request
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setIsLoading(true)
    setError(null)

    try {
      const result = await getAIConnections(contentToAnalyze, abortController.signal)

      // Only update state if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setConnections(result)
        setIsLoading(false)
        lastAnalyzedContentRef.current = contentToAnalyze
      }
    } catch (err) {
      // Ignore abort errors
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }

      // Only update state if this request wasn't aborted
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to analyze content')
        setIsLoading(false)
      }
    }
  }, [])

  // Debounced analysis trigger
  useEffect(() => {
    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    // If content is too short, clear connections immediately
    if (content.length < MIN_CONTENT_LENGTH) {
      // Cancel any pending analysis
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
      setConnections([])
      setIsLoading(false)
      setError(null)
      lastAnalyzedContentRef.current = null
      return
    }

    // Set loading state to indicate we're waiting to analyze
    // (but only if content has changed from last analysis)
    if (content !== lastAnalyzedContentRef.current) {
      // Don't set loading here - we're just debouncing
      // Loading will be set when actual analysis starts
    }

    // Schedule analysis after debounce delay
    debounceTimerRef.current = setTimeout(() => {
      analyzeContent(content)
    }, AI_ANALYSIS_DEBOUNCE_MS)

    // Cleanup
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [content, analyzeContent])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Cancel any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      // Clear any pending timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  // Refresh function - forces immediate re-analysis
  const refresh = useCallback(() => {
    // Clear cached content to force re-analysis
    lastAnalyzedContentRef.current = null

    // Cancel pending debounce and analyze immediately
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    analyzeContent(content)
  }, [content, analyzeContent])

  return {
    connections,
    isLoading,
    error,
    refresh
  }
}

// =============================================================================
// Export types for external use
// =============================================================================

export type { JournalEntry, HeatmapEntry, MonthEntryPreview, MonthStats, DayContext, DayTask }
export type { AIConnection }
