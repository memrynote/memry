/**
 * Who still points at an attachment (#2077).
 *
 * An attachment's bytes live at `attachments/<ownerNoteId>/<storedFilename>`
 * and never move. A note references them through its block `url`, in one of the
 * shapes `attachment-actions.ts` documents: note-relative
 * (`../attachments/<owner>/<file>`), mobile root-relative
 * (`attachments/<owner>/<file>`) or legacy absolute
 * (`memry-file://local/…/attachments/<owner>/<file>`). Every one of them
 * contains the literal `attachments/<owner>/<file>` run, which is what makes a
 * substring scan of the note bodies a complete answer rather than a heuristic.
 *
 * This exists so that deleting an attachment cannot take a second note's embed
 * with it: a shared reference is the whole point of "insert existing
 * attachment", and the delete path is the only thing in the app that removes a
 * blob (note deletion deliberately leaves the folder alone).
 *
 * It stays free of any import from `attachments.ts` on purpose — that module
 * calls into this one, and the reverse edge would be a cycle.
 *
 * @module vault/attachment-reference-scan
 */

import { readFileSync } from 'fs'
import path from 'path'
import { getAllNoteRefRows } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getVaultRoot } from './notes-io'

const logger = createLogger('AttachmentReferenceScan')

/** The stable identity of a stored blob: the folder that owns it plus its name. */
export interface AttachmentTarget {
  ownerNoteId: string
  filename: string
}

export interface FindReferencesOptions {
  /** A note whose own references do not count — the one asking to delete. */
  excludeNoteId?: string
}

/**
 * The vault-relative `attachments/<owner>/<file>` target an absolute path names,
 * or null when the path is not inside the vault's attachments tree.
 */
export function attachmentTargetFromAbsolutePath(
  vaultPath: string,
  absolutePath: string
): AttachmentTarget | null {
  const relative = path.relative(path.resolve(vaultPath), path.resolve(absolutePath))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const segments = relative.split(/[/\\]/).filter(Boolean)
  if (segments.length !== 3 || segments[0] !== 'attachments') return null
  return { ownerNoteId: segments[1], filename: segments[2] }
}

/** What a scan found, and whether it managed to look at everything. */
export interface AttachmentReferenceScan {
  /** Note ids whose body names the target, `excludeNoteId` aside. */
  referencedBy: string[]
  /**
   * False when the scan could not read the index or the vault root. The caller
   * must then behave as if the file were shared: "unknown" may never license a
   * deletion.
   */
  complete: boolean
}

/**
 * Which notes still reference `target`.
 *
 * A note row whose file is missing is skipped — a file that is not there cannot
 * be holding a reference — but a failure to enumerate the notes at all clears
 * {@link AttachmentReferenceScan.complete} instead of being reported as "no
 * references".
 */
export function findNotesReferencingAttachment(
  target: AttachmentTarget,
  options?: FindReferencesOptions
): AttachmentReferenceScan {
  const needle = `attachments/${target.ownerNoteId}/${target.filename}`
  let vaultPath: string
  let rows: { id: string; path: string }[]
  try {
    vaultPath = getVaultRoot()
    rows = getAllNoteRefRows(getIndexDatabase())
  } catch (error) {
    logger.warn('Reference scan could not read the index; treating the file as shared', { error })
    return { referencedBy: [], complete: false }
  }

  const referencedBy: string[] = []
  for (const row of rows) {
    if (row.id === options?.excludeNoteId) continue
    let body: string
    try {
      body = readFileSync(path.join(vaultPath, row.path), 'utf-8')
    } catch {
      continue
    }
    if (body.includes(needle)) referencedBy.push(row.id)
  }
  return { referencedBy, complete: true }
}

/** True when nothing else references the target and the scan could prove it. */
export function isAttachmentUnreferenced(
  target: AttachmentTarget,
  options?: FindReferencesOptions
): boolean {
  const scan = findNotesReferencingAttachment(target, options)
  return scan.complete && scan.referencedBy.length === 0
}
