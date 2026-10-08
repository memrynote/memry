import fs from 'fs'
import path from 'path'
import { getNoteMetadataById } from '@memry/storage-data'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { getDatabase, isDatabaseInitialized } from '../database'
import { createLogger } from '../lib/logger'
import { getCurrentVaultPath } from '../store'
import { queueUploadIfAbsent } from './attachment-outbox'
import {
  countNoteFiles,
  embeddedFilesOutsideNoteFolders,
  existingFiles,
  notesWithRecords,
  ownFolderFiles,
  unrecordedFiles
} from './attachment-files'
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
 * an outbox row, the outbox uploads. When the emit never fired (an editor bug
 * between #1606 and its fix, a file copied into a note's folder, a vault file a
 * body embeds), nothing downstream learned the file existed, and it stayed on
 * the single device that had it. Every upload re-drive runs this to close
 * that gap.
 *
 * Two places hold such files: a note's own `attachments/<noteId>/` folder,
 * where desktop's editor stores them, and any vault file the note's body embeds
 * (an imported note pointing at `images/photo.png`). A file is queued when the
 * attachment record does not know it; see `attachment-files` for how a note
 * from before the record is counted rather than uploaded again.
 *
 * Idempotent: a queued file is recorded once it uploads, and a file that
 * already has a row keeps it untouched, retry window included.
 */
export function backfillUnsyncedAttachmentsWith(deps: AttachmentBackfillDeps): {
  scanned: number
  queued: number
} {
  let notes: Array<typeof noteMetadata.$inferSelect>
  try {
    notes = deps.db.select().from(noteMetadata).all()
  } catch (error) {
    log.warn('Note metadata unreadable during backfill', { error })
    return { scanned: 0, queued: 0 }
  }

  let folders: Set<string>
  try {
    folders = new Set(
      fs
        .readdirSync(path.join(deps.vaultPath, 'attachments'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    )
  } catch {
    // No attachments folder yet is the normal state of a fresh vault. The
    // bodies can still embed files from elsewhere, so the scan goes on.
    folders = new Set()
  }
  const counted = notesWithRecords(deps.db)

  let scanned = 0
  let queued = 0
  for (const note of notes) {
    // A local-only note is deliberately not on the server; uploading its
    // attachments would leak exactly what the flag exists to hold back.
    if (note.localOnly) continue
    const files = [
      ...(folders.has(note.id) ? ownFolderFiles(deps.vaultPath, note.id) : []),
      ...embeddedFilesOf(deps.db, deps.vaultPath, note)
    ]
    if (files.length === 0) {
      if ((note.attachmentReferences ?? []).length > 0 && !counted.has(note.id)) {
        countNoteFiles(deps.db, deps.vaultPath, note.id, [])
      }
      continue
    }
    let unknown: string[]
    try {
      unknown = unrecordedFiles(deps.db, deps.vaultPath, note, files)
    } catch (error) {
      log.warn('Attachment record unreadable during backfill', { noteId: note.id, error })
      continue
    }
    let added = 0
    for (const file of unknown) {
      try {
        if (queueUploadIfAbsent(deps.db, note.id, file)) added++
      } catch (error) {
        log.warn('Failed to queue backfilled attachment', { noteId: note.id, error })
      }
    }
    // A file with a row already (pending, or failed and waiting out its retry
    // window) is not news; counting it would log this every pass.
    if (added === 0) continue
    scanned++
    queued += added
  }

  if (queued > 0) {
    log.info('Queued attachments that never reached the server', { notes: scanned, files: queued })
  }
  return { scanned, queued }
}

/**
 * Notes whose body embeds no vault file outside their own folder, by absolute
 * path, with the mtime and size they had when read. Such a note gains an embed
 * only by changing, so the re-drive every five minutes stats it instead of
 * reading every note body in the vault again.
 */
const notesWithoutEmbeds = new Map<string, string>()

/** The vault files outside its own folder that a note's body embeds and that are on disk. */
function embeddedFilesOf(
  db: DrizzleDb,
  vaultPath: string,
  note: typeof noteMetadata.$inferSelect
): string[] {
  // A binary note's file IS the attachment; it has no body to scan.
  if (!note.path.endsWith('.md')) return []
  const notePath = path.join(vaultPath, note.path)
  let markdown: string
  let version: string
  try {
    const stats = fs.statSync(notePath)
    version = `${stats.mtimeMs}:${stats.size}`
    if (notesWithoutEmbeds.get(notePath) === version) return []
    markdown = fs.readFileSync(notePath, 'utf8')
  } catch {
    return []
  }
  const files = embeddedFilesOutsideNoteFolders(db, markdown, vaultPath, note.path, note.id)
  if (files.length === 0) notesWithoutEmbeds.set(notePath, version)
  return existingFiles(files)
}

/**
 * Offer the files of a note whose body was just written or indexed (#2651),
 * instead of waiting for the next backfill pass: its own folder and what the
 * body embeds, by the same record rule. A file with an outbox row is on its
 * way; the rest get a row and the save event, which uploads at once.
 */
export function queueEmbeddedVaultFilesWith(
  deps: AttachmentBackfillDeps,
  noteId: string,
  markdown: string
): number {
  const note = getNoteMetadataById(deps.db, noteId)
  if (!note || note.localOnly) return 0
  const files = [
    ...ownFolderFiles(deps.vaultPath, noteId),
    ...existingFiles(
      embeddedFilesOutsideNoteFolders(deps.db, markdown, deps.vaultPath, note.path, noteId)
    )
  ]
  let queued = 0
  for (const file of unrecordedFiles(deps.db, deps.vaultPath, note, files)) {
    if (!queueUploadIfAbsent(deps.db, noteId, file)) continue
    attachmentEvents.emitSaved({ noteId, diskPath: file })
    queued++
  }
  return queued
}

/** Never throws: the body is already written, and an upload can wait for the re-drive. */
export function queueEmbeddedVaultFiles(noteId: string, markdown: string): void {
  try {
    const vaultPath = getCurrentVaultPath()
    if (!vaultPath || !isDatabaseInitialized()) return
    queueEmbeddedVaultFilesWith({ db: getDatabase(), vaultPath }, noteId, markdown)
  } catch (error) {
    log.warn('Failed to queue the files a note embeds', { noteId, error })
  }
}

/** The sync runtime's entry point: resolve this vault, then scan it. */
export function backfillUnsyncedAttachments(): { scanned: number; queued: number } {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return { scanned: 0, queued: 0 }
  return backfillUnsyncedAttachmentsWith({ db: getDatabase(), vaultPath })
}
