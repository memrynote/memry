import { eq, and, sql } from 'drizzle-orm'
import {
  noteCache,
  noteLinks,
  type NoteCache,
  type NoteLink,
  type NewNoteLink
} from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../../types'

export function setNoteLinks(
  db: IndexDb,
  sourceId: string,
  links: { targetTitle: string; targetId?: string }[]
): void {
  db.delete(noteLinks).where(eq(noteLinks.sourceId, sourceId)).run()

  if (links.length > 0) {
    const linkRecords: NewNoteLink[] = links.map((link) => ({
      sourceId,
      targetId: link.targetId ?? null,
      targetTitle: link.targetTitle
    }))
    db.insert(noteLinks).values(linkRecords).run()
  }
}

export function getOutgoingLinks(db: IndexDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
}

export function getIncomingLinks(db: IndexDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.targetId, noteId)).all()
}

export function deleteLinksToNote(db: IndexDb, targetId: string): void {
  db.delete(noteLinks).where(eq(noteLinks.targetId, targetId)).run()
}

export function resolveNoteByTitle(db: IndexDb, title: string): NoteCache | undefined {
  let result = db.select().from(noteCache).where(eq(noteCache.title, title)).get()

  if (result) {
    return result
  }

  result = db
    .select()
    .from(noteCache)
    .where(sql`lower(${noteCache.title}) = lower(${title})`)
    .get()

  return result
}

export function resolveNotesByTitles(
  db: IndexDb,
  titles: string[]
): Map<string, { id: string; path: string } | null> {
  if (titles.length === 0) {
    return new Map()
  }

  const normalizedTitles = new Set(titles.map((t) => t.toLowerCase()))

  const allNotes = db
    .select({
      id: noteCache.id,
      path: noteCache.path,
      title: noteCache.title
    })
    .from(noteCache)
    .all()

  const resultMap = new Map<string, { id: string; path: string } | null>()

  for (const title of titles) {
    resultMap.set(title, null)
  }

  for (const note of allNotes) {
    if (normalizedTitles.has(note.title.toLowerCase())) {
      for (const title of titles) {
        if (note.title.toLowerCase() === title.toLowerCase()) {
          resultMap.set(title, { id: note.id, path: note.path })
        }
      }
    }
  }

  return resultMap
}

export function updateLinkTargets(db: IndexDb, sourceId: string): void {
  const links = getOutgoingLinks(db, sourceId)

  for (const link of links) {
    if (!link.targetId) {
      const target = resolveNoteByTitle(db, link.targetTitle)
      if (target) {
        db.update(noteLinks)
          .set({ targetId: target.id })
          .where(and(eq(noteLinks.sourceId, sourceId), eq(noteLinks.targetTitle, link.targetTitle)))
          .run()
      }
    }
  }
}
