/**
 * Insert an attachment a note already has into a second note (#2077).
 *
 * The relationship is not a new record: it is the ref itself. An attachment's
 * bytes live at `attachments/<ownerNoteId>/<storedFilename>` and stay there for
 * life, so `(ownerNoteId, storedFilename)` is already a stable, vault-wide
 * identity — the same one the existing note-relative ref encodes. A second note
 * embeds the same blob by writing that same target relative to its own folder,
 * which means every path that already understands attachment refs (resolve,
 * self-heal, cross-device remap, move rewriting, the markdown serializer)
 * understands a shared one with no change, and every older vault keeps reading
 * exactly as before.
 *
 * What that costs is paid elsewhere: `attachment-reference-scan.ts` is how the
 * delete path learns that the bytes are not its own to remove.
 *
 * Two things this deliberately does not do:
 *
 *  - It never copies bytes. Inserting an existing attachment writes a ref and
 *    nothing else, so there is no second upload, no second blob and no second
 *    manifest; the owning note's sync already carries the file to every device,
 *    and the borrowing note's ref resolves against it once it lands.
 *  - It never de-duplicates what is already there. Two notes that each uploaded
 *    the same PDF keep their own copies — collapsing them would rewrite bodies
 *    the user did not ask us to touch and would make a delete in one note
 *    reach into another.
 *
 * @module vault/attachment-references
 */

import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'
import type {
  VaultAttachmentEntry,
  InsertExistingAttachmentResult
} from '@memry/contracts/notes-api'
import { getAllNoteRefRows, getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { createLogger } from '../lib/logger'
import {
  getAttachmentRef,
  getFileType,
  getMimeType,
  getNoteAttachmentsDir,
  isAllowedFileType
} from './attachments'
import { getVaultRoot } from './notes-io'

const logger = createLogger('AttachmentReferences')

/** The `{6-char nanoid}-` prefix `generateUniqueFilename` puts on every file. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

/**
 * The name to show for a stored file: the nanoid prefix off, nothing else.
 *
 * The block prop the uploading note carries is the true original name, but it
 * lives in that note's body rather than on disk, and reading every note to
 * recover it would make opening a picker cost a vault scan. Dropping the prefix
 * gets back the sanitized original, which is what the user typed modulo spaces.
 */
export function displayNameForStoredFilename(filename: string): string {
  return STORED_PREFIX_RE.test(filename) ? filename.slice(7) : filename
}

/**
 * Every attachment in the vault, newest first, with the note that stores it.
 *
 * Walks `attachments/` rather than any table because the folder is the source
 * of truth for what exists on this device — the same reason
 * `listNoteAttachments` does. Folders whose note id is no longer in the index
 * are still listed: the bytes are real and a user may well want them back in a
 * note, they just have no title to show.
 */
export function listVaultAttachments(): VaultAttachmentEntry[] {
  const vaultPath = getVaultRoot()
  const root = path.join(vaultPath, 'attachments')
  if (!existsSync(root)) return []

  const titles = new Map<string, string>()
  try {
    for (const row of getAllNoteRefRows(getIndexDatabase())) titles.set(row.id, row.title)
  } catch (error) {
    logger.warn('Could not read note titles for the attachment picker', { error })
  }

  const entries: VaultAttachmentEntry[] = []
  let ownerDirs: string[]
  try {
    ownerDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch (error) {
    logger.warn('Could not read the attachments folder', { error })
    return []
  }

  for (const ownerNoteId of ownerDirs) {
    const dir = path.join(root, ownerNoteId)
    let files: string[]
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const filename of files) {
      // Extension-gated the same way uploads are: a folder can hold whatever an
      // importer put there, and the picker only offers what a block can render.
      if (!isAllowedFileType(filename)) continue
      let size: number
      let modifiedAt: string
      try {
        const stats = statSync(path.join(dir, filename))
        size = stats.size
        modifiedAt = stats.mtime.toISOString()
      } catch {
        continue
      }
      entries.push({
        ownerNoteId,
        ownerNoteTitle: titles.get(ownerNoteId) ?? null,
        filename,
        displayName: displayNameForStoredFilename(filename),
        size,
        mimeType: getMimeType(filename),
        type: getFileType(filename),
        modifiedAt
      })
    }
  }

  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  return entries
}

/**
 * The block props `noteId` should use to embed an attachment stored under
 * `ownerNoteId` — including when the two are the same note, which is simply an
 * ordinary local ref.
 *
 * Validated rather than trusted: both ids have to be plain path segments and the
 * file has to exist, so a crafted `ownerNoteId` can never make a note reference
 * something outside `attachments/`.
 */
export function buildExistingAttachmentReference(
  noteId: string,
  ownerNoteId: string,
  filename: string
): InsertExistingAttachmentResult {
  if (!isPlainSegment(ownerNoteId) || !isPlainSegment(filename)) {
    throw new NoteError('Invalid attachment reference', NoteErrorCode.INVALID_PATH, noteId)
  }

  const vaultPath = getVaultRoot()
  const diskPath = path.join(getNoteAttachmentsDir(vaultPath, ownerNoteId), filename)
  if (!existsSync(diskPath)) {
    throw new NoteError('Attachment file not found on disk', NoteErrorCode.NOT_FOUND, noteId)
  }

  const notePath = getNoteCacheById(getIndexDatabase(), noteId)?.path
  if (!notePath) {
    throw new NoteError(`Note not found: ${noteId}`, NoteErrorCode.NOT_FOUND, noteId)
  }

  return {
    url: getAttachmentRef(vaultPath, ownerNoteId, filename, notePath),
    name: displayNameForStoredFilename(filename),
    filename,
    ownerNoteId,
    size: statSync(diskPath).size,
    mimeType: getMimeType(filename),
    type: getFileType(filename)
  }
}

function isPlainSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}
