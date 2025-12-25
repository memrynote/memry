/**
 * Journal Hooks
 * React hooks for journal operations in the renderer process.
 * Uses TanStack Query for caching and data fetching.
 *
 * @module hooks/use-journal
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { JournalEntry, HeatmapEntry } from '../../../preload/index.d'
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
  heatmap: (year: number) => [...journalKeys.heatmaps(), year] as const
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
  /** Update the entry content (triggers auto-save) */
  updateContent: (content: string) => void
  /** Update the entry tags */
  updateTags: (tags: string[]) => void
  /** Force save now (bypasses debounce) */
  saveNow: () => Promise<void>
  /** Reload the entry from server */
  reload: () => Promise<void>
  /** Delete the entry */
  deleteEntry: () => Promise<boolean>
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

  // Update current date ref when date changes
  useEffect(() => {
    currentDateRef.current = date
    // Clear pending changes when date changes
    pendingContentRef.current = null
    pendingTagsRef.current = null
    setIsDirty(false)
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
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
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    } catch (err) {
      // Keep the dirty state so user knows there's unsaved content
      console.error('Failed to save journal entry:', err)
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
    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      // Ignore updates from our own saves
      if (isSavingRef.current) {
        return
      }
      if (event.date === currentDateRef.current) {
        // Only update cache if we don't have pending changes
        if (!isDirtyRef.current) {
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
    updateContent,
    updateTags,
    saveNow,
    reload,
    deleteEntry
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
// Export types for external use
// =============================================================================

export type { JournalEntry, HeatmapEntry }
