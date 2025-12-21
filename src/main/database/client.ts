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

  // WAL mode for better concurrency and crash recovery
  sqliteDataDb.pragma('journal_mode = WAL')

  // Enable foreign key constraints
  sqliteDataDb.pragma('foreign_keys = ON')

  // Synchronous mode for safety (NORMAL is good balance for WAL)
  sqliteDataDb.pragma('synchronous = NORMAL')

  // Wait up to 5 seconds for locks
  sqliteDataDb.pragma('busy_timeout = 5000')

  // Increase cache size for better performance (64MB)
  sqliteDataDb.pragma('cache_size = -64000')

  // Store temp tables in memory
  sqliteDataDb.pragma('temp_store = MEMORY')

  dataDb = drizzle(sqliteDataDb, { schema })
  return dataDb
}

export function initIndexDatabase(dbPath: string): DrizzleDb {
  sqliteIndexDb = new Database(dbPath)

  // WAL mode for better concurrency
  sqliteIndexDb.pragma('journal_mode = WAL')

  // No foreign keys on index database (it's a rebuildable cache)

  // Synchronous mode
  sqliteIndexDb.pragma('synchronous = NORMAL')

  // Wait up to 5 seconds for locks
  sqliteIndexDb.pragma('busy_timeout = 5000')

  // Larger cache for search performance (128MB)
  sqliteIndexDb.pragma('cache_size = -128000')

  // Store temp tables in memory
  sqliteIndexDb.pragma('temp_store = MEMORY')

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

/**
 * Wraps a database operation with a timeout.
 * Useful for long-running queries that might hang.
 *
 * @param operation - Async function to execute
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns Result of the operation
 * @throws Error if operation times out
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   async () => db.select().from(tasks).all(),
 *   5000 // 5 second timeout
 * )
 * ```
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Database operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    operation()
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}
