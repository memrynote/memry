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
    createdAt: text('created_at').notNull(),
    modifiedAt: text('modified_at').notNull(),
    indexedAt: text('indexed_at').notNull().default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_note_cache_path').on(table.path),
    index('idx_note_cache_modified').on(table.modifiedAt)
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
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
})

// ============================================================================
// Type Exports
// ============================================================================

export type NoteCache = typeof noteCache.$inferSelect
export type NewNoteCache = typeof noteCache.$inferInsert
export type NoteTag = typeof noteTags.$inferSelect
export type NewNoteTag = typeof noteTags.$inferInsert
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
