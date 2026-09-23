import { eq, and, isNull, or, sql } from 'drizzle-orm'
import {
  noteCache,
  noteLinks,
  type NoteCache,
  type NoteLink,
  type NewNoteLink
} from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../../types'
import { noteCacheExists } from './note-crud'
import { getIncomingPropertyRefs } from './property-ref-queries'

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

/**
 * A note just appeared (created, or a new file indexed) under `title`. Any
 * existing outbound link whose target was unresolved (`target_id IS NULL`)
 * because it pointed at this title before the target existed now resolves —
 * this is what makes create-from-link (and any other creation route) produce
 * a backlink retroactively instead of only for links written after the fact.
 */
export function backfillUnresolvedLinksByTitle(db: IndexDb, noteId: string, title: string): void {
  db.update(noteLinks)
    .set({ targetId: noteId })
    .where(and(isNull(noteLinks.targetId), sql`lower(${noteLinks.targetTitle}) = lower(${title})`))
    .run()
}

export function getIncomingLinks(db: IndexDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.targetId, noteId)).all()
}

/**
 * A note's incoming references: wiki-link backlinks (`via` undefined) plus
 * relation-property references (`via.kind === 'property'`). A source that
 * references the target both ways produces two distinct entries.
 */
export interface IncomingReference {
  sourceNoteId: string
  via?: { kind: 'property'; propertyName: string }
}

export function getIncomingReferences(db: IndexDb, noteId: string): IncomingReference[] {
  const wikiLinks: IncomingReference[] = getIncomingLinks(db, noteId).map((link) => ({
    sourceNoteId: link.sourceId
  }))

  // property_refs is a rebuildable index-DB cache with no FK enforcement, so
  // a source note can be deleted without its outgoing rows being cleaned up.
  // Drop those before they turn into phantom backlinks.
  const propertyLinks: IncomingReference[] = getIncomingPropertyRefs(db, 'note', noteId)
    .filter((ref) => noteCacheExists(db, ref.sourceNoteId))
    .map((ref) => ({
      sourceNoteId: ref.sourceNoteId,
      via: { kind: 'property' as const, propertyName: ref.propertyName }
    }))

  return [...wikiLinks, ...propertyLinks]
}

/**
 * The target note is gone, but every `[[Title]]` pointing at it is still in its
 * source's text. Keep those rows as unresolved links instead of deleting them,
 * so the source's outgoing links and the graph still show them, and
 * `backfillUnresolvedLinksByTitle` re-resolves them if the title comes back.
 */
export function unresolveLinksToNote(db: IndexDb, targetId: string): void {
  db.update(noteLinks).set({ targetId: null }).where(eq(noteLinks.targetId, targetId)).run()
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

/**
 * Distinct sources whose wiki-links reach a note about to be renamed.
 *
 * Resolved rows are matched by target id. Unresolved rows (`target_id` null)
 * are matched by the indexed title — the SPLIT note-half a link was stored
 * under (`extractWikiLinks`), so pass `splitWikiTarget(oldTitle).note`, not
 * the raw title — because a link written before its target was re-indexed
 * still deserves the rename-time rewrite. The rewrite itself re-checks every
 * occurrence, so an over-broad candidate here costs a file read, never a
 * wrong edit.
 */
export function getInboundLinkSourceIds(
  db: IndexDb,
  targetId: string,
  indexedTitle: string
): string[] {
  return db
    .selectDistinct({ sourceId: noteLinks.sourceId })
    .from(noteLinks)
    .where(
      or(
        eq(noteLinks.targetId, targetId),
        and(
          isNull(noteLinks.targetId),
          sql`lower(${noteLinks.targetTitle}) = lower(${indexedTitle})`
        )
      )
    )
    .all()
    .map((row) => row.sourceId)
}
