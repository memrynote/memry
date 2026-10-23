import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { readwiseHighlights } from '@memry/db-schema/schema/readwise-highlights'
import { highlightInstant, type ReadwiseBook } from '@memry/importers/readwise'
import type { DataDb } from '../database/types'

/**
 * The device-local index of highlight dates behind the journal day sections
 * (#3476, D17). `upsertHighlights` keeps it current on every run, and
 * `replaceIndex` rebuilds it from a full export, so a device that takes over
 * renders the bytes the old one wrote.
 */

/** SQLite allows 999 bound variables on old builds: 5 columns per inserted row, 1 per looked-up id. */
const INSERT_CHUNK = 150
const LOOKUP_CHUNK = 500

type IndexRow = typeof readwiseHighlights.$inferInsert & { highlightId: number }

/** One row per highlight the books hold, deleted and discarded ones flagged. */
export function toIndexRows(books: readonly ReadwiseBook[]): IndexRow[] {
  const rows: IndexRow[] = []
  for (const book of books) {
    for (const highlight of book.highlights ?? []) {
      rows.push({
        highlightId: highlight.id,
        bookId: book.user_book_id,
        highlightedAt: highlightInstant({ highlightedAt: highlight.highlighted_at }),
        createdAt: highlightInstant({ createdAt: highlight.created_at }),
        deleted: Boolean(book.is_deleted || highlight.is_deleted || highlight.is_discard)
      })
    }
  }
  return rows
}

function insertRows(db: DataDb, rows: readonly IndexRow[]): void {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    db.insert(readwiseHighlights)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoUpdate({
        target: readwiseHighlights.highlightId,
        set: {
          bookId: sql`excluded.book_id`,
          highlightedAt: sql`excluded.highlighted_at`,
          createdAt: sql`excluded.created_at`,
          deleted: sql`excluded.deleted`
        }
      })
      .run()
  }
}

/** The ids among `ids` the index already holds. */
export function knownHighlightIds(db: DataDb, ids: readonly number[]): Set<number> {
  const known = new Set<number>()
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const rows = db
      .select({ id: readwiseHighlights.highlightId })
      .from(readwiseHighlights)
      .where(inArray(readwiseHighlights.highlightId, ids.slice(i, i + LOOKUP_CHUNK)))
      .all()
    for (const row of rows) known.add(row.id)
  }
  return known
}

/** A book deleted in Readwise: every highlight of it is deleted, whichever of them the payload held. */
export function markBooksDeleted(db: DataDb, bookIds: readonly number[]): void {
  for (let i = 0; i < bookIds.length; i += LOOKUP_CHUNK) {
    db.update(readwiseHighlights)
      .set({ deleted: true })
      .where(inArray(readwiseHighlights.bookId, bookIds.slice(i, i + LOOKUP_CHUNK)))
      .run()
  }
}

export function upsertHighlights(db: DataDb, rows: readonly IndexRow[]): void {
  db.transaction((tx) => insertRows(tx, rows))
}

/** Replaces the whole index with `rows` (a full export). */
export function replaceIndex(db: DataDb, rows: readonly IndexRow[]): void {
  db.transaction((tx) => {
    tx.delete(readwiseHighlights).run()
    insertRows(tx, rows)
  })
}

/** A live highlight in the index. */
export interface IndexedHighlight {
  highlightId: number
  bookId: number
  /** `highlighted_at`, or `created_at` when it is missing. */
  at: string
}

/**
 * The highlights whose date falls between `from` and `to` (ISO instants,
 * `to` exclusive). A day is a local date, so the caller widens its window by
 * the largest UTC offset and filters by `highlightDay` afterwards.
 */
export function highlightsBetween(db: DataDb, from: string, to: string): IndexedHighlight[] {
  const at = sql<string>`coalesce(${readwiseHighlights.highlightedAt}, ${readwiseHighlights.createdAt})`
  return db
    .select({
      highlightId: readwiseHighlights.highlightId,
      bookId: readwiseHighlights.bookId,
      at
    })
    .from(readwiseHighlights)
    .where(and(gte(at, from), lt(at, to), eq(readwiseHighlights.deleted, false)))
    .all()
}
