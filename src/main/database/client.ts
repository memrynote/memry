import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
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

/**
 * Index health status
 */
export type IndexHealth = 'healthy' | 'corrupt' | 'missing'

/**
 * Check the health of the index database.
 * Returns 'healthy' if the database exists and has all required tables,
 * 'corrupt' if the database exists but is missing tables or unreadable,
 * 'missing' if the database file doesn't exist.
 *
 * @param indexDbPath - Absolute path to index.db
 * @returns Index health status
 */
export function checkIndexHealth(indexDbPath: string): IndexHealth {
  try {
    // Check if file exists
    if (!existsSync(indexDbPath)) {
      return 'missing'
    }

    // Try to open and query the database
    const sqlite = new Database(indexDbPath, { readonly: true })

    try {
      // Check if core tables exist
      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]

      const requiredTables = ['note_cache', 'note_tags', 'note_links']
      const existingTables = tables.map((t) => t.name)

      const hasAllTables = requiredTables.every((t) => existingTables.includes(t))

      sqlite.close()

      return hasAllTables ? 'healthy' : 'corrupt'
    } catch {
      sqlite.close()
      return 'corrupt'
    }
  } catch {
    // Failed to open database - it's corrupt
    return 'corrupt'
  }
}
