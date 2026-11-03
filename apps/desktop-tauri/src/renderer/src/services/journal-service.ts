import type {
  JournalClientAPI,
  JournalEntry,
  JournalEntryCreatedEvent,
  JournalEntryUpdatedEvent,
  JournalEntryDeletedEvent,
  JournalExternalChangeEvent
} from '../../../preload/index.d'
import { commands, events, type JournalEntryView, type Value } from '../../../generated/bindings'
import { subscribeToEvent } from './tauri-event'
import { createWindowApiForwarder } from './window-api-forwarder'

/** A day's entry as Rust sends it, with `properties` left out when the file has none. */
function toEntry({ properties, ...entry }: JournalEntryView): JournalEntry {
  return properties === null ? entry : { ...entry, properties }
}

/** The journal methods served from Rust commands (`commands/journal.rs`, #3530 13m-2). */
const ported = {
  /**
   * Get a journal entry by date.
   * @param date - Date in YYYY-MM-DD format
   * @returns Journal entry or null if not found
   */
  getEntry: async (date: string): Promise<JournalEntry | null> => {
    const entry = await commands.journalGetEntry(date)
    return entry && toEntry(entry)
  },

  /**
   * Create a new journal entry. A day that has a file already is answered as it is.
   * @param input - Entry creation input
   * @returns Created journal entry
   */
  createEntry: async (input: {
    date: string
    content?: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry> => {
    const entry = await commands.journalCreateEntry({
      date: input.date,
      content: input.content,
      tags: input.tags,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- property values are the JSON the command carries as is
      properties: input.properties as Record<string, Value> | undefined
    })
    return toEntry(entry)
  },

  /**
   * Delete a journal entry.
   * @param date - Date in YYYY-MM-DD format
   * @returns Success status
   */
  deleteEntry: (date: string): Promise<{ success: boolean }> => commands.journalDeleteEntry(date)
} satisfies Partial<JournalClientAPI>

/** The journal methods served from Rust; `window.api.journal` is typed without them. */
export type PortedJournalMethod = keyof typeof ported

/**
 * Journal service - the journal operations of the renderer: the ported ones over Rust commands,
 * the rest through `window.api.journal`.
 */
export const journalService: JournalClientAPI = createWindowApiForwarder<
  JournalClientAPI,
  PortedJournalMethod
>(() => window.api.journal, ported)

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/** The subscriptions below that Rust events serve; `window.api` is typed without them. */
export type PortedJournalEvent = 'onJournalEntryCreated' | 'onJournalEntryDeleted'

/**
 * Subscribe to journal entry created events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onJournalEntryCreated(
  callback: (event: JournalEntryCreatedEvent) => void
): () => void {
  return subscribeToEvent(events.journalEntryCreatedEvent, ({ date, entry }) =>
    callback({ date, entry: toEntry(entry) })
  )
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
  return subscribeToEvent(events.journalEntryDeletedEvent, callback)
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
