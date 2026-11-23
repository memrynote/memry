import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { hasPendingUpload } from '../attachment-outbox'
import { readSyncedBinaryHash } from '../binary-synced-hash'
import {
  hashFile,
  holdsCaseTwinForeignBytes,
  markCaseTwinForeignBytes
} from '../../vault/case-twin-bytes'
import { sharesCaseTwinFile } from '../../vault/case-twin-file'
import { getVaultRoot, toAbsolutePath } from '../../vault/notes'

interface BinaryNote {
  id: string
  path: string
  attachmentId: string | null
  localOnly: boolean
}

/**
 * A pulled record names another attachment for a binary note whose file is
 * here: a peer replaced its bytes (#5580). Attachment ids are random per
 * upload, so a new id is new bytes. The file is marked as holding bytes that
 * are not the note's own, the same mark a split case twin's file gets, so
 * `askForCaseTwinOwnBytes` asks for the new attachment onto it, the watcher
 * holds a change to it, and `landCaseTwinDownload` keeps a change that is on
 * no server as a conflict copy before the bytes land.
 *
 * Plan before the record moves the file or the row, with `concurrent` for a
 * record that merged with a change of this device's. The step marks the file
 * where it is after the move; then ask.
 */
export function planPeerBinaryReplace(
  db: DrizzleDb,
  note: BinaryNote,
  remoteAttachmentId: string | null | undefined,
  concurrent: boolean
): ((filePath: string) => void) | null {
  if (!remoteAttachmentId || remoteAttachmentId === note.attachmentId || note.localOnly) return null
  // A shared file holds one twin's bytes; the case twin owner asks for a split twin's own.
  if (sharesCaseTwinFile(getVaultRoot(), note.path) || holdsCaseTwinForeignBytes(db, note.id)) {
    return null
  }
  const filePath = toAbsolutePath(note.path)
  // On no server: never uploaded, an upload pending or in flight, or this
  // device's own concurrent replacement.
  const changed = concurrent || !note.attachmentId || hasPendingUpload(db, note.id, filePath)
  // Otherwise the file holds bytes a server has only while they hash to those
  // last landed or uploaded here (#5598). With none recorded it may hold a
  // change made while the app was closed, whatever its size.
  const synced = readSyncedBinaryHash(db, note.id)
  return (landingPath) => {
    const sha256 = changed || synced === undefined ? null : hashFile(landingPath)
    markCaseTwinForeignBytes(db, note.id, sha256 !== null && sha256 === synced ? { sha256 } : null)
  }
}
