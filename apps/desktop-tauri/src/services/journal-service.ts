import type {
  JournalClientAPI,
  JournalEntry,
  HeatmapEntry,
  MonthEntryPreview,
  MonthStats,
  DayContext,
  JournalTagCount,
  JournalStreak,
  JournalEntryCreatedEvent,
  JournalEntryUpdatedEvent,
  JournalEntryDeletedEvent,
  JournalExternalChangeEvent
} from '@/types/preload-types'

/**
 * Journal service - thin wrapper around window.api.journal
 * Provides a typed interface for journal operations in the renderer process.
 */
export const journalService: JournalClientAPI = {
  // =========================================================================
  // Entry CRUD
  // =========================================================================

  /**
   * Get a journal entry by date.
   * @param date - Date in YYYY-MM-DD format
   * @returns Journal entry or null if not found
   */
  getEntry: (date: string): Promise<JournalEntry | null> => {
    return window.api.journal.getEntry(date)
  },

  /**
   * Create a new journal entry.
   * @param input - Entry creation input
   * @returns Created journal entry
   */
  createEntry: (input: {
    date: string
    content?: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry> => {
    return window.api.journal.createEntry(input)
  },

  /**
   * Update an existing journal entry.
   * Creates the entry if it doesn't exist.
   * @param input - Entry update input
   * @returns Updated journal entry
   */
  updateEntry: (input: {
    date: string
    content?: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry> => {
    return window.api.journal.updateEntry(input)
  },

  /**
   * Delete a journal entry.
   * @param date - Date in YYYY-MM-DD format
   * @returns Success status
   */
  deleteEntry: (date: string): Promise<{ success: boolean }> => {
    return window.api.journal.deleteEntry(date)
  },

  // =========================================================================
  // Calendar & Views
  // =========================================================================

  /**
   * Get heatmap data for a year.
   * @param year - Year (e.g., 2024)
   * @returns Array of heatmap entries with date, character count, and activity level
   */
  getHeatmap: (year: number): Promise<HeatmapEntry[]> => {
    return window.api.journal.getHeatmap(year)
  },

  /**
   * Get entries for a specific month with preview data.
   * @param year - Year (e.g., 2024)
   * @param month - Month (1-12)
   * @returns Array of month entry previews
   */
  getMonthEntries: (year: number, month: number): Promise<MonthEntryPreview[]> => {
    return window.api.journal.getMonthEntries(year, month)
  },

  /**
   * Get statistics for each month in a year.
   * @param year - Year (e.g., 2024)
   * @returns Array of monthly statistics
   */
  getYearStats: (year: number): Promise<MonthStats[]> => {
    return window.api.journal.getYearStats(year)
  },

  // =========================================================================
  // Context
  // =========================================================================

  /**
   * Get tasks and events for a specific date.
   * @param date - Date in YYYY-MM-DD format
   * @returns Day context with tasks and events
   */
  getDayContext: (date: string): Promise<DayContext> => {
    return window.api.journal.getDayContext(date)
  },

  // =========================================================================
  // Tags & Search
  // =========================================================================

  /**
   * Get all tags used in journal entries with counts.
   * @returns Array of tag counts
   */
  getAllTags: (): Promise<JournalTagCount[]> => {
    return window.api.journal.getAllTags()
  },

  // =========================================================================
  // Streak
  // =========================================================================

  /**
   * Get current and longest journaling streak.
   * @returns Streak information
   */
  getStreak: (): Promise<JournalStreak> => {
    return window.api.journal.getStreak()
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to journal entry created events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryCreated(
  callback: (event: JournalEntryCreatedEvent) => void
): () => void {
  return window.api.onJournalEntryCreated(callback)
}

/**
 * Subscribe to journal entry updated events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryUpdated(
  callback: (event: JournalEntryUpdatedEvent) => void
): () => void {
  return window.api.onJournalEntryUpdated(callback)
}

/**
 * Subscribe to journal entry deleted events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryDeleted(
  callback: (event: JournalEntryDeletedEvent) => void
): () => void {
  return window.api.onJournalEntryDeleted(callback)
}

/**
 * Subscribe to journal external change events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalExternalChange(
  callback: (event: JournalExternalChangeEvent) => void
): () => void {
  return window.api.onJournalExternalChange(callback)
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]
}

/**
 * Format a date for display.
 * @param date - Date in YYYY-MM-DD format
 * @returns Formatted date string
 */
export function formatJournalDate(date: string): string {
  const d = new Date(date + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

/**
 * Check if a date is today.
 * @param date - Date in YYYY-MM-DD format
 */
export function isToday(date: string): boolean {
  return date === getTodayDate()
}

/**
 * Check if a date is in the past.
 * @param date - Date in YYYY-MM-DD format
 */
export function isPastDate(date: string): boolean {
  return date < getTodayDate()
}

/**
 * Check if a date is in the future.
 * @param date - Date in YYYY-MM-DD format
 */
export function isFutureDate(date: string): boolean {
  return date > getTodayDate()
}
