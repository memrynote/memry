export {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase,
  closeDatabase,
  closeIndexDatabase,
  closeAllDatabases,
  checkIndexHealth,
  withTimeout,
  type IndexHealth
} from './client'

export type { DataDb, IndexDb, RawIndexDb, DrizzleDb } from './types'

export { runMigrations, runIndexMigrations } from './migrate'

export {
  createFtsTable,
  createFtsTriggers,
  updateFtsContent,
  insertFtsNote,
  deleteFtsNote,
  clearFtsTable,
  getFtsCount,
  ftsNoteExists,
  initializeFts
} from './fts'

export {
  queueFtsUpdate,
  flushFtsUpdates,
  cancelPendingFtsUpdates,
  getPendingFtsCount,
  hasPendingFtsUpdates,
  scheduleFlush
} from './fts-queue'

export { initializeFtsTasks } from './fts-tasks'
export { initializeFtsInbox } from './fts-inbox'
