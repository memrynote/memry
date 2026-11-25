/**
 * Where a downloaded attachment lands when its file may hold a case twin's
 * bytes, and what the landing keeps first (#5560, #5585, #5594). A change is
 * told by content hash: a landing after a split compares the file with the
 * hash marked at the split (`case-twin-file.ts`, `planBinarySurvivor`), and
 * a landing on a file twins still share compares it with the bytes a download
 * last landed there. Either landing also takes bytes it kept before as kept,
 * while their copy still holds them.
 *
 * @module vault/case-twin-landing
 */

import fs from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import {
  foldNotePath,
  getNoteMetadataById,
  listNoteMetadataByFoldedPath
} from '@memry/storage-data'
import { getNoteCacheByPath } from '@main/database/queries/notes'
import { assertOwnAttachmentLands } from '../sync/note-attachment-metadata'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { diskCaseOf, volumeIgnoresCase } from './disk-case'
import {
  hashFile,
  holdsCaseTwinForeignBytes,
  readCaseTwinForeignBytes,
  readKeptCaseTwinCopy,
  readLandedCaseTwinHash,
  recordKeptCaseTwinCopy,
  recordLandedCaseTwinHash,
  takeHeldCaseTwinChange,
  takeLandedCaseTwinHash
} from './case-twin-bytes'
import { sharesCaseTwinFile } from './case-twin-file'
import { generateUniquePathSync } from './file-ops'
import { getVaultRoot, toRelativePath } from './notes-io'

const log = createLogger('CaseTwinLanding')

/**
 * Where a downloaded attachment whose bytes hash to `sha256` lands
 * (`beforeFileLands`). Bytes landing on a file case twins share are recorded,
 * so their split can tell a change made since (#5585). For a note whose file
 * may hold its case twin's bytes (#5560), a download asked for at the path the
 * note had before a split lands at its file now, not on the file the other
 * twin kept. A change made to the file since it was marked is on no server,
 * so it is kept first as a new file next to it, "<name> (conflict copy)",
 * which the vault takes in as a note of its own. A landing on a file twins
 * still share keeps a change made since the bytes a download last landed
 * there the same way, and forgets a change the watcher held to it; with no
 * landing recorded, the file counts as changed (#5594). Either way the change
 * is kept once while its copy still holds it (`keepChange`). The first bytes
 * to land where twins' rows name no file yet are recorded too
 * (`recordFirstOnTwinFile`). It reads the marks of the note whose own file it
 * is and of the notes on the file it lands on, never every mark (#5580).
 * Throws, with nothing landed, when that copy cannot be written: the download
 * is retried.
 */
export function landCaseTwinDownload(
  filePath: string,
  attachmentId: string,
  sha256: string,
  fileOwnerId?: string
): string {
  const landAt = caseTwinLandingFor(filePath, attachmentId, fileOwnerId)
  const db = getDatabase()
  const vaultPath = getVaultRoot()
  const landsOn = toRelativePath(landAt)
  const onFile = listNoteMetadataByFoldedPath(db, landsOn)
    .map((note) => ({ id: note.id, mark: readCaseTwinForeignBytes(db, note.id) }))
    .find(({ mark }) => mark !== undefined)
  const shared = sharesCaseTwinFile(vaultPath, landsOn)
  if (onFile) {
    keepChange(db, landAt, sha256, onFile.mark?.sha256, { noteId: onFile.id })
  } else if (shared) {
    keepChange(db, landAt, sha256, readLandedCaseTwinHash(db, landsOn), { attachmentId })
    takeHeldCaseTwinChange(db, landsOn)
  }
  if (shared) recordLandedCaseTwinHash(db, landsOn, sha256)
  else if (diskCaseOf(vaultPath, landsOn) === null) {
    recordFirstOnTwinFile(db, vaultPath, landsOn, sha256)
  }
  return landAt
}

/**
 * Where `landCaseTwinDownload` lands a download, with nothing kept or
 * recorded. Throws `SupersededDownloadError` when the note whose own file it
 * is names another attachment now.
 */
export function caseTwinLandingFor(
  filePath: string,
  attachmentId: string,
  fileOwnerId?: string
): string {
  const db = getDatabase()
  if (fileOwnerId !== undefined) assertOwnAttachmentLands(db, fileOwnerId, attachmentId)
  const owner = fileOwnerId === undefined ? undefined : getNoteMetadataById(db, fileOwnerId)
  const ownerMarked =
    owner?.attachmentId === attachmentId && holdsCaseTwinForeignBytes(db, owner.id)
  if (!owner || !ownerMarked) return filePath
  if (foldNotePath(owner.path) === foldNotePath(toRelativePath(filePath))) return filePath
  const vaultPath = getVaultRoot()
  return join(vaultPath, diskCaseOf(vaultPath, owner.path) ?? owner.path)
}

/**
 * Bytes landing where no file is yet are recorded when other rows name the
 * file they make, so the other twin's landing finds them known (REVIEW-5602).
 * The proof is `listRowsOnFile`'s: a volume that keeps case has no twins, and
 * a row whose file is on disk names another file, as a twin of this one would
 * open it (`ılık.png` and `Ilık.png` on APFS). What a landing recorded under
 * their shared fold is forgotten then (VERIFY-5602), unless that file is
 * shared: it is then a twin pair's, and the record theirs (VERIFY-5602R2).
 */
function recordFirstOnTwinFile(
  db: DrizzleDb,
  vaultPath: string,
  landsOn: string,
  sha256: string
): void {
  if (!volumeIgnoresCase(vaultPath)) return
  const rows = listNoteMetadataByFoldedPath(db, landsOn)
  const onDisk = rows.filter((row) => diskCaseOf(vaultPath, row.path) !== null)
  if (onDisk.length === 0) {
    if (rows.length > 1) recordLandedCaseTwinHash(db, landsOn, sha256)
  } else if (!onDisk.some((row) => sharesCaseTwinFile(vaultPath, row.path))) {
    takeLandedCaseTwinHash(db, landsOn)
  }
}

/**
 * Keeps the file at `landAt` as a conflict copy, and records the copy, when
 * it holds bytes other than the landing's (`sha256`), the known ones (`known`:
 * the mark, or the last landing on a still-shared file), and the ones a
 * landing on this file last kept, while their copy still holds them. So a
 * landing retried after its rename failed keeps a change once, and a copy
 * moved back over the file, changed, or deleted is kept again
 * (VERIFY-5602R2).
 */
function keepChange(
  db: DrizzleDb,
  landAt: string,
  sha256: string,
  known: string | undefined,
  context: Record<string, string>
): void {
  const onDisk = hashFile(landAt)
  if (onDisk === null || onDisk === sha256 || onDisk === known) return
  const landsOn = toRelativePath(landAt)
  if (onDisk === readKeptCaseTwinCopy(db, getVaultRoot(), landsOn)) return
  recordKeptCaseTwinCopy(db, landsOn, { sha256: onDisk, copy: keepConflictCopy(landAt, context) })
}

/** Copies the file at `filePath` to a new "(conflict copy)" file, returning its vault path. */
function keepConflictCopy(filePath: string, context: Record<string, string>): string {
  const ext = extname(filePath)
  const copyPath = generateUniquePathSync(
    join(dirname(filePath), `${basename(filePath, ext)} (conflict copy)${ext}`),
    (p) => !!getNoteCacheByPath(getIndexDatabase(), toRelativePath(p))
  )
  fs.copyFileSync(filePath, copyPath, fs.constants.COPYFILE_EXCL)
  const copy = toRelativePath(copyPath)
  log.warn("A change to a file that may have held a case twin's bytes is kept as a new file", {
    ...context,
    copy
  })
  return copy
}
