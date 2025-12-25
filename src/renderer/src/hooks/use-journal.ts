/**
 * Journal Hooks
 * React hooks for journal operations in the renderer process.
 *
 * @module hooks/use-journal
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { JournalEntry, HeatmapEntry } from '../../../preload/index.d'
import {
  journalService,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  onJournalEntryCreated
} from '@/services/journal-service'

// =============================================================================
// Types
// =============================================================================

export interface UseJournalEntryResult {
  /** The current journal entry, or null if not loaded/doesn't exist */
  entry: JournalEntry | null
  /** Loading state */
  isLoading: boolean
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

// =============================================================================
// useJournalEntry Hook
// =============================================================================

/**
 * Hook for loading and managing a journal entry.
 *
 * @param date - Date in YYYY-MM-DD format
 * @returns Journal entry state and operations
 */
export function useJournalEntry(date: string): UseJournalEntryResult {
  // State
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  // Refs for pending changes and debounce timer
  const pendingContentRef = useRef<string | null>(null)
  const pendingTagsRef = useRef<string[] | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentDateRef = useRef(date)

  // Update current date ref when date changes
  useEffect(() => {
    currentDateRef.current = date
  }, [date])

  // Load entry when date changes
  const loadEntry = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setIsDirty(false)
    pendingContentRef.current = null
    pendingTagsRef.current = null

    // Clear any pending save
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    try {
      const loadedEntry = await journalService.getEntry(date)
      // Only update if this is still the current date
      if (currentDateRef.current === date) {
        setEntry(loadedEntry)
      }
    } catch (err) {
      if (currentDateRef.current === date) {
        setError(err instanceof Error ? err.message : 'Failed to load journal entry')
        setEntry(null)
      }
    } finally {
      if (currentDateRef.current === date) {
        setIsLoading(false)
      }
    }
  }, [date])

  // Load entry on mount and when date changes
  useEffect(() => {
    loadEntry()
  }, [loadEntry])

  // Internal save function
  const performSave = useCallback(async () => {
    const content = pendingContentRef.current
    const tags = pendingTagsRef.current
    const currentDate = currentDateRef.current

    // Nothing to save
    if (content === null && tags === null) {
      return
    }

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

      const updatedEntry = await journalService.updateEntry(updateInput)

      // Only update state if we're still on the same date
      if (currentDateRef.current === currentDate) {
        setEntry(updatedEntry)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    } catch (err) {
      // Keep the dirty state so user knows there's unsaved content
      console.error('Failed to save journal entry:', err)
      if (currentDateRef.current === currentDate) {
        setError(err instanceof Error ? err.message : 'Failed to save')
      }
    } finally {
      if (currentDateRef.current === currentDate) {
        setIsSaving(false)
      }
    }
  }, [])

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
    if (isDirty) {
      await saveNow()
    }
    await loadEntry()
  }, [isDirty, saveNow, loadEntry])

  // Delete entry
  const deleteEntry = useCallback(async (): Promise<boolean> => {
    try {
      const result = await journalService.deleteEntry(date)
      if (result.success) {
        setEntry(null)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
      return result.success
    } catch (err) {
      console.error('Failed to delete journal entry:', err)
      return false
    }
  }, [date])

  // Cleanup on unmount or date change - save pending changes
  useEffect(() => {
    return () => {
      // Clear timer
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }

      // Save pending changes synchronously (best effort)
      if (pendingContentRef.current !== null || pendingTagsRef.current !== null) {
        // Note: This won't actually wait for the save to complete,
        // but it will trigger the save request
        performSave()
      }
    }
  }, [date, performSave])

  // Subscribe to external updates
  useEffect(() => {
    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      if (event.date === date && currentDateRef.current === date) {
        // Only update if we don't have pending changes
        if (!isDirty) {
          setEntry(event.entry as JournalEntry)
        }
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      if (event.date === date && currentDateRef.current === date) {
        setEntry(null)
        setIsDirty(false)
        pendingContentRef.current = null
        pendingTagsRef.current = null
      }
    })

    const unsubscribeExternal = onJournalExternalChange((event) => {
      if (event.date === date && currentDateRef.current === date) {
        if (event.type === 'deleted') {
          setEntry(null)
          setIsDirty(false)
        } else if (event.type === 'modified' && !isDirty) {
          // Reload if externally modified and we don't have pending changes
          loadEntry()
        }
      }
    })

    return () => {
      unsubscribeUpdated()
      unsubscribeDeleted()
      unsubscribeExternal()
    }
  }, [date, isDirty, loadEntry])

  return {
    entry,
    isLoading,
    error,
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
 * Automatically refreshes when journal entries are created/updated/deleted.
 *
 * @param year - Year to load heatmap data for (e.g., 2024)
 * @returns Heatmap data state
 */
export function useJournalHeatmap(year: number): UseJournalHeatmapResult {
  const [data, setData] = useState<HeatmapEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const currentYearRef = useRef(year)

  // Update current year ref when year changes
  useEffect(() => {
    currentYearRef.current = year
  }, [year])

  // Load heatmap data
  const loadHeatmap = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const heatmapData = await journalService.getHeatmap(year)
      // Only update if this is still the current year
      if (currentYearRef.current === year) {
        setData(heatmapData)
      }
    } catch (err) {
      if (currentYearRef.current === year) {
        setError(err instanceof Error ? err.message : 'Failed to load heatmap data')
        setData([])
      }
    } finally {
      if (currentYearRef.current === year) {
        setIsLoading(false)
      }
    }
  }, [year])

  // Load heatmap on mount and when year changes
  useEffect(() => {
    loadHeatmap()
  }, [loadHeatmap])

  // Subscribe to entry changes to refresh heatmap
  useEffect(() => {
    // Refresh heatmap when entries are created, updated, or deleted
    const unsubscribeCreated = onJournalEntryCreated((event) => {
      // Check if the event's date is in the current year
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === currentYearRef.current) {
        loadHeatmap()
      }
    })

    const unsubscribeUpdated = onJournalEntryUpdated((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === currentYearRef.current) {
        loadHeatmap()
      }
    })

    const unsubscribeDeleted = onJournalEntryDeleted((event) => {
      const eventYear = parseInt(event.date.slice(0, 4), 10)
      if (eventYear === currentYearRef.current) {
        loadHeatmap()
      }
    })

    return () => {
      unsubscribeCreated()
      unsubscribeUpdated()
      unsubscribeDeleted()
    }
  }, [loadHeatmap])

  return {
    data,
    isLoading,
    error,
    reload: loadHeatmap
  }
}

// =============================================================================
// Export types for external use
// =============================================================================

export type { JournalEntry, HeatmapEntry }
