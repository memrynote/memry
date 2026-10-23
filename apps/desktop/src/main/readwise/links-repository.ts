import { and, asc, eq } from 'drizzle-orm'
import {
  readwiseLinks,
  type ReadwiseLink,
  type ReadwiseLinkState
} from '@memry/db-schema/schema/readwise-links'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from '../database/types'

export type LinkKey = { readwiseBookId: number } | { readerDocumentId: string } | { noteId: string }

export interface UpsertLinkInput {
  readwiseBookId?: number | null
  readerDocumentId?: string | null
  noteId: string
  state?: ReadwiseLinkState
}

export function getLinkByBookId(db: DataDb, readwiseBookId: number): ReadwiseLink | undefined {
  return db
    .select()
    .from(readwiseLinks)
    .where(eq(readwiseLinks.readwiseBookId, readwiseBookId))
    .get()
}

export function getLinkByReaderDocumentId(
  db: DataDb,
  readerDocumentId: string
): ReadwiseLink | undefined {
  return db
    .select()
    .from(readwiseLinks)
    .where(eq(readwiseLinks.readerDocumentId, readerDocumentId))
    .get()
}

/**
 * The row of a v2 book: by its own id, or by its `external_id`, which is the Reader
 * document's id (D11). A Reader note made before the book's highlights arrived is
 * found the second way, so the book writes into that note and makes no second one.
 */
export function getLinkForBook(
  db: DataDb,
  readwiseBookId: number,
  externalId: string | null | undefined
): ReadwiseLink | undefined {
  return (
    getLinkByBookId(db, readwiseBookId) ??
    (externalId ? getLinkByReaderDocumentId(db, externalId) : undefined)
  )
}

/**
 * Gives a row the id it lacks, so the book and its Reader document share one
 * note (D11). Another row that already holds the id is left alone: two notes
 * named the same item (a takeover can bring both), and the lowest id keeps it.
 */
export function completeLink(
  db: DataDb,
  link: ReadwiseLink,
  ids: { readwiseBookId: number; readerDocumentId: string | null | undefined }
): void {
  const readwiseBookId = link.readwiseBookId ?? ids.readwiseBookId
  const readerDocumentId = link.readerDocumentId ?? ids.readerDocumentId ?? null
  if (readwiseBookId === link.readwiseBookId && readerDocumentId === link.readerDocumentId) return
  const taken =
    (link.readwiseBookId === null && getLinkByBookId(db, readwiseBookId)) ||
    (link.readerDocumentId === null &&
      readerDocumentId !== null &&
      getLinkByReaderDocumentId(db, readerDocumentId))
  if (taken) return
  db.update(readwiseLinks)
    .set({ readwiseBookId, readerDocumentId, updatedAt: utcNow() })
    .where(eq(readwiseLinks.id, link.id))
    .run()
}

export function getLinkByNoteId(db: DataDb, noteId: string): ReadwiseLink | undefined {
  return db
    .select()
    .from(readwiseLinks)
    .where(eq(readwiseLinks.noteId, noteId))
    .orderBy(asc(readwiseLinks.id))
    .get()
}

export function listLinks(db: DataDb, state?: ReadwiseLinkState): ReadwiseLink[] {
  const query = db.select().from(readwiseLinks)
  return (state ? query.where(eq(readwiseLinks.state, state)) : query)
    .orderBy(asc(readwiseLinks.id))
    .all()
}

/**
 * Inserts or updates the row that holds this book or Reader document. A row
 * found by either id keeps its identity and gains the other id, so a Reader
 * document linked first can pick up its book id later.
 */
export function upsertLink(db: DataDb, input: UpsertLinkInput): ReadwiseLink {
  const { readwiseBookId = null, readerDocumentId = null, noteId, state = 'linked' } = input
  if (readwiseBookId === null && readerDocumentId === null) {
    throw new Error('upsertLink needs a readwiseBookId or a readerDocumentId')
  }
  return db.transaction((tx) => {
    const existing =
      (readwiseBookId !== null ? getLinkByBookId(tx, readwiseBookId) : undefined) ??
      (readerDocumentId !== null ? getLinkByReaderDocumentId(tx, readerDocumentId) : undefined)
    if (!existing) {
      return tx
        .insert(readwiseLinks)
        .values({ readwiseBookId, readerDocumentId, noteId, state, updatedAt: utcNow() })
        .returning()
        .get()
    }
    // Another row can already hold the id (a takeover rebuilt two notes for one
    // document, D11): the unique index would reject it, so this row keeps its own.
    const heldElsewhere =
      readerDocumentId !== null &&
      existing.readerDocumentId !== readerDocumentId &&
      getLinkByReaderDocumentId(tx, readerDocumentId) !== undefined
    return tx
      .update(readwiseLinks)
      .set({
        readwiseBookId: readwiseBookId ?? existing.readwiseBookId,
        readerDocumentId: heldElsewhere
          ? existing.readerDocumentId
          : (readerDocumentId ?? existing.readerDocumentId),
        noteId,
        state,
        updatedAt: utcNow()
      })
      .where(eq(readwiseLinks.id, existing.id))
      .returning()
      .get()
  })
}

function keyCondition(key: LinkKey) {
  if ('readwiseBookId' in key) return eq(readwiseLinks.readwiseBookId, key.readwiseBookId)
  if ('readerDocumentId' in key) return eq(readwiseLinks.readerDocumentId, key.readerDocumentId)
  return eq(readwiseLinks.noteId, key.noteId)
}

/** Returns the updated row, or undefined when no row matches the key. */
export function markLinkState(
  db: DataDb,
  key: LinkKey,
  state: ReadwiseLinkState
): ReadwiseLink | undefined {
  return db
    .update(readwiseLinks)
    .set({ state, updatedAt: utcNow() })
    .where(and(keyCondition(key)))
    .returning()
    .get()
}
