/**
 * Reminder Service
 *
 * Thin wrapper around Tauri invoke commands for the renderer process.
 * Provides typed interface for reminder operations.
 *
 * @module services/reminder-service
 */

import type {
  Reminder,
  ReminderWithTarget,
  CreateReminderInput,
  UpdateReminderInput,
  SnoozeReminderInput,
  ListRemindersInput,
  ReminderListResponse,
  ReminderCreateResponse,
  ReminderUpdateResponse,
  ReminderDeleteResponse,
  ReminderDismissResponse,
  ReminderSnoozeResponse,
  BulkDismissResponse,
  ReminderTargetType,
  ReminderCreatedEvent,
  ReminderUpdatedEvent,
  ReminderDeletedEvent,
  ReminderDueEvent,
  ReminderDismissedEvent,
  ReminderSnoozedEvent
} from '@/types/preload-types'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

// Re-export types for convenience
export type {
  Reminder,
  ReminderWithTarget,
  CreateReminderInput,
  UpdateReminderInput,
  SnoozeReminderInput,
  ListRemindersInput,
  ReminderListResponse,
  ReminderCreateResponse,
  ReminderUpdateResponse,
  ReminderDeleteResponse,
  ReminderDismissResponse,
  ReminderSnoozeResponse,
  BulkDismissResponse,
  ReminderTargetType,
  ReminderCreatedEvent,
  ReminderUpdatedEvent,
  ReminderDeletedEvent,
  ReminderDueEvent,
  ReminderDismissedEvent,
  ReminderSnoozedEvent
}

// ============================================================================
// Reminder Service
// ============================================================================

export const reminderService = {
  /**
   * Create a new reminder
   */
  create: (input: CreateReminderInput): Promise<ReminderCreateResponse> => {
    return invoke<ReminderCreateResponse>(
      'reminders_create',
      input as unknown as Record<string, unknown>
    )
  },

  /**
   * Update an existing reminder
   */
  update: (input: UpdateReminderInput): Promise<ReminderUpdateResponse> => {
    return invoke<ReminderUpdateResponse>(
      'reminders_update',
      input as unknown as Record<string, unknown>
    )
  },

  /**
   * Delete a reminder
   */
  delete: (id: string): Promise<ReminderDeleteResponse> => {
    return invoke<ReminderDeleteResponse>('reminders_delete', { args: [id] })
  },

  /**
   * Get a reminder by ID
   */
  get: (id: string): Promise<ReminderWithTarget | null> => {
    return invoke<ReminderWithTarget | null>('reminders_get', { args: [id] })
  },

  /**
   * List reminders with optional filters
   */
  list: (options?: ListRemindersInput): Promise<ReminderListResponse> => {
    return invoke<ReminderListResponse>(
      'reminders_list',
      options as unknown as Record<string, unknown> | undefined
    )
  },

  /**
   * Get upcoming reminders (next N days)
   */
  getUpcoming: (days?: number): Promise<ReminderListResponse> => {
    return invoke<ReminderListResponse>(
      'reminders_get_upcoming',
      days === undefined ? undefined : { args: [days] }
    )
  },

  /**
   * Get due reminders (ready to be shown)
   */
  getDue: (): Promise<ReminderWithTarget[]> => {
    return invoke<ReminderWithTarget[]>('reminders_get_due')
  },

  /**
   * Get reminders for a specific target
   */
  getForTarget: (targetType: ReminderTargetType, targetId: string): Promise<Reminder[]> => {
    return invoke<Reminder[]>('reminders_get_for_target', { targetType, targetId })
  },

  /**
   * Count pending reminders (for badge display)
   */
  countPending: (): Promise<number> => {
    return invoke<number>('reminders_count_pending')
  },

  /**
   * Dismiss a reminder
   */
  dismiss: (id: string): Promise<ReminderDismissResponse> => {
    return invoke<ReminderDismissResponse>('reminders_dismiss', { args: [id] })
  },

  /**
   * Snooze a reminder to a later time
   */
  snooze: (input: SnoozeReminderInput): Promise<ReminderSnoozeResponse> => {
    return invoke<ReminderSnoozeResponse>(
      'reminders_snooze',
      input as unknown as Record<string, unknown>
    )
  },

  /**
   * Bulk dismiss multiple reminders
   */
  bulkDismiss: (reminderIds: string[]): Promise<BulkDismissResponse> => {
    return invoke<BulkDismissResponse>('reminders_bulk_dismiss', { reminderIds })
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a note reminder
 */
export async function createNoteReminder(
  noteId: string,
  remindAt: string,
  options?: { title?: string; note?: string }
): Promise<ReminderCreateResponse> {
  return reminderService.create({
    targetType: 'note',
    targetId: noteId,
    remindAt,
    title: options?.title,
    note: options?.note
  })
}

/**
 * Create a journal reminder
 */
export async function createJournalReminder(
  journalDate: string,
  remindAt: string,
  options?: { title?: string; note?: string }
): Promise<ReminderCreateResponse> {
  return reminderService.create({
    targetType: 'journal',
    targetId: journalDate,
    remindAt,
    title: options?.title,
    note: options?.note
  })
}

/**
 * Create a highlight reminder
 */
export async function createHighlightReminder(
  noteId: string,
  highlightText: string,
  highlightStart: number,
  highlightEnd: number,
  remindAt: string,
  options?: { title?: string; note?: string }
): Promise<ReminderCreateResponse> {
  return reminderService.create({
    targetType: 'highlight',
    targetId: noteId,
    remindAt,
    highlightText,
    highlightStart,
    highlightEnd,
    title: options?.title,
    note: options?.note
  })
}

// ============================================================================
// Event Subscriptions
// ============================================================================

/**
 * Subscribe to reminder created events
 */
export function onReminderCreated(callback: (event: ReminderCreatedEvent) => void): () => void {
  return subscribeEvent<ReminderCreatedEvent>('reminder-created', callback)
}

/**
 * Subscribe to reminder updated events
 */
export function onReminderUpdated(callback: (event: ReminderUpdatedEvent) => void): () => void {
  return subscribeEvent<ReminderUpdatedEvent>('reminder-updated', callback)
}

/**
 * Subscribe to reminder deleted events
 */
export function onReminderDeleted(callback: (event: ReminderDeletedEvent) => void): () => void {
  return subscribeEvent<ReminderDeletedEvent>('reminder-deleted', callback)
}

/**
 * Subscribe to reminder due events (reminder is ready to show)
 */
export function onReminderDue(callback: (event: ReminderDueEvent) => void): () => void {
  return subscribeEvent<ReminderDueEvent>('reminder-due', callback)
}

/**
 * Subscribe to reminder dismissed events
 */
export function onReminderDismissed(callback: (event: ReminderDismissedEvent) => void): () => void {
  return subscribeEvent<ReminderDismissedEvent>('reminder-dismissed', callback)
}

/**
 * Subscribe to reminder snoozed events
 */
export function onReminderSnoozed(callback: (event: ReminderSnoozedEvent) => void): () => void {
  return subscribeEvent<ReminderSnoozedEvent>('reminder-snoozed', callback)
}
