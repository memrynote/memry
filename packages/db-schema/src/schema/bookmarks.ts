/**
 * Bookmarks Schema
 *
 * A simple, flat bookmarking system that works with any item type.
 * Stored in data.db (source of truth, not rebuildable).
 *
 * Design:
 * - Polymorphic: item_type + item_id can reference any content type
 * - Flat: No collections/folders, just a simple list
 * - Extensible: New item types can be added without schema changes
 *
 * @module db/schema/bookmarks
 */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
export { BookmarkItemTypes, type BookmarkItemType } from '@memry/contracts/bookmark-types'

// ============================================================================
// Bookmarks Table
// ============================================================================

export const bookmarks = sqliteTable(
  'bookmarks',
  {
    /** Unique identifier (nanoid) */
    id: text('id').primaryKey(),

    /**
     * Type of the bookmarked item.
     * Uses polymorphic pattern for extensibility.
     */
    itemType: text('item_type').notNull(),

    /**
     * ID of the bookmarked item.
     * References vary by item_type:
     * - note/journal: noteCache.id
     * - task: tasks.id
     * - image/pdf/audio/file: attachment path or future table id
     */
    itemId: text('item_id').notNull(),

    /**
     * Position for manual ordering.
     * Lower values appear first.
     */
    position: integer('position').notNull().default(0),

    /** When the bookmark was created */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    // Prevent duplicate bookmarks of the same item
    uniqueIndex('idx_bookmarks_unique_item').on(table.itemType, table.itemId),
    // Fast filtering by item type
    index('idx_bookmarks_item_type').on(table.itemType),
    // Fast ordering queries
    index('idx_bookmarks_position').on(table.position),
    // Fast lookups by creation time
    index('idx_bookmarks_created').on(table.createdAt)
  ]
)

// ============================================================================
// Type Exports
// ============================================================================

export type Bookmark = typeof bookmarks.$inferSelect
export type NewBookmark = typeof bookmarks.$inferInsert
