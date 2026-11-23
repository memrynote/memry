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
 *    the moving twin's own file at its new path; the caller moves its row in
 *    the same step.
 *
 * The survivor's header is rebuilt from its index rows: header tags,
 * properties, aliases, and the cover ref. An image cover's framing and credit
 * live only in the file, so the rebuilt file has the bare ref, and the next
 * push leaves the cover out until it changes here (`recordRebuiltNoteCover`):
 * peers keep the framing.
 *
 * A binary survivor (`isBinaryNoteRow`) has no doc to rebuild a file from, and
 * its bytes are not markdown: its leave keeps the file as it is (#5562).
 * A binary twin has no doc to rebuild a file from: a peer's rename or move
 * of one plans with `planBinaryCaseTwinMove` (#5560). Either way the
 * survivor's file may hold the leaver's bytes (`planBinarySurvivor`). Such a
 * file is not pushed until the note's own attachment lands on it
 * (`landCaseTwinDownload`), which first keeps a change made to the file as a
 * conflict copy. A change is told by content hash (#5585): the split compares
 * the file with the bytes a download last landed on it, and the landing with
 * the hash marked at the split. A landing on a file twins still share compares
 * it with the bytes a download last landed there (#5594).
 *
 * @module vault/case-twin-file
 */

import fs from 'fs'
import { basename, dirname, extname, join } from 'path'
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
import { markWritebackIgnored, scheduleWriteback } from '../sync/crdt-writeback'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import { clearOwedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline } from '../sync/writeback-baseline'
import { assertOwnAttachmentLands } from '../sync/note-attachment-metadata'
import { hasPendingVaultFileOp, writeNoteFileNow } from '../sync/bulk-apply'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import type { NoteBody } from '../sync/writing-markdown'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { isCoverValue } from '@memry/shared/cover-image'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { toWritingFrontmatterValue, WRITING_FRONTMATTER_KEY } from '@memry/shared'
import {
  getAliasesForNotes,
  getNoteCacheById,
  getNoteCacheByPath,
  getNoteHeaderTags,
  getNotePropertiesAsRecord,
  updateNoteCache
} from '@main/database/queries/notes'
import { foldNotePath, getNoteMetadataById } from '@memry/storage-data'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { applyRemoteFrontmatter } from '../sync/item-handlers/note-handler-frontmatter'
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
  markCaseTwinForeignBytes,
  readCaseTwinForeignBytes,
  readLandedCaseTwinHash,
  recordConflictCopyKept,
  recordLandedCaseTwinHash,
  takeHeldCaseTwinChange,
  takeLandedCaseTwinHash,
  type MarkedFile
} from './case-twin-bytes'
import { generateUniquePathSync } from './file-ops'
import { generateContentHash, parseNote, serializeNote, type NoteFrontmatter } from './frontmatter'
import { findCanonicalNoteForFile, listCaseTwinIds, syncNoteToCache } from './note-sync'
import { getVaultRoot, toAbsolutePath, toRelativePath } from './notes-io'
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

interface PreparedBody {
  /** Null for a doc with no body: the file keeps the header alone. */
  body: NoteBody | null
  /** The doc's state vector when converted. */
  converted: Uint8Array
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
 * doc cannot be loaded or written as markdown.
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
}

function prepareOnce(id: string): Promise<void> {
  const inFlight = preparing.get(id)
  if (inFlight) return inFlight
  const run = prepareBody(id).finally(() => preparing.delete(id))
  preparing.set(id, run)
  return run
}

async function prepareBody(noteId: string): Promise<void> {
  const provider = getCrdtProvider()
  const live = provider.getDoc(noteId)
  try {
    const doc = live ?? (await provider.open(noteId, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
        preparedBodies.set(noteId, { body: null, converted: Y.encodeStateVector(doc) })
        return
      }
      const convert = await readyWritebackConverter()
      const converted = Y.encodeStateVector(doc)
      const notePath = getNoteMetadataById(getDatabase(), noteId)?.path ?? ''
      // No file to restore spellings from: the bytes there may be the other twin's.
      const conversion = await convert(doc, notePath, async () => null)
      if (conversion.kind === 'unrepresentable' || conversion.body === null) {
        throw new Error(`The doc cannot be written as markdown (${conversion.kind})`)
      }
      preparedBodies.set(noteId, { body: conversion.body, converted })
    } finally {
      if (!live) await provider.closeIfInactive(noteId)
    }
  } catch (error) {
    throw new NoteError(
      'A note on this shared file could not be written; nothing was changed',
      NoteErrorCode.WRITE_FAILED,
      noteId,
      { cause: error }
    )
  }
}

/**
 * Call right before the step that drops `leavingId`'s row from the file, with
 * no await between. Throws, with nothing changed, when the file cannot be
 * read, when it is no longer shared, or (`CaseTwinLeaveNotReadyError`) while
 * the survivor's file is not prepared or a page apply still owes the file a
 * write. Returns the step's first part: it writes the survivor's own file and
 * baseline, and never awaits.
 */
export function planCaseTwinLeave(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): () => void {
  return planLeave(vaultPath, relativePath, leavingId, null).leave
}

/** What a twin moved off a shared file now has at its new path. */
export interface MovedTwinFile {
  content: string
  frontmatter: NoteFrontmatter
  markdown: string
}

/**
 * `planCaseTwinLeave` for a rename or move of `leavingId` to `newRelativePath`
 * (#5498): the step also writes the leaving twin's own file there, with its
 * baseline, so the caller moves its row in the same step. The leaving twin's
 * own file is the shared file's bytes when they are its own, else its doc's
 * body under a header rebuilt from its index rows. Prepare with
 * `prepareCaseTwinLeave(..., true)`.
 */
export function planCaseTwinMove(
  vaultPath: string,
  relativePath: string,
  leavingId: string,
  newRelativePath: string
): () => MovedTwinFile {
  const { leave, raw, notReady } = planLeave(vaultPath, relativePath, leavingId, newRelativePath)
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  const leaving = getNoteMetadataById(dataDb, leavingId)
  const cached = getNoteCacheById(indexDb, leavingId)
  if (!leaving || !cached) throw new CaseTwinLeaveNotReadyError(leavingId)
  const onDisk = raw === null ? null : generateContentHash(raw)
  let own: MovedTwinFile & { cover?: string | null }
  if (raw !== null && (onDisk === cached.contentHash || onDisk === cached.pendingWriteHash)) {
    const parsed = parseNote(raw)
    own = { content: raw, frontmatter: parsed.frontmatter, markdown: parsed.content }
  } else {
    const prepared = preparedBodies.get(leavingId) ?? notReady()
    own = ownFile(indexDb, leavingId, leaving.title, cached.cover, prepared)
  }
  const absolutePath = toAbsolutePath(newRelativePath)
  return () => {
    leave()
    writeNoteFileNow(absolutePath, own.content)
    recordBaseline(indexDb, leavingId, own.content)
    if (own.cover !== undefined) recordRebuiltNoteCover(dataDb, leavingId, own.cover)
    const prepared = preparedBodies.get(leavingId)
    preparedBodies.delete(leavingId)
    // An edit that reached the live doc after the conversion goes to the file next.
    const live = getCrdtProvider().getDoc(leavingId)
    if (prepared && live && !sameStateVector(Y.encodeStateVector(live), prepared.converted)) {
      scheduleWriteback(leavingId, live, 'local')
    }
    return { content: own.content, frontmatter: own.frontmatter, markdown: own.markdown }
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
  const onDisk = raw === null ? null : generateContentHash(raw)
  if (raw === null || onDisk === cached.contentHash || onDisk === cached.pendingWriteHash) {
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

/** A note's own file: its prepared doc body under a header rebuilt from its index rows. */
function ownFile(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  title: string,
  cachedCover: string | null | undefined,
  prepared: PreparedBody
): MovedTwinFile & { cover: string | null } {
  const cover = isCoverValue(cachedCover) ? cachedCover : null
  const header = applyRemoteFrontmatter(
    {},
    {
      tags: getNoteHeaderTags(indexDb, noteId),
      properties: getNotePropertiesAsRecord(indexDb, noteId),
      aliases: getAliasesForNotes(indexDb, [noteId]).get(noteId) ?? [],
      ...(cover !== null ? { cover: { ref: cover } } : {}),
      title
    }
  )
  const writing = prepared.body ? toWritingFrontmatterValue(prepared.body.writing) : undefined
  if (writing) header[WRITING_FRONTMATTER_KEY] = writing
  const markdown = prepared.body?.markdown ?? ''
  const serialized = serializeNote(header, markdown)
  const content = serialized.endsWith('\n') ? serialized : `${serialized}\n`
  return { content, frontmatter: header, markdown, cover }
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
    markWritebackIgnored(newAbsolutePath)
    fs.mkdirSync(dirname(newAbsolutePath), { recursive: true })
    fs.copyFileSync(sharedPath, newAbsolutePath)
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
 * they are those bytes. The step never awaits.
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

function askForOwnBytes(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string,
  diskPath: string
): void {
  markDownloadOwed(db, noteId, attachmentId)
  if (!shouldAttemptDownload(db, noteId, attachmentId)) return
  markDownloadRequested(noteId, attachmentId)
  if (!attachmentEvents.emitDownloadNeeded({ noteId, attachmentId, diskPath })) {
    releaseDownloadAttempt(noteId, attachmentId)
  }
}

/**
 * A pulled record update of binary note `noteId`: while its file may hold its
 * case twin's bytes, its own attachment, which the update may have replaced,
 * is asked for again (#5560).
 */
export function askForCaseTwinOwnBytes(db: DrizzleDb, noteId: string): void {
  if (!holdsCaseTwinForeignBytes(db, noteId)) return
  const note = getNoteMetadataById(db, noteId)
  if (note?.attachmentId) {
    askForOwnBytes(db, noteId, note.attachmentId, toAbsolutePath(note.path))
  }
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

/**
 * Where a downloaded attachment whose bytes hash to `sha256` lands
 * (`beforeFileLands`). Bytes landing on a file case twins share are recorded,
 * so their split can tell a change made since (#5585). For a note whose file
 * may hold its case twin's bytes (#5560), a download asked for at the path the
 * note had before a split lands at its file now, not on the file the other
 * twin kept. A change made to the file since it was marked is on no server,
 * so it is kept first as a new file next to it, "<name> (conflict copy)",
 * which the vault takes in as a note of its own, once: a landing retried
 * after its rename failed finds the change kept. A landing on a file twins
 * still share keeps a change made since the bytes a download last landed
 * there the same way; with no landing recorded, the file counts as changed
 * (#5594). Throws, with nothing landed, when that copy cannot be written: the
 * download is retried.
 */
export function landCaseTwinDownload(
  filePath: string,
  attachmentId: string,
  sha256: string,
  fileOwnerId?: string
): string {
  const db = getDatabase()
  if (fileOwnerId !== undefined) assertOwnAttachmentLands(db, fileOwnerId, attachmentId)
  const vaultPath = getVaultRoot()
  const marks = readCaseTwinForeignBytes(db)
  const marked = [...marks.keys()].flatMap((id) => getNoteMetadataById(db, id) ?? [])
  const owner = marked.find((note) => note.attachmentId === attachmentId)
  const landAt =
    owner && foldNotePath(owner.path) !== foldNotePath(toRelativePath(filePath))
      ? join(vaultPath, diskCaseOf(vaultPath, owner.path) ?? owner.path)
      : filePath
  const landsOn = toRelativePath(landAt)
  const onFile = marked.find((note) => foldNotePath(note.path) === foldNotePath(landsOn))
  const shared = sharesCaseTwinFile(vaultPath, landsOn)
  if (onFile) {
    const kept = keepChange(landAt, sha256, marks.get(onFile.id)?.sha256, { noteId: onFile.id })
    if (kept !== null) recordConflictCopyKept(db, onFile.id, kept)
  } else if (shared) {
    keepChange(landAt, sha256, readLandedCaseTwinHash(db, landsOn), { attachmentId })
  }
  if (shared) recordLandedCaseTwinHash(db, landsOn, sha256)
  return landAt
}

/**
 * Keeps the file at `landAt` as a conflict copy when it holds bytes other than
 * the landing's (`sha256`) and the known ones (`known`), returning their hash.
 */
function keepChange(
  landAt: string,
  sha256: string,
  known: string | undefined,
  context: Record<string, string>
): string | null {
  const onDisk = hashFile(landAt)
  if (onDisk === null || onDisk === sha256 || onDisk === known) return null
  keepConflictCopy(landAt, context)
  return onDisk
}

function keepConflictCopy(filePath: string, context: Record<string, string>): void {
  const ext = extname(filePath)
  const copyPath = generateUniquePathSync(
    join(dirname(filePath), `${basename(filePath, ext)} (conflict copy)${ext}`),
    (p) => !!getNoteCacheByPath(getIndexDatabase(), toRelativePath(p))
  )
  fs.copyFileSync(filePath, copyPath, fs.constants.COPYFILE_EXCL)
  log.warn("A change to a file that may have held a case twin's bytes is kept as a new file", {
    ...context,
    copy: toRelativePath(copyPath)
  })
}

function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
