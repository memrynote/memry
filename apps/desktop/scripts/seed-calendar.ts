#!/usr/bin/env npx tsx

import { resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@memry/db-schema/schema'
import { seedDefaults } from '../src/main/database/seed'
import { seedSampleCalendar } from '../src/main/database/seed-calendar'

const DATA_MIGRATIONS = resolve(__dirname, '../src/main/database/drizzle-data')
const DEFAULT_DB_DIR = resolve(__dirname, '../dev-data')
const DEFAULT_DB_PATH = resolve(DEFAULT_DB_DIR, 'data.db')

function main(): void {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH

  if (!existsSync(resolve(dbPath, '..'))) {
    mkdirSync(resolve(dbPath, '..'), { recursive: true })
  }

  console.log(`Seeding calendar data at: ${dbPath}`)

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')

  const db = drizzle(sqlite, { schema })

  console.log('Running migrations...')
  migrate(db, { migrationsFolder: DATA_MIGRATIONS })

  console.log('Seeding defaults (inbox project)...')
  seedDefaults(db)

  console.log('Seeding sample calendar (events, external, tasks, reminders, snoozes)...')
  seedSampleCalendar(db)

  sqlite.close()
  console.log('Done!')
}

main()
