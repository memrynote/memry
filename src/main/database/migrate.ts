import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import path from 'path'

/**
 * Run migrations for data.db (tasks, projects, inbox).
 * Uses drizzle-data migrations folder with task-related schemas only.
 */
export function runMigrations(dbPath: string): void {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite)

  const migrationsFolder = path.join(__dirname, 'drizzle-data')
  migrate(db, { migrationsFolder })

  sqlite.close()
}

/**
 * Run migrations for index.db (note cache).
 * Uses drizzle-index migrations folder with note-cache schemas only.
 */
export function runIndexMigrations(dbPath: string): void {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite)

  const migrationsFolder = path.join(__dirname, 'drizzle-index')
  migrate(db, { migrationsFolder })

  sqlite.close()
}
