/**
 * Reminders IPC API Contract
 *
 * Defines the API for the reminder system which supports reminders
 * for notes, journal entries, and highlighted text.
 *
 * @module contracts/reminders-api
 */

import { z } from 'zod'

// Import and re-export channels from the contract-local surface.
import { ReminderChannels } from './ipc-channels'
export { ReminderChannels }

// Re-export canonical reminder types.
import {
  reminderTargetType,
  reminderStatus,
  type ReminderTargetType,
  type ReminderStatus
} from './reminder-types'
export { reminderTargetType, reminderStatus, type ReminderTargetType, type ReminderStatus }

// ============================================================================
// Zod Schemas
// ============================================================================

export const ReminderTargetTypeSchema = z.enum(['note', 'journal', 'highlight'])
export const ReminderStatusSchema = z.enum(['pending', 'triggered', 'dismissed', 'snoozed'])

/**
 * Schema for creating a reminder for a note
 */
export const CreateNoteReminderSchema = z.object({
  noteId: z.string().min(1),
  remindAt: z.string().datetime(),
  title: z.string().max(200).optional(),
  note: z.string().max(1000).optional()
})

/**
 * Schema for creating a reminder for a journal entry
 */
export const CreateJournalReminderSchema = z.object({
  journalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  remindAt: z.string().datetime(),
  title: z.string().max(200).optional(),
  note: z.string().max(1000).optional()
})

/**
 * Schema for creating a reminder for highlighted text
 */
export const CreateHighlightReminderSchema = z
  .object({
    noteId: z.string().min(1),
    highlightText: z.string().min(1).max(5000),
    highlightStart: z.number().int().min(0),
    highlightEnd: z.number().int().min(0),
    remindAt: z.string().datetime(),
    title: z.string().max(200).optional(),
    note: z.string().max(1000).optional()
  })
  .refine((data) => data.highlightEnd > data.highlightStart, {
    message: 'highlightEnd must be greater than highlightStart'
  })

/**
 * Generic create schema that accepts all reminder types
 */
export const CreateReminderSchema = z.discriminatedUnion('targetType', [
  z.object({
    targetType: z.literal('note'),
    targetId: z.string().min(1),
    remindAt: z.string().datetime(),
    title: z.string().max(200).optional(),
    note: z.string().max(1000).optional()
  }),
  z.object({
    targetType: z.literal('journal'),
    targetId: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    remindAt: z.string().datetime(),
    title: z.string().max(200).optional(),
    note: z.string().max(1000).optional()
  }),
  z.object({
    targetType: z.literal('highlight'),
    targetId: z.string().min(1), // Parent note ID
    highlightText: z.string().min(1).max(5000),
    highlightStart: z.number().int().min(0),
    highlightEnd: z.number().int().min(0),
    remindAt: z.string().datetime(),
    title: z.string().max(200).optional(),
    note: z.string().max(1000).optional()
  })
])

/**
 * Schema for updating a reminder
 */
export const UpdateReminderSchema = z.object({
  id: z.string().min(1),
  remindAt: z.string().datetime().optional(),
  title: z.string().max(200).optional().nullable(),
  note: z.string().max(1000).optional().nullable()
})

/**
 * Schema for snoozing a reminder
 */
export const SnoozeReminderSchema = z.object({
  id: z.string().min(1),
  snoozeUntil: z.string().datetime()
})

/**
 * Schema for listing reminders with filters
 */
export const ListRemindersSchema = z.object({
  targetType: ReminderTargetTypeSchema.optional(),
  targetId: z.string().optional(),
  status: z.union([ReminderStatusSchema, z.array(ReminderStatusSchema)]).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})

/**
 * Schema for getting reminders for a specific target
 */
export const GetForTargetSchema = z.object({
  targetType: ReminderTargetTypeSchema,
  targetId: z.string().min(1)
})

/**
 * Schema for bulk dismiss
 */
export const BulkDismissSchema = z.object({
  reminderIds: z.array(z.string().min(1)).min(1)
})

// ============================================================================
// TypeScript Types
// ============================================================================

export type CreateNoteReminderInput = z.infer<typeof CreateNoteReminderSchema>
export type CreateJournalReminderInput = z.infer<typeof CreateJournalReminderSchema>
export type CreateHighlightReminderInput = z.infer<typeof CreateHighlightReminderSchema>
export type CreateReminderInput = z.infer<typeof CreateReminderSchema>
export type UpdateReminderInput = z.infer<typeof UpdateReminderSchema>
export type SnoozeReminderInput = z.infer<typeof SnoozeReminderSchema>
export type ListRemindersInput = z.infer<typeof ListRemindersSchema>
export type GetForTargetInput = z.infer<typeof GetForTargetSchema>
export type BulkDismissInput = z.infer<typeof BulkDismissSchema>

// ============================================================================
// Response Types
// ============================================================================

/**
 * Full reminder record
 */
export interface Reminder {
  id: string
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
  highlightText: string | null
  highlightStart: number | null
  highlightEnd: number | null
  title: string | null
  note: string | null
  status: ReminderStatus
  triggeredAt: string | null
  dismissedAt: string | null
  snoozedUntil: string | null
  createdAt: string
  modifiedAt: string
}

/**
 * Reminder with resolved target information
 */
export interface ReminderWithTarget extends Reminder {
  /** Title of the target (note title, journal date, or parent note title) */
  targetTitle: string | null
  /** Whether the target still exists */
  targetExists: boolean
  /** For highlights: whether the text still exists in the note */
  highlightExists?: boolean
}

export interface ReminderCreateResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderUpdateResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderDeleteResponse {
  success: boolean
  error?: string
}

export interface ReminderDismissResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderSnoozeResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderListResponse {
  reminders: ReminderWithTarget[]
  total: number
  hasMore: boolean
}

export interface BulkDismissResponse {
  success: boolean
  dismissedCount: number
  error?: string
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface ReminderCreatedEvent {
  reminder: Reminder
}

export interface ReminderUpdatedEvent {
  reminder: Reminder
}

export interface ReminderDeletedEvent {
  id: string
  targetType: ReminderTargetType
  targetId: string
}

export interface ReminderDueEvent {
  reminders: ReminderWithTarget[]
  count: number
}

export interface ReminderDismissedEvent {
  reminder: Reminder
}

export interface ReminderSnoozedEvent {
  reminder: Reminder
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Reminders service client interface for renderer process
 *
 * @example
 * ```typescript
 * const reminders = window.api.reminders;
 *
 * // Create a reminder for a note
 * const result = await reminders.create({
 *   targetType: 'note',
 *   targetId: 'note_abc123',
 *   remindAt: '2025-01-15T09:00:00Z',
 *   title: 'Review this note'
 * });
 *
 * // Create a reminder for highlighted text
 * const highlightResult = await reminders.create({
 *   targetType: 'highlight',
 *   targetId: 'note_abc123', // parent note
 *   highlightText: 'Important passage to remember',
 *   highlightStart: 100,
 *   highlightEnd: 130,
 *   remindAt: '2025-01-15T09:00:00Z'
 * });
 *
 * // Get upcoming reminders
 * const upcoming = await reminders.getUpcoming(7); // next 7 days
 *
 * // Snooze a reminder
 * await reminders.snooze({
 *   id: 'rem_abc123',
 *   snoozeUntil: '2025-01-16T09:00:00Z'
 * });
 *
 * // Listen for due reminders
 * window.api.onReminderDue((event) => {
 *   console.log('Due reminders:', event.reminders);
 *   // Show notification
 * });
 * ```
 */
export interface RemindersClientAPI {
  /** Create a new reminder */
  create(input: CreateReminderInput): Promise<ReminderCreateResponse>

  /** Update an existing reminder */
  update(input: UpdateReminderInput): Promise<ReminderUpdateResponse>

  /** Delete a reminder */
  delete(id: string): Promise<ReminderDeleteResponse>

  /** Get a reminder by ID */
  get(id: string): Promise<ReminderWithTarget | null>

  /** List reminders with optional filters */
  list(options?: ListRemindersInput): Promise<ReminderListResponse>

  /** Get upcoming reminders (next N days) */
  getUpcoming(days?: number): Promise<ReminderListResponse>

  /** Get due reminders (remindAt <= now and status = pending) */
  getDue(): Promise<ReminderWithTarget[]>

  /** Get reminders for a specific target */
  getForTarget(input: GetForTargetInput): Promise<Reminder[]>

  /** Dismiss a reminder */
  dismiss(id: string): Promise<ReminderDismissResponse>

  /** Snooze a reminder to a later time */
  snooze(input: SnoozeReminderInput): Promise<ReminderSnoozeResponse>

  /** Bulk dismiss multiple reminders */
  bulkDismiss(reminderIds: string[]): Promise<BulkDismissResponse>
}
