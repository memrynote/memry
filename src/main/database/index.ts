export {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  closeDatabase,
  closeIndexDatabase,
  closeAllDatabases,
  checkIndexHealth,
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
