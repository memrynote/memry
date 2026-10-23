import { isDeletedBookPlan, planNote, type PlanNoteOptions } from '@memry/importers/readwise'
import { READWISE_CATEGORIES, type ReadwiseCategory } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { recordActivity } from '../vault/activity-log'
import { createLogger } from '../lib/logger'
import { exportBooks, exportPages, ReadwiseError, sleep, type ReadwiseBook } from './client'
import { markLinkState } from './links-repository'
import { upsertReadwiseNote, type UpsertOutcome } from './note-writer'
import { readReadwiseOptions } from './settings'
import {
  addRetry,
  getCursor,
  getFullPassPending,
  getLastFullRead,
  getRetryList,
  removeRetry,
  setCursor,
  setFullPassPending,
  setLastFullRead,
  setLastRun
} from './sync-state'

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
  /**
   * The engine writes the run's activity log line when something changed
   * (D19). The import runner writes its own summary, so it sets this to false.
   */
  logActivity?: boolean
}

export interface RunResult {
  cancelled: boolean
  /** Books looked at: the retry list and the books the export named as changed. */
  books: number
  added: number
  updated: number
  appended: number
  /** Skipped because the note is open in an editor. They are on the retry list. */
  deferred: number
  failed: number
  /** Highlights in the books that changed, as the export reported them. */
  highlights: number
}

export interface SyncServiceDeps {
  /** Resolves once memry sync is not in the middle of its launch pull (D8). */
  waitForSync?: (signal: AbortSignal) => Promise<void>
  now?: () => Date
}

/**
 * Highlights can change without `updatedAfter` saying so for a book-level edit
 * (a new `document_note`). #1415 could not check that against the live API (the
 * test account holds no highlights), so a run reads the whole export once a day.
 * Untouched sections come out identical and cost no write (D5).
 */
export const FULL_READ_INTERVAL_MS = 24 * 60 * 60 * 1000

function toEvent(
  title: string,
  outcome: Exclude<UpsertOutcome, { status: 'needs-full' }>
): BookEvent {
  if (outcome.status === 'failed') return { title, result: 'failed', reason: outcome.reason }
  if (outcome.status === 'skipped') return { title, result: 'skipped', reason: outcome.reason }
  return { title, result: outcome.status }
}

/**
 * The cursor: the newest highlight `updated_at` seen, minus one second (D7).
 * Readwise time, not ours. It reads the export's own payload, never the books
 * fetched by `ids=` afterwards, which can hold edits newer than the export.
 * Never moves back, and stays put when the export held no highlight.
 */
function nextCursor(books: ReadwiseBook[], previous: string | null, startedAt: Date): string {
  let newest = Number.NEGATIVE_INFINITY
  for (const book of books) {
    for (const highlight of book.highlights) {
      const time = highlight.updated_at ? Date.parse(highlight.updated_at) : Number.NaN
      if (!Number.isNaN(time) && time > newest) newest = time
    }
  }
  const kept = previous === null ? Number.NaN : Date.parse(previous)
  if (newest === Number.NEGATIVE_INFINITY) {
    return new Date(
      Number.isNaN(kept) ? startedAt.getTime() - EMPTY_LIBRARY_CURSOR_MARGIN_MS : kept
    ).toISOString()
  }
  const candidate = newest - 1000
  return new Date(Number.isNaN(kept) ? candidate : Math.max(kept, candidate)).toISOString()
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

type Written = { event: BookEvent } | { needsFull: true }

export class ReadwiseSyncService {
  private running = false

  constructor(private readonly deps: SyncServiceDeps = {}) {}

  get isRunning(): boolean {
    return this.running
  }

  /**
   * One run (D7): the retry list by `ids=`, then the export since the cursor
   * to learn which books changed, then the full books where a render needs
   * them (new notes and untouched sections). Touched sections take the export's
   * payload. The cursor moves once, when the run completes: a crash re-runs the
   * same window and the writer's no-op rule makes that free. A failing or
   * deferred book goes on the retry list and never stops the run. A cancelled
   * run writes nothing further and leaves the cursor where it was.
   *
   * With no cursor, a pending full pass (a category was switched on, D7), or
   * a day since the last full read, the export has no `updatedAfter` and
   * already returns full books.
   */
  async run(token: string, observer: RunObserver): Promise<RunResult> {
    if (this.running) throw new Error('A Readwise run is already in progress')
    this.running = true
    const { signal } = observer
    const result: RunResult = {
      cancelled: false,
      books: 0,
      added: 0,
      updated: 0,
      appended: 0,
      deferred: 0,
      failed: 0,
      highlights: 0
    }
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
      const cursor = getCursor(db)
      const lastFullRead = getLastFullRead(db)
      const lastFullAt = lastFullRead === null ? Number.NaN : Date.parse(lastFullRead)
      const full =
        cursor === null ||
        getFullPassPending(db) ||
        Number.isNaN(lastFullAt) ||
        startedAt.getTime() - lastFullAt >= FULL_READ_INTERVAL_MS
      const cancelled = (): RunResult => ({ ...result, cancelled: true })
      const needsAttention = (error: unknown): void => {
        if (error instanceof ReadwiseError && error.code === 'invalid-token') {
          setLastRun(db, { at: new Date().toISOString(), needsAttention: true })
        }
      }

      observer.reading?.()
      // 1. The retry list, as full books.
      const retryIds = getRetryList(db).map((entry) => entry.readwiseBookId)
      let retryBooks: ReadwiseBook[] = []
      let retryFetched = true
      try {
        retryBooks = await readBooks(token, retryIds, signal)
      } catch (error) {
        if (signal.aborted) return cancelled()
        needsAttention(error)
        if (error instanceof ReadwiseError && error.code === 'invalid-token') throw error
        // The books stay on the list for the next run.
        retryFetched = false
        log.warn('The Readwise retry list could not be fetched', { error })
      }
      const fetchedRetryIds = new Set(retryBooks.map((book) => book.user_book_id))

      // 2. What changed.
      const exported: ReadwiseBook[] = []
      try {
        for await (const page of exportPages({
          token,
          updatedAfter: full ? undefined : (cursor ?? undefined),
          includeDeleted: true,
          signal
        })) {
          exported.push(...page)
        }
      } catch (error) {
        if (signal.aborted) return cancelled()
        needsAttention(error)
        throw error
      }
      const exportedIds = new Set(exported.map((book) => book.user_book_id))
      if (retryFetched) {
        // `ids=` answered without the book and the export does not name it: it
        // is gone from Readwise, and asking again would never end.
        for (const id of retryIds) {
          if (!fetchedRetryIds.has(id) && !exportedIds.has(id)) removeRetry(db, id)
        }
      }
      const changed = exported.filter((book) => !fetchedRetryIds.has(book.user_book_id))

      const total = retryBooks.length + changed.length
      result.books = total
      observer.planned?.(total)

      const finish = (written: Written, payload: ReadwiseBook): void => {
        if ('needsFull' in written) return
        tally(result, written.event, payload)
        observer.book(written.event)
      }

      // The highlights each book brought, as the export reported them.
      const needFull: ReadwiseBook[] = []
      for (const book of retryBooks) {
        if (signal.aborted) return cancelled()
        finish(await this.writeBook(book, planOptions, observer, false), book)
      }
      for (const book of changed) {
        if (signal.aborted) return cancelled()
        const written = await this.writeBook(book, planOptions, observer, !full)
        if ('needsFull' in written) needFull.push(book)
        else finish(written, book)
      }

      // 3. The full books that a render needs.
      if (needFull.length > 0) {
        const payloads = new Map(needFull.map((book) => [book.user_book_id, book]))
        let fullBooks: ReadwiseBook[]
        try {
          fullBooks = await readBooks(token, [...payloads.keys()], signal)
        } catch (error) {
          if (signal.aborted) return cancelled()
          needsAttention(error)
          if (error instanceof ReadwiseError && error.code === 'invalid-token') throw error
          // Rate limit or network: each book is asked for again next run.
          const reason = error instanceof Error ? error.message : String(error)
          for (const book of needFull) {
            addRetry(db, book.user_book_id, reason)
            finish({ event: { title: bookTitle(book), result: 'failed', reason } }, book)
          }
          fullBooks = []
          payloads.clear()
        }
        for (const fullBook of fullBooks) {
          if (signal.aborted) return cancelled()
          const payload = payloads.get(fullBook.user_book_id)
          if (!payload) continue
          payloads.delete(fullBook.user_book_id)
          finish(await this.writeBook(fullBook, planOptions, observer, false), payload)
        }
        for (const gone of payloads.values()) {
          // Gone from Readwise between the two reads: nothing to render.
          log.info('A Readwise book vanished between the export and its full fetch', {
            bookId: gone.user_book_id
          })
          finish({ event: { title: bookTitle(gone), result: 'unchanged' } }, gone)
        }
      }

      setCursor(db, nextCursor(exported, cursor, startedAt))
      if (full) {
        setLastFullRead(db, startedAt.toISOString())
        // A category switched on while this run was reading keeps its flag.
        const now = readReadwiseOptions(db)
        const gained = READWISE_CATEGORIES.some(
          (category) => now.categories[category] && !options.categories[category]
        )
        if (!gained) setFullPassPending(db, false)
      }
      setLastRun(db, { at: new Date().toISOString(), needsAttention: false })
      const changedBooks = result.added + result.updated + result.appended
      if (changedBooks > 0 && observer.logActivity !== false) {
        recordActivity({
          kind: 'import',
          source: 'import',
          importer: 'readwise',
          message: `Readwise: ${plural(changedBooks, 'book')}, ${plural(result.highlights, 'highlight')}`,
          counts: { imported: changedBooks, failed: result.failed }
        })
      }
      return result
    } finally {
      this.running = false
    }
  }

  private async writeBook(
    book: ReadwiseBook,
    planOptions: PlanNoteOptions,
    observer: RunObserver,
    incremental: boolean
  ): Promise<Written> {
    const title = bookTitle(book)
    const db = getDatabase()
    try {
      const plan = planNote(book, planOptions)
      if (plan === null) {
        removeRetry(db, book.user_book_id)
        return { event: { title, result: 'skipped', reason: 'category-off' } }
      }
      if (isDeletedBookPlan(plan)) {
        // D9: the note stays, and the book stops syncing.
        markLinkState(db, { readwiseBookId: book.user_book_id }, 'source-deleted')
        removeRetry(db, book.user_book_id)
        return { event: { title, result: 'skipped', reason: 'source-deleted' } }
      }
      observer.writing?.(title)
      const outcome = await upsertReadwiseNote(book, plan, { planOptions, incremental })
      if (outcome.status === 'needs-full') return { needsFull: true }
      return { event: toEvent(title, outcome) }
    } catch (error) {
      // The writer reports its own failures. This catches the mapper and the
      // retry bookkeeping, so one book still cannot stop the run.
      log.warn('A Readwise book could not be processed', { bookId: book.user_book_id, error })
      return {
        event: {
          title,
          result: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}

async function readBooks(
  token: string,
  ids: readonly number[],
  signal: AbortSignal
): Promise<ReadwiseBook[]> {
  const books: ReadwiseBook[] = []
  if (ids.length === 0) return books
  for await (const page of exportBooks({ token, ids, signal })) books.push(...page)
  return books
}

/** Adds the book's result to the run's counts. `payload` holds the highlights the export reported. */
function tally(result: RunResult, event: BookEvent, payload: ReadwiseBook): void {
  if (event.result === 'created') result.added += 1
  else if (event.result === 'updated') result.updated += 1
  else if (event.result === 'appended') result.appended += 1
  else if (event.result === 'failed') result.failed += 1
  else if (event.result === 'skipped' && event.reason === 'busy') result.deferred += 1
  if (event.result === 'created' || event.result === 'updated' || event.result === 'appended') {
    result.highlights += payload.highlights.filter(isLive).length
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
