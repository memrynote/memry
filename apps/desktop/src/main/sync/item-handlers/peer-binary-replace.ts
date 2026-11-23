import fs from 'fs'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { hasPendingUpload } from '../attachment-outbox'
import { holdsCaseTwinForeignBytes, markCaseTwinForeignBytes } from '../../vault/case-twin-bytes'
import { sharesCaseTwinFile } from '../../vault/case-twin-file'
import { getVaultRoot, toAbsolutePath } from '../../vault/notes'

interface BinaryNote {
  id: string
  path: string
  attachmentId: string | null
  fileSize: number | null
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
  const stats = fs.statSync(filePath, { throwIfNoEntry: false })
  // On no server: never uploaded, an upload pending or in flight, a size the
  // watcher has not recorded yet, or this device's own concurrent replacement.
  const changed =
    !!stats &&
    (concurrent ||
      !note.attachmentId ||
      hasPendingUpload(db, note.id, filePath) ||
      (!!note.fileSize && stats.size !== note.fileSize))
  return (landingPath) =>
    markCaseTwinForeignBytes(db, note.id, landingPath, changed || !fs.existsSync(landingPath))
}
