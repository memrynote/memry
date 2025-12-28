/**
 * Inbox Database Schema
 *
 * Defines the database schema for the inbox capture system.
 * Includes inbox items, tags, filing history, and statistics.
 *
 * @module shared/db/schema/inbox
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ============================================================================
// Type Constants
// ============================================================================

/**
 * Inbox item types
 */
export const inboxItemType = {
  LINK: 'link',
  NOTE: 'note',
  IMAGE: 'image',
  VOICE: 'voice',
  CLIP: 'clip',
  PDF: 'pdf',
  SOCIAL: 'social'
} as const

export type InboxItemType = (typeof inboxItemType)[keyof typeof inboxItemType]

/**
 * Processing status for async operations
 */
export const processingStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed'
} as const

export type ProcessingStatus = (typeof processingStatus)[keyof typeof processingStatus]

/**
 * Filing action types
 */
export const filingAction = {
  FOLDER: 'folder',
  NOTE: 'note',
  LINKED: 'linked'
} as const

export type FilingAction = (typeof filingAction)[keyof typeof filingAction]

// ============================================================================
// inbox_items Table
// ============================================================================

/**
 * Main inbox items table.
 * Stores all captured content (links, notes, images, voice, clips, PDFs, social posts).
 */
export const inboxItems = sqliteTable(
  'inbox_items',
  {
    /** Unique identifier (e.g., inbox_lnk_abc123) */
    id: text('id').primaryKey(),

    /** Item type: link, note, image, voice, clip, pdf, social */
    type: text('type').notNull(),

    /** Display title (auto-generated or user-provided) */
    title: text('title').notNull(),

    /** Text content or excerpt */
    content: text('content'),

    /** Creation timestamp */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),

    /** Last modification timestamp */
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(datetime('now'))`),

    // ========================================================================
    // Filing Status
    // ========================================================================

    /** When the item was filed */
    filedAt: text('filed_at'),

    /** Where the item was filed (noteId or folder path) */
    filedTo: text('filed_to'),

    /** How the item was filed: folder, note, linked */
    filedAction: text('filed_action'),

    // ========================================================================
    // Snooze Status
    // ========================================================================

    /** When the snooze expires (ISO datetime) */
    snoozedUntil: text('snoozed_until'),

    /** User-provided reason for snoozing */
    snoozeReason: text('snooze_reason'),

    // ========================================================================
    // Processing Status
    // ========================================================================

    /** Current processing status: pending, processing, complete, failed */
    processingStatus: text('processing_status').default('complete'),

    /** Error message if processing failed */
    processingError: text('processing_error'),

    // ========================================================================
    // Type-Specific Metadata
    // ========================================================================

    /** JSON metadata specific to item type */
    metadata: text('metadata', { mode: 'json' }),

    // ========================================================================
    // Attachments
    // ========================================================================

    /** Relative path to attachment folder (e.g., attachments/inbox/{itemId}) */
    attachmentPath: text('attachment_path'),

    /** Relative path to thumbnail image */
    thumbnailPath: text('thumbnail_path'),

    // ========================================================================
    // Transcription (Voice Items)
    // ========================================================================

    /** Transcription text (for voice items) */
    transcription: text('transcription'),

    /** Transcription processing status */
    transcriptionStatus: text('transcription_status'),

    // ========================================================================
    // Source Information
    // ========================================================================

    /** Original URL for links, clips, social posts */
    sourceUrl: text('source_url'),

    /** Original page title for clips */
    sourceTitle: text('source_title')
  },
  (table) => [
    index('idx_inbox_items_type').on(table.type),
    index('idx_inbox_items_created').on(table.createdAt),
    index('idx_inbox_items_filed').on(table.filedAt),
    index('idx_inbox_items_snoozed').on(table.snoozedUntil),
    index('idx_inbox_items_processing').on(table.processingStatus)
  ]
)

export type InboxItem = typeof inboxItems.$inferSelect
export type NewInboxItem = typeof inboxItems.$inferInsert

// ============================================================================
// inbox_item_tags Table
// ============================================================================

/**
 * Tags associated with inbox items.
 * Allows organizing items with tags before filing.
 */
export const inboxItemTags = sqliteTable(
  'inbox_item_tags',
  {
    /** Unique identifier */
    id: text('id').primaryKey(),

    /** Reference to inbox item */
    itemId: text('item_id')
      .notNull()
      .references(() => inboxItems.id, { onDelete: 'cascade' }),

    /** Tag name */
    tag: text('tag').notNull(),

    /** When the tag was added */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_inbox_tags_item').on(table.itemId),
    index('idx_inbox_tags_tag').on(table.tag)
  ]
)

export type InboxItemTag = typeof inboxItemTags.$inferSelect
export type NewInboxItemTag = typeof inboxItemTags.$inferInsert

// ============================================================================
// filing_history Table
// ============================================================================

/**
 * History of filed items for suggestion learning.
 * Tracks where items were filed to improve future suggestions.
 */
export const filingHistory = sqliteTable(
  'filing_history',
  {
    /** Unique identifier */
    id: text('id').primaryKey(),

    /** Type of item that was filed */
    itemType: text('item_type').notNull(),

    /** First 500 chars of content for matching */
    itemContent: text('item_content'),

    /** Where the item was filed */
    filedTo: text('filed_to').notNull(),

    /** How the item was filed: folder, note, linked */
    filedAction: text('filed_action').notNull(),

    /** Tags that were applied (JSON array) */
    tags: text('tags', { mode: 'json' }),

    /** When the item was filed */
    filedAt: text('filed_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_filing_history_type').on(table.itemType),
    index('idx_filing_history_filed_at').on(table.filedAt)
  ]
)

export type FilingHistory = typeof filingHistory.$inferSelect
export type NewFilingHistory = typeof filingHistory.$inferInsert

// ============================================================================
// inbox_stats Table
// ============================================================================

/**
 * Daily capture and processing statistics.
 * Aggregates for the stats dashboard and patterns view.
 */
export const inboxStats = sqliteTable(
  'inbox_stats',
  {
    /** Unique identifier */
    id: text('id').primaryKey(),

    /** Date in YYYY-MM-DD format */
    date: text('date').notNull().unique(),

    /** Count of captured links */
    captureCountLink: integer('capture_count_link').default(0),

    /** Count of captured notes */
    captureCountNote: integer('capture_count_note').default(0),

    /** Count of captured images */
    captureCountImage: integer('capture_count_image').default(0),

    /** Count of captured voice memos */
    captureCountVoice: integer('capture_count_voice').default(0),

    /** Count of captured web clips */
    captureCountClip: integer('capture_count_clip').default(0),

    /** Count of captured PDFs */
    captureCountPdf: integer('capture_count_pdf').default(0),

    /** Count of captured social posts */
    captureCountSocial: integer('capture_count_social').default(0),

    /** Count of items processed (filed) */
    processedCount: integer('processed_count').default(0),

    /** Count of items deleted */
    deletedCount: integer('deleted_count').default(0)
  },
  (table) => [index('idx_inbox_stats_date').on(table.date)]
)

export type InboxStats = typeof inboxStats.$inferSelect
export type NewInboxStats = typeof inboxStats.$inferInsert
