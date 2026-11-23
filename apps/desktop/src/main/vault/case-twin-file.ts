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
import { getNoteMetadataById } from '@memry/storage-data'
import { applyRemoteFrontmatter } from '../sync/item-handlers/note-handler-frontmatter'
import { recordRebuiltNoteCover } from '../sync/item-handlers/note-cover-sync'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { diskCaseOf } from './disk-case'
import { generateContentHash, serializeNote } from './frontmatter'
import { findCanonicalNoteForFile, listCaseTwinIds, syncNoteToCache } from './note-sync'
import { toAbsolutePath } from './notes-io'
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

/** The survivor's doc as file body, by survivor id, for its next `planCaseTwinLeave`. */
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
 * next `planCaseTwinLeave`. Changes nothing durable. Throws `NoteError` when
 * the doc cannot be loaded or written as markdown.
 */
export function prepareCaseTwinLeave(
  vaultPath: string,
  relativePath: string,
  leavingId: string
): Promise<void> {
  const twins = twinsOnFile(vaultPath, relativePath, leavingId)
  if (twins?.length !== 1) return Promise.resolve()
  const survivorId = twins[0]
  const inFlight = preparing.get(survivorId)
  if (inFlight) return inFlight
  const run = prepareBody(survivorId).finally(() => preparing.delete(survivorId))
  preparing.set(survivorId, run)
  return run
}

async function prepareBody(survivorId: string): Promise<void> {
  const provider = getCrdtProvider()
  const live = provider.getDoc(survivorId)
  try {
    const doc = live ?? (await provider.open(survivorId, undefined, { skipSeed: true }))
    try {
      if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
        preparedBodies.set(survivorId, { body: null, converted: Y.encodeStateVector(doc) })
        return
      }
      const convert = await readyWritebackConverter()
      const converted = Y.encodeStateVector(doc)
      const notePath = getNoteMetadataById(getDatabase(), survivorId)?.path ?? ''
      // No file to restore spellings from: the bytes there may be the other twin's.
      const conversion = await convert(doc, notePath, async () => null)
      if (conversion.kind === 'unrepresentable' || conversion.body === null) {
        throw new Error(`The doc cannot be written as markdown (${conversion.kind})`)
      }
      preparedBodies.set(survivorId, { body: conversion.body, converted })
    } finally {
      if (!live) await provider.closeIfInactive(survivorId)
    }
  } catch (error) {
    throw new NoteError(
      'The note left on this file could not be written; nothing was changed',
      NoteErrorCode.WRITE_FAILED,
      survivorId,
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
  const twins = twinsOnFile(vaultPath, relativePath, leavingId)
  if (twins === null) {
    throw new NoteError(
      'The note no longer shares its file; try the delete again',
      NoteErrorCode.DELETE_FAILED,
      leavingId
    )
  }
  if (twins.length > 1) return () => {}
  const survivorId = twins[0]
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  const survivor = getNoteMetadataById(dataDb, survivorId)
  const cached = getNoteCacheById(indexDb, survivorId)
  if (!survivor || !cached) throw new CaseTwinLeaveNotReadyError(leavingId)
  const raw = readVaultFileSync(vaultPath, survivor.path)
  const onDisk = raw === null ? null : generateContentHash(raw)
  if (raw === null || onDisk === cached.contentHash || onDisk === cached.pendingWriteHash) {
    return () => preparedBodies.delete(survivorId)
  }
  const absolutePath = toAbsolutePath(survivor.path)
  const prepared = preparedBodies.get(survivorId)
  if (!prepared || hasPendingVaultFileOp(absolutePath)) {
    // A pending page write of this file would land after the step, putting
    // the other twin's bytes back under the survivor's baseline.
    if (!prepared) {
      prepareCaseTwinLeave(vaultPath, relativePath, leavingId).catch((error: unknown) => {
        log.error('Could not prepare the file of the case twin left on it', {
          leavingId,
          survivorId,
          error
        })
        trackMainError('notes', 'case_twin_file_prepare', error)
      })
    }
    throw new CaseTwinLeaveNotReadyError(leavingId)
  }

  const cover = isCoverValue(cached.cover) ? cached.cover : null
  const header = applyRemoteFrontmatter(
    {},
    {
      tags: getNoteHeaderTags(indexDb, survivorId),
      properties: getNotePropertiesAsRecord(indexDb, survivorId),
      aliases: getAliasesForNotes(indexDb, [survivorId]).get(survivorId) ?? [],
      ...(cover !== null ? { cover: { ref: cover } } : {}),
      title: survivor.title
    }
  )
  const writing = prepared.body ? toWritingFrontmatterValue(prepared.body.writing) : undefined
  if (writing) header[WRITING_FRONTMATTER_KEY] = writing
  const markdown = prepared.body?.markdown ?? ''
  const serialized = serializeNote(header, markdown)
  const file = serialized.endsWith('\n') ? serialized : `${serialized}\n`

  return () => {
    if (raw !== file) {
      createSnapshot(survivorId, raw, survivor.title, SnapshotReasons.SIGNIFICANT)
      updateNoteCache(indexDb, survivorId, { pendingWriteHash: generateContentHash(file) })
    }
    writeNoteFileNow(absolutePath, file)
    recordBaseline(indexDb, survivorId, file)
    if (owesFileBody(survivorId)) clearOwedFileBody(survivorId)
    recordRebuiltNoteCover(dataDb, survivorId, cover)
    syncNoteToCache(
      indexDb,
      {
        id: survivorId,
        path: survivor.path,
        fileContent: file,
        frontmatter: header,
        parsedContent: markdown,
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
}

function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
