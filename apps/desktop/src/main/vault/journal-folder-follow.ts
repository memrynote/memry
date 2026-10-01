/**
 * Recognise a journal folder that was moved as a whole.
 *
 * Renaming `Daily Notes` to `Diary` in Finder (or moving it under another
 * folder) reaches the watcher as one unlink + add per file. With the config
 * still naming `Daily Notes`, every add lands outside the journal folder, and
 * each entry would be turned into a note: a journal delete synced for every
 * day. Instead, the first entry that shows up at the same relative path under
 * another folder, while the configured folder is gone, moves the config along.
 *
 * @module vault/journal-folder-follow
 */

import fs from 'fs'
import path from 'path'
import { normalizeJournalFolder } from '@memry/storage-vault'
import { VaultChannels } from '@memry/contracts/ipc-channels'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { getConfig, getStatus } from './index'
import { writeVaultConfig } from './init'

const logger = createLogger('JournalFolderFollow')

/**
 * Point the journal at the folder it was moved to, after the move already
 * happened on disk: an in-app folder rename, or one done in Finder / Obsidian
 * that the watcher recognised. Files are not touched and the index is not
 * rebuilt; the watcher re-pairs every moved entry with its row as a rename,
 * which keeps each journal's id and date.
 */
export function followJournalFolder(newFolder: string): void {
  const vaultPath = getStatus().path
  if (!vaultPath) return
  const folder = normalizeJournalFolder(newFolder)
  const oldFolder = getConfig().journalFolder
  if (!folder || folder === oldFolder) return

  writeVaultConfig(vaultPath, { journalFolder: folder })
  const newConfig = getConfig()
  logger.info('Journal folder followed a move', { from: oldFolder, to: folder })
  broadcastToAllWindows(VaultChannels.events.CONFIG_CHANGED, newConfig)
}

/**
 * An in-app rename or move of `oldPath` to `newPath`: when that is the journal
 * folder, or a folder it sits in, the journal setting goes along. Called right
 * after the move so the watcher, which reads every moved entry with the config
 * of the moment, pairs each one with its row as a plain rename instead of a
 * journal leaving its folder.
 */
export function followJournalFolderMove(oldPath: string, newPath: string): void {
  const { journalFolder } = getConfig()
  if (journalFolder === oldPath || journalFolder.startsWith(`${oldPath}/`)) {
    followJournalFolder(newPath + journalFolder.slice(oldPath.length))
  }
}

/**
 * The folder a journal entry now lives in, when `newPath` is `oldPath` with the
 * journal folder swapped for another one and the path below it unchanged:
 * `Daily Notes/2025/01/2025-01-14.md` -> `Diary/2025/01/2025-01-14.md` gives
 * `Diary`. Null for any other move.
 */
export function inferMovedJournalFolder(
  journalFolder: string,
  oldPath: string,
  newPath: string
): string | null {
  if (!journalFolder) return null
  const prefix = `${journalFolder}/`
  if (!oldPath.startsWith(prefix)) return null

  const below = oldPath.slice(prefix.length)
  if (!newPath.endsWith(`/${below}`)) return null

  const folder = newPath.slice(0, -(below.length + 1))
  return folder && folder !== journalFolder ? folder : null
}

/**
 * True when every segment of `relativeFolder` exists under `vaultPath` with
 * exactly this spelling. A plain `existsSync` says yes to `daily` after a
 * rename to `Daily` on the default (case-insensitive) macOS and Windows file
 * systems, which would hide exactly the rename this module exists to catch.
 */
export function folderExistsExactCase(vaultPath: string, relativeFolder: string): boolean {
  let current = vaultPath
  for (const segment of relativeFolder.split('/')) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return false
    }
    if (!entries.some((entry) => entry.isDirectory() && entry.name === segment)) return false
    current = path.join(current, segment)
  }
  return true
}
