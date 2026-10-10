// Writes for what MemryApp has no operation for. They run after app.close(),
// with desktop not running, through the same migrated databases. Each writer
// names the code that owns the data and why writing it directly is safe.
import type Database from 'better-sqlite3'

import { openDatabases, type DataDb } from '../../app-core/database.ts'
import type { SandboxContext } from '../context.ts'
import { inboxHistory } from './inbox.ts'
import {
  backdateSnapshots,
  iconsAndDates,
  liftNestedProperties,
  recentlyOpened,
  registerImportedFiles
} from './notes.ts'
import { folderConfigs, homeBoard, lockSignedOffSpec, tagCategoriesAndOrder } from './organize.ts'
import { tagSchemas, taskFields } from './tags.ts'
import { backdateTasks, projectExtras, taskActivity } from './work.ts'

export interface PostContext {
  ctx: SandboxContext
  data: Database.Database
  index: Database.Database
  dataDb: DataDb
}

export async function runPostSteps(ctx: SandboxContext): Promise<void> {
  const databases = openDatabases(ctx.vaultPath)
  const post: PostContext = {
    ctx,
    data: databases.dataSqlite,
    index: databases.indexSqlite,
    dataDb: databases.dataDb
  }
  try {
    await registerImportedFiles(post)
    // Files are rewritten before their dates are set; nothing touches them after.
    await liftNestedProperties(post)
    await iconsAndDates(post)
    recentlyOpened(post)
    backdateSnapshots(post)
    backdateTasks(post)
    taskActivity(post)
    projectExtras(post)
    inboxHistory(post)
    folderConfigs(post)
    tagCategoriesAndOrder(post)
    tagSchemas(post)
    taskFields(post)
    homeBoard(post)
    lockSignedOffSpec(post)
  } finally {
    databases.close()
  }
}
