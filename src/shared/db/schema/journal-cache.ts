/**
 * Journal Cache Schema
 *
 * SQLite cache tables for journal entries. This cache is rebuildable
 * from the markdown files in vault/journal/.
 *
 * @module shared/db/schema/journal-cache
 */

import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ============================================================================
// Journal Cache Table
// ============================================================================

/**
 * Cached metadata for journal entries.
 * Source of truth is the markdown file at vault/journal/YYYY-MM-DD.md
 */
export const journalCache = sqliteTable(
  'journal_cache',
  {
    // Unique identifier: j{YYYY-MM-DD}
    id: text('id').primaryKey(),

    // Date in YYYY-MM-DD format for queries
    date: text('date').notNull().unique(),

    // Relative path from vault root (e.g., "journal/2025-12-25.md")
    path: text('path').notNull(),

    // Content statistics
    wordCount: integer('word_count').notNull().default(0),
    characterCount: integer('character_count').notNull().default(0),

    // Computed activity level (0-4) for heatmap
    // 0 = empty, 1 = 1-100 chars, 2 = 101-500, 3 = 501-1000, 4 = 1001+
    activityLevel: integer('activity_level').notNull().default(0),

    // Timestamps
    createdAt: text('created_at').notNull(),
    modifiedAt: text('modified_at').notNull(),
    indexedAt: text('indexed_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    // Fast date-based queries (calendar, navigation)
    index('idx_journal_date').on(table.date),
    // Fast activity queries (heatmap filtering)
    index('idx_journal_activity').on(table.activityLevel),
    // Fast modified queries (recent entries)
    index('idx_journal_modified').on(table.modifiedAt)
  ]
)

// ============================================================================
// Journal Tags Table
// ============================================================================

/**
 * Many-to-many relationship for journal entry tags.
 */
export const journalTags = sqliteTable(
  'journal_tags',
  {
    entryId: text('entry_id')
      .notNull()
      .references(() => journalCache.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.tag] }),
    index('idx_journal_tags_tag').on(table.tag),
    index('idx_journal_tags_entry').on(table.entryId)
  ]
)

// ============================================================================
// Type Exports
// ============================================================================

export type JournalCache = typeof journalCache.$inferSelect
export type InsertJournalCache = typeof journalCache.$inferInsert
export type JournalTag = typeof journalTags.$inferSelect
export type InsertJournalTag = typeof journalTags.$inferInsert
