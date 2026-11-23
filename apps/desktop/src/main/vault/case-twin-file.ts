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
 * @module vault/case-twin-file
 */

import * as Y from 'yjs'
import { getCrdtProvider } from '../sync/crdt-provider'
import { scheduleWriteback } from '../sync/crdt-writeback'
import { readyWritebackConverter } from '../sync/converter-worker-bridge'
import { clearOwedFileBody, owesFileBody } from '../sync/crdt-owed-file-body'
import { recordBaseline } from '../sync/writeback-baseline'
import { hasPendingVaultFileOp, writeNoteFileNow } from '../sync/bulk-apply'
import { PendingSyncIntentError } from '../sync/pending-sync-intent-error'
import type { NoteBody } from '../sync/writing-markdown'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { isCoverValue } from '@memry/shared/cover-image'
import { toWritingFrontmatterValue, WRITING_FRONTMATTER_KEY } from '@memry/shared'
import {
  getAliasesForNotes,
  getNoteCacheById,
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
import { generateContentHash, parseNote, serializeNote, type NoteFrontmatter } from './frontmatter'
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
  const ids = [...(twins.length === 1 ? twins : []), ...(movesLeaving ? [leavingId] : [])]
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

function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
