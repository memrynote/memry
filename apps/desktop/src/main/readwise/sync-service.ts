import { isDeletedBookPlan, planNote, type PlanNoteOptions } from '@memry/importers/readwise'
import { READWISE_CATEGORIES, type ReadwiseCategory } from '@memry/contracts/import-channels'
import { getDatabase, getIndexDatabase } from '../database'
import { recordActivity } from '../vault/activity-log'
import { createLogger } from '../lib/logger'
import { exportBooks, exportPages, ReadwiseError, type ReadwiseBook } from './client'
import { awaitPullAuthority, claimLostToAnotherDevice } from './pull-gate'
import { releaseTokenIfClaimedElsewhere } from './release'
import { waitForVaultIndexBuild } from '../sync/vault-index-ready'
import { completeLink, getLinkForBook, listLinks, markLinkState } from './links-repository'
import { rebuildLinks } from './rebuild-links'
import { clearRunFailure, recordRunFailure, setRunProgress } from './run-status'
import { upsertReadwiseNote, type UpsertOutcome } from './note-writer'
import { listDocuments } from './reader'
import { runReaderPass } from './reader-sync'
import { readReadwiseOptions } from './settings'
import {
  addRetry,
  getCursor,
  getFullPassPending,
  getLastRun,
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
  return (await scanLibrary(token, signal)).counts
}

/**
 * What a first import would bring: the counts, and the ids of the Reader
 * documents the v2 books already cover (`external_id`, D11).
 */
export async function scanLibrary(
  token: string,
  signal: AbortSignal
): Promise<{ counts: LibraryCounts; bookExternalIds: Set<string> }> {
  const bookExternalIds = new Set<string>()
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
      if (book.external_id) bookExternalIds.add(book.external_id)
      const entry = counts[categoryOf(book)]
      entry.books += 1
      entry.highlights += book.highlights.filter(isLive).length
      if (entry.sampleTitles.length < SAMPLE_TITLES) entry.sampleTitles.push(bookTitle(book))
    }
  }
  return { counts, bookExternalIds }
}

/**
 * The saved Reader documents a first import would add: the documents without
 * a v2 book (D11), counted from the same list the run reads, without the
 * article HTML. The 20 requests a minute budget makes a large library take
 * minutes, which is why the preview asks only when the switch is on.
 */
export async function countReaderDocuments(
  token: string,
  signal: AbortSignal,
  bookExternalIds: ReadonlySet<string>
): Promise<CategoryCount> {
  const count: CategoryCount = { books: 0, highlights: 0, sampleTitles: [] }
  for await (const page of listDocuments({ token, withHtmlContent: false, signal })) {
    for (const document of page) {
      if (bookExternalIds.has(document.id)) continue
      count.books += 1
      if (count.sampleTitles.length < SAMPLE_TITLES) {
        count.sampleTitles.push((document.title ?? '').trim() || 'Untitled')
      }
    }
  }
  return count
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
  /** `count` more items (Reader documents) will be looked at, on top of `planned`. */
  more?(count: number): void
  /** A book or a Reader document is done. */
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
  /** Reader notes created for saved documents without highlights (D11). */
  documents: number
  /** Highlights in the books that changed, as the export reported them. */
  highlights: number
  /** Another device took Readwise over, so this run stopped at the next book (D8). */
  claimLost?: boolean
}

export interface SyncServiceDeps {
  /**
   * Resolves once this device may pull (D8): sync has completed a pull since
   * launch and the vault is indexed, so the notes other devices wrote are found
   * by `readwise_url`. Rejects when another device pulls.
   */
  awaitReady?: (signal: AbortSignal) => Promise<void>
  /** Re-read before each book: true once another device holds the claim (D8). */
  claimLost?: () => boolean
  /** Called when a run stopped because the claim moved. */
  onClaimLost?: () => void
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
  private stopRun: (() => void) | null = null

  constructor(private readonly deps: SyncServiceDeps = {}) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Stops the run in progress at its next book, whoever started it (#1418). A no-op when idle. */
  cancel(): void {
    this.stopRun?.()
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
    const stop = new AbortController()
    this.stopRun = () => stop.abort()
    const signal = AbortSignal.any([observer.signal, stop.signal])
    const result: RunResult = {
      cancelled: false,
      books: 0,
      added: 0,
      updated: 0,
      appended: 0,
      deferred: 0,
      failed: 0,
      documents: 0,
      highlights: 0
    }
    let claimMoved = false
    let failed: unknown = null
    try {
      setRunProgress({ stage: 'waiting-for-sync', planned: null, done: 0 })
      await this.deps.awaitReady?.(signal)
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
        // A clock set back leaves a time in the future: read, rather than wait for it.
        startedAt.getTime() - lastFullAt >= FULL_READ_INTERVAL_MS ||
        lastFullAt > startedAt.getTime()
      // The claim is re-read before each book, so a takeover stops this run at
      // the next one (D8). The cursor stays put, and the other device's first
      // run is a full export.
      const stopped = (): boolean => {
        if (signal.aborted) return true
        if (this.deps.claimLost?.() !== true) return false
        claimMoved = true
        return true
      }
      const cancelled = (): RunResult => ({
        ...result,
        cancelled: true,
        ...(claimMoved ? { claimLost: true } : {})
      })
      if (cursor === null) adoptExistingNotes(db)
      // An error the user must fix parks the schedule and keeps the last run's counts.
      const needsAttention = (error: unknown): void => {
        if (
          error instanceof ReadwiseError &&
          (error.code === 'invalid-token' || error.code === 'subscription-expired')
        ) {
          const previous = getLastRun(db)
          setLastRun(db, {
            at: new Date().toISOString(),
            needsAttention: true,
            attention: error.code,
            ...(previous?.counts ? { counts: previous.counts } : {})
          })
        }
      }
      const mustFix = (error: unknown): boolean =>
        error instanceof ReadwiseError &&
        (error.code === 'invalid-token' || error.code === 'subscription-expired')

      setRunProgress({ stage: 'reading', planned: null, done: 0 })
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
        if (mustFix(error)) throw error
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
      let done = 0
      setRunProgress({ stage: 'writing', planned: total, done })

      const finish = (written: Written, payload: ReadwiseBook): void => {
        if ('needsFull' in written) return
        tally(result, written.event, payload)
        observer.book(written.event)
        done += 1
        setRunProgress({ stage: 'writing', planned: total, done }, { tick: true })
      }

      // The highlights each book brought, as the export reported them.
      const needFull: ReadwiseBook[] = []
      for (const book of retryBooks) {
        if (stopped()) return cancelled()
        finish(await this.writeBook(book, planOptions, observer, false), book)
      }
      for (const book of changed) {
        if (stopped()) return cancelled()
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
          if (mustFix(error)) throw error
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
          if (stopped()) return cancelled()
          const payload = payloads.get(fullBook.user_book_id)
          if (!payload) continue
          payloads.delete(fullBook.user_book_id)
          finish(await this.writeBook(fullBook, planOptions, observer, false), payload)
        }
        for (const gone of payloads.values()) {
          // Missing from `ids=` after the export named it. Probably gone, and the
          // next run's retry fetch drops it then. If it was a hiccup, it is read again.
          addRetry(db, gone.user_book_id, 'Missing from the full fetch')
          log.info('A Readwise book vanished between the export and its full fetch', {
            bookId: gone.user_book_id
          })
          finish({ event: { title: bookTitle(gone), result: 'unchanged' } }, gone)
        }
      }

      setCursor(db, nextCursor(exported, cursor, startedAt))

      // 4. Saved Reader documents, only when the user asked for them (D11).
      // The v2 work is done and its cursor kept, so a Reader failure never undoes it.
      if (options.readerDocuments) {
        const bookExternalIds = new Set<string>()
        for (const link of listLinks(db)) {
          if (link.readerDocumentId !== null) bookExternalIds.add(link.readerDocumentId)
        }
        for (const book of [...retryBooks, ...exported]) {
          if (book.external_id) bookExternalIds.add(book.external_id)
        }
        try {
          const reader = await runReaderPass({
            db,
            token,
            signal,
            startedAt,
            options,
            bookExternalIds,
            stopped,
            more: (count) => observer.more?.(count),
            onDocument: (event) => {
              if (event.result === 'failed') result.failed += 1
              if (event.result === 'created') result.documents += 1
              observer.book(event)
            }
          })
          if (reader.cancelled) return cancelled()
        } catch (error) {
          if (signal.aborted) return cancelled()
          needsAttention(error)
          if (error instanceof ReadwiseError && error.code === 'invalid-token') throw error
          // Rate limit or network: the Reader cursor stays, and the next run lists again.
          const reason = error instanceof Error ? error.message : String(error)
          log.warn('The Reader documents could not be listed', { error })
          result.failed += 1
          observer.book({ title: 'Reader', result: 'failed', reason })
        }
      }

      if (full) {
        setLastFullRead(db, startedAt.toISOString())
        // A category switched on while this run was reading keeps its flag.
        const now = readReadwiseOptions(db)
        const gained =
          (now.readerDocuments && !options.readerDocuments) ||
          READWISE_CATEGORIES.some(
            (category) => now.categories[category] && !options.categories[category]
          )
        if (!gained) setFullPassPending(db, false)
      }
      setLastRun(db, {
        at: new Date().toISOString(),
        needsAttention: false,
        counts: {
          books: result.books,
          added: result.added,
          updated: result.updated,
          appended: result.appended,
          deferred: result.deferred,
          failed: result.failed,
          highlights: result.highlights
        }
      })
      clearRunFailure()
      return result
    } catch (error) {
      failed = error
      throw error
    } finally {
      this.running = false
      this.stopRun = null
      if (failed !== null) recordRunFailure(failed)
      setRunProgress(null)
      if (claimMoved) this.deps.onClaimLost?.()
      // Also for a cancelled or failed run: the notes it wrote did change.
      const changedBooks = result.added + result.updated + result.appended
      if (changedBooks + result.documents > 0 && observer.logActivity !== false) {
        recordActivity({
          kind: 'import',
          source: 'import',
          importer: 'readwise',
          message:
            `Readwise: ${plural(changedBooks, 'book')}, ${plural(result.highlights, 'highlight')}` +
            (result.documents > 0 ? `, ${plural(result.documents, 'Reader document')}` : ''),
          counts: { imported: changedBooks + result.documents, failed: result.failed }
        })
      }
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
      // Before any skip: a deleted or category-off book still tells which Reader document it covers (D11).
      const link = getLinkForBook(db, book.user_book_id, book.external_id)
      if (link) {
        completeLink(db, link, {
          readwiseBookId: book.user_book_id,
          readerDocumentId: book.external_id
        })
      }
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
      const reason = error instanceof Error ? error.message : String(error)
      // The cursor moves on without this book, so it must be on the list.
      addRetry(db, book.user_book_id, reason)
      return { event: { title, result: 'failed', reason } }
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

/**
 * Refills the link cache from the notes' `readwise_url` before a full export
 * (the first import, and a takeover's first run, D8). The writer also looks a
 * book up by `readwise_url` when it has no link row, so a failure here costs
 * only the `note-deleted` and `source-deleted` bookkeeping, never a duplicate.
 */
function adoptExistingNotes(db: ReturnType<typeof getDatabase>): void {
  try {
    rebuildLinks(db, getIndexDatabase())
  } catch (error) {
    log.warn('Could not rebuild the Readwise links from the notes', { error })
  }
}

let service: ReadwiseSyncService | null = null

/** The process's run engine. The import dialog and (#1416) the scheduler share it, so runs never overlap. */
export function getReadwiseSyncService(): ReadwiseSyncService {
  service ??= new ReadwiseSyncService({
    awaitReady: async (signal) => {
      await awaitPullAuthority(signal)
      await waitForVaultIndexBuild(signal)
    },
    claimLost: claimLostToAnotherDevice,
    onClaimLost: () => {
      void releaseTokenIfClaimedElsewhere().catch((error) =>
        log.warn('Could not drop the Readwise token after a takeover', { error })
      )
    }
  })
  return service
}
