export {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase,
  requireDatabase,
  closeDatabase,
  closeIndexDatabase,
  closeAllDatabases,
  checkIndexHealth,
  withTimeout,
  type IndexHealth
} from './client'

export type { DataDb, IndexDb, RawIndexDb } from './types'

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

export { initializeFtsTasks } from './fts-tasks'
export { initializeFtsInbox } from './fts-inbox'
