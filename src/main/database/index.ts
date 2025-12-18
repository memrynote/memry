export {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  closeDatabase,
  closeIndexDatabase,
  closeAllDatabases,
  type DrizzleDb
} from './client'

export { runMigrations, runIndexMigrations } from './migrate'
