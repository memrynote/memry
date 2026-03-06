/**
 * Reminders Database Schema
 *
 * Defines the database schema for the reminder system.
 * Supports reminders for notes, journal entries, and highlighted text.
 *
 * @module shared/db/schema/reminders
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
export {
  reminderTargetType,
  reminderStatus,
  type ReminderTargetType,
  type ReminderStatus
} from '@memry/contracts/reminder-types'

// ============================================================================
// reminders Table
// ============================================================================

/**
 * Main reminders table.
 * Stores reminders for notes, journal entries, and highlighted text.
 *
 * Key concepts:
 * - targetType: What kind of content the reminder is for (note, journal, highlight)
 * - targetId: The ID of the target (noteId, journal date, or parent noteId for highlights)
 * - For highlights: stores the text and character offsets for positioning
 */
export const reminders = sqliteTable(
  'reminders',
  {
    /** Unique identifier (e.g., rem_abc123) */
    id: text('id').primaryKey(),

    /** Target type: note, journal, or highlight */
    targetType: text('target_type').notNull(),

    /** ID of the target (noteId, journal date YYYY-MM-DD, or parent noteId for highlights) */
    targetId: text('target_id').notNull(),

    // ========================================================================
    // Reminder Timing
    // ========================================================================

    /** When to trigger the reminder (ISO datetime) */
    remindAt: text('remind_at').notNull(),

    // ========================================================================
    // Highlight Context (only for 'highlight' type)
    // ========================================================================

    /** The highlighted text (for display in notification) */
    highlightText: text('highlight_text'),

    /** Character offset where highlight starts */
    highlightStart: integer('highlight_start'),

    /** Character offset where highlight ends */
    highlightEnd: integer('highlight_end'),

    // ========================================================================
    // Reminder Metadata
    // ========================================================================

    /** Custom reminder title (optional) */
    title: text('title'),

    /** User note about why they set the reminder */
    note: text('note'),

    // ========================================================================
    // Status Tracking
    // ========================================================================

    /** Current status: pending, triggered, dismissed, snoozed */
    status: text('status').notNull().default('pending'),

    /** When the reminder was shown to the user */
    triggeredAt: text('triggered_at'),

    /** When the user dismissed the reminder */
    dismissedAt: text('dismissed_at'),

    /** If snoozed, when to remind again (ISO datetime) */
    snoozedUntil: text('snoozed_until'),

    // ========================================================================
    // Timestamps
    // ========================================================================

    /** When the reminder was created */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),

    /** When the reminder was last modified */
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    /** Index for finding reminders by target */
    index('idx_reminders_target').on(table.targetType, table.targetId),
    /** Index for finding due reminders */
    index('idx_reminders_remind_at').on(table.remindAt),
    /** Index for filtering by status */
    index('idx_reminders_status').on(table.status)
  ]
)

export type Reminder = typeof reminders.$inferSelect
export type NewReminder = typeof reminders.$inferInsert
