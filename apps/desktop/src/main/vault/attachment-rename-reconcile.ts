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

import { existsSync, readdirSync, renameSync, statSync } from 'fs'
import { open, stat, unlink } from 'fs/promises'
import path from 'path'
import { createLogger } from '../lib/logger'
import { getNoteAttachmentsDir } from './attachments'
import { STORED_PREFIX_RE } from './attachment-heal'

const logger = createLogger('AttachmentRenameReconcile')

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

type Identity = 'same' | 'different' | 'unknown'

const foldName = (name: string): string => name.normalize('NFC').toLowerCase()

/**
 * Whether two paths name one file: a case or normalization variant on a
 * folding FS. A file is removed or replaced only when identity is proven, so
 * callers act on `same` and `different` and leave everything alone on
 * `unknown`. Some mounts (SMB/WebDAV redirectors, virtual cloud drives, FUSE)
 * report ino 0 for every file, which proves neither. The folder listing then
 * settles `same` only when both names fold to one spelling and exactly one
 * entry carries it.
 */
function sameFile(a: string, b: string): Identity {
  const sa = statSync(a, { bigint: true })
  const sb = statSync(b, { bigint: true })
  if (sa.dev === undefined || sb.dev === undefined || !sa.ino || !sb.ino) {
    const folded = foldName(path.basename(a))
    if (folded !== foldName(path.basename(b))) return 'unknown'
    const entries = readdirSync(path.dirname(a)).filter((name) => foldName(name) === folded)
    return entries.length === 1 ? 'same' : 'unknown'
  }
  return sa.dev === sb.dev && sa.ino === sb.ino ? 'same' : 'different'
}

/** Reads both files off the main thread's event loop, chunk by chunk. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)])
  if (sa.size !== sb.size) return false
  const fa = await open(a, 'r')
  try {
    const fb = await open(b, 'r')
    try {
      const ba = Buffer.alloc(64 * 1024)
      const bb = Buffer.alloc(ba.length)
      for (let at = 0; at < sa.size;) {
        const { bytesRead: n } = await fa.read(ba, 0, ba.length, at)
        if (n === 0 || (await fb.read(bb, 0, n, at)).bytesRead !== n) return false
        if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false
        at += n
      }
      return true
    } finally {
      await fb.close()
    }
  } finally {
    await fa.close()
  }
}

/**
 * Give one file the body's spelling of its own name. Two steps through a
 * temporary name, because a folding FS may treat a direct case-only rename as
 * a rename onto itself and keep the old spelling.
 */
function renameCaseOnly(from: string, to: string): void {
  const temporary = `${from}.${process.pid}.case`
  renameSync(from, temporary)
  try {
    renameSync(temporary, to)
  } catch (error) {
    renameSync(temporary, from)
    throw error
  }
}

/**
 * Rename a just-downloaded attachment to the name the note body asks for.
 *
 * The encrypted manifest froze the filename at upload, so a device that
 * materializes the file after a rename gets the old name. The body is the
 * authority here — and the file was created by sync a moment ago, so there is
 * no user-chosen name to overwrite.
 *
 * A file already under the body's name with the same bytes is this download
 * landed and renamed before, its record cut short (OL-M48): the download is a
 * second copy, so it is removed and that file reused. Other bytes there are
 * kept beside it. On a case-insensitive FS a ref that differs only by case
 * names the download itself (REVIEW-5749): that one file takes the body's
 * spelling and nothing is removed. When the FS cannot prove whether the two
 * names are one file (ino 0), the download keeps its name and nothing moves.
 *
 * Returns the file's final path (renamed or not), or null when the input is not
 * a file in this note's attachments folder.
 */
export async function reconcileDownloadedAttachmentName(
  noteId: string,
  downloadedPath: string,
  noteMarkdown: string | null,
  vaultPath: string
): Promise<string | null> {
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
  try {
    if (existsSync(target)) {
      const identity = sameFile(downloadedPath, target)
      if (identity === 'unknown') return downloadedPath
      if (identity === 'same') {
        // Both spellings listed are two links to one file: nothing to rename.
        if (readdirSync(dir).includes(candidates[0])) return downloadedPath
        renameCaseOnly(downloadedPath, target)
        logger.info('Gave a downloaded attachment its synced spelling', { noteId })
        return target
      }
      // Invariant (REVIEW-5749): never delete a path unless it is a different
      // file whose bytes are identical. The same file under two spellings would
      // lose its only copy, with any local edits the server lacks.
      if (!(await sameBytes(downloadedPath, target))) return downloadedPath
      await unlink(downloadedPath)
      logger.info('Reused the attachment already under its synced name', { noteId })
      return target
    }
    renameSync(downloadedPath, target)
    logger.info('Renamed a downloaded attachment to its synced name', { noteId })
    return target
  } catch (error) {
    logger.warn('Failed to rename a downloaded attachment', { noteId, error })
    return downloadedPath
  }
}
