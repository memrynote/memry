import type {
  JournalClientAPI,
  JournalEntryCreatedEvent,
  JournalEntryUpdatedEvent,
  JournalEntryDeletedEvent,
  JournalExternalChangeEvent
} from '@/types/preload-types'
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

/**
 * Journal service - Tauri invoke forwarder.
 * Provides a typed interface for journal operations in the renderer process.
 */
export const journalService: JournalClientAPI = createInvokeForwarder<JournalClientAPI>('journal')

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
  return subscribeEvent<JournalEntryCreatedEvent>('journal-entry-created', callback)
}

/**
 * Subscribe to journal entry updated events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryUpdated(
  callback: (event: JournalEntryUpdatedEvent) => void
): () => void {
  return subscribeEvent<JournalEntryUpdatedEvent>('journal-entry-updated', callback)
}

/**
 * Subscribe to journal entry deleted events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryDeleted(
  callback: (event: JournalEntryDeletedEvent) => void
): () => void {
  return subscribeEvent<JournalEntryDeletedEvent>('journal-entry-deleted', callback)
}

/**
 * Subscribe to journal external change events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalExternalChange(
  callback: (event: JournalExternalChangeEvent) => void
): () => void {
  return subscribeEvent<JournalExternalChangeEvent>('journal-external-change', callback)
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
