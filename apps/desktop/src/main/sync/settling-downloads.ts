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
 * bounded time. One settling after that database closed or another vault's
 * opened writes nothing: its owed row stands in for it.
 */
export interface SettlingDownload {
  readonly noteId: string
  readonly attachmentId: string
  readonly source: 'eager' | 'interactive'
  /** The vault database open when it was requested, which its outcome goes to. */
  readonly db: DataDb | null
  /** Its outcome, or the owed row that stands in for it, is written. */
  recorded: boolean
}

const settlingDownloads = new Map<Promise<string | null>, SettlingDownload>()

/** Its vault's database closed, or another vault's opened, since it was requested. */
export function outlived(download: SettlingDownload): boolean {
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
    recorded: false
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

export async function settleDownloadsWithin(ms: number): Promise<void> {
  if (settlingDownloads.size === 0) return
  if (await completeWithin(Promise.allSettled(settlingDownloads.keys()), ms)) return
  logger.warn('Stopped waiting for downloads; they record nothing when they settle', {
    unsettled: [...settlingDownloads.values()].map((d) => `${d.noteId}::${d.attachmentId}`)
  })
}
