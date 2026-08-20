import { eq, desc, asc, and, gt, like, inArray, sql, count, type SQL } from 'drizzle-orm'
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

// ============================================================================
// Note Listing
// ============================================================================

/**
 * The columns `listNotes`'s `fields: 'tree'` shape actually maps (PR #1316).
 * Selecting only these keeps SQLite from reading the cached ~200-char `snippet`
 * — plus `mimeType`/`fileSize` and the six columns no list caller ever reads —
 * for every row of a whole-vault sidebar fetch that then throws them away.
 */
const NOTE_TREE_COLUMNS = {
  id: noteCache.id,
  path: noteCache.path,
  title: noteCache.title,
  fileType: noteCache.fileType,
  emoji: noteCache.emoji,
  localOnly: noteCache.localOnly,
  wordCount: noteCache.wordCount,
  createdAt: noteCache.createdAt,
  modifiedAt: noteCache.modifiedAt
} as const

/** A `shape: 'tree'` row. Deliberately not a `NoteCache` — it has fewer columns. */
export type NoteTreeCacheRow = Pick<NoteCache, keyof typeof NOTE_TREE_COLUMNS>

export interface ListNotesOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title' | 'position'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
  /**
   * `'tree'` narrows the SQL projection to {@link NOTE_TREE_COLUMNS}. Defaults
   * to the full `note_cache` row so every existing caller is unaffected.
   */
  shape?: 'full' | 'tree'
}

export function listNotesFromCache(
  db: IndexDb,
  options?: ListNotesOptions & { shape?: 'full' }
): NoteCache[]
export function listNotesFromCache(
  db: IndexDb,
  options: ListNotesOptions & { shape: 'tree' }
): NoteTreeCacheRow[]
export function listNotesFromCache(
  db: IndexDb,
  options: ListNotesOptions = {}
): NoteCache[] | NoteTreeCacheRow[] {
  const {
    folder,
    tags,
    sortBy = 'modified',
    sortOrder = 'desc',
    limit = 100,
    offset = 0,
    shape = 'full'
  } = options

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

  const where = conditions.length > 0 ? and(...conditions) : undefined

  if (shape === 'tree') {
    return db
      .select(NOTE_TREE_COLUMNS)
      .from(noteCache)
      .where(where)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset)
      .all()
  }

  return db
    .select()
    .from(noteCache)
    .where(where)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset)
    .all()
}

export interface NoteCacheFileRow {
  id: string
  path: string
  indexedAt: string
}

/**
 * Cursor-paged `id`/`path` scan over the same rows `listNotesFromCache` walks
 * (journal entries carry a date and stay out of it).
 *
 * Keyset on the primary key instead of LIMIT/OFFSET: the reconcile pass deletes
 * rows while it walks, and an offset window silently skips a row for every one
 * removed behind it. `indexedAt` rides along so a caller that leaves the pass to
 * do async work can tell whether the row it read was rewritten in the meantime.
 */
export function listNoteCacheFilesAfter(
  db: IndexDb,
  afterId: string,
  limit: number
): NoteCacheFileRow[] {
  return db
    .select({ id: noteCache.id, path: noteCache.path, indexedAt: noteCache.indexedAt })
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NULL`, gt(noteCache.id, afterId)))
    .orderBy(asc(noteCache.id))
    .limit(limit)
    .all()
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

/**
 * Every CRDT-backed note in the vault, most recently modified first.
 *
 * The order is the paced catch-up sweep's priority. `FullSyncRunner` queues
 * these ids in the order they arrive and the queue drains FIFO, so a note that
 * changed recently — by this user, or by the device this one is catching up
 * with — is both the note most likely to actually be stale and the note most
 * likely to be opened next. Unordered, this returned rowid order, which is
 * index-build order and says nothing about either. `idx_note_cache_modified`
 * already covers the sort.
 *
 * Ordering only, never filtering. The sweep is the sole channel by which a
 * body-only remote edit reaches a device that missed the `crdt_updated`
 * broadcast — bodies never travel in the record change feed — so it stays
 * exhaustive and every markdown note is still returned. A vault with uniform
 * mtimes (restored from backup, freshly cloned, bulk-imported) simply falls
 * back to an arbitrary order, which is what it had before.
 */
export function getAllCrdtNoteIds(db: IndexDb): string[] {
  return db
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(eq(noteCache.fileType, 'markdown'))
    .orderBy(desc(noteCache.modifiedAt))
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
