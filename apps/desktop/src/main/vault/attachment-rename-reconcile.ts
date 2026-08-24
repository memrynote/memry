/**
 * Making an attachment rename land on every device's disk (#1714).
 *
 * A rename travels as a note body change: the block's `url` names a different
 * file in the same `attachments/<noteId>/` folder, with the nanoid prefix
 * unchanged. Nothing is re-uploaded, so a peer receiving that body still holds
 * the file under the OLD name — self-heal keeps the embed working, but the file
 * on that device keeps a name the user renamed away from, forever.
 *
 * Two narrow, evidence-backed points converge it:
 *
 *  - `planAttachmentRenames` diffs the refs of the body a write-back is about
 *    to replace against the refs it is writing. A ref that disappeared and a
 *    ref that appeared sharing its nanoid prefix IS the rename that just
 *    arrived — nothing else produces that pair.
 *  - `reconcileDownloadedAttachmentName` runs when sync materializes a file:
 *    the manifest froze the filename at upload, so a file downloaded after the
 *    rename lands under the old name and is renamed to what the body asks for.
 *
 * Deliberately NOT a general "make the folder match the body" pass. A file the
 * user renamed by hand outside the app (#1713) has no matching body change and
 * is never touched here — it keeps the name the user gave it and keeps being
 * served through self-heal.
 */

import { renameSync, existsSync } from 'fs'
import path from 'path'
import { createLogger } from '../lib/logger'
import { getNoteAttachmentsDir } from './attachments'

const logger = createLogger('AttachmentRenameReconcile')

/** The `{6-char nanoid}-` prefix `generateUniqueFilename` puts on every file. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

export interface PlannedRename {
  from: string
  to: string
}

/**
 * Every stored filename a note body references for its own attachments folder.
 *
 * Covers all three ref shapes at once — note-relative (`../attachments/<id>/f`),
 * the `<!-- file:{"url":…} -->` marker's escaped JSON, and legacy absolute
 * `memry-file://local/…/attachments/<id>/f` — because all three contain the
 * same `attachments/<noteId>/<filename>` tail.
 */
export function extractAttachmentFilenames(noteId: string, markdown: string): Set<string> {
  const out = new Set<string>()
  if (!markdown) return out

  // Escape the id: note ids are generated, but this string reaches a regex.
  const escapedId = noteId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`attachments[/\\\\]${escapedId}[/\\\\]([^)\\s"'<>\\\\]+)`, 'g')

  for (const match of markdown.matchAll(re)) {
    const raw = match[1]
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // A stray `%` is not an encoding — keep the literal name.
    }
    if (decoded) out.add(decoded)
  }
  return out
}

/**
 * The renames implied by one body replacing another: a ref that left and
 * exactly one ref that arrived carrying the same nanoid prefix.
 *
 * "Exactly one" on both sides is the whole safety story. Two files renamed in
 * the same write-back still pair up (their prefixes differ); an ambiguous
 * prefix — two candidates either way — is left alone rather than guessed at.
 */
export function planAttachmentRenames(previous: Set<string>, next: Set<string>): PlannedRename[] {
  const gone = [...previous].filter((name) => !next.has(name) && STORED_PREFIX_RE.test(name))
  const arrived = [...next].filter((name) => !previous.has(name) && STORED_PREFIX_RE.test(name))
  if (gone.length === 0 || arrived.length === 0) return []

  const plans: PlannedRename[] = []
  for (const from of gone) {
    const prefix = from.slice(0, 7)
    const candidates = arrived.filter((name) => name.startsWith(prefix))
    const sources = gone.filter((name) => name.startsWith(prefix))
    if (candidates.length === 1 && sources.length === 1) {
      plans.push({ from, to: candidates[0] })
    }
  }
  return plans
}

/**
 * Apply the renames a body change implies to this device's attachments folder.
 *
 * Never throws: the note's bytes are already written by the time this runs, and
 * a folder that cannot be touched must not turn a successful write-back into a
 * failure. Skips anything already in the target state, so it is idempotent and
 * a no-op on the device that performed the rename in the first place.
 */
export function reconcileRenamedAttachments(
  noteId: string,
  previousMarkdown: string | null,
  nextMarkdown: string,
  vaultPath: string
): PlannedRename[] {
  if (!previousMarkdown || !vaultPath) return []

  const plans = planAttachmentRenames(
    extractAttachmentFilenames(noteId, previousMarkdown),
    extractAttachmentFilenames(noteId, nextMarkdown)
  )
  if (plans.length === 0) return []

  const dir = getNoteAttachmentsDir(vaultPath, noteId)
  const applied: PlannedRename[] = []
  for (const plan of plans) {
    const from = path.join(dir, plan.from)
    const to = path.join(dir, plan.to)
    // Source gone: this device renamed it (or never had it). Target taken:
    // something already holds the name — overwriting it would destroy a file.
    if (!existsSync(from) || existsSync(to)) continue
    try {
      renameSync(from, to)
      applied.push(plan)
    } catch (error) {
      logger.warn('Failed to apply a synced attachment rename', { noteId, error })
    }
  }
  if (applied.length > 0) {
    logger.info('Applied synced attachment renames', { noteId, count: applied.length })
  }
  return applied
}

/**
 * Rename a just-downloaded attachment to the name the note body asks for.
 *
 * The encrypted manifest froze the filename at upload, so a device that
 * materializes the file after a rename gets the old name. The body is the
 * authority here — and the file was created by sync a moment ago, so there is
 * no user-chosen name to overwrite.
 *
 * Returns the file's final path (renamed or not), or null when the input is not
 * a file in this note's attachments folder.
 */
export function reconcileDownloadedAttachmentName(
  noteId: string,
  downloadedPath: string,
  noteMarkdown: string | null,
  vaultPath: string
): string | null {
  if (!noteMarkdown || !vaultPath) return null

  const dir = getNoteAttachmentsDir(vaultPath, noteId)
  if (path.resolve(path.dirname(downloadedPath)) !== path.resolve(dir)) return null

  const downloaded = path.basename(downloadedPath)
  if (!STORED_PREFIX_RE.test(downloaded)) return downloadedPath

  const refs = extractAttachmentFilenames(noteId, noteMarkdown)
  if (refs.has(downloaded)) return downloadedPath

  const prefix = downloaded.slice(0, 7)
  const candidates = [...refs].filter((name) => name.startsWith(prefix))
  if (candidates.length !== 1) return downloadedPath

  const target = path.join(dir, candidates[0])
  if (existsSync(target)) return downloadedPath

  try {
    renameSync(downloadedPath, target)
    logger.info('Renamed a downloaded attachment to its synced name', { noteId })
    return target
  } catch (error) {
    logger.warn('Failed to rename a downloaded attachment', { noteId, error })
    return downloadedPath
  }
}
