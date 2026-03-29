import { eq, and, inArray, count, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  noteCache,
  noteTags,
  type NoteCache,
  type NewNoteTag
} from '@memry/db-schema/schema/notes-cache'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

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
  } = {}
): NoteWithTagInfo[] {
  const { sortBy = 'modified', sortOrder = 'desc' } = options
  const normalizedTag = tag.toLowerCase()

  const tagRecords = db
    .select({
      noteId: noteTags.noteId,
      pinnedAt: noteTags.pinnedAt
    })
    .from(noteTags)
    .where(eq(noteTags.tag, normalizedTag))
    .all()

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

  if (normalizedOld === normalizedNew) {
    return 0
  }

  const result = db
    .update(noteTags)
    .set({ tag: normalizedNew })
    .where(eq(noteTags.tag, normalizedOld))
    .run()

  return result.changes
}

export function deleteTag(db: DrizzleDb, tag: string): number {
  const normalizedTag = tag.toLowerCase().trim()

  const result = db.delete(noteTags).where(eq(noteTags.tag, normalizedTag)).run()

  return result.changes
}

export function removeTagFromNote(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase().trim()

  db.delete(noteTags)
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

// ============================================================================
// Tag Definition Operations (vault-wide tag registry with colors)
// ============================================================================

const TAG_COLOR_PALETTE = [
  'rose',
  'pink',
  'fuchsia',
  'purple',
  'violet',
  'indigo',
  'blue',
  'sky',
  'cyan',
  'teal',
  'emerald',
  'green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'stone',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'warm',
  'red',
  'coral'
]

export function getOrCreateTag(db: DrizzleDb, name: string): { name: string; color: string } {
  const normalizedName = name.toLowerCase().trim()

  const existing = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedName))
    .get()

  if (existing) {
    return { name: existing.name, color: existing.color }
  }

  const tagCount = db.select({ count: count() }).from(tagDefinitions).get()?.count ?? 0

  const color = TAG_COLOR_PALETTE[tagCount % TAG_COLOR_PALETTE.length]

  db.insert(tagDefinitions).values({ name: normalizedName, color }).run()

  return { name: normalizedName, color }
}

export function getAllTagDefinitions(db: DrizzleDb): { name: string; color: string }[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color
    })
    .from(tagDefinitions)
    .all()
}

export function updateTagColor(db: DrizzleDb, name: string, color: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.update(tagDefinitions).set({ color }).where(eq(tagDefinitions.name, normalizedName)).run()
}

export function renameTagDefinition(db: DrizzleDb, oldName: string, newName: string): void {
  const normalizedOld = oldName.toLowerCase().trim()
  const normalizedNew = newName.toLowerCase().trim()

  if (normalizedOld === normalizedNew) {
    return
  }

  const existingNew = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedNew))
    .get()

  if (existingNew) {
    db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedOld)).run()
  } else {
    db.update(tagDefinitions)
      .set({ name: normalizedNew })
      .where(eq(tagDefinitions.name, normalizedOld))
      .run()
  }
}

export function deleteTagDefinition(db: DrizzleDb, name: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedName)).run()
}

export function ensureTagDefinitions(
  db: DrizzleDb,
  tags: string[]
): { name: string; color: string }[] {
  const normalized = Array.from(
    new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))
  )
  return normalized.map((tag) => getOrCreateTag(db, tag))
}
