/**
 * Reveal action for vault folders (#2205). Split out of notes-crud.ts, which
 * is at the repo's file-length ceiling.
 *
 * @module vault/folder-actions
 */

import { shell } from 'electron'
import { toAbsolutePath } from './notes-io'

/**
 * Reveal a folder itself in the OS file manager. `shell.showItemInFolder`
 * selects the given path inside its parent directory, so the folder ends up
 * highlighted rather than opened into — unlike `shell.openPath` would do.
 */
export function revealFolderInFinder(folderPath: string): void {
  const absolutePath = toAbsolutePath(folderPath)
  shell.showItemInFolder(absolutePath)
}
