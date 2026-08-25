import { createLogger } from '../lib/logger'
import { getDatabase, isDatabaseInitialized } from '../database'
import { getStatus as getVaultStatus } from '../vault/index'
import { getNoteAttachmentsDir } from '../vault/attachments'
import { toAbsolutePath } from '../vault/notes'
import { getNoteMetadataById } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  listRedrivableDownloadFailures,
  markDownloadRequested,
  releaseDownloadAttempt,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import { isAttachmentAutoDownloadEnabled } from './attachment-download-settings'

const log = createLogger('AttachmentDownloadRedriver')

const REDRIVE_BATCH_LIMIT = 25
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
 * Rows whose owner is not a note in the data DB (canvas assets, deleted notes)
 * are left alone: canvas assets self-heal at resolve time, and a deleted
 * note's failures are moot.
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

    const rows = listRedrivableDownloadFailures(db, Date.now(), REDRIVE_BATCH_LIMIT)
    for (const row of rows) {
      const note = getNoteMetadataById(db, row.ownerId)
      if (!note) {
        summary.skipped++
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
        // The note no longer references this attachment — nothing to fetch.
        summary.skipped++
        continue
      }

      // Same claim discipline as the pull path: the guard re-checks the
      // failure row (and the in-flight/succeeded session sets) so a row whose
      // window closed between the list and here is not double-requested.
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
        break
      }
      summary.requested++
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
