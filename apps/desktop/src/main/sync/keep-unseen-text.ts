/**
 * Keeps text a pulled delete would erase unseen (#3029), and the bytes of a
 * binary note file it would unlink while no server holds them (#5803).
 *
 * Another device deleted a note or journal day while this device held text it
 * never received. Delete still wins (chapter 05 §5.8), but before the handler
 * removes the row, doc and file, that text is saved as a new inbox note with a
 * fresh id. `keepsUnseenText` decides; this module gathers its facts and
 * writes the copy.
 *
 * The copy is written on the pull's page db, so it commits or rolls back with
 * the delete. A delete that arrives again finds no row and never reaches here,
 * which keeps the copy to one.
 *
 * A binary file (an image, PDF, audio or video) has no text. A replace made
 * outside the app, while it was closed or inside the watcher's debounce, holds
 * bytes no clock moved for, so the tombstone cannot say the deleter saw them.
 * `keepUnseenBinary` copies them to a new file beside the note's,
 * "<name> (kept from deleted note)<ext>", which the vault takes in as a note
 * of its own.
 *
 * @module sync/keep-unseen-text
 */

import fs from 'fs'
import { basename, dirname, extname, join } from 'path'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { keepsUnseenText } from '@memry/sync-client/delete-keep'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getNoteCacheById, getNoteCacheByPath } from '@main/database/queries/notes'
import type { getIndexDatabase } from '../database/client'
import type { DataDb } from '../database/types'
import { syncInboxCreate } from '../inbox/runtime-effects'
import { generateId } from '../lib/id'
import { parseNote } from '../vault/frontmatter'
import { hashFile } from '../vault/case-twin-bytes'
import { toRelativePath } from '../vault/notes-io'
import { hasPendingUpload } from './attachment-outbox'
import { readSyncedBinaryHash } from './binary-synced-hash'
import { createLogger } from '../lib/logger'
import { readLocalBodyFacts } from './note-sync-state'

const log = createLogger('KeepUnseenText')

export interface UnseenTextDelete {
  itemId: string
  /** Title of the inbox copy. */
  title: string
  localClock: VectorClock | null
  tombstoneClock: VectorClock | undefined
  deletedAt: number | undefined
  /** The tombstone's `bodyStateVector` (#3037). */
  bodyStateVector: string | undefined
  /**
   * The item's file holds bytes this device never ingested (#5757). Its text
   * is unseen whatever the clocks say, since no clock moved for it.
   */
  unseenFile?: boolean
  /** The item's markdown body, read only when a copy may be needed. */
  readBody: () => string | null
}

/** A markdown note's body, without its frontmatter. Null when it cannot be read. */
export function readNoteFileBody(absolutePath: string): string | null {
  try {
    return parseNote(fs.readFileSync(absolutePath, 'utf-8')).content
  } catch (error) {
    log.warn('Could not read a note file before a remote delete', { error })
    return null
  }
}

export function keepUnseenText(ctx: ApplyContext, del: UnseenTextDelete): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loosely typed value (unknown, column or error) named as its contract type; a runtime guard would change behavior
  const facts = readLocalBodyFacts(ctx.db as DataDb, del.itemId)
  const decide = (bodyBlank: boolean): boolean =>
    del.unseenFile === true
      ? !bodyBlank
      : keepsUnseenText({
          bodyBlank,
          waitingChanges: facts.waiting,
          localClock: del.localClock,
          tombstoneClock: del.tombstoneClock ?? null,
          deletedAt: del.deletedAt ?? null,
          lastLocalBodyAt: facts.confirmedAt,
          deleterBodyStateVector: del.bodyStateVector ?? null,
          localBodyStateVector: facts.pushedStateVector
        })
  if (!decide(false)) return
  const body = del.readBody()
  if (!body || !decide(body.trim() === '')) return

  const id = generateId()
  const now = new Date().toISOString()
  ctx.db
    .insert(inboxItems)
    .values({
      id,
      type: 'note',
      title: del.title,
      content: body,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'complete'
    })
    .run()
  syncInboxCreate(id)
  ctx.emit(InboxChannels.events.CAPTURED, { id })
  log.info('Kept unseen text of a remotely deleted item in the inbox', {
    itemId: del.itemId,
    inboxId: id
  })
}

type IndexDb = ReturnType<typeof getIndexDatabase>

interface BinaryNote {
  id: string
  path: string
  fileType?: string | null
  attachmentId: string | null
  /** The size of the bytes a server holds, as the row last recorded them. */
  fileSize?: number | null
}

/**
 * Whether the file at `filePath` holds bytes of note `note` that no server
 * has, as the tombstone's clock `seenBy` knows. Hashes the file only when the
 * synced hash can match it: a peer deleting many large files never reads
 * them on the main process for nothing (REVIEW-5811).
 *
 * Invariant: a binary file whose bytes this device cannot show are on a
 * server is never deleted unseen. The proof, in order:
 * - No attachment, or an upload pending or in flight: on no server.
 * - The synced hash (`binary-synced-hash.ts`): the bytes a download landed,
 *   or an upload whose push the tombstone's clock holds. Other bytes are
 *   unseen, and so are uploaded bytes whose push the clock lacks or whose
 *   push is unknown. A file whose size is not the row's recorded size holds
 *   other bytes, with no hash needed.
 * - No synced hash (a note last synced by a build before #5603): the file's
 *   mtime against the index row's `indexedAt`, the watcher's own test for a
 *   file changed since it was read (`rescan`). No index row is no proof.
 */
function holdsBytesOnNoServer(
  db: DrizzleDb,
  indexDb: IndexDb,
  note: BinaryNote,
  filePath: string,
  seenBy: VectorClock | undefined
): boolean {
  if (!note.attachmentId || hasPendingUpload(db, note.id, filePath)) return true
  if (readSyncedBinaryHash(db, note.id) !== undefined) {
    if (note.fileSize != null && fs.statSync(filePath).size !== note.fileSize) return true
    return hashFile(filePath) !== readSyncedBinaryHash(db, note.id, seenBy)
  }
  const indexedAt = Date.parse(getNoteCacheById(indexDb, note.id)?.indexedAt ?? '')
  if (Number.isNaN(indexedAt)) return true
  return Math.floor(fs.statSync(filePath).mtimeMs) > indexedAt
}

/**
 * Before a pulled delete unlinks note `note`'s file at `filePath`: copies
 * bytes no server has to a new file beside it when the note is binary
 * (`isBinaryNoteRow`); a markdown note's text is `keepUnseenText`'s. A retry of the delete
 * (a rolled-back page) finds its copy by hash and makes no second one. Throws
 * when the copy cannot be written, so the delete fails with the file intact
 * and the pull retries it.
 */
export function keepUnseenBinary(
  db: DrizzleDb,
  indexDb: IndexDb,
  note: BinaryNote,
  filePath: string,
  seenBy: VectorClock | undefined
): void {
  if (!isBinaryNoteRow(note)) return
  if (!fs.existsSync(filePath) || !holdsBytesOnNoServer(db, indexDb, note, filePath, seenBy)) return
  const size = fs.statSync(filePath).size
  let onDisk: string | null | undefined
  // A row's path with no file yet (a download still owed) is taken too.
  const taken = (p: string): boolean =>
    fs.existsSync(p) || getNoteCacheByPath(indexDb, toRelativePath(p)) !== undefined
  // A copy of other bytes differs in size or hash; only a same-size one is read.
  const holdsSame = (p: string): boolean => {
    const stat = fs.statSync(p, { throwIfNoEntry: false })
    if (stat?.size !== size) return false
    onDisk ??= hashFile(filePath)
    return hashFile(p) === onDisk
  }
  let copyPath = keptCopyPath(filePath, 0)
  for (let n = 1; taken(copyPath); n++) {
    if (holdsSame(copyPath)) return
    copyPath = keptCopyPath(filePath, n)
  }
  fs.copyFileSync(filePath, copyPath, fs.constants.COPYFILE_EXCL)
  log.warn('Kept bytes no server has of a remotely deleted binary note as a new file', {
    noteId: note.id,
    copy: toRelativePath(copyPath)
  })
}

/** The longest file name every supported file system takes, in UTF-8 bytes. */
const MAX_NAME_BYTES = 255

/**
 * The path of the `n`th copy kept from `filePath` (0 for the first):
 * "<name> (kept from deleted note)[ n]<ext>" beside it. The name is cut,
 * whole characters at a time, so the copy's name fits `MAX_NAME_BYTES`
 * whatever the original's length: a name too long to write would fail the
 * delete on every pull (REVIEW-5811). An extension too long to keep with the
 * suffix is cut as part of the name.
 */
export function keptCopyPath(filePath: string, n: number): string {
  const suffix = ` (kept from deleted note)${n === 0 ? '' : ` ${n}`}`
  let ext = extname(filePath)
  let name = basename(filePath, ext)
  if (Buffer.byteLength(suffix + ext) > MAX_NAME_BYTES) {
    name += ext
    ext = ''
  }
  let budget = MAX_NAME_BYTES - Buffer.byteLength(suffix + ext)
  let kept = ''
  for (const char of name) {
    budget -= Buffer.byteLength(char)
    if (budget < 0) break
    kept += char
  }
  return join(dirname(filePath), `${kept}${suffix}${ext}`)
}
