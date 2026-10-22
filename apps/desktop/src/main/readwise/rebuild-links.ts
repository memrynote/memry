import { asc, eq } from 'drizzle-orm'
import { noteProperties } from '@memry/db-schema/schema/notes-cache'
import type { DataDb, IndexDb } from '../database/types'
import { getLinkByBookId, getLinkByReaderDocumentId, upsertLink } from './links-repository'

const BOOK_URL = /^https?:\/\/(?:www\.)?readwise\.io\/bookreview\/(\d+)\/?$/
const READER_URL = /^https?:\/\/read\.readwise\.io\/read\/([A-Za-z0-9_-]+)\/?$/

type Identity = { readwiseBookId: number } | { readerDocumentId: string }

/** The Readwise item a `readwise_url` property names (D4), or null for any other value. */
export function parseReadwiseUrl(url: string): Identity | null {
  const trimmed = url.trim()
  const book = BOOK_URL.exec(trimmed)
  if (book) return { readwiseBookId: Number(book[1]) }
  const reader = READER_URL.exec(trimmed)
  if (reader) return { readerDocumentId: reader[1] }
  return null
}

/**
 * Refills `readwise_links` from the notes' `readwise_url` property, which is the
 * identity that travels with the note (D4). A takeover (D8) and a run that
 * finds the table empty call this.
 *
 * Rows survive a rebuild: `source-deleted` stays so a deleted book does not
 * start syncing again, and a `note-deleted` row whose note is back becomes
 * `linked`. If two notes name the same item, the lowest note id wins, so every
 * device picks the same one.
 *
 * @returns the number of notes linked
 */
export function rebuildLinks(db: DataDb, indexDb: IndexDb): number {
  const rows = indexDb
    .select({ noteId: noteProperties.noteId, value: noteProperties.value })
    .from(noteProperties)
    .where(eq(noteProperties.name, 'readwise_url'))
    .orderBy(asc(noteProperties.noteId))
    .all()

  let linked = 0
  db.transaction((tx) => {
    const seen = new Set<string>()
    for (const { noteId, value } of rows) {
      const identity = value ? parseReadwiseUrl(value) : null
      if (!identity) continue
      const key =
        'readwiseBookId' in identity
          ? `b${identity.readwiseBookId}`
          : `r${identity.readerDocumentId}`
      if (seen.has(key)) continue
      seen.add(key)

      const existing =
        'readwiseBookId' in identity
          ? getLinkByBookId(tx, identity.readwiseBookId)
          : getLinkByReaderDocumentId(tx, identity.readerDocumentId)
      const state = existing?.state === 'source-deleted' ? 'source-deleted' : 'linked'
      upsertLink(tx, { ...identity, noteId, state })
      linked += 1
    }
  })
  return linked
}
