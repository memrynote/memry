/**
 * Note cache query functions for Drizzle ORM.
 * These queries operate on index.db (rebuildable cache).
 *
 * @module db/queries/notes
 */

import { eq, desc, asc, and, like, inArray, sql, count, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  noteCache,
  noteTags,
  noteLinks,
  type NoteCache,
  type NewNoteCache,
  type NewNoteTag,
  type NoteLink,
  type NewNoteLink
} from '../schema/notes-cache'
import * as schema from '../schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Note Cache CRUD
// ============================================================================

/**
 * Insert a new note into the cache.
 */
export function insertNoteCache(db: DrizzleDb, note: NewNoteCache): NoteCache {
  return db.insert(noteCache).values(note).returning().get()
}

/**
 * Update an existing note in the cache.
 */
export function updateNoteCache(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<NoteCache, 'id'>>
): NoteCache | undefined {
  return db
    .update(noteCache)
    .set({
      ...updates,
      indexedAt: new Date().toISOString()
    })
    .where(eq(noteCache.id, id))
    .returning()
    .get()
}

/**
 * Delete a note from the cache.
 */
export function deleteNoteCache(db: DrizzleDb, id: string): void {
  db.delete(noteCache).where(eq(noteCache.id, id)).run()
}

/**
 * Get a note from cache by ID.
 */
export function getNoteCacheById(db: DrizzleDb, id: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.id, id)).get()
}

/**
 * Get a note from cache by path.
 */
export function getNoteCacheByPath(db: DrizzleDb, path: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.path, path)).get()
}

/**
 * Check if a note exists in cache by ID.
 */
export function noteCacheExists(db: DrizzleDb, id: string): boolean {
  const result = db
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(eq(noteCache.id, id))
    .get()
  return result !== undefined
}

/**
 * Check if a note exists with a given path but different ID (duplicate detection).
 */
export function findDuplicateId(
  db: DrizzleDb,
  id: string,
  excludePath: string
): NoteCache | undefined {
  return db
    .select()
    .from(noteCache)
    .where(and(eq(noteCache.id, id), sql`${noteCache.path} != ${excludePath}`))
    .get()
}

// ============================================================================
// Note Listing
// ============================================================================

export interface ListNotesOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * List notes from cache with filtering and sorting.
 */
export function listNotesFromCache(
  db: DrizzleDb,
  options: ListNotesOptions = {}
): NoteCache[] {
  const {
    folder,
    tags,
    sortBy = 'modified',
    sortOrder = 'desc',
    limit = 100,
    offset = 0
  } = options

  // Build conditions
  const conditions: SQL<unknown>[] = []

  if (folder) {
    // Match notes in folder (path starts with folder/)
    conditions.push(like(noteCache.path, `${folder}/%`))
  }

  // Get note IDs that have all specified tags
  let noteIdsWithTags: string[] | undefined
  if (tags && tags.length > 0) {
    const tagResults = db
      .select({
        noteId: noteTags.noteId,
        tagCount: sql<number>`count(distinct ${noteTags.tag})`
      })
      .from(noteTags)
      .where(inArray(noteTags.tag, tags))
      .groupBy(noteTags.noteId)
      .all()

    // Filter to notes that have ALL requested tags
    noteIdsWithTags = tagResults
      .filter((r) => r.tagCount === tags.length)
      .map((r) => r.noteId)

    if (noteIdsWithTags.length === 0) {
      return [] // No notes match all tags
    }

    conditions.push(inArray(noteCache.id, noteIdsWithTags))
  }

  // Build sort order
  const sortColumn =
    sortBy === 'modified'
      ? noteCache.modifiedAt
      : sortBy === 'created'
        ? noteCache.createdAt
        : noteCache.title

  const orderFn = sortOrder === 'asc' ? asc : desc

  // Execute query
  let query = db.select().from(noteCache)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

/**
 * Count total notes in cache.
 */
export function countNotes(db: DrizzleDb, folder?: string): number {
  let query = db.select({ count: count() }).from(noteCache)

  if (folder) {
    query = query.where(like(noteCache.path, `${folder}/%`)) as typeof query
  }

  const result = query.get()
  return result?.count ?? 0
}

// ============================================================================
// Tag Operations
// ============================================================================

/**
 * Set tags for a note (replaces existing tags).
 */
export function setNoteTags(db: DrizzleDb, noteId: string, tags: string[]): void {
  // Delete existing tags
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run()

  // Insert new tags
  if (tags.length > 0) {
    const tagRecords: NewNoteTag[] = tags.map((tag) => ({
      noteId,
      tag: tag.toLowerCase().trim()
    }))
    db.insert(noteTags).values(tagRecords).run()
  }
}

/**
 * Get tags for a note.
 */
export function getNoteTags(db: DrizzleDb, noteId: string): string[] {
  const results = db
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(eq(noteTags.noteId, noteId))
    .all()

  return results.map((r) => r.tag)
}

/**
 * Get all unique tags with counts.
 */
export function getAllTags(db: DrizzleDb): { tag: string; count: number }[] {
  return db
    .select({
      tag: noteTags.tag,
      count: count()
    })
    .from(noteTags)
    .groupBy(noteTags.tag)
    .orderBy(desc(count()))
    .all()
}

/**
 * Find notes with a specific tag.
 */
export function findNotesByTag(db: DrizzleDb, tag: string): NoteCache[] {
  const noteIds = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(eq(noteTags.tag, tag.toLowerCase()))
    .all()
    .map((r) => r.noteId)

  if (noteIds.length === 0) {
    return []
  }

  return db.select().from(noteCache).where(inArray(noteCache.id, noteIds)).all()
}

// ============================================================================
// Link Operations
// ============================================================================

/**
 * Set links for a note (replaces existing links).
 */
export function setNoteLinks(
  db: DrizzleDb,
  sourceId: string,
  links: { targetTitle: string; targetId?: string }[]
): void {
  // Delete existing links from this source
  db.delete(noteLinks).where(eq(noteLinks.sourceId, sourceId)).run()

  // Insert new links
  if (links.length > 0) {
    const linkRecords: NewNoteLink[] = links.map((link) => ({
      sourceId,
      targetId: link.targetId ?? null,
      targetTitle: link.targetTitle
    }))
    db.insert(noteLinks).values(linkRecords).run()
  }
}

/**
 * Get outgoing links from a note.
 */
export function getOutgoingLinks(db: DrizzleDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
}

/**
 * Get incoming links (backlinks) to a note.
 */
export function getIncomingLinks(db: DrizzleDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.targetId, noteId)).all()
}

/**
 * Delete links where this note is the target (cleanup orphaned links on note deletion).
 */
export function deleteLinksToNote(db: DrizzleDb, targetId: string): void {
  db.delete(noteLinks).where(eq(noteLinks.targetId, targetId)).run()
}

/**
 * Resolve a link target title to a note ID.
 */
export function resolveNoteByTitle(db: DrizzleDb, title: string): NoteCache | undefined {
  // First try exact title match
  let result = db
    .select()
    .from(noteCache)
    .where(eq(noteCache.title, title))
    .get()

  if (result) {
    return result
  }

  // Try case-insensitive title match
  result = db
    .select()
    .from(noteCache)
    .where(sql`lower(${noteCache.title}) = lower(${title})`)
    .get()

  return result
}

/**
 * Update link target IDs after resolving titles.
 */
export function updateLinkTargets(db: DrizzleDb, sourceId: string): void {
  const links = getOutgoingLinks(db, sourceId)

  for (const link of links) {
    if (!link.targetId) {
      const target = resolveNoteByTitle(db, link.targetTitle)
      if (target) {
        db.update(noteLinks)
          .set({ targetId: target.id })
          .where(
            and(
              eq(noteLinks.sourceId, sourceId),
              eq(noteLinks.targetTitle, link.targetTitle)
            )
          )
          .run()
      }
    }
  }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Insert multiple notes into cache (for initial indexing).
 */
export function bulkInsertNotes(db: DrizzleDb, notes: NewNoteCache[]): void {
  if (notes.length === 0) return

  // Insert in batches of 100
  const batchSize = 100
  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize)
    db.insert(noteCache).values(batch).run()
  }
}

/**
 * Clear all notes from cache (for rebuilding).
 */
export function clearNoteCache(db: DrizzleDb): void {
  db.delete(noteLinks).run()
  db.delete(noteTags).run()
  db.delete(noteCache).run()
}

/**
 * Get all note IDs from cache.
 */
export function getAllNoteIds(db: DrizzleDb): string[] {
  return db
    .select({ id: noteCache.id })
    .from(noteCache)
    .all()
    .map((r) => r.id)
}

/**
 * Get notes that were modified after a certain date.
 */
export function getNotesModifiedAfter(db: DrizzleDb, date: string): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(sql`${noteCache.modifiedAt} > ${date}`)
    .all()
}
