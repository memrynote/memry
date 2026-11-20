/**
 * The spelling a vault path has on disk.
 *
 * macOS and Windows file systems ignore case, so `Supernotes/a.md` and
 * `SuperNotes/a.md` open the same file. The index keys notes by their exact
 * path, so a path in the wrong case looks like a file it does not know.
 *
 * @module vault/disk-case
 */

import { existsSync, realpathSync } from 'fs'
import path from 'path'
import { normalizeRelativePath } from '../lib/paths'

/**
 * `relativePath` as the disk spells it: the same path in another case when the
 * file system ignores case and stores it differently, else `relativePath`
 * itself. Null when nothing is at the path.
 *
 * Only a case difference is taken from the disk. A path the disk resolves
 * anywhere else (a symlink, a Unicode normalization) is returned as given.
 * Synchronous, so a watcher handler keeps its place in the event order.
 */
export function diskCaseOf(vaultPath: string, relativePath: string): string | null {
  let onDisk: string
  try {
    // The native realpath reports each segment as stored; the JS one echoes the input.
    onDisk = normalizeRelativePath(
      path.relative(
        realpathSync.native(vaultPath),
        realpathSync.native(path.join(vaultPath, relativePath))
      )
    )
  } catch {
    return null
  }
  return onDisk !== relativePath && onDisk.toLowerCase() === relativePath.toLowerCase()
    ? onDisk
    : relativePath
}

const ignoresCaseByVault = new Map<string, boolean>()

/**
 * Whether the vault's volume ignores case, probed once per vault through its
 * `.memry` folder. A case-sensitive volume (Linux, a case-sensitive APFS
 * image) keeps every spelling as its own file, so no row in another case can
 * name a file there. A vault without `.memry` counts as ignoring case: the
 * caller still proves each match with `diskCaseOf`.
 */
export function volumeIgnoresCase(vaultPath: string): boolean {
  let ignores = ignoresCaseByVault.get(vaultPath)
  if (ignores === undefined) {
    ignores =
      !existsSync(path.join(vaultPath, '.memry')) || existsSync(path.join(vaultPath, '.MEMRY'))
    ignoresCaseByVault.set(vaultPath, ignores)
  }
  return ignores
}
