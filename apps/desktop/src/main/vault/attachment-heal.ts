/**
 * Self-heal for broken attachment refs (#1713).
 *
 * The attachments folder is deliberately excluded from the indexer and the
 * file watcher, so an attachment renamed on disk outside the app breaks its
 * block reference silently and nothing ever repairs it. This module finds the
 * renamed file again — at resolve/serve time only. The note's markdown is
 * never rewritten: sync freezes the filename inside the encrypted manifest at
 * upload, so a url rewrite on one device would fight the other devices' disks
 * forever. Each device instead heals against its own folder on every resolve.
 *
 * Stored attachments are named `{6-char nanoid}-{sanitized name}{ext}`
 * (see `generateUniqueFilename`). A missing file is matched against the other
 * files of the SAME `attachments/<noteId>/` folder — never across notes — by:
 *  - prefix: the candidate kept the 6-char prefix and was renamed after it, or
 *  - suffix: the candidate kept the name and lost/changed the prefix
 *    (a user stripping the "junk" prefix is the most likely manual rename).
 * The union of both must be exactly one file, otherwise the ref stays broken
 * and the block surfaces the expected filename instead.
 */

import { readdirSync } from 'fs'
import path from 'path'

/** The `{6-char nanoid}-` prefix `generateUniqueFilename` puts on every file. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

/**
 * The unique prefix/suffix match for a missing file among its siblings, or
 * null when there is none or more than one. `dirPath` must already be a
 * note's own attachments folder — callers guard that via `healAttachmentPath`.
 */
export function findHealCandidate(dirPath: string, expectedFilename: string): string | null {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return null
  }

  const expectedHasPrefix = STORED_PREFIX_RE.test(expectedFilename)
  const expectedPrefix = expectedHasPrefix ? expectedFilename.slice(0, 7) : null
  const expectedSuffix = expectedHasPrefix ? expectedFilename.slice(7) : expectedFilename

  const matches: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (name.startsWith('.') || name === expectedFilename) continue

    const prefixMatch = expectedPrefix !== null && name.startsWith(expectedPrefix)
    const suffixMatch =
      expectedSuffix.length > 0 && name.replace(STORED_PREFIX_RE, '') === expectedSuffix
    if (prefixMatch || suffixMatch) matches.push(name)
  }

  return matches.length === 1 ? matches[0] : null
}

/**
 * Heal an absolute attachment path that does not exist on disk, or null.
 *
 * Only paths of the exact shape `<vault>/attachments/<noteId>/<file>` are
 * eligible — anything else (a note body, a path outside the vault) is not an
 * attachment and must keep its plain 404 behavior.
 */
export function healAttachmentPath(absolutePath: string, vaultPaths: string[]): string | null {
  const dir = path.dirname(absolutePath)
  const attachmentsRoot = path.dirname(dir)
  if (path.basename(attachmentsRoot) !== 'attachments') return null

  const vaultRoot = path.dirname(attachmentsRoot)
  const inVault = vaultPaths.some(
    (vault) => vault && path.resolve(vault) === path.resolve(vaultRoot)
  )
  if (!inVault) return null

  const healed = findHealCandidate(dir, path.basename(absolutePath))
  return healed ? path.join(dir, healed) : null
}
