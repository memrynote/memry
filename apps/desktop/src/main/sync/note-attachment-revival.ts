/**
 * Uploads again the attachments of a revived note that the server freed
 * (#3054, protocol 14 §14.8.2).
 *
 * The device that deletes a note frees its attachments' chunks 30 days later
 * (`deleted-asset-release.ts`). A device whose edit beats that delete skips the
 * pulled tombstone, and its push brings the note back on every device. When
 * that happens after the release, the note names chunks that are gone, and no
 * device can download its files. The reviving device still has them, so it
 * checks each attachment on the server and queues an upload of its local copy
 * for every one that is gone. Chunk holds would not cover this: a hold ends
 * with the grace period, and a device can stay offline longer.
 *
 * Liveness: an attachment whose manifest the server does not have is gone.
 * Otherwise its chunks are probed with a hold that is released at once
 * (`probeNoteAttachments`). A server that predates holds skips the probe.
 *
 * Revived notes wait in memory until a check settles them. A check that cannot
 * reach the server stays for the next upload re-drive. A restart before the
 * check settles loses it.
 */

import path from 'node:path'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import type { AttachmentChunks, HoldOutcome } from '../canvas/assets/chunk-holds'
import { createLogger } from '../lib/logger'
import { filesOfAttachments } from './attachment-files'
import { enqueueUpload } from './attachment-outbox'

const log = createLogger('NoteAttachmentRevival')

export interface RevivalDeps {
  db: DrizzleDb
  vaultPath: string
  /** The server chunk hashes of an attachment; `[]` when the server has no manifest. Throws on failure. */
  chunkHashesOf: (attachmentId: string) => Promise<string[]>
  /** `missing` names the attachments with a dead chunk. Never throws. */
  probe: (noteId: string, attachments: AttachmentChunks[]) => Promise<HoldOutcome>
}

const revived = new Set<string>()
let wake: (() => void) | null = null

/** The upload re-drive registers itself so a revival is checked at once. */
export function onNoteRevived(listener: (() => void) | null): void {
  wake = listener
}

/** The note handler's entry point: this device's edit beat a pulled delete. */
export function noteRevived(noteId: string): void {
  revived.add(noteId)
  wake?.()
}

/** Check every revived note once. A note whose check fails stays for the next pass. */
export async function settleRevivedNotes(deps: RevivalDeps): Promise<void> {
  for (const noteId of Array.from(revived)) {
    try {
      if (await reuploadFreedAttachments(deps, noteId)) revived.delete(noteId)
    } catch (error) {
      log.warn("Could not check a revived note's attachments; retrying later", { noteId, error })
    }
  }
}

/** False when the server could not answer. */
async function reuploadFreedAttachments(deps: RevivalDeps, noteId: string): Promise<boolean> {
  const note = getNoteMetadataById(deps.db, noteId)
  if (!note || note.localOnly) return true
  const ids = new Set([
    ...(note.attachmentReferences ?? []),
    ...(note.attachmentId ? [note.attachmentId] : [])
  ])
  if (ids.size === 0) return true

  const gone = new Set<string>()
  const stored: AttachmentChunks[] = []
  for (const attachmentId of ids) {
    const chunkHashes = await deps.chunkHashesOf(attachmentId)
    if (chunkHashes.length === 0) gone.add(attachmentId)
    else stored.push({ attachmentId, chunkHashes })
  }
  const probed = await deps.probe(noteId, stored)
  if (probed.status === 'failed') return false
  if (probed.status === 'ok') for (const id of probed.missing) gone.add(id)
  if (gone.size === 0) return true

  // A freed id never comes back, and the upload reuses a referenced attachment
  // whose manifest matches the file, which a freed one still does.
  updateNoteMetadata(deps.db, noteId, {
    attachmentReferences: (note.attachmentReferences ?? []).filter((id) => !gone.has(id))
  })
  const files = filesOfAttachments(deps.db, deps.vaultPath, note, gone)
  if (note.fileType !== 'markdown' && note.attachmentId && gone.has(note.attachmentId)) {
    files.push(path.join(deps.vaultPath, note.path))
  }
  const queued = new Set(files)
  for (const file of queued) enqueueUpload(deps.db, noteId, file)
  const logged = { noteId, freed: gone.size, queued: queued.size }
  if (queued.size === 0)
    log.warn('A revived note names freed attachments this device has no copy of', logged)
  else log.info("Queued a revived note's freed attachments for upload", logged)
  return true
}
