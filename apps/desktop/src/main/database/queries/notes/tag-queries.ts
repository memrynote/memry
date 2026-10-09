import { eq, and, or, inArray, isNull, like, count, desc } from 'drizzle-orm'
import {
  noteCache,
  noteTags,
  type NoteCache,
  type NewNoteTag
} from '@memry/db-schema/schema/notes-cache'
import { foldTag } from '@memry/shared/tag-fold'
import type { IndexDb } from '../../types'

// ============================================================================
// Tag Operations
// ============================================================================

export interface NoteTagSet {
  /** The frontmatter `tags:` list, in file order. */
  header: readonly string[]
  /** Body `#tags`. One that is also in `header` is stored once, as a header tag. */
  inline: readonly string[]
}

export function setNoteTags(db: IndexDb, noteId: string, tags: NoteTagSet): void {
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run()

  // Case-preserving, case-insensitive dedupe (tag column is COLLATE NOCASE,
  // so case variants would violate the (noteId, tag) primary key). Header
  // first, so its spelling and position win over an inline copy.
  const byKey = new Map<string, { tag: string; inHeader: boolean }>()
  const add = (raw: string, inHeader: boolean): void => {
    const tag = raw.trim()
    if (!tag) return
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, { tag, inHeader })
  }
  for (const tag of tags.header) add(tag, true)
  for (const tag of tags.inline) add(tag, false)

  if (byKey.size > 0) {
    const tagRecords: NewNoteTag[] = [...byKey.values()].map(({ tag, inHeader }, index) => ({
      noteId,
      tag,
      position: index,
      inHeader
    }))
    db.insert(noteTags).values(tagRecords).run()
  }
}

/** Notes with tag rows an older build wrote without a header flag. */
export function listNotesWithUnresolvedHeaderTags(
  db: IndexDb
): Array<Pick<NoteCache, 'id' | 'path' | 'fileType'>> {
  return db
    .selectDistinct({ id: noteCache.id, path: noteCache.path, fileType: noteCache.fileType })
    .from(noteTags)
    .innerJoin(noteCache, eq(noteCache.id, noteTags.noteId))
    .where(isNull(noteTags.inHeader))
    .all()
}

/**
 * Flags the note's unresolved tag rows from its frontmatter `tags:`. A row the
 * projector wrote since already carries its flag and is left alone.
 */
export function resolveHeaderTagFlags(
  db: IndexDb,
  noteId: string,
  headerTags: readonly string[]
): void {
  const unresolved = and(eq(noteTags.noteId, noteId), isNull(noteTags.inHeader))
  if (headerTags.length > 0) {
    db.update(noteTags)
      .set({ inHeader: true })
      .where(and(unresolved, inArray(noteTags.tag, [...headerTags])))
      .run()
  }
  db.update(noteTags).set({ inHeader: false }).where(unresolved).run()
}

export function getNoteTags(db: IndexDb, noteId: string): string[] {
  const results = db
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(eq(noteTags.noteId, noteId))
    .orderBy(noteTags.position)
    .all()

  return results.map((r) => r.tag)
}

export function getTagsForNotes(db: IndexDb, noteIds: string[]): Map<string, string[]> {
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

export function getAllTags(db: IndexDb): { tag: string; count: number }[] {
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

export function findNotesByTag(db: IndexDb, tag: string): NoteCache[] {
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

export function findNotesByTagPrefix(db: IndexDb, tag: string): NoteCache[] {
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
  db: IndexDb,
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

  const seen = new Set<string>()
  const tagRecordsDeduped = tagRecords.filter((r) => {
    if (seen.has(r.noteId)) return false
    seen.add(r.noteId)
    return true
  })

  if (tagRecordsDeduped.length === 0) {
    return []
  }

  const noteIds = tagRecordsDeduped.map((r) => r.noteId)
  const pinnedMap = new Map(tagRecordsDeduped.map((r) => [r.noteId, r.pinnedAt]))

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

export function pinNoteToTag(db: IndexDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()
  const now = new Date().toISOString()

  db.update(noteTags)
    .set({ pinnedAt: now })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

export function unpinNoteFromTag(db: IndexDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()

  db.update(noteTags)
    .set({ pinnedAt: null })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

export function renameTag(db: IndexDb, oldName: string, newName: string): number {
  const normalizedOld = foldTag(oldName.trim())
  const trimmedNew = newName.trim()

  // Case-only renames are valid: they update the stored display case
  if (oldName.trim() === trimmedNew) return 0

  const exactResult = db
    .update(noteTags)
    .set({ tag: trimmedNew })
    .where(eq(noteTags.tag, normalizedOld))
    .run()

  // Rewrite children row-by-row: SQL replace() is case-sensitive, but stored
  // prefixes may differ in case from the requested name
  const childRows = db
    .select({ noteId: noteTags.noteId, tag: noteTags.tag })
    .from(noteTags)
    .where(like(noteTags.tag, `${normalizedOld}/%`))
    .all()

  for (const row of childRows) {
    db.update(noteTags)
      .set({ tag: trimmedNew + row.tag.slice(normalizedOld.length) })
      .where(and(eq(noteTags.noteId, row.noteId), eq(noteTags.tag, row.tag)))
      .run()
  }

  return exactResult.changes + childRows.length
}

export function deleteTag(db: IndexDb, tag: string, options: { cascade?: boolean } = {}): number {
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

export function removeTagFromNote(db: IndexDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase().trim()

  db.delete(noteTags)
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}
