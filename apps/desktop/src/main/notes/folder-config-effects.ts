import { eq } from 'drizzle-orm'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { utcNow } from '@memry/shared/utc'
import { getDatabase } from '../database'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

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

export function syncFolderConfigRename(oldPath: string, newPath: string): void {
  const db = getDatabase()
  if (!db) return

  const existing = db.select().from(folderConfigs).where(eq(folderConfigs.path, oldPath)).get()

  if (existing) {
    const snapshot = JSON.stringify({
      path: oldPath,
      icon: existing.icon,
      clock: existing.clock
    })
    db.delete(folderConfigs).where(eq(folderConfigs.path, oldPath)).run()
    enqueueLocalSyncDelete('folder_config', oldPath, snapshot)

    const now = utcNow()
    db.insert(folderConfigs)
      .values({ path: newPath, icon: existing.icon, createdAt: now, modifiedAt: now })
      .run()
    enqueueLocalSyncCreate('folder_config', newPath)
  }
}

export function syncFolderConfigDelete(folderPath: string): void {
  const db = getDatabase()
  if (!db) return

  const existing = db.select().from(folderConfigs).where(eq(folderConfigs.path, folderPath)).get()

  if (existing) {
    const snapshot = JSON.stringify({
      path: folderPath,
      icon: existing.icon,
      clock: existing.clock
    })
    db.delete(folderConfigs).where(eq(folderConfigs.path, folderPath)).run()
    enqueueLocalSyncDelete('folder_config', folderPath, snapshot)
  }
}
