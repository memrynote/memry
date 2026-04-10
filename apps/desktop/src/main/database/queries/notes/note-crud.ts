import { eq, desc, asc, and, like, inArray, sql, count, type SQL } from 'drizzle-orm'
import {
  noteCache,
  noteTags,
  noteLinks,
  type NoteCache,
  type NewNoteCache
} from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../../types'

// ============================================================================
// Note Cache CRUD
// ============================================================================

export function insertNoteCache(db: IndexDb, note: NewNoteCache): NoteCache {
  return db
    .insert(noteCache)
    .values(note)
    .onConflictDoUpdate({
      target: noteCache.id,
      set: {
        path: note.path,
        title: note.title,
        emoji: note.emoji,
        localOnly: note.localOnly,
        contentHash: note.contentHash,
        wordCount: note.wordCount,
        characterCount: note.characterCount,
        snippet: note.snippet,
        date: note.date,
        modifiedAt: note.modifiedAt,
        indexedAt: new Date().toISOString()
      }
    })
    .returning()
    .get()
}

export function updateNoteCache(
  db: IndexDb,
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

export function deleteNoteCache(db: IndexDb, id: string): void {
  db.delete(noteCache).where(eq(noteCache.id, id)).run()
}

export function getNoteCacheById(db: IndexDb, id: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.id, id)).get()
}

export function getNoteCacheByPath(db: IndexDb, path: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.path, path)).get()
}

export function noteCacheExists(db: IndexDb, id: string): boolean {
  const result = db.select({ id: noteCache.id }).from(noteCache).where(eq(noteCache.id, id)).get()
  return result !== undefined
}

export function getLocalOnlyCount(db: IndexDb): number {
  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(eq(noteCache.localOnly, true))
    .get()
  return result?.count ?? 0
}

export function findDuplicateId(
  db: IndexDb,
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
  sortBy?: 'modified' | 'created' | 'title' | 'position'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export function listNotesFromCache(db: IndexDb, options: ListNotesOptions = {}): NoteCache[] {
  const { folder, tags, sortBy = 'modified', sortOrder = 'desc', limit = 100, offset = 0 } = options

  const conditions: SQL<unknown>[] = []

  conditions.push(sql`${noteCache.date} IS NULL`)

  if (folder) {
    conditions.push(like(noteCache.path, `${folder}/%`))
  }

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

    noteIdsWithTags = tagResults.filter((r) => r.tagCount === tags.length).map((r) => r.noteId)

    if (noteIdsWithTags.length === 0) {
      return []
    }

    conditions.push(inArray(noteCache.id, noteIdsWithTags))
  }

  const effectiveSortBy = sortBy === 'position' ? 'modified' : sortBy
  const sortColumn =
    effectiveSortBy === 'modified'
      ? noteCache.modifiedAt
      : effectiveSortBy === 'created'
        ? noteCache.createdAt
        : noteCache.title

  const orderFn = sortOrder === 'asc' ? asc : desc

  let query = db.select().from(noteCache)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

export function countNotes(db: IndexDb, folder?: string): number {
  const conditions: SQL<unknown>[] = [sql`${noteCache.date} IS NULL`]

  if (folder) {
    conditions.push(like(noteCache.path, `${folder}/%`))
  }

  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(and(...conditions))
    .get()

  return result?.count ?? 0
}

// ============================================================================
// Bulk Operations
// ============================================================================

export function bulkInsertNotes(db: IndexDb, notes: NewNoteCache[]): void {
  if (notes.length === 0) return

  const batchSize = 100
  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize)
    db.insert(noteCache).values(batch).run()
  }
}

export function clearNoteCache(db: IndexDb): void {
  db.delete(noteLinks).run()
  db.delete(noteTags).run()
  db.delete(noteCache).run()
}

export function getAllNoteIds(db: IndexDb): string[] {
  return db
    .select({ id: noteCache.id })
    .from(noteCache)
    .all()
    .map((r) => r.id)
}

export function getAllCrdtNoteIds(db: IndexDb): string[] {
  return db
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(eq(noteCache.fileType, 'markdown'))
    .all()
    .map((r) => r.id)
}

export function getNotesModifiedAfter(db: IndexDb, date: string): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(sql`${noteCache.modifiedAt} > ${date}`)
    .all()
}
