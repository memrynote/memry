import {
  highlightDay,
  planJournalWrite,
  type JournalBook,
  type ReadwiseBook
} from '@memry/importers/readwise'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { appendToJournalEntry, updateJournalEntry } from '../journal/update-entry'
import { resolveJournalEntryId } from '../journal/create-entry'
import { getFeaturesSettings } from '../settings/features'
import { getCrdtProvider } from '../sync/crdt-provider'
import { wasRecentNetworkUpdate } from '../sync/crdt-writeback'
import { readJournalEntry } from '../vault/journal'
import { getNoteById } from '../vault/notes'
import {
  highlightsBetween,
  knownHighlightIds,
  markBooksDeleted,
  replaceIndex,
  toIndexRows,
  upsertHighlights
} from './highlights-index'
import { getLinkByBookId } from './links-repository'
import {
  getJournalPending,
  setHighlightIndexReady,
  setJournalPending,
  type JournalPending
} from './sync-state'

const log = createLogger('ReadwiseJournal')

/**
 * The journal side of a Readwise run (#3476, D17). `recordHighlights` keeps the
 * device-local index current and notes which journal days owe a write, and
 * `flushJournal` writes them through the journal owner.
 */

/** The switch is on and the journal feature is on. Nothing is written otherwise. */
export function journalHighlightsOn(switchOn: boolean): boolean {
  return switchOn && getFeaturesSettings().journal
}

export interface RecordOptions {
  /** The books came from a full export: the index is rebuilt from them. */
  rebuild: boolean
  /**
   * The highlights new to the index are new arrivals. False for the first
   * import, a takeover's first run and a category full pass, which only fill
   * the index (D17, no backfill).
   */
  countArrivals: boolean
  /** The switch and the journal feature are on. Off clears what was pending. */
  enabled: boolean
  timeZone: string
}

/**
 * Updates the index from the books a run saw, and the pending days with the
 * arrivals, in one transaction: a crash re-reads the same window, and the
 * highlights that arrived are already owed to the journal.
 */
export function recordHighlights(
  db: DataDb,
  books: readonly ReadwiseBook[],
  options: RecordOptions
): void {
  // Later books win, so a full fetch overrides the export's partial payload.
  const byId = new Map(toIndexRows(books).map((row) => [row.highlightId, row]))
  const rows = [...byId.values()]
  db.transaction((tx) => {
    const pending: JournalPending = options.enabled ? getJournalPending(tx) : {}
    if (options.enabled && options.countArrivals) {
      const known = knownHighlightIds(tx, [...byId.keys()])
      for (const row of rows) {
        if (row.deleted || known.has(row.highlightId)) continue
        const day = highlightDay(
          { highlightedAt: row.highlightedAt, createdAt: row.createdAt },
          options.timeZone
        )
        if (day === null) continue
        const forDay = (pending[day] ??= {})
        forDay[String(row.bookId)] = (forDay[String(row.bookId)] ?? 0) + 1
      }
    }
    if (options.rebuild) {
      replaceIndex(tx, rows)
      setHighlightIndexReady(tx)
    } else {
      upsertHighlights(tx, rows)
    }
    markBooksDeleted(
      tx,
      books.filter((book) => book.is_deleted).map((book) => book.user_book_id)
    )
    setJournalPending(tx, pending)
  })
}

/** The entry is open in an editor or took a network update moments ago (D6). */
function isBusy(date: string): boolean {
  const id = resolveJournalEntryId(date)
  return Boolean(getCrdtProvider().getDoc(id)) || wasRecentNetworkUpdate(id)
}

type DayWrite = 'written' | 'unchanged' | 'busy'

async function writeDay(
  date: string,
  day: readonly JournalBook[],
  arrivals: readonly JournalBook[]
): Promise<DayWrite> {
  if (isBusy(date)) return 'busy'
  const existing = await readJournalEntry(date)
  const plan = planJournalWrite(existing?.content ?? null, day, arrivals)
  if (plan.kind === 'unchanged') return 'unchanged'
  // The read above waited on the disk: an editor may have opened since.
  if (isBusy(date)) return 'busy'
  try {
    if (plan.kind === 'append') await appendToJournalEntry(date, plan.markdown)
    else await updateJournalEntry({ date, content: plan.content })
  } catch (error) {
    // The file is written before the cache, sync queue and editor doc are
    // updated. When it is on disk, a retry would append the same line again.
    const now = (await readJournalEntry(date))?.content ?? null
    const onDisk =
      now !== null && (plan.kind === 'append' ? now.includes(plan.markdown) : now === plan.content)
    if (!onDisk) throw error
    log.warn('A Readwise journal day was written, but a later step failed', { date, error })
  }
  return 'written'
}

const MS_PER_HOUR = 3_600_000

/** Every local date that is `date` somewhere on Earth lies in this window (UTC-12 to UTC+14). */
function dayWindow(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00.000Z`)
  return {
    from: new Date(start - 14 * MS_PER_HOUR).toISOString(),
    to: new Date(start + 36 * MS_PER_HOUR).toISOString()
  }
}

/** The live highlights of `date` in the index, grouped by book. */
function booksOfDay(
  db: DataDb,
  date: string,
  timeZone: string
): Map<number, { count: number; first: string }> {
  const { from, to } = dayWindow(date)
  const books = new Map<number, { count: number; first: string }>()
  for (const row of highlightsBetween(db, from, to)) {
    if (highlightDay({ highlightedAt: row.at }, timeZone) !== date) continue
    const entry = books.get(row.bookId)
    if (entry) {
      entry.count += 1
      if (row.at < entry.first) entry.first = row.at
    } else {
      books.set(row.bookId, { count: 1, first: row.at })
    }
  }
  return books
}

/** The book note's current title, or null when the book has no note to link. */
async function bookTitle(db: DataDb, bookId: number): Promise<string | null> {
  const link = getLinkByBookId(db, bookId)
  if (!link || link.state !== 'linked') return null
  return (await getNoteById(link.noteId))?.title ?? null
}

export interface FlushOptions {
  timeZone: string
  /** Books whose note write is still owed: their journal lines wait for the note. */
  retryBookIds: ReadonlySet<number>
  stopped: () => boolean
}

/**
 * Writes the pending days, oldest first. A day whose entry is open in an
 * editor, or whose write failed, stays pending for the next run (D6). Books
 * without a note are left out, and dropped unless their note is still owed.
 */
export async function flushJournal(db: DataDb, options: FlushOptions): Promise<void> {
  const pending = getJournalPending(db)
  const titles = new Map<number, string | null>()
  const titleOf = async (bookId: number): Promise<string | null> => {
    if (!titles.has(bookId)) titles.set(bookId, await bookTitle(db, bookId))
    return titles.get(bookId) ?? null
  }

  for (const date of Object.keys(pending).sort()) {
    if (options.stopped()) return
    let outcome: DayWrite | 'failed'
    const stays: Record<string, number> = {}
    const owed = pending[date]
    try {
      const day = new Map<number, JournalBook>()
      for (const [bookId, entry] of booksOfDay(db, date, options.timeZone)) {
        const title = await titleOf(bookId)
        if (title !== null) day.set(bookId, { title, count: entry.count, first: entry.first })
      }
      const arrivals: JournalBook[] = []
      for (const [key, count] of Object.entries(pending[date])) {
        const bookId = Number(key)
        const title = await titleOf(bookId)
        const listed = day.get(bookId)
        if (title !== null && listed) arrivals.push({ title, count, first: listed.first })
        else if (title === null && options.retryBookIds.has(bookId)) stays[key] = count
      }
      // Pending goes first: a crash after the write must not append the same
      // lines again. A day that was not written gets its entry back below.
      const rest = { ...getJournalPending(db) }
      if (Object.keys(stays).length > 0) rest[date] = stays
      else delete rest[date]
      setJournalPending(db, rest)
      outcome = await writeDay(date, [...day.values()], arrivals)
    } catch (error) {
      log.warn('A Readwise journal day could not be written', { date, error })
      outcome = 'failed'
    }
    if (outcome === 'busy' || outcome === 'failed') {
      // Keep the whole day: the next run writes it, or the entry closes first.
      setJournalPending(db, { ...getJournalPending(db), [date]: owed })
    }
  }
}
