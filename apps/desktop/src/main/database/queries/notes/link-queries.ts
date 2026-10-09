import { eq, and, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  noteCache,
  noteLinks,
  type NoteCache,
  type NoteLink,
  type NewNoteLink
} from '@memry/db-schema/schema/notes-cache'
import { listHtmlBlockText } from '@memry/app-core/html-block-text'
import { extractWikiLinks, noteLinkStem, wikiPathStem } from '@memry/shared/wiki-target'
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
  const resolvedTitles = resolveNotesByTitles(db, [...titles])
  setNoteLinks(
    db,
    noteId,
    [...titles].map((title) => ({ targetTitle: title, targetId: resolvedTitles.get(title)?.id }))
  )
}

export function getOutgoingLinks(db: IndexDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
}

/**
 * The lowercased `target_title` forms a path-form link to the note at `path`
 * can be stored under: `Folder/Note`, `Folder/Note.md`, each with or without a
 * leading `/` (links are indexed as written).
 */
function pathLinkKeys(path: string): string[] {
  const forms = [noteLinkStem(path), path].map((form) => form.toLowerCase())
  return [...new Set(forms.flatMap((form) => [form, `/${form}`]))]
}

function targetTitleIn(keys: string[]): SQL {
  return or(
    ...keys.map((key) => sql`lower(${noteLinks.targetTitle}) = ${key.toLowerCase()}`)
  ) as SQL
}

/**
 * A note just appeared (created, or a new file indexed) under `title`, or
 * landed at a new `path`. Any existing outbound link whose target was
 * unresolved (`target_id IS NULL`) because it named this title or path before
 * the target existed now resolves — this is what makes create-from-link (and
 * any other creation route) produce a backlink retroactively instead of only
 * for links written after the fact.
 */
export function backfillUnresolvedLinksByTitle(
  db: IndexDb,
  noteId: string,
  title: string,
  path: string
): void {
  db.update(noteLinks)
    .set({ targetId: noteId })
    .where(and(isNull(noteLinks.targetId), targetTitleIn([title, ...pathLinkKeys(path)])))
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

/**
 * The note a wiki-link note half names. A half holding `/` is a path from the
 * vault root (`Folder/Note`, see `wikiPathStem`) and matches `note_cache.path`
 * case-insensitively, with or without `.md`. Anything else, or a path that
 * matches no file, is looked up by title: exact case first, then any case.
 */
export function resolveNoteByTitle(db: IndexDb, title: string): NoteCache | undefined {
  const stem = wikiPathStem(title)
  if (stem !== null) {
    const byPath = db
      .select()
      .from(noteCache)
      .where(sql`lower(${noteCache.path}) in (lower(${stem}), lower(${stem + '.md'}))`)
      .get()
    if (byPath) return byPath
  }

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

  const notesByPath = new Map(allNotes.map((note) => [note.path.toLowerCase(), note]))
  for (const title of titles) {
    const stem = wikiPathStem(title)?.toLowerCase()
    if (stem === undefined) continue
    const note = notesByPath.get(`${stem}.md`) ?? notesByPath.get(stem)
    if (note) resultMap.set(title, { id: note.id, path: note.path })
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
 * Distinct sources whose wiki-links reach a note about to be renamed or moved.
 *
 * Resolved rows are matched by target id. Unresolved rows (`target_id` null)
 * are matched by the indexed title — the SPLIT note-half a link was stored
 * under (`extractWikiLinks`), so pass `splitWikiTarget(oldTitle).note`, not
 * the raw title — or by any path form of the note's old `path`, because a
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
        and(isNull(noteLinks.targetId), targetTitleIn([indexedTitle, ...pathLinkKeys(oldPath)]))
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
