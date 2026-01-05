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
  type DrizzleDb,
  type IndexHealth
} from './client'

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
