import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync } from 'fs'
import * as dataSchema from '@memry/db-schema/data-schema'
import * as indexSchema from '@memry/db-schema/index-schema'
import * as sqliteVec from 'sqlite-vec'
import { EMBEDDING_DIMENSION } from '../lib/embeddings-constants'
import type { DataDb, IndexDb, RawIndexDb } from './types'

export type { DataDb, IndexDb, RawIndexDb } from './types'

let dataDb: DataDb | null = null
let indexDb: IndexDb | null = null
let sqliteDataDb: Database.Database | null = null
let sqliteIndexDb: Database.Database | null = null

export function initDatabase(dbPath: string): DataDb {
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

  dataDb = drizzle(sqliteDataDb, { schema: dataSchema })
  return dataDb
}

export function initIndexDatabase(dbPath: string): IndexDb {
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

  // Load sqlite-vec extension for vector search
  sqliteVec.load(sqliteIndexDb)

  // Create vec0 virtual table for note embeddings (not managed by Drizzle)
  // Uses cosine distance metric for similarity search
  sqliteIndexDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
      note_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSION}] distance_metric=cosine
    )
  `)

  indexDb = drizzle(sqliteIndexDb, { schema: indexSchema })
  return indexDb
}

export function getDatabase(): DataDb {
  if (!dataDb) throw new Error('Database not initialized')
  return dataDb
}

export function requireDatabase(): DataDb {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

export function isDatabaseInitialized(): boolean {
  return dataDb !== null
}

export function getIndexDatabase(): IndexDb {
  if (!indexDb) throw new Error('Index database not initialized')
  return indexDb
}

export function isIndexDatabaseInitialized(): boolean {
  return indexDb !== null
}

/**
 * Get the raw better-sqlite3 connection for the index database.
 * Used for direct sqlite-vec queries on vec_notes virtual table.
 */
export function getRawIndexDatabase(): RawIndexDb {
  if (!sqliteIndexDb) throw new Error('Index database not initialized')
  return sqliteIndexDb
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
export type IndexHealth = 'healthy' | 'corrupt' | 'missing' | 'migration_failed'

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
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]

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
      .catch((error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}
