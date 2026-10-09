import path from 'path'
import { eq } from 'drizzle-orm'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import { readTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { VaultError, VaultErrorCode } from '../lib/errors'
import { removeFolderIfEmpty } from '../vault/folders'
import { whenPageApplyQuiescent } from './bulk-apply'

const log = createLogger('DeletedFolderPrune')

/** How long a prune waits for the pull page that scheduled it to land its files. */
const PAGE_QUIESCENCE_TIMEOUT_MS = 60_000

/**
 * A folder deleted on another device reaches this one as a folder_config
 * tombstone per folder in the subtree, plus one note tombstone per note that
 * was inside it. The folder_config delete usually lands first (the deleting
 * device queues it with the delete; the note deletes follow from its watcher),
 * so the folder still holds notes then and is kept. Each later note delete
 * re-checks the folders above it, and the last one removes the emptied folder.
 *
 * The check runs once the pull page is quiescent, because the page defers note
 * unlinks until after its commit: pruning inside the apply would always see the
 * note files still there.
 */
export function scheduleDeletedFolderPrune(
  db: DrizzleDb,
  folderPath: string,
  options: { folderConfigDeleted?: boolean } = {}
): void {
  if (!folderPath || folderPath === '.') return
  void whenPageApplyQuiescent(PAGE_QUIESCENCE_TIMEOUT_MS)
    .then((quiescent) => {
      if (!quiescent) {
        log.warn('Skipped removing a folder deleted on another device, sync files still pending', {
          folderPath
        })
        return
      }
      return pruneDeletedFolders(db, folderPath, options.folderConfigDeleted === true)
    })
    .catch((error: unknown) => {
      if (error instanceof VaultError && error.code === VaultErrorCode.NOT_INITIALIZED) {
        log.warn('Skipped removing a folder deleted on another device, no vault is open', {
          folderPath
        })
        return
      }
      log.error('Failed to remove a folder deleted on another device', { folderPath, error })
    })
}

/**
 * A folder counts as deleted remotely when it has no folder_config row and a
 * folder_config tombstone. Without the tombstone check a note delete would
 * also prune folders that simply have no row yet (made in a file manager since
 * the last backfill).
 */
function isDeletedFolder(db: DrizzleDb, folderPath: string): boolean {
  const row = db
    .select({ path: folderConfigs.path })
    .from(folderConfigs)
    .where(eq(folderConfigs.path, folderPath))
    .get()
  if (row) return false
  return readTombstoneClock(db, 'folder_config', folderPath) !== null
}

async function pruneDeletedFolders(
  db: DrizzleDb,
  folderPath: string,
  folderConfigDeleted: boolean
): Promise<void> {
  let current = folderPath
  let knownDeleted = folderConfigDeleted
  while (current && current !== '.') {
    if (!knownDeleted && !isDeletedFolder(db, current)) return
    knownDeleted = false

    const result = await removeFolderIfEmpty(current)
    if (result.removed) {
      log.info('Removed a folder deleted on another device', { folderPath: current })
      broadcastToAllWindows(NotesChannels.events.FOLDER_CONFIG_UPDATED, { path: current })
    } else if (result.reason === 'holds-files') {
      log.info('Kept a folder deleted on another device, it still holds files', {
        folderPath: current,
        file: result.file
      })
      return
    } else if (result.reason !== 'missing') {
      log.warn('Kept a folder deleted on another device', {
        folderPath: current,
        reason: result.reason
      })
      return
    }
    current = path.posix.dirname(current)
  }
}
