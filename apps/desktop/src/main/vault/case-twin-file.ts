/**
 * The one owner for a note leaving a file it shares with a case twin (#5297,
 * #5495): a local or remote delete, and a rename or move (#5501).
 *
 * On a case-insensitive disk two rows whose paths differ only in case name
 * one file, and the file holds one twin's body. A twin that leaves takes only
 * its row: the file is the other twin's too. The bytes on disk may be the
 * leaving twin's body and header, and the survivor must never read them in.
 *
 * So the survivor's own file replaces them in the same synchronous step as the
 * leaving row's drop (and a local delete's tombstone): nothing durable happens
 * before the step, and a crash after it finds the survivor's own bytes,
 * recorded as its baseline. Bytes that are not the survivor's never become its
 * baseline.
 *
 * 1. `sharesCaseTwinFile`, while the leaving row still names the file.
 * 2. `prepareCaseTwinLeave` does every await and changes nothing durable: it
 *    converts the survivor's doc into its file body.
 * 3. `planCaseTwinLeave`, synchronous, right before the step: every read and
 *    check, so a throw aborts the leave with nothing changed. It returns the
 *    step's first part, which writes the survivor's file with no await.
 *    A rename or move plans with `planCaseTwinMove`, whose step also writes
 *    the moving twin's own file at its new path and moves the caller's row.
 *
 * No write-back turn of the leaving twin runs beside the step: a pass that
 * read its row before the step writes the shared file after it (#5559,
 * #5610).
 *
 * A peer's frontmatter update of a twin whose bytes are not on the file goes
 * to its index rows only, with the body tags of its own doc
 * (`case-twin-off-file.ts`, #5561).
 *
 * The survivor's header is rebuilt from its index rows (`case-twin-own-file.ts`):
 * header tags, properties, aliases, and the cover ref. An image cover's framing
 * and credit live only in the file, so the rebuilt file has the bare ref, and
 * the next push leaves the cover out until it changes here
 * (`recordRebuiltNoteCover`): peers keep the framing.
 *
 * A binary survivor (`isBinaryNoteRow`) has no doc to rebuild a file from, and
 * its bytes are not markdown: its leave keeps the file as it is (#5562).
 * A binary twin has no doc to rebuild a file from: a peer's rename or move
 * of one plans with `planBinaryCaseTwinMove` (#5560). Either way the
 * survivor's file may hold the leaver's bytes (`planBinarySurvivor`). Such a
 * file is not pushed until the note's own attachment lands on it
 * (`case-twin-landing.ts`), which first keeps a change made to the file as a
 * conflict copy. A change is told by content hash (#5585): the split compares
 * the file with the bytes a download last landed on it.
 *
 * @module vault/case-twin-file
 */

import fs from 'fs'
import { dirname, join } from 'path'
import * as Y from 'yjs'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  isDownloadAbandoned,
  markDownloadOwed,
  markDownloadRequested,
  releaseDownloadAttempt,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getCrdtProvider } from '../sync/crdt-provider'
import { hasWritebackTurn, scheduleWriteback, takeWritebackTurn } from '../sync/crdt-writeback'
import { recordAppWrite } from './app-writes'
import { clearOwedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline } from '../sync/writeback-baseline'
import { hasPendingVaultFileOp, writeNoteFileNow } from '../sync/bulk-apply'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import { foldNotePath, getNoteMetadataById } from '@memry/storage-data'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { recordRebuiltNoteCover } from '../sync/item-handlers/note-cover-sync'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import {
  clearCaseTwinForeignBytes,
  hashFile,
  holdsCaseTwinForeignBytes,
  listCaseTwinForeignBytes,
  markCaseTwinForeignBytes,
  takeHeldCaseTwinChange,
  takeLandedCaseTwinHash,
  type MarkedFile
} from './case-twin-bytes'
import {
  convertBody,
  holdsOwnBytes,
  ownFile,
  sameStateVector,
  type OwnTwinFile,
  type PreparedBody
} from './case-twin-own-file'
import { generateContentHash, parseNote } from './frontmatter'
import { findCanonicalNoteForFile, listCaseTwinIds, syncNoteToCache } from './note-sync'
import { getVaultRoot, toAbsolutePath } from './notes-io'
import { createSnapshot } from './notes-versions'

const log = createLogger('CaseTwinFile')

/** Thrown while the survivor's file is not ready; a pull retries the item (`item-recovery.ts`). */
export class CaseTwinLeaveNotReadyError extends PendingSyncIntentError {
  constructor(leavingId: string) {
    super('note', leavingId)
    this.name = 'CaseTwinLeaveNotReadyError'
    this.message = "The case twin left on this note's file is not ready for it yet"
  }
}

/** A twin's doc as file body, by note id, for its next `planCaseTwinLeave` or `planCaseTwinMove`. */
const preparedBodies = new Map<string, PreparedBody>()
const preparing = new Map<string, Promise<void>>()

/** Whether a case twin shares this note's file. Ask before the note's row leaves it. */
export function sharesCaseTwinFile(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/** The rows other than `leavingId` on the file, or null when it is not shared. */
function twinsOnFile(vaultPath: string, relativePath: string, leavingId: string): string[] | null {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const twins = onDisk === null ? [] : listCaseTwinIds(vaultPath, onDisk, leavingId)
  return twins.length > 0 ? twins : null
}

/**
 * Converts the doc of the twin left on the file into its file body, for the
 * next `planCaseTwinLeave`, and with `movesLeaving` the leaving twin's doc too,
 * for `planCaseTwinMove`. Changes nothing durable. Throws `NoteError` when a
 * doc cannot be loaded or written as markdown. Waits out the leaving twin's
 * write-back turn last, as the step refuses to run beside one.
 */
export async function prepareCaseTwinLeave(
  vaultPath: string,
  relativePath: string,
  leavingId: string,
  movesLeaving = false
): Promise<void> {
  const twins = twinsOnFile(vaultPath, relativePath, leavingId)
  if (twins === null) return
  const survivor = twins.length === 1 ? getNoteCacheById(getIndexDatabase(), twins[0]) : undefined
  const rebuildsSurvivor = survivor !== undefined && !isBinaryNoteRow(survivor)
  const ids = [...(rebuildsSurvivor ? twins : []), ...(movesLeaving ? [leavingId] : [])]
  await Promise.all(ids.map(prepareOnce))
  await takeWritebackTurn(leavingId, async () => {})
}

function prepareOnce(id: string): Promise<void> {
  const inFlight = preparing.get(id)
  if (inFlight) return inFlight
  const run = prepareBody(id).finally(() => preparing.delete(id))
  preparing.set(id, run)
  return run
}

async function prepareBody(noteId: string): Promise<void> {
  preparedBodies.set(noteId, await convertBody(noteId))
}

/**
 * Call right before the step that drops `leavingId`'s row from the file, with
 * no await between. Throws, with nothing changed, when the file cannot be
 * read, when it is no longer shared, or (`CaseTwinLeaveNotReadyError`) while
 * the survivor's file is not prepared, a page apply still owes the file a
 * write, or a write-back turn of the leaving twin runs: past its checks, it
 * would land the deleted twin's bytes on the survivor's file after the step
 * and re-create its row after the tombstone (#5559). Returns the step's first
 * part: it writes the survivor's own file and baseline, and never awaits.
 */
export function planCaseTwinLeave(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): () => void {
  return planLeave(vaultPath, relativePath, leavingId, null).leave
}

/**
 * `planCaseTwinLeave` for a rename or move of `leavingId` to `newRelativePath`
 * (#5498): the step also writes the leaving twin's own file there, with its
 * baseline, so the caller moves its row in the same step. The leaving twin's
 * own file is the shared file's bytes when they are its own, else its doc's
 * body under a header rebuilt from its index rows. Prepare with
 * `prepareCaseTwinLeave(..., true)`. Throws as `planCaseTwinLeave` does; a
 * write-back turn of the moving twin would put its body over the survivor's
 * file after the step, and its row back on the shared file (#5610).
 *
 * The step's `moveRow` moves the caller's row to the new path, in one
 * data-DB transaction: a throw in it leaves the row on the shared file. A
 * write outside that database comes last in it (the peer's index row path),
 * or after the step returns (the local move's index event). A throw after the
 * moving twin's file is written
 * removes that file: no row names it, and the next vault open would list it
 * as a new note.
 */
export function planCaseTwinMove(
  vaultPath: string,
  relativePath: string,
  leavingId: string,
  newRelativePath: string
): (moveRow: (moved: OwnTwinFile) => void) => OwnTwinFile {
  const { leave, raw, notReady } = planLeave(vaultPath, relativePath, leavingId, newRelativePath)
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  const leaving = getNoteMetadataById(dataDb, leavingId)
  const cached = getNoteCacheById(indexDb, leavingId)
  if (!leaving || !cached) throw new CaseTwinLeaveNotReadyError(leavingId)
  let own: OwnTwinFile & { cover?: string | null }
  if (raw !== null && holdsOwnBytes(raw, cached)) {
    const parsed = parseNote(raw)
    own = { content: raw, frontmatter: parsed.frontmatter, markdown: parsed.content }
  } else {
    const prepared = preparedBodies.get(leavingId) ?? notReady()
    own = ownFile(indexDb, leavingId, leaving.title, cached.cover, prepared)
  }
  const absolutePath = toAbsolutePath(newRelativePath)
  const moved = { content: own.content, frontmatter: own.frontmatter, markdown: own.markdown }
  return (moveRow) => {
    leave()
    writeNoteFileNow(absolutePath, own.content)
    try {
      recordBaseline(indexDb, leavingId, own.content)
      if (own.cover !== undefined) recordRebuiltNoteCover(dataDb, leavingId, own.cover)
      dataDb.transaction(() => moveRow(moved))
    } catch (error) {
      fs.rmSync(absolutePath, { force: true })
      throw error
    }
    const prepared = preparedBodies.get(leavingId)
    preparedBodies.delete(leavingId)
    // An edit that reached the live doc after the conversion goes to the file next.
    const live = getCrdtProvider().getDoc(leavingId)
    if (prepared && live && !sameStateVector(Y.encodeStateVector(live), prepared.converted)) {
      scheduleWriteback(leavingId, live, 'local')
    }
    return moved
  }
}

function planLeave(
  vaultPath: string,
  relativePath: string,
  leavingId: string,
  movesTo: string | null
): { leave: () => void; raw: string | null; notReady: () => never } {
  const twins = twinsOnFile(vaultPath, relativePath, leavingId)
  if (twins === null) {
    throw new NoteError(
      movesTo === null
        ? 'The note no longer shares its file; try the delete again'
        : 'The note no longer shares its file; try the rename or move again',
      movesTo === null ? NoteErrorCode.DELETE_FAILED : NoteErrorCode.WRITE_FAILED,
      leavingId
    )
  }
  const notReady = (): never => {
    prepareCaseTwinLeave(vaultPath, relativePath, leavingId, movesTo !== null).catch(
      (error: unknown) => {
        log.error('Could not prepare the files of a case twin leaving a shared file', {
          leavingId,
          error
        })
        trackMainError('notes', 'case_twin_file_prepare', error)
      }
    )
    throw new CaseTwinLeaveNotReadyError(leavingId)
  }
  if (hasWritebackTurn(leavingId)) notReady()
  const raw = readVaultFileSync(vaultPath, relativePath)
  if (twins.length > 1) return { leave: () => {}, raw, notReady }
  const survivorId = twins[0]
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  const survivor = getNoteMetadataById(dataDb, survivorId)
  const cached = getNoteCacheById(indexDb, survivorId)
  if (!survivor || !cached) throw new CaseTwinLeaveNotReadyError(leavingId)
  if (isBinaryNoteRow(cached)) {
    const onDisk = diskCaseOf(vaultPath, relativePath) ?? relativePath
    const sha256 = hashFile(join(vaultPath, onDisk))
    return { leave: planBinarySurvivor(vaultPath, onDisk, survivorId, sha256), raw, notReady }
  }
  if (raw === null || holdsOwnBytes(raw, cached)) {
    return { leave: () => preparedBodies.delete(survivorId), raw, notReady }
  }
  const absolutePath = toAbsolutePath(survivor.path)
  const prepared = preparedBodies.get(survivorId) ?? notReady()
  // A pending page write of this file would land after the step, putting
  // the other twin's bytes back under the survivor's baseline.
  if (hasPendingVaultFileOp(absolutePath)) throw new CaseTwinLeaveNotReadyError(leavingId)

  const own = ownFile(indexDb, survivorId, survivor.title, cached.cover, prepared)
  const leave = (): void => {
    if (raw !== own.content) {
      createSnapshot(survivorId, raw, survivor.title, SnapshotReasons.SIGNIFICANT)
      updateNoteCache(indexDb, survivorId, { pendingWriteHash: generateContentHash(own.content) })
    }
    writeNoteFileNow(absolutePath, own.content)
    recordBaseline(indexDb, survivorId, own.content)
    if (owesFileBody(survivorId)) clearOwedFileBody(survivorId)
    recordRebuiltNoteCover(dataDb, survivorId, own.cover)
    syncNoteToCache(
      indexDb,
      {
        id: survivorId,
        path: survivor.path,
        fileContent: own.content,
        frontmatter: own.frontmatter,
        parsedContent: own.markdown,
        title: cached.title,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt,
        localOnly: cached.localOnly ?? false,
        emoji: cached.emoji ?? null
      },
      { isNew: false, source: 'sync' }
    )
    preparedBodies.delete(survivorId)
    log.info('A case twin left a shared file; the file is the survivor’s own again', {
      leavingId,
      survivorId
    })
    // An edit that reached the live doc after the conversion goes to the file next.
    const live = getCrdtProvider().getDoc(survivorId)
    if (live && !sameStateVector(Y.encodeStateVector(live), prepared.converted)) {
      scheduleWriteback(survivorId, live, 'remote')
    }
  }
  return { leave, raw, notReady }
}

/**
 * Refuse a folder rename that would strand a case twin (#5498). The rename
 * carries the rows spelled with the folder's exact name. A twin spelled with
 * the folder in another case would keep a path with no file, and carrying it
 * would put both twins on one path.
 */
export function assertFolderRenameKeepsCaseTwins(folderPath: string): void {
  const exact = `${folderPath}/`
  const folded = foldNotePath(exact)
  const vaultPath = getVaultRoot()
  const stranded = getDatabase()
    .select({ path: noteMetadata.path })
    .from(noteMetadata)
    .all()
    .some(
      ({ path }) =>
        !path.startsWith(exact) &&
        foldNotePath(path).startsWith(folded) &&
        sharesCaseTwinFile(vaultPath, path)
    )
  if (stranded) throw new Error('errors:folder.renameCaseTwins')
}

/**
 * A peer's rename or move of binary note `movingId` off a file it shares with
 * a case twin (#5560). The file stays where it is for the other twin. The
 * moving twin gets a copy at `newAbsolutePath`, so its row never lacks a file.
 * Either file may hold the other twin's bytes, so each twin's own attachment
 * is asked for onto its file (`requestOwnBytes`). Call right before the step
 * that moves the row, with no await between. Throws, with nothing changed,
 * when the file is no longer shared; a copy that fails throws before anything
 * moves.
 */
export function planBinaryCaseTwinMove(
  vaultPath: string,
  relativePath: string,
  movingId: string,
  newAbsolutePath: string,
  attachmentId: string | null
): () => void {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  const twins = twinsOnFile(vaultPath, relativePath, movingId)
  if (onDisk === null || twins === null) {
    throw new NoteError(
      'The note no longer shares its file; try the rename or move again',
      NoteErrorCode.WRITE_FAILED,
      movingId
    )
  }
  const db = getDatabase()
  const sharedPath = join(vaultPath, onDisk)
  const sha256 = hashFile(sharedPath)
  const localOnly = getNoteMetadataById(db, movingId)?.localOnly ?? false
  // With more than one twin left, the file is still shared and the watcher holds it.
  const keepSurvivor =
    twins.length === 1 ? planBinarySurvivor(vaultPath, onDisk, twins[0], sha256) : () => {}
  return () => {
    // No hash means the file was gone at the plan, and the copy throws.
    const landed = sha256 === null ? null : recordAppWrite(newAbsolutePath, { sha256 })
    fs.mkdirSync(dirname(newAbsolutePath), { recursive: true })
    fs.copyFileSync(sharedPath, newAbsolutePath)
    landed?.()
    log.info('A binary case twin moved off a shared file; the file stays with the other twin', {
      movingId,
      attachmentId
    })
    // The copy holds the shared bytes: a change in them is the survivor's to keep.
    const copied = sha256 === null ? null : { sha256 }
    requestOwnBytes(db, { id: movingId, attachmentId, localOnly }, newAbsolutePath, copied)
    keepSurvivor()
  }
}

/**
 * Binary note `survivorId` keeps the file at `onDisk` alone once the other
 * twin leaves it (moved or deleted), and the file may hold the leaver's
 * bytes: its own attachment is asked for onto the file. `sha256` is the
 * file's hash, read by the plan. The file holds a change on no server when
 * the watcher held one, or when it differs from the bytes a download last
 * landed on it (#5585): an edit made while the app was closed, or whose event
 * is on the way, whatever its size. With no landing recorded (twins that
 * shared the file before this build), the bytes are treated as changed. Such
 * a change is kept as a conflict copy when the survivor's bytes land, unless
 * they are those bytes, or bytes a landing kept before whose copy still holds
 * them then: a copy can change or go between the split and the landing
 * (VERIFY-5602R2). The step never awaits.
 */
function planBinarySurvivor(
  vaultPath: string,
  onDisk: string,
  survivorId: string,
  sha256: string | null
): () => void {
  const db = getDatabase()
  const survivor = getNoteMetadataById(db, survivorId)
  if (!survivor) return () => {}
  const sharedPath = join(vaultPath, onDisk)
  return () => {
    const held = takeHeldCaseTwinChange(db, onDisk)
    const landed = takeLandedCaseTwinHash(db, onDisk)
    const changed = held || sha256 === null || sha256 !== landed
    requestOwnBytes(db, survivor, sharedPath, changed ? null : { sha256 })
  }
}

/**
 * The file at `diskPath` may hold note `note`'s case twin's bytes. Its pushes
 * are held, and its own attachment is asked for there through the download
 * tracking, recorded as owed so the re-driver retries a request no downloader
 * took. `mark` is the file's hash, or null when it holds a change on no
 * server. A note with no
 * attachment, kept local only, or whose attachment the server no longer has,
 * has no other copy of its bytes: its file is the best one there is, and
 * stays pushable.
 */
function requestOwnBytes(
  db: DrizzleDb,
  note: { id: string; attachmentId: string | null; localOnly: boolean },
  diskPath: string,
  mark: MarkedFile
): void {
  if (!note.attachmentId || note.localOnly || isDownloadAbandoned(db, note.id, note.attachmentId)) {
    log.warn(
      "A case twin's file may hold its twin's bytes and is its only copy; it stays pushable",
      {
        noteId: note.id,
        attachmentId: note.attachmentId,
        localOnly: note.localOnly,
        changed: mark === null
      }
    )
    return
  }
  markCaseTwinForeignBytes(db, note.id, mark)
  askForOwnBytes(db, note.id, note.attachmentId, diskPath)
}

/** Whether the download was asked for now. */
function askForOwnBytes(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string,
  diskPath: string
): boolean {
  markDownloadOwed(db, noteId, attachmentId)
  if (!shouldAttemptDownload(db, noteId, attachmentId)) return false
  const claim = markDownloadRequested(noteId, attachmentId)
  if (!claim) return false
  if (attachmentEvents.emitDownloadNeeded({ noteId, attachmentId, diskPath, claim })) return true
  releaseDownloadAttempt(claim)
  return false
}

/**
 * A pulled record update of binary note `noteId`: while its file may hold its
 * case twin's bytes, its own attachment, which the update may have replaced,
 * is asked for again (#5560). Returns whether it was asked for now.
 */
export function askForCaseTwinOwnBytes(db: DrizzleDb, noteId: string): boolean {
  if (!holdsCaseTwinForeignBytes(db, noteId)) return false
  const note = getNoteMetadataById(db, noteId)
  if (!note?.attachmentId) return false
  return askForOwnBytes(db, noteId, note.attachmentId, toAbsolutePath(note.path))
}

/**
 * Asks again for the own bytes of every binary note whose file is held for
 * them, past each one's retry window: the re-driver's pass while attachment
 * auto-download is off (#5580). Returns how many it asked for.
 */
export function askForHeldOwnBytes(db: DrizzleDb): number {
  return listCaseTwinForeignBytes(db).filter((noteId) => askForCaseTwinOwnBytes(db, noteId)).length
}

/**
 * A download of note `noteId`'s attachment failed as gone (#5560). Once it is
 * never asked for again, while it is still the note's own, the note's file is
 * the only copy of its bytes there is, and stops being held.
 */
export function releaseAbandonedCaseTwinBytes(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string
): void {
  if (!holdsCaseTwinForeignBytes(db, noteId)) return
  if (getNoteMetadataById(db, noteId)?.attachmentId !== attachmentId) return
  if (!isDownloadAbandoned(db, noteId, attachmentId)) return
  clearCaseTwinForeignBytes(db, noteId)
  log.warn("The server no longer has a case twin's own bytes; its file stays as the only copy", {
    noteId,
    attachmentId
  })
}
