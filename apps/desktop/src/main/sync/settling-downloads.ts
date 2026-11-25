import type { AttachmentDownloadNeededEvent } from '@memry/sync-client/attachment-events'
import { markDownloadOwed } from '@memry/sync-client/attachment-download-state'
import { getDatabase, isDatabaseInitialized, type DataDb } from '../database/client'
import { createLogger } from '../lib/logger'
import { completeWithin } from '../shutdown-sequence'

const logger = createLogger('SettlingDownloads')

/**
 * A download whose outcome is not recorded yet, from its request to its
 * outcome, a token wait included.
 *
 * Invariant (REVIEW-5722): teardown never waits unbounded; a download
 * outliving its session writes nothing. A teardown owes every pull's request
 * still unsettled while its vault's database is open, then waits for them a
 * bounded time. One settling after that wait stopped, that database closed or
 * another vault's opened writes nothing: its owed row stands in for it.
 */
export interface SettlingDownload {
  readonly noteId: string
  readonly attachmentId: string
  readonly source: 'eager' | 'interactive'
  /** The vault database open when it was requested, which its outcome goes to. */
  readonly db: DataDb | null
  /** Its outcome, or the owed row that stands in for it, is written. */
  recorded: boolean
  /** A teardown stopped waiting for it: its session is over. */
  cut: boolean
}

const settlingDownloads = new Map<Promise<string | null>, SettlingDownload>()

/**
 * A teardown stopped waiting for it, or its vault's database closed or another
 * vault's opened since it was requested. The open database alone cannot tell
 * sessions apart: a same-vault restart or a logout keeps it (VERIFY-5722).
 */
export function outlived(download: SettlingDownload): boolean {
  if (download.cut) return true
  return download.db !== null && !(isDatabaseInitialized() && getDatabase() === download.db)
}

export function trackDownload(
  event: AttachmentDownloadNeededEvent,
  source: SettlingDownload['source'],
  work: (download: SettlingDownload) => Promise<string | null>
): Promise<string | null> {
  const download: SettlingDownload = {
    noteId: event.noteId,
    attachmentId: event.attachmentId,
    source,
    db: isDatabaseInitialized() ? getDatabase() : null,
    recorded: false,
    cut: false
  }
  const settled = work(download)
  settlingDownloads.set(settled, download)
  const forget = (): void => {
    settlingDownloads.delete(settled)
  }
  settled.then(forget, forget)
  return settled
}

/**
 * Owe every pull's request still unsettled, while its vault's database is
 * open: the next runtime's pull starts from its cursor and asks for none of
 * them (#5697).
 */
export function oweUnsettledDownloads(): void {
  for (const download of settlingDownloads.values()) {
    if (download.source !== 'eager' || download.recorded || !download.db) continue
    if (outlived(download)) continue
    download.recorded = true
    try {
      markDownloadOwed(download.db, download.noteId, download.attachmentId)
    } catch (err) {
      logger.warn('Failed to record a dropped download as owed', {
        noteId: download.noteId,
        attachmentId: download.attachmentId,
        err
      })
    }
  }
}

/**
 * Waits for the downloads unsettled now, at most `ms`, so quit never spends
 * close-vault's reserve. Every one still unsettled then is cut, so it records
 * nothing into whichever session comes next. One a later session requests is
 * not this wait's to cut.
 */
export async function settleDownloadsWithin(ms: number): Promise<void> {
  const waitedOn = new Map(settlingDownloads)
  if (waitedOn.size === 0) return
  if (await completeWithin(Promise.allSettled(waitedOn.keys()), ms)) return
  const unsettled = [...waitedOn].filter(([settled]) => settlingDownloads.has(settled))
  for (const [, download] of unsettled) download.cut = true
  logger.warn('Stopped waiting for downloads; they record nothing when they settle', {
    unsettled: unsettled.map(([, d]) => `${d.noteId}::${d.attachmentId}`)
  })
}
