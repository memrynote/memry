import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import path from 'node:path'
import * as dataSchema from '@memry/db-schema/data-schema'
import * as indexSchema from '@memry/db-schema/index-schema'
import { projects, statuses } from '@memry/db-schema/data-schema'
import { eq } from 'drizzle-orm'
import { findWorkspaceRoot, getDataDbPath, getIndexDbPath, getMemryDir } from './paths.ts'

export type DataDb = BetterSQLite3Database<typeof dataSchema>
export type IndexDb = BetterSQLite3Database<typeof indexSchema>

export interface OpenedDatabases {
  dataDb: DataDb
  indexDb: IndexDb
  dataSqlite: Database.Database
  indexSqlite: Database.Database
  close(): void
}

const dataCacheKiB = 16000
const indexCacheKiB = 32000
const sqliteTempStore = 'MEMORY'

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))
const initLockTimeoutMs = 30_000
const staleInitLockMs = 5 * 60_000

function configure(sqlite: Database.Database, cacheSize: number): void {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma(`cache_size = ${cacheSize}`)
  sqlite.pragma(`temp_store = ${sqliteTempStore}`)
}

function sleepSync(ms: number): void {
  Atomics.wait(lockWaitBuffer, 0, 0, ms)
}

function isFileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function tryRemoveStaleInitLock(lockPath: string): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(lockPath)
  } catch (error) {
    if (isFileMissing(error)) return
    throw error
  }

  if (Date.now() - stat.mtimeMs > staleInitLockMs) {
    try {
      fs.unlinkSync(lockPath)
    } catch (error) {
      if (!isFileMissing(error)) throw error
    }
  }
}

function withDatabaseInitLock<T>(vaultPath: string, fn: () => T): T {
  fs.mkdirSync(getMemryDir(vaultPath), { recursive: true })
  const lockPath = path.join(getMemryDir(vaultPath), 'database-init.lock')
  const start = Date.now()
  let fd: number | null = null

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      tryRemoveStaleInitLock(lockPath)
      if (Date.now() - start > initLockTimeoutMs) {
        throw new Error('Timed out waiting for vault database initialization lock.')
      }
      sleepSync(50)
    }
  }

  try {
    return fn()
  } finally {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(lockPath)
    } catch (error) {
      if (!isFileMissing(error)) throw error
    }
  }
}

function runMigrations(dbPath: string, folder: string): void {
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  migrate(drizzle(sqlite), { migrationsFolder: folder })
  sqlite.close()
}

function ensureDefaultTaskProject(db: DataDb): void {
  const existing = db.select().from(projects).where(eq(projects.id, 'inbox')).get()
  if (existing) return

  const now = new Date().toISOString()
  db.insert(projects)
    .values({
      id: 'inbox',
      name: 'Inbox',
      description: 'Quick capture for tasks',
      color: '#6366f1',
      icon: 'inbox',
      position: 0,
      isInbox: true,
      createdAt: now,
      modifiedAt: now
    })
    .run()
  db.insert(statuses)
    .values([
      {
        id: 'inbox-todo',
        projectId: 'inbox',
        name: 'To Do',
        color: '#6b7280',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: now
      },
      {
        id: 'inbox-in-progress',
        projectId: 'inbox',
        name: 'In Progress',
        color: '#F59E0B',
        position: 1,
        isDefault: false,
        isDone: false,
        createdAt: now
      },
      {
        id: 'inbox-done',
        projectId: 'inbox',
        name: 'Done',
        color: '#22c55e',
        position: 2,
        isDefault: false,
        isDone: true,
        createdAt: now
      }
    ])
    .run()
}

export function openDatabases(vaultPath: string): OpenedDatabases {
  const workspaceRoot = findWorkspaceRoot()
  const dataDbPath = getDataDbPath(vaultPath)
  const indexDbPath = getIndexDbPath(vaultPath)

  withDatabaseInitLock(vaultPath, () => {
    runMigrations(
      dataDbPath,
      path.join(workspaceRoot, 'apps/desktop/src/main/database/drizzle-data')
    )
    runMigrations(
      indexDbPath,
      path.join(workspaceRoot, 'apps/desktop/src/main/database/drizzle-index')
    )

    const seedSqlite = new Database(dataDbPath)
    configure(seedSqlite, -dataCacheKiB)
    try {
      ensureDefaultTaskProject(drizzle(seedSqlite, { schema: dataSchema }))
    } finally {
      seedSqlite.close()
    }
  })

  const dataSqlite = new Database(dataDbPath)
  const indexSqlite = new Database(indexDbPath)
  configure(dataSqlite, -dataCacheKiB)
  configure(indexSqlite, -indexCacheKiB)

  const dataDb = drizzle(dataSqlite, { schema: dataSchema })
  const indexDb = drizzle(indexSqlite, { schema: indexSchema })

  return {
    dataDb,
    indexDb,
    dataSqlite,
    indexSqlite,
    close() {
      dataSqlite.close()
      indexSqlite.close()
    }
  }
}
