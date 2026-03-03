/**
 * Reminder Service
 *
 * Thin wrapper around window.api.reminders for the renderer process.
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
} from '../../../preload/index.d'

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
    return window.api.reminders.create(input)
  },

  /**
   * Update an existing reminder
   */
  update: (input: UpdateReminderInput): Promise<ReminderUpdateResponse> => {
    return window.api.reminders.update(input)
  },

  /**
   * Delete a reminder
   */
  delete: (id: string): Promise<ReminderDeleteResponse> => {
    return window.api.reminders.delete(id)
  },

  /**
   * Get a reminder by ID
   */
  get: (id: string): Promise<ReminderWithTarget | null> => {
    return window.api.reminders.get(id)
  },

  /**
   * List reminders with optional filters
   */
  list: (options?: ListRemindersInput): Promise<ReminderListResponse> => {
    return window.api.reminders.list(options)
  },

  /**
   * Get upcoming reminders (next N days)
   */
  getUpcoming: (days?: number): Promise<ReminderListResponse> => {
    return window.api.reminders.getUpcoming(days)
  },

  /**
   * Get due reminders (ready to be shown)
   */
  getDue: (): Promise<ReminderWithTarget[]> => {
    return window.api.reminders.getDue()
  },

  /**
   * Get reminders for a specific target
   */
  getForTarget: (targetType: ReminderTargetType, targetId: string): Promise<Reminder[]> => {
    return window.api.reminders.getForTarget({ targetType, targetId })
  },

  /**
   * Count pending reminders (for badge display)
   */
  countPending: (): Promise<number> => {
    return window.api.reminders.countPending()
  },

  /**
   * Dismiss a reminder
   */
  dismiss: (id: string): Promise<ReminderDismissResponse> => {
    return window.api.reminders.dismiss(id)
  },

  /**
   * Snooze a reminder to a later time
   */
  snooze: (input: SnoozeReminderInput): Promise<ReminderSnoozeResponse> => {
    return window.api.reminders.snooze(input)
  },

  /**
   * Bulk dismiss multiple reminders
   */
  bulkDismiss: (reminderIds: string[]): Promise<BulkDismissResponse> => {
    return window.api.reminders.bulkDismiss({ reminderIds })
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
  return window.api.onReminderCreated(callback)
}

/**
 * Subscribe to reminder updated events
 */
export function onReminderUpdated(callback: (event: ReminderUpdatedEvent) => void): () => void {
  return window.api.onReminderUpdated(callback)
}

/**
 * Subscribe to reminder deleted events
 */
export function onReminderDeleted(callback: (event: ReminderDeletedEvent) => void): () => void {
  return window.api.onReminderDeleted(callback)
}

/**
 * Subscribe to reminder due events (reminder is ready to show)
 */
export function onReminderDue(callback: (event: ReminderDueEvent) => void): () => void {
  return window.api.onReminderDue(callback)
}

/**
 * Subscribe to reminder dismissed events
 */
export function onReminderDismissed(callback: (event: ReminderDismissedEvent) => void): () => void {
  return window.api.onReminderDismissed(callback)
}

/**
 * Subscribe to reminder snoozed events
 */
export function onReminderSnoozed(callback: (event: ReminderSnoozedEvent) => void): () => void {
  return window.api.onReminderSnoozed(callback)
}
