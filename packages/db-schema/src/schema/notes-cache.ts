import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { FileType } from '@memry/shared/file-types'
import type { VectorClock } from '@memry/contracts/sync-api'
export { PropertyTypes, type PropertyType } from '@memry/contracts/property-types'

export const noteCache = sqliteTable(
  'note_cache',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    title: text('title').notNull(),
    // File type discriminator: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
    fileType: text('file_type').$type<FileType>().notNull().default('markdown'),
    // MIME type for the file (e.g., 'application/pdf', 'image/png')
    mimeType: text('mime_type'),
    // File size in bytes
    fileSize: integer('file_size'),
    // Attachment ID for synced binary files (links to R2 blob)
    attachmentId: text('attachment_id'),
    emoji: text('emoji'), // T003: Emoji icon for visual identification (markdown only)
    localOnly: integer('local_only', { mode: 'boolean' }).default(false),
    // Content hash for change detection (markdown only - nullable for other types)
    contentHash: text('content_hash'),
    // Word count (markdown only - nullable for other types)
    wordCount: integer('word_count'),
    // Unified: characterCount for activity level calculation (markdown only)
    characterCount: integer('character_count'),
    // Cached snippet for list views (markdown only - first ~150 chars)
    snippet: text('snippet'),
    // Unified: date field for journal entries (YYYY-MM-DD), null for regular notes
    date: text('date'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at').notNull(),
    modifiedAt: text('modified_at').notNull(),
    indexedAt: text('indexed_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_note_cache_path').on(table.path),
    index('idx_note_cache_modified').on(table.modifiedAt),
    // Index for journal date-based queries (heatmap, calendar)
    index('idx_note_cache_date').on(table.date),
    // Index for filtering by file type
    index('idx_note_cache_file_type').on(table.fileType)
  ]
)

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    position: integer('position').notNull().default(0),
    // When the note was pinned to this tag (null = not pinned)
    pinnedAt: text('pinned_at')
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.tag] }),
    index('idx_note_tags_tag').on(table.tag),
    index('idx_note_tags_pinned').on(table.pinnedAt)
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
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
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
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
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
  SIGNIFICANT: 'significant', // Significant content change detected
  CLOSE: 'close' // Tab/window/app close — bypass word threshold
} as const

export type SnapshotReason = (typeof SnapshotReasons)[keyof typeof SnapshotReasons]
