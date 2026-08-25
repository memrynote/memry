import { createLogger } from '../lib/logger'
import { getDatabase, isDatabaseInitialized } from '../database'
import { getStatus as getVaultStatus } from '../vault/index'
import { getNoteAttachmentsDir } from '../vault/attachments'
import { toAbsolutePath } from '../vault/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  clearAttachmentDownloadFailure,
  listRedrivableDownloadFailures,
  markDownloadRequested,
  releaseDownloadAttempt,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import { isAttachmentAutoDownloadEnabled } from './attachment-download-settings'

const log = createLogger('AttachmentDownloadRedriver')

const REDRIVE_BATCH_LIMIT = 25
/**
 * The batch is oldest-25 by updatedAt, and dead rows never age out on their
 * own. Purging happens inside the walk (see below); when a whole round was
 * dead rows and produced no requests, another round is taken — up to this
 * cap — so live failures parked behind a wall of dead rows are reached in
 * the same cycle instead of a batch-size crawl per interval.
 */
const REDRIVE_MAX_ROUNDS = 5
const REDRIVE_INTERVAL_MS = 15 * 60 * 1000

let redriveTimer: NodeJS.Timeout | null = null
let redriving = false

/**
 * Persistent re-driver for failed attachment downloads (#1829).
 *
 * Before this, a failed download was only retried when its note happened to be
 * re-applied from a pull — a fresh device whose first pull hit a blip ended up
 * with silently missing attachments forever. This walks the persisted
 * `attachment_download_failures` rows whose retry window has opened and feeds
 * them back through the same emit → DownloadQueue path a pull uses, on sync
 * runtime start, on network reconnect, and on an interval.
 *
 * Rows whose owner is not a note in the data DB (deleted notes) or whose note
 * no longer references the attachment are DELETED as the walk meets them:
 * they are neither retried nor updated, so left alone ≥25 of them permanently
 * occupy the oldest-first batch window and starve live failures behind them
 * (a deleted note's failures are moot — a restored note re-emits
 * download-needed on its next pull — and a union-merged reference list only
 * ever loses an entry through deliberate pruning). Canvas assets never get
 * failure rows here; they self-heal at resolve time. Retryable skips keep
 * their backoff semantics and are left untouched.
 */
export async function redriveAttachmentDownloads(): Promise<{
  requested: number
  skipped: number
}> {
  const summary = { requested: 0, skipped: 0 }
  if (redriving) return summary
  redriving = true
  try {
    if (!isDatabaseInitialized()) return summary
    const db = getDatabase()
    if (!isAttachmentAutoDownloadEnabled(db)) return summary
    const vaultPath = getVaultStatus().path
    if (!vaultPath) return summary

    for (let round = 0; round < REDRIVE_MAX_ROUNDS; round++) {
      const rows = listRedrivableDownloadFailures(db, Date.now(), REDRIVE_BATCH_LIMIT)
      if (rows.length === 0) break
      let purged = 0

      for (const row of rows) {
        const note = getNoteMetadataById(db, row.ownerId)
        if (!note) {
          // Note gone (local delete or remote tombstone): the row is moot.
          clearAttachmentDownloadFailure(db, row.ownerId, row.attachmentId)
          summary.skipped++
          purged++
          continue
        }

        let diskPath: string
        let intoDir = false
        let sizeHint: number | undefined
        if (note.attachmentReferences?.includes(row.attachmentId)) {
          // Embedded attachment: materialize into the note's attachments dir.
          diskPath = getNoteAttachmentsDir(vaultPath, row.ownerId)
          intoDir = true
        } else if (note.attachmentId === row.attachmentId) {
          // Binary note: the note file itself IS the attachment.
          diskPath = toAbsolutePath(note.path)
          if (typeof note.fileSize === 'number' && note.fileSize > 0) sizeHint = note.fileSize
        } else {
          // The note no longer references this attachment — refs merge
          // union-only, so a dropped reference was pruned on positive evidence
          // of absence. The row can never be driven again; delete it.
          clearAttachmentDownloadFailure(db, row.ownerId, row.attachmentId)
          summary.skipped++
          purged++
          continue
        }

        // Same claim discipline as the pull path: the guard re-checks the
        // failure row (and the in-flight/succeeded session sets) so a row whose
        // window closed between the list and here is not double-requested.
        // Left as-is: these rows are alive, just not due right now.
        if (!shouldAttemptDownload(db, row.ownerId, row.attachmentId)) {
          summary.skipped++
          continue
        }
        markDownloadRequested(row.ownerId, row.attachmentId)

        const recencyMs = note.modifiedAt ? Date.parse(note.modifiedAt) : NaN
        const delivered = attachmentEvents.emitDownloadNeeded({
          noteId: row.ownerId,
          attachmentId: row.attachmentId,
          diskPath,
          ...(intoDir ? { intoDir: true } : {}),
          ...(Number.isFinite(recencyMs) ? { recencyHint: recencyMs } : {}),
          ...(sizeHint !== undefined ? { sizeHint } : {})
        })
        if (!delivered) {
          // No listener (runtime restarting): release the claim and stop — the
          // rest of the batch would drop the same way.
          releaseDownloadAttempt(row.ownerId, row.attachmentId)
          return summary
        }
        summary.requested++
      }

      // Only take another round when this one made no requests but cleared at
      // least one dead row — otherwise the remaining live work waits its turn
      // on the next interval like everything else. Any request or any
      // backoff-skip means progress was made or rows are still live; stop.
      if (summary.requested > 0 || purged === 0) break
    }

    if (summary.requested > 0 || summary.skipped > 0) {
      log.info('Re-drove failed attachment downloads', summary)
    }
    return summary
  } catch (err) {
    log.warn('Attachment download re-drive failed', { error: err })
    return summary
  } finally {
    redriving = false
  }
}

/** Interval re-drive while a sync runtime is up. Idempotent. */
export function startAttachmentDownloadRedriver(): void {
  stopAttachmentDownloadRedriver()
  redriveTimer = setInterval(() => {
    void redriveAttachmentDownloads()
  }, REDRIVE_INTERVAL_MS)
  redriveTimer.unref?.()
}

export function stopAttachmentDownloadRedriver(): void {
  if (redriveTimer) {
    clearInterval(redriveTimer)
    redriveTimer = null
  }
}
