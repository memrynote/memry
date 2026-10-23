import { isDeletedBookPlan, planNote, type PlanNoteOptions } from '@memry/importers/readwise'
import { READWISE_CATEGORIES, type ReadwiseCategory } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { exportPages, ReadwiseError, sleep, type ReadwiseBook } from './client'
import { markLinkState } from './links-repository'
import { upsertReadwiseNote, type UpsertOutcome } from './note-writer'
import { readReadwiseOptions } from './settings'
import { getCursor, removeRetry, setCursor, setFullPassPending, setLastRun } from './sync-state'

const log = createLogger('Readwise:Sync')

/**
 * The Readwise run engine (#1408 D7). The first import and every later run
 * go through `run`: one code path, which #1415 extends with the incremental
 * fetch. With no cursor the export already returns full books, so a book
 * goes straight from the export to the mapper (#1410) and the writer (#1412).
 */

export type PreviewCategory = ReadwiseCategory | 'other'

export interface CategoryCount {
  books: number
  highlights: number
  /** A few titles, for the preview. */
  sampleTitles: string[]
}

export type LibraryCounts = Record<PreviewCategory, CategoryCount>

const SAMPLE_TITLES = 3
/** A cursor with no highlight to anchor on starts this far before the run, absorbing clock skew. */
const EMPTY_LIBRARY_CURSOR_MARGIN_MS = 5 * 60 * 1000

function categoryOf(book: ReadwiseBook): PreviewCategory {
  const category = (book.category ?? '').trim().toLowerCase()
  return (READWISE_CATEGORIES as readonly string[]).includes(category)
    ? (category as ReadwiseCategory)
    : 'other'
}

function bookTitle(book: ReadwiseBook): string {
  return (book.readable_title || book.title || '').trim() || 'Untitled'
}

function isLive(highlight: { is_deleted?: boolean | null; is_discard?: boolean | null }): boolean {
  return !highlight.is_deleted && !highlight.is_discard
}

/**
 * Counts the library by category without writing anything (the first-import
 * preview). Reads the whole export, like the run does.
 */
export async function countLibrary(token: string, signal: AbortSignal): Promise<LibraryCounts> {
  const empty = (): CategoryCount => ({ books: 0, highlights: 0, sampleTitles: [] })
  const counts: LibraryCounts = {
    books: empty(),
    articles: empty(),
    tweets: empty(),
    podcasts: empty(),
    supplementals: empty(),
    other: empty()
  }
  for await (const page of exportPages({ token, includeDeleted: false, signal })) {
    for (const book of page) {
      if (book.is_deleted) continue
      const entry = counts[categoryOf(book)]
      entry.books += 1
      entry.highlights += book.highlights.filter(isLive).length
      if (entry.sampleTitles.length < SAMPLE_TITLES) entry.sampleTitles.push(bookTitle(book))
    }
  }
  return counts
}

export type BookEvent =
  | { title: string; result: 'created' | 'updated' | 'appended' | 'unchanged' }
  | {
      title: string
      result: 'skipped'
      reason: 'category-off' | 'note-deleted' | 'source-deleted' | 'busy'
    }
  | { title: string; result: 'failed'; reason: string }

export interface RunObserver {
  signal: AbortSignal
  /** The export is being read. */
  reading?(): void
  /** The export is read: `total` books will be looked at. */
  planned?(total: number): void
  /** A book is about to be written. */
  writing?(title: string): void
  /** A book is done. */
  book(event: BookEvent): void
}

export interface RunResult {
  cancelled: boolean
  books: number
}

export interface SyncServiceDeps {
  /** Resolves once memry sync is not in the middle of its launch pull (D8). */
  waitForSync?: (signal: AbortSignal) => Promise<void>
  now?: () => Date
}

function toEvent(title: string, outcome: UpsertOutcome): BookEvent {
  if (outcome.status === 'failed') return { title, result: 'failed', reason: outcome.reason }
  if (outcome.status === 'skipped') return { title, result: 'skipped', reason: outcome.reason }
  return { title, result: outcome.status }
}

/** The cursor: the newest highlight `updated_at` seen, minus one second (D7). Readwise time, not ours. */
function nextCursor(books: ReadwiseBook[], previous: string | null, startedAt: Date): string {
  let newest = Number.NEGATIVE_INFINITY
  for (const book of books) {
    for (const highlight of book.highlights) {
      const time = highlight.updated_at ? Date.parse(highlight.updated_at) : Number.NaN
      if (!Number.isNaN(time) && time > newest) newest = time
    }
  }
  const candidate =
    newest === Number.NEGATIVE_INFINITY
      ? startedAt.getTime() - EMPTY_LIBRARY_CURSOR_MARGIN_MS
      : newest - 1000
  const kept = previous === null ? Number.NaN : Date.parse(previous)
  return new Date(Number.isNaN(kept) ? candidate : Math.max(kept, candidate)).toISOString()
}

export class ReadwiseSyncService {
  private running = false

  constructor(private readonly deps: SyncServiceDeps = {}) {}

  get isRunning(): boolean {
    return this.running
  }

  /**
   * One run: read the export, write each book through the note writer, then
   * move the cursor once (D7). A failing book is reported and goes on the retry
   * list (the writer does that), and never stops the run. A cancelled run
   * writes nothing further and leaves the cursor where it was.
   */
  async run(token: string, observer: RunObserver): Promise<RunResult> {
    if (this.running) throw new Error('A Readwise run is already in progress')
    this.running = true
    const { signal } = observer
    try {
      await this.deps.waitForSync?.(signal)
      const db = getDatabase()
      const startedAt = (this.deps.now ?? (() => new Date()))()
      const options = readReadwiseOptions(db)
      const planOptions: PlanNoteOptions = {
        root: options.rootFolder,
        folderLayout: options.folderLayout,
        categories: options.categories,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }

      observer.reading?.()
      const books: ReadwiseBook[] = []
      try {
        for await (const page of exportPages({ token, includeDeleted: true, signal })) {
          books.push(...page)
        }
      } catch (error) {
        if (signal.aborted) return { cancelled: true, books: 0 }
        if (error instanceof ReadwiseError && error.code === 'invalid-token') {
          setLastRun(db, { at: new Date().toISOString(), needsAttention: true })
        }
        throw error
      }

      observer.planned?.(books.length)
      for (const book of books) {
        if (signal.aborted) return { cancelled: true, books: books.length }
        observer.book(await this.writeBook(book, planOptions, observer))
      }

      setCursor(db, nextCursor(books, getCursor(db), startedAt))
      // A full pass has read every category, so a pending one is done.
      setFullPassPending(db, false)
      setLastRun(db, { at: new Date().toISOString(), needsAttention: false })
      return { cancelled: false, books: books.length }
    } finally {
      this.running = false
    }
  }

  private async writeBook(
    book: ReadwiseBook,
    planOptions: PlanNoteOptions,
    observer: RunObserver
  ): Promise<BookEvent> {
    const title = bookTitle(book)
    const db = getDatabase()
    try {
      const plan = planNote(book, planOptions)
      if (plan === null) {
        removeRetry(db, book.user_book_id)
        return { title, result: 'skipped', reason: 'category-off' }
      }
      if (isDeletedBookPlan(plan)) {
        // D9: the note stays, and the book stops syncing.
        markLinkState(db, { readwiseBookId: book.user_book_id }, 'source-deleted')
        removeRetry(db, book.user_book_id)
        return { title, result: 'skipped', reason: 'source-deleted' }
      }
      observer.writing?.(title)
      return toEvent(title, await upsertReadwiseNote(book, plan, { planOptions }))
    } catch (error) {
      // The writer reports its own failures. This catches the mapper and the
      // retry bookkeeping, so one book still cannot stop the run.
      log.warn('A Readwise book could not be processed', { bookId: book.user_book_id, error })
      return {
        title,
        result: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

let service: ReadwiseSyncService | null = null

/** The process's run engine. The import dialog and (#1415) the scheduler share it, so runs never overlap. */
export function getReadwiseSyncService(): ReadwiseSyncService {
  service ??= new ReadwiseSyncService({ waitForSync: waitForMemrySync })
  return service
}

const SYNC_WAIT_POLL_MS = 500
const SYNC_WAIT_MAX_MS = 60_000

/**
 * D8: notes another device just created arrive with memry sync's launch pull.
 * A run that started before them would not find the notes it should adopt.
 * Waits while that pull is in progress, up to a minute.
 */
async function waitForMemrySync(signal: AbortSignal): Promise<void> {
  // Lazy: the sync runtime pulls in the whole sync stack, which a Readwise run
  // needs only for this one state read.
  const { getSyncEngine } = await import('../sync/runtime')
  for (let waited = 0; waited < SYNC_WAIT_MAX_MS; waited += SYNC_WAIT_POLL_MS) {
    if (getSyncEngine()?.currentState !== 'syncing') return
    await sleep(SYNC_WAIT_POLL_MS, signal)
  }
}
