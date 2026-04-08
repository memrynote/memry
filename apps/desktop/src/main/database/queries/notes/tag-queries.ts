import { eq, and, or, inArray, like, count, desc, sql } from 'drizzle-orm'
import {
  noteCache,
  noteTags,
  type NoteCache,
  type NewNoteTag
} from '@memry/db-schema/schema/notes-cache'
import type { DrizzleDb } from '../../types'

// ============================================================================
// Tag Operations
// ============================================================================

export function setNoteTags(db: DrizzleDb, noteId: string, tags: string[]): void {
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run()

  if (tags.length > 0) {
    const tagRecords: NewNoteTag[] = tags.map((tag, index) => ({
      noteId,
      tag: tag.toLowerCase().trim(),
      position: index
    }))
    db.insert(noteTags).values(tagRecords).run()
  }
}

export function getNoteTags(db: DrizzleDb, noteId: string): string[] {
  const results = db
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(eq(noteTags.noteId, noteId))
    .orderBy(noteTags.position)
    .all()

  return results.map((r) => r.tag)
}

export function getTagsForNotes(db: DrizzleDb, noteIds: string[]): Map<string, string[]> {
  if (noteIds.length === 0) {
    return new Map()
  }

  const results = db
    .select({
      noteId: noteTags.noteId,
      tag: noteTags.tag
    })
    .from(noteTags)
    .where(inArray(noteTags.noteId, noteIds))
    .all()

  const tagMap = new Map<string, string[]>()

  for (const noteId of noteIds) {
    tagMap.set(noteId, [])
  }

  for (const row of results) {
    const tags = tagMap.get(row.noteId)
    if (tags) {
      tags.push(row.tag)
    }
  }

  return tagMap
}

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
    .map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

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

export function findNotesByTagPrefix(db: DrizzleDb, tag: string): NoteCache[] {
  const normalizedTag = tag.toLowerCase()
  const noteIds = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(or(eq(noteTags.tag, normalizedTag), like(noteTags.tag, `${normalizedTag}/%`)))
    .all()
    .map((r) => r.noteId)

  const uniqueIds = [...new Set(noteIds)]
  if (uniqueIds.length === 0) return []

  return db.select().from(noteCache).where(inArray(noteCache.id, uniqueIds)).all()
}

export interface NoteWithTagInfo extends NoteCache {
  isPinned: boolean
  pinnedAt: string | null
}

export function findNotesWithTagInfo(
  db: DrizzleDb,
  tag: string,
  options: {
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  } = {}
): NoteWithTagInfo[] {
  const { sortBy = 'modified', sortOrder = 'desc', includeDescendants = false } = options
  const normalizedTag = tag.toLowerCase()

  const whereClause = includeDescendants
    ? or(eq(noteTags.tag, normalizedTag), like(noteTags.tag, `${normalizedTag}/%`))
    : eq(noteTags.tag, normalizedTag)

  const tagRecords = db
    .select({
      noteId: noteTags.noteId,
      pinnedAt: noteTags.pinnedAt
    })
    .from(noteTags)
    .where(whereClause)
    .all()
    .filter((r, i, arr) => arr.findIndex((x) => x.noteId === r.noteId) === i)

  if (tagRecords.length === 0) {
    return []
  }

  const noteIds = tagRecords.map((r) => r.noteId)
  const pinnedMap = new Map(tagRecords.map((r) => [r.noteId, r.pinnedAt]))

  const notes = db.select().from(noteCache).where(inArray(noteCache.id, noteIds)).all()

  const notesWithInfo: NoteWithTagInfo[] = notes.map((note) => ({
    ...note,
    isPinned: pinnedMap.get(note.id) !== null,
    pinnedAt: pinnedMap.get(note.id) ?? null
  }))

  const pinned = notesWithInfo.filter((n) => n.isPinned)
  const unpinned = notesWithInfo.filter((n) => !n.isPinned)

  pinned.sort((a, b) => {
    const aTime = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0
    const bTime = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0
    return aTime - bTime
  })

  const sortFn = (a: NoteCache, b: NoteCache) => {
    let aVal: string | number
    let bVal: string | number

    switch (sortBy) {
      case 'title':
        aVal = a.title.toLowerCase()
        bVal = b.title.toLowerCase()
        break
      case 'created':
        aVal = new Date(a.createdAt).getTime()
        bVal = new Date(b.createdAt).getTime()
        break
      default:
        aVal = new Date(a.modifiedAt).getTime()
        bVal = new Date(b.modifiedAt).getTime()
    }

    if (sortOrder === 'asc') {
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0
    }
    return aVal > bVal ? -1 : aVal < bVal ? 1 : 0
  }

  unpinned.sort(sortFn)

  return [...pinned, ...unpinned]
}

export function pinNoteToTag(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()
  const now = new Date().toISOString()

  db.update(noteTags)
    .set({ pinnedAt: now })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

export function unpinNoteFromTag(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()

  db.update(noteTags)
    .set({ pinnedAt: null })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

export function renameTag(db: DrizzleDb, oldName: string, newName: string): number {
  const normalizedOld = oldName.toLowerCase().trim()
  const normalizedNew = newName.toLowerCase().trim()

  if (normalizedOld === normalizedNew) return 0

  const exactResult = db
    .update(noteTags)
    .set({ tag: normalizedNew })
    .where(eq(noteTags.tag, normalizedOld))
    .run()

  const childResult = db
    .update(noteTags)
    .set({
      tag: sql`replace(${noteTags.tag}, ${normalizedOld + '/'}, ${normalizedNew + '/'})`
    })
    .where(like(noteTags.tag, `${normalizedOld}/%`))
    .run()

  return exactResult.changes + childResult.changes
}

export function deleteTag(db: DrizzleDb, tag: string, options: { cascade?: boolean } = {}): number {
  const normalizedTag = tag.toLowerCase().trim()
  const { cascade = false } = options

  const exactResult = db.delete(noteTags).where(eq(noteTags.tag, normalizedTag)).run()

  if (!cascade) return exactResult.changes

  const childResult = db
    .delete(noteTags)
    .where(like(noteTags.tag, `${normalizedTag}/%`))
    .run()

  return exactResult.changes + childResult.changes
}

export function removeTagFromNote(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase().trim()

  db.delete(noteTags)
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}
