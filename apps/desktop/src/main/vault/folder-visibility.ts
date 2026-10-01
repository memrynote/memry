/**
 * Which vault folders the sidebar notes tree lists.
 *
 * @module vault/folder-visibility
 */

import type { VaultConfig } from '@memry/contracts/vault-api'
import { CANVAS_DIR } from '../canvas/scene-file'

/**
 * A predicate over vault-relative folder paths for `getFolders`.
 *
 * Structural and excluded top-level folders (attachments, canvases,
 * node_modules, etc.) are hidden by their first segment; canvases have their
 * own sidebar section with their own tree.
 *
 * The journal folder is hidden as an exact subtree instead: hiding `Notes/Daily`
 * must not take the rest of `Notes` with it. It is listed when the user turns
 * on `journalShowInSidebar`.
 */
export function createTreeFolderFilter(config: VaultConfig): (folderPath: string) => boolean {
  const hiddenRoots = new Set(
    [config.attachmentsFolder, CANVAS_DIR, ...config.excludePatterns]
      .filter(Boolean)
      .map((p) => p.replace(/\/+$/, '').split('/')[0])
  )
  const journalFolder = config.journalShowInSidebar ? '' : config.journalFolder

  return (folderPath) =>
    !hiddenRoots.has(folderPath.split('/')[0]) &&
    !(journalFolder && (folderPath === journalFolder || folderPath.startsWith(`${journalFolder}/`)))
}
