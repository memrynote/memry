import type { ReadwiseOptions } from '@memry/contracts/import-channels'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import type { BookEvent } from './sync-service'
import { listDocuments, type ReaderDocument } from './reader'
import { writeReaderNote, type ReaderOutcome } from './reader-notes'
import { getReaderCursor, setReaderCursor } from './sync-state'

const log = createLogger('Readwise:ReaderPass')

/** A cursor with no document to anchor on starts this far before the pass, absorbing clock skew. */
const EMPTY_CURSOR_MARGIN_MS = 5 * 60 * 1000

export interface ReaderPassInput {
  db: DataDb
  token: string
  signal: AbortSignal
  startedAt: Date
  options: Pick<ReadwiseOptions, 'rootFolder' | 'folderLayout' | 'readerFullText'>
  /** Reader documents that already have a v2 book. Their highlights live in that book's note (D11). */
  bookExternalIds: ReadonlySet<string>
  /** True once another device holds the claim or the run was cancelled. */
  stopped: () => boolean
  /** `count` more documents are about to be looked at. */
  more?: (count: number) => void
  onDocument: (event: BookEvent) => void
}

export interface ReaderPassResult {
  cancelled: boolean
  created: number
  failed: number
}

function eventOf(document: ReaderDocument, outcome: ReaderOutcome): BookEvent {
  const title = (document.title ?? '').trim() || 'Untitled'
  if (outcome.status === 'failed') return { title, result: 'failed', reason: outcome.reason }
  if (outcome.status === 'skipped') {
    return outcome.reason === 'has-book'
      ? { title, result: 'unchanged' }
      : { title, result: 'skipped', reason: outcome.reason }
  }
  return { title, result: outcome.status }
}

function nextCursor(newest: number, previous: string | null, startedAt: Date): string {
  const kept = previous === null ? Number.NaN : Date.parse(previous)
  if (newest === Number.NEGATIVE_INFINITY) {
    return new Date(
      Number.isNaN(kept) ? startedAt.getTime() - EMPTY_CURSOR_MARGIN_MS : kept
    ).toISOString()
  }
  const candidate = newest - 1000
  return new Date(Number.isNaN(kept) ? candidate : Math.max(kept, candidate)).toISOString()
}

/**
 * The Reader pass (#1408 D11): saved documents that have no v2 book become
 * notes under `Reader/`, once. The cursor is Reader's own `updated_at`, kept
 * separately because the v2 cursor follows highlights. It moves only when
 * every document was handled, and a document that already has a note is a
 * no-op, so a crash or a failed document costs a re-read and no duplicate.
 * Throws what the list client throws (rate limit, network, token).
 */
export async function runReaderPass(input: ReaderPassInput): Promise<ReaderPassResult> {
  const { db, options } = input
  const previous = getReaderCursor(db)
  const result: ReaderPassResult = { cancelled: false, created: 0, failed: 0 }
  let newest = Number.NEGATIVE_INFINITY

  for await (const page of listDocuments({
    token: input.token,
    updatedAfter: previous ?? undefined,
    withHtmlContent: options.readerFullText,
    signal: input.signal
  })) {
    input.more?.(page.length)
    for (const document of page) {
      if (input.stopped()) return { ...result, cancelled: true }
      const updated = document.updated_at ? Date.parse(document.updated_at) : Number.NaN
      if (!Number.isNaN(updated) && updated > newest) newest = updated
      const outcome = await writeReaderNote(document, {
        root: options.rootFolder,
        folderLayout: options.folderLayout,
        fullText: options.readerFullText,
        bookExternalIds: input.bookExternalIds
      })
      if (outcome.status === 'created') result.created += 1
      else if (outcome.status === 'failed') result.failed += 1
      input.onDocument(eventOf(document, outcome))
    }
  }

  if (result.failed === 0) setReaderCursor(db, nextCursor(newest, previous, input.startedAt))
  else log.warn('Some Reader documents failed; the next pass reads them again', result)
  return result
}
