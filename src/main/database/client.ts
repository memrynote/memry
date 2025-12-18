import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import * as schema from '@shared/db/schema'

export type DrizzleDb = BetterSQLite3Database<typeof schema>

let dataDb: DrizzleDb | null = null
let indexDb: DrizzleDb | null = null
let sqliteDataDb: Database.Database | null = null
let sqliteIndexDb: Database.Database | null = null

export function initDatabase(dbPath: string): DrizzleDb {
  sqliteDataDb = new Database(dbPath)
  sqliteDataDb.pragma('journal_mode = WAL')
  sqliteDataDb.pragma('foreign_keys = ON')

  dataDb = drizzle(sqliteDataDb, { schema })
  return dataDb
}

export function initIndexDatabase(dbPath: string): DrizzleDb {
  sqliteIndexDb = new Database(dbPath)
  sqliteIndexDb.pragma('journal_mode = WAL')

  indexDb = drizzle(sqliteIndexDb, { schema })
  return indexDb
}

export function getDatabase(): DrizzleDb {
  if (!dataDb) throw new Error('Database not initialized')
  return dataDb
}

export function getIndexDatabase(): DrizzleDb {
  if (!indexDb) throw new Error('Index database not initialized')
  return indexDb
}

export function closeDatabase(): void {
  sqliteDataDb?.close()
  sqliteDataDb = null
  dataDb = null
}

export function closeIndexDatabase(): void {
  sqliteIndexDb?.close()
  sqliteIndexDb = null
  indexDb = null
}

export function closeAllDatabases(): void {
  closeDatabase()
  closeIndexDatabase()
}
