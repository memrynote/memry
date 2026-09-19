import { eq } from 'drizzle-orm'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { utcNow } from '@memry/shared/utc'
import { getDatabase } from '../database'
import { getFolders } from '../vault/notes'
import { getCurrentVaultPath } from '../store'
import { createLogger } from '../lib/logger'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

const log = createLogger('FolderConfigEffects')

/**
 * A folder with no notes in it exists nowhere but on disk, and sync ships rows,
 * not directories. Without a folder_config row an empty folder (and every empty
 * folder under it) simply never reaches another device — it only appeared once
 * a note was created inside it, because the note carries its folder path.
 *
 * So folder creation writes the row with a null icon. Applying it remotely
 * mkdir -p's the path (writeFolderConfig creates the directory before deciding
 * the config is empty), which is exactly the missing materialisation.
 */
export function syncFolderConfigCreate(folderPath: string): void {
  if (!folderPath) return
  syncFolderConfigSet(folderPath, null)
}

export function syncFolderConfigSet(folderPath: string, icon: string | null | undefined): void {
  const db = getDatabase()
  if (!db) return

  const existing = db.select().from(folderConfigs).where(eq(folderConfigs.path, folderPath)).get()
  const now = utcNow()

  if (existing) {
    db.update(folderConfigs)
      .set({ icon: icon ?? null, modifiedAt: now })
      .where(eq(folderConfigs.path, folderPath))
      .run()
    enqueueLocalSyncUpdate('folder_config', folderPath)
  } else {
    db.insert(folderConfigs)
      .values({ path: folderPath, icon: icon ?? null, createdAt: now, modifiedAt: now })
      .run()
    enqueueLocalSyncCreate('folder_config', folderPath)
  }
}

/**
 * Renaming a folder moves its whole subtree on disk, so every descendant row is
 * re-keyed too. Re-keying only the folder itself left the descendants pointing
 * at the old path, and another device re-created the old tree from them.
 */
export function syncFolderConfigRename(oldPath: string, newPath: string): void {
  const db = getDatabase()
  if (!db) return

  for (const existing of selectSubtree(db, oldPath)) {
    const targetPath = newPath + existing.path.slice(oldPath.length)
    const snapshot = JSON.stringify({
      path: existing.path,
      icon: existing.icon,
      clock: existing.clock
    })
    db.delete(folderConfigs).where(eq(folderConfigs.path, existing.path)).run()
    enqueueLocalSyncDelete('folder_config', existing.path, snapshot)

    const now = utcNow()
    db.insert(folderConfigs)
      .values({ path: targetPath, icon: existing.icon, createdAt: now, modifiedAt: now })
      .run()
    enqueueLocalSyncCreate('folder_config', targetPath)
  }
}

/**
 * Deleting a folder deletes its subtree on disk, so the descendant rows are
 * tombstoned with it; a surviving descendant row re-creates the deleted folder
 * on the next device that applies it.
 */
export function syncFolderConfigDelete(folderPath: string): void {
  const db = getDatabase()
  if (!db) return

  for (const existing of selectSubtree(db, folderPath)) {
    const snapshot = JSON.stringify({
      path: existing.path,
      icon: existing.icon,
      clock: existing.clock
    })
    db.delete(folderConfigs).where(eq(folderConfigs.path, existing.path)).run()
    enqueueLocalSyncDelete('folder_config', existing.path, snapshot)
  }
}

/**
 * Every folder that predates the create-time row above still exists only on
 * disk, so without this the fix would only ever sync folders made from now on.
 * One pass at sync start writes the missing rows; after that every folder is
 * already in the table and the pass is a no-op.
 */
export async function backfillFolderConfigs(): Promise<number> {
  // No vault open (sign-out, vault switch, shutdown mid-start) means nothing to
  // scan, and getFolders would throw VAULT_NOT_INITIALIZED.
  if (!getCurrentVaultPath()) return 0

  const db = getDatabase()
  if (!db) return 0

  const known = new Set(
    db
      .select({ path: folderConfigs.path })
      .from(folderConfigs)
      .all()
      .map((r) => r.path)
  )
  let queued = 0
  for (const folder of await getFolders()) {
    if (known.has(folder.path)) continue
    syncFolderConfigCreate(folder.path)
    queued += 1
  }

  if (queued > 0) log.info('Queued folder configs for folders that had none', { queued })
  return queued
}

/**
 * The folder's own row plus every row beneath it. Filtered in JS rather than
 * with LIKE because `%` and `_` are legal folder-name characters and drizzle's
 * `like` takes no ESCAPE clause; the table holds one row per folder, so the
 * full scan is cheaper than the escaping it replaces.
 */
function selectSubtree(
  db: NonNullable<ReturnType<typeof getDatabase>>,
  folderPath: string
): { path: string; icon: string | null; clock: unknown }[] {
  const prefix = `${folderPath}/`
  return db
    .select()
    .from(folderConfigs)
    .all()
    .filter((row) => row.path === folderPath || row.path.startsWith(prefix))
}
