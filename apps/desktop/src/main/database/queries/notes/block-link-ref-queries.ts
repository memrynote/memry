import { and, eq, inArray, ne } from 'drizzle-orm'
import {
  blockLinkRefs,
  noteCache,
  noteLinks,
  noteNames,
  type BlockLinkRefRow
} from '@memry/db-schema/schema/notes-cache'
import { nameKey } from '@memry/shared/note-names'
import type { IndexDb } from '../../types'
import { pathLinkKeys } from './note-names-queries'

export type { BlockLinkRefRow }

/** Replaces a source note's block links. A note with none ends with no rows. */
export function setBlockLinkRefs(
  db: IndexDb,
  sourceNoteId: string,
  links: readonly { note: string; anchor: string }[]
): void {
  db.delete(blockLinkRefs).where(eq(blockLinkRefs.sourceNoteId, sourceNoteId)).run()
  const rows = new Map<string, BlockLinkRefRow>()
  for (const link of links) {
    const targetKey = nameKey(link.note)
    if (targetKey === null) continue
    rows.set(`${targetKey}\u0000${link.anchor}`, { sourceNoteId, targetKey, anchor: link.anchor })
  }
  if (rows.size > 0)
    db.insert(blockLinkRefs)
      .values([...rows.values()])
      .run()
}

export function getBlockLinkRefsForSource(db: IndexDb, sourceNoteId: string): BlockLinkRefRow[] {
  return db.select().from(blockLinkRefs).where(eq(blockLinkRefs.sourceNoteId, sourceNoteId)).all()
}

export interface LinkUsageRow {
  sourceNoteId: string
  title: string
  path: string
}

/**
 * Other notes that link to `noteId`. With `anchor`, only links to that block
 * (`[[Note#^anchor]]`, `[[memry://note/<id>#^anchor]]`, markdown links),
 * matched through the note's id, title, aliases and path forms. Without it, every wiki link to the note. A source whose note row is
 * gone is left out.
 */
export function getLinkUsage(db: IndexDb, noteId: string, anchor?: string): LinkUsageRow[] {
  const select = {
    sourceNoteId: noteCache.id,
    title: noteCache.title,
    path: noteCache.path
  }
  if (!anchor) {
    return db
      .selectDistinct(select)
      .from(noteLinks)
      .innerJoin(noteCache, eq(noteCache.id, noteLinks.sourceId))
      .where(and(eq(noteLinks.targetId, noteId), ne(noteLinks.sourceId, noteId)))
      .orderBy(noteCache.title)
      .all()
  }
  const note = db
    .select({ path: noteCache.path })
    .from(noteCache)
    .where(eq(noteCache.id, noteId))
    .get()
  if (!note) return []
  const keys = [
    ...db
      .select({ key: noteNames.key })
      .from(noteNames)
      .where(eq(noteNames.noteId, noteId))
      .all()
      .map((row) => row.key),
    ...pathLinkKeys(note.path),
    nameKey(`memry://note/${noteId}`)
  ].filter((key) => key !== null)
  return db
    .selectDistinct(select)
    .from(blockLinkRefs)
    .innerJoin(noteCache, eq(noteCache.id, blockLinkRefs.sourceNoteId))
    .where(
      and(
        inArray(blockLinkRefs.targetKey, [...new Set(keys)]),
        eq(blockLinkRefs.anchor, anchor),
        ne(blockLinkRefs.sourceNoteId, noteId)
      )
    )
    .orderBy(noteCache.title)
    .all()
}
