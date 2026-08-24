/**
 * Renaming an attachment from its block menu (#1714).
 *
 * A stored attachment is named `{6-char nanoid}-{sanitized name}{ext}` inside
 * `attachments/<noteId>/`. A rename keeps the nanoid prefix and the extension
 * and only replaces the middle: the prefix is what every cross-device repair
 * path keys on (self-heal in `attachment-heal.ts`, the rename reconcile below),
 * and a changed extension would make the block's mime type a lie.
 *
 * Order of operations is disk first, note body second — the renderer writes the
 * block's `url`/`name` after this resolves. A crash in that window leaves the
 * body pointing at the old name, which self-heal already repairs by prefix; the
 * reverse order would leave the body naming a file that does not exist anywhere.
 *
 * Sync semantics: nothing is re-uploaded. The blob and its encrypted manifest
 * are untouched (the manifest's filename stays frozen at whatever it was at
 * upload). What travels is the note body — the block's new `url` — through the
 * ordinary CRDT path, so an older client simply sees a body whose ref differs
 * from its disk and falls back to self-heal. Peers converge their own disk from
 * the body: see `attachment-rename-reconcile.ts`.
 */

import { rename, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import type { AttachmentRenameResult } from '@memry/contracts/notes-api'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { sanitizeFilename } from './file-ops'
import { resolveAttachment } from './attachment-actions'
import { reconcileDownloadedAttachmentName } from './attachment-rename-reconcile'
import { getAttachmentRef, getNoteAttachmentsDir } from './attachments'
import { getVaultRoot } from './notes-io'

const logger = createLogger('AttachmentRename')

/** The `{6-char nanoid}-` prefix `generateUniqueFilename` puts on every file. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

/** How many `-2`, `-3`… suffixes a collision may walk before giving up. */
const MAX_COLLISION_ATTEMPTS = 100

/**
 * The stored middle segment for a user-typed name.
 *
 * Same shaping as `generateUniqueFilename`: spaces, parens and braces are out
 * (they break markdown image links and terminate the `<!-- file:{…} -->`
 * marker), and the result can never be empty.
 */
export function sanitizeAttachmentName(requested: string): string {
  return (
    sanitizeFilename(requested)
      .replace(/[\s(){}]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'file'
  )
}

/**
 * The stored filename a rename produces, before collision handling.
 *
 * `currentStored` keeps its nanoid prefix and its extension; a user who types
 * an extension gets it stripped when it matches the current one, so
 * "invoice.pdf" and "invoice" both land on `{prefix}-invoice.pdf`.
 */
export function buildRenamedFilename(currentStored: string, requestedName: string): string {
  const ext = path.extname(currentStored)
  const prefixMatch = currentStored.match(STORED_PREFIX_RE)
  const prefix = prefixMatch ? prefixMatch[0] : ''

  let base = requestedName.trim()
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, base.length - ext.length)
  }

  return `${prefix}${sanitizeAttachmentName(base)}${ext}`
}

/**
 * A free filename in `dir` for `candidate`, appending `-2`, `-3`… before the
 * extension when the name is taken.
 *
 * Refusing the rename on a collision was the other option; suffixing wins
 * because the two files are genuinely different attachments (different nanoid
 * prefixes) that the user simply wants to call the same thing, and an error
 * dialog cannot tell them which existing file is in the way.
 */
export function resolveCollision(dir: string, candidate: string): string {
  if (!existsSync(path.join(dir, candidate))) return candidate

  const ext = path.extname(candidate)
  const base = candidate.slice(0, candidate.length - ext.length)
  for (let n = 2; n < MAX_COLLISION_ATTEMPTS; n++) {
    const next = `${base}-${n}${ext}`
    if (!existsSync(path.join(dir, next))) return next
  }
  throw new NoteError('Could not find a free attachment filename', NoteErrorCode.INVALID_PATH)
}

/**
 * Rename an attachment on disk and report the new block `url` / `name`.
 *
 * The caller passes the block's raw `props.url`; it is resolved (and self-healed)
 * against the vault exactly like every other attachment action, so an arbitrary
 * filesystem path can never be renamed through this.
 */
export async function renameAttachment(
  noteId: string,
  url: string,
  newName: string
): Promise<AttachmentRenameResult> {
  const trimmed = newName.trim()
  if (!trimmed) {
    throw new NoteError('New attachment name is empty', NoteErrorCode.INVALID_PATH, noteId)
  }

  const resolved = resolveAttachment(noteId, url)
  if (!resolved.exists) {
    throw new NoteError('Attachment file not found on disk', NoteErrorCode.NOT_FOUND, noteId)
  }

  const vaultPath = getVaultRoot()
  const attachmentsDir = getNoteAttachmentsDir(vaultPath, noteId)
  if (path.resolve(path.dirname(resolved.absolutePath)) !== path.resolve(attachmentsDir)) {
    // Only files this note owns are renameable: a shared or out-of-folder file
    // would have references this note cannot rewrite.
    throw new NoteError(
      'Attachment is not stored in this note’s attachments folder',
      NoteErrorCode.INVALID_PATH,
      noteId
    )
  }

  const currentStored = resolved.storedFilename
  const target = resolveCollision(attachmentsDir, buildRenamedFilename(currentStored, trimmed))

  if (target !== currentStored) {
    await rename(resolved.absolutePath, path.join(attachmentsDir, target))
    logger.info('Attachment renamed', { noteId })
  }

  const notePath = getNoteCacheById(getIndexDatabase(), noteId)?.path
  return {
    storedFilename: target,
    url: getAttachmentRef(vaultPath, noteId, target, notePath),
    name: displayNameFor(target, trimmed)
  }
}

/**
 * What the block shows. The stored name is sanitized and prefixed; the display
 * name keeps what the user typed, with the extension restored when they dropped
 * it, so a PDF never reads as extension-less in the card.
 */
function displayNameFor(storedFilename: string, requested: string): string {
  const ext = path.extname(storedFilename)
  const trimmed = requested.trim()
  if (!ext || trimmed.toLowerCase().endsWith(ext.toLowerCase())) return trimmed
  return `${trimmed}${ext}`
}

/**
 * Rename a file sync just materialized to the name this note's body asks for.
 *
 * The one caller is the attachment download handler; the note's markdown is read
 * here so the reconcile itself stays a pure function of (body, folder). Never
 * throws: a missing note file or an unreadable folder leaves the download exactly
 * as it landed, which is what happened before this existed.
 */
export async function applyDownloadedAttachmentName(
  noteId: string,
  downloadedPath: string
): Promise<void> {
  try {
    const notePath = getNoteCacheById(getIndexDatabase(), noteId)?.path
    if (!notePath) return
    const vaultPath = getVaultRoot()
    const markdown = await readFile(path.join(vaultPath, notePath), 'utf-8')
    reconcileDownloadedAttachmentName(noteId, downloadedPath, markdown, vaultPath)
  } catch (error) {
    logger.warn('Could not reconcile a downloaded attachment name', { noteId, error })
  }
}
