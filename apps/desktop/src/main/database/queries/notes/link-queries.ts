import { eq, and, inArray, isNull, or } from 'drizzle-orm'
import { noteLinks, type NoteLink, type NewNoteLink } from '@memry/db-schema/schema/notes-cache'
import { listHtmlBlockText } from '@memry/app-core/html-block-text'
import { nameKey } from '@memry/shared/note-names'
import { extractWikiLinks } from '@memry/shared/wiki-target'
import type { IndexDb } from '../../types'
import { noteCacheExists } from './note-crud'
import { pathLinkKeys } from './note-names-queries'
import { getIncomingPropertyRefs } from './property-ref-queries'
import { resolveLinkTargets } from './wiki-target-resolver'

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
      targetTitle: link.targetTitle,
      targetKey: nameKey(link.targetTitle)
    }))
    db.insert(noteLinks).values(linkRecords).run()
  }
}

/**
 * A markdown note's outbound links: the ones in its body, then the ones in the
 * visible text of the HTML blocks it embeds, which the file-text runner keeps
 * in `extracted_text`.
 */
export function setMarkdownNoteLinks(db: IndexDb, noteId: string, markdownLinks: string[]): void {
  const titles = new Set(markdownLinks)
  for (const text of listHtmlBlockText(db, noteId)) {
    for (const title of extractWikiLinks(text)) titles.add(title)
  }
  const resolved = resolveLinkTargets(db, [...titles])
  setNoteLinks(
    db,
    noteId,
    [...titles].map((title) => ({ targetTitle: title, targetId: resolved.get(title)?.noteId }))
  )
}

export function getOutgoingLinks(db: IndexDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
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
 * Distinct sources whose wiki-links reach a note about to be renamed or moved.
 *
 * Resolved rows are matched by target id. Unresolved rows (`target_id` null)
 * are matched by the name key of the indexed title — the SPLIT note-half a
 * link was stored under (`extractWikiLinks`), so pass
 * `splitWikiTarget(oldTitle).note`, not the raw title — or by any path form of
 * the note's old `path`, because a
 * link written before its target was re-indexed still deserves the rewrite. The rewrite itself re-checks every
 * occurrence, so an over-broad candidate here costs a file read, never a
 * wrong edit.
 */
export function getInboundLinkSourceIds(
  db: IndexDb,
  targetId: string,
  indexedTitle: string,
  oldPath: string
): string[] {
  return db
    .selectDistinct({ sourceId: noteLinks.sourceId })
    .from(noteLinks)
    .where(
      or(
        eq(noteLinks.targetId, targetId),
        and(
          isNull(noteLinks.targetId),
          inArray(noteLinks.targetKey, [nameKey(indexedTitle) ?? '', ...pathLinkKeys(oldPath)])
        )
      )
    )
    .all()
    .map((row) => row.sourceId)
}

/** Every note that has at least one outgoing wiki-link row. */
export function listLinkSourceIds(db: IndexDb): string[] {
  return db
    .selectDistinct({ sourceId: noteLinks.sourceId })
    .from(noteLinks)
    .all()
    .map((row) => row.sourceId)
}
