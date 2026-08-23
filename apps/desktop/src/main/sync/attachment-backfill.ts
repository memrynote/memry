import fs from 'fs'
import path from 'path'
import { getNoteMetadataById } from '@memry/storage-data'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getCurrentVaultPath } from '../store'
import { enqueueUpload } from './attachment-outbox'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('AttachmentBackfill')

export interface AttachmentBackfillDeps {
  db: DrizzleDb
  vaultPath: string
}

/**
 * Queue attachments that are on disk but were never offered to the server.
 *
 * The upload path is event-driven: saving an attachment emits, the emit writes
 * an outbox row, the outbox uploads. When the emit itself failed — it did, for
 * every attachment written from the editor between #1606 and this fix — nothing
 * downstream ever learned the file existed. Fixing the emit only helps the next
 * attachment; the ones already written stay on the single device that made
 * them, referenced by a note that every other device can see. This closes that
 * gap on startup so those files are not lost to a window of bad builds.
 *
 * Only notes with NO recorded attachment references are considered. An
 * attachment id is minted randomly per upload, not derived from the bytes, so
 * there is no way to ask "is this particular file already up there?" — a note
 * that has some references would have to re-upload all of its files to be sure,
 * duplicating in R2 whatever was already there. Skipping those notes trades a
 * partial mixed-era note (rare: it needs attachments from both sides of a
 * two-day window) for never wasting a user's storage.
 *
 * Idempotent by construction: once a queued file uploads, the note gains a
 * reference and is skipped from then on. Re-enqueuing an already-queued row is
 * an upsert, so a repeated run before a successful drain costs nothing.
 */
export function backfillUnsyncedAttachmentsWith(deps: AttachmentBackfillDeps): {
  scanned: number
  queued: number
} {
  const attachmentsRoot = path.join(deps.vaultPath, 'attachments')
  let scanned = 0
  let queued = 0

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(attachmentsRoot, { withFileTypes: true })
  } catch {
    // No attachments folder yet is the normal state of a fresh vault.
    return { scanned, queued }
  }

  for (const entry of entries) {
    // Each subdirectory is named for the note that owns it. `inbox`, `images`
    // and other non-note folders live here too; they fail the metadata lookup
    // below and drop out on their own.
    if (!entry.isDirectory()) continue

    const noteId = entry.name
    let metadata: ReturnType<typeof getNoteMetadataById>
    try {
      metadata = getNoteMetadataById(deps.db, noteId)
    } catch (error) {
      log.warn('Note metadata lookup failed during backfill', { noteId, error })
      continue
    }
    if (!metadata) continue
    // A local-only note is deliberately not on the server; uploading its
    // attachments would leak exactly what the flag exists to hold back.
    if (metadata.localOnly) continue
    if ((metadata.attachmentReferences ?? []).length > 0) continue

    scanned++

    const noteDir = path.join(attachmentsRoot, noteId)
    let files: fs.Dirent[]
    try {
      files = fs.readdirSync(noteDir, { withFileTypes: true })
    } catch (error) {
      log.warn('Attachment folder unreadable during backfill', { noteId, error })
      continue
    }

    for (const file of files) {
      if (!file.isFile()) continue
      // .DS_Store and friends are not the user's attachments.
      if (file.name.startsWith('.')) continue
      try {
        enqueueUpload(deps.db, noteId, path.join(noteDir, file.name))
        queued++
      } catch (error) {
        log.warn('Failed to queue backfilled attachment', { noteId, error })
      }
    }
  }

  if (queued > 0) {
    log.info('Queued attachments that never reached the server', { notes: scanned, files: queued })
  }
  return { scanned, queued }
}

/** The sync runtime's entry point: resolve this vault, then scan it. */
export function backfillUnsyncedAttachments(): { scanned: number; queued: number } {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return { scanned: 0, queued: 0 }
  return backfillUnsyncedAttachmentsWith({ db: getDatabase(), vaultPath })
}
