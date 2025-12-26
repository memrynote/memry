import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const noteCache = sqliteTable(
  'note_cache',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    title: text('title').notNull(),
    emoji: text('emoji'), // T003: Emoji icon for visual identification
    contentHash: text('content_hash').notNull(),
    wordCount: integer('word_count').notNull().default(0),
    // Unified: characterCount for activity level calculation (journal + notes)
    characterCount: integer('character_count').notNull().default(0),
    // Unified: date field for journal entries (YYYY-MM-DD), null for regular notes
    date: text('date'),
    createdAt: text('created_at').notNull(),
    modifiedAt: text('modified_at').notNull(),
    indexedAt: text('indexed_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_note_cache_path').on(table.path),
    index('idx_note_cache_modified').on(table.modifiedAt),
    // Index for journal date-based queries (heatmap, calendar)
    index('idx_note_cache_date').on(table.date)
  ]
)

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.tag] }),
    index('idx_note_tags_tag').on(table.tag)
  ]
)

// ============================================================================
// Tag Definitions Table (vault-wide tag registry with persistent colors)
// ============================================================================

export const tagDefinitions = sqliteTable('tag_definitions', {
  name: text('name').primaryKey(),
  color: text('color').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

export const noteLinks = sqliteTable(
  'note_links',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    targetId: text('target_id'),
    targetTitle: text('target_title').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.targetTitle] }),
    index('idx_note_links_target').on(table.targetId)
  ]
)

// ============================================================================
// T004: Note Properties Table (rebuildable cache from frontmatter)
// ============================================================================

export const noteProperties = sqliteTable(
  'note_properties',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'), // JSON-encoded for arrays and complex types
    type: text('type').notNull() // PropertyType enum
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.name] }),
    index('idx_note_properties_name').on(table.name),
    index('idx_note_properties_value').on(table.value)
  ]
)

// ============================================================================
// T005: Property Definitions Table (vault-wide schema, NOT rebuildable)
// ============================================================================

export const propertyDefinitions = sqliteTable('property_definitions', {
  name: text('name').primaryKey(),
  type: text('type').notNull(), // PropertyType enum
  options: text('options'), // JSON array for select/multiselect
  defaultValue: text('default_value'),
  color: text('color'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`)
})

// ============================================================================
// Type Exports
// ============================================================================

export type NoteCache = typeof noteCache.$inferSelect
export type NewNoteCache = typeof noteCache.$inferInsert
export type NoteTag = typeof noteTags.$inferSelect
export type NewNoteTag = typeof noteTags.$inferInsert
export type TagDefinition = typeof tagDefinitions.$inferSelect
export type NewTagDefinition = typeof tagDefinitions.$inferInsert
export type NoteLink = typeof noteLinks.$inferSelect
export type NewNoteLink = typeof noteLinks.$inferInsert
export type NoteProperty = typeof noteProperties.$inferSelect
export type NewNoteProperty = typeof noteProperties.$inferInsert
export type PropertyDefinition = typeof propertyDefinitions.$inferSelect
export type NewPropertyDefinition = typeof propertyDefinitions.$inferInsert

// ============================================================================
// Property Type Constants
// ============================================================================

export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  URL: 'url',
  RATING: 'rating'
} as const

export type PropertyType = (typeof PropertyTypes)[keyof typeof PropertyTypes]

// ============================================================================
// T110: Note Snapshots Table (version history)
// ============================================================================

export const noteSnapshots = sqliteTable(
  'note_snapshots',
  {
    id: text('id').primaryKey(), // nanoid(12) snapshot ID
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    // Column is 'content' in DB but stores full file content (frontmatter + markdown body)
    fileContent: text('content').notNull(),
    title: text('title').notNull(), // Title at snapshot time (for display)
    wordCount: integer('word_count').notNull().default(0),
    contentHash: text('content_hash').notNull(), // For deduplication
    reason: text('reason').notNull(), // 'auto' | 'significant'
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_note_snapshots_note_id').on(table.noteId),
    index('idx_note_snapshots_created').on(table.createdAt)
  ]
)

export type NoteSnapshot = typeof noteSnapshots.$inferSelect
export type NewNoteSnapshot = typeof noteSnapshots.$inferInsert

// Snapshot reason constants
export const SnapshotReasons = {
  MANUAL: 'manual', // User explicitly saved a version
  AUTO: 'auto', // Auto-save triggered snapshot
  TIMER: 'timer', // Periodic timer (e.g., every 5 minutes of editing)
  SIGNIFICANT: 'significant' // Significant content change detected
} as const

export type SnapshotReason = (typeof SnapshotReasons)[keyof typeof SnapshotReasons]
