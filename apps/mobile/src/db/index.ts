import * as SQLite from 'expo-sqlite'
import { Directory, Paths } from 'expo-file-system'
import { createLogger } from '../lib/logger'
import { MOBILE_MIGRATIONS } from './migrations'

const log = createLogger('MobileDb')

/**
 * One SQLite database per vault (data-model.md §1), opened on demand and
 * cached per vault id.
 *
 * Location note, on record (T033 deviation): the spec says Application
 * Support, but expo-file-system exposes no Application Support path (Paths:
 * cache/document/bundle only) and expo-sqlite's directory override takes a
 * file URI from the same set. The constraint behind the spec words is
 * "non-evictable, never Caches, survives OS cache eviction" — the iOS
 * Documents directory satisfies it (files are never evicted there and the app
 * has no UIFileSharingEnabled, so it stays private). The
 * NSFileProtectionCompleteUntilFirstUserAuthentication entitlement in
 * app.config.ts applies to the whole sandbox.
 *
 * R2 findings baked in: bulk writes MUST go through prepared statements inside
 * one transaction (9× faster), and FTS5 vtabs must be dropped before a
 * deliberate close (expo-sqlite SDK 57 segfault in sqlite3Fts5IndexClose).
 */

const VAULTS_DIR_NAME = 'vaults'
const DB_FILE_NAME = 'vault.db'

export function vaultsRootDir(): Directory {
  return new Directory(Paths.document, VAULTS_DIR_NAME)
}

export function vaultDir(vaultId: string): Directory {
  return new Directory(vaultsRootDir(), vaultId)
}

function ensureVaultDir(vaultId: string): Directory {
  const root = vaultsRootDir()
  if (!root.exists) root.create({ intermediates: true })
  const dir = vaultDir(vaultId)
  if (!dir.exists) dir.create({ intermediates: true })
  return dir
}

export type VaultDb = SQLite.SQLiteDatabase

const openDbs = new Map<string, Promise<VaultDb>>()

export function openVaultDb(vaultId: string): Promise<VaultDb> {
  let pending = openDbs.get(vaultId)
  if (!pending) {
    pending = openAndMigrate(vaultId)
    openDbs.set(vaultId, pending)
    pending.catch(() => openDbs.delete(vaultId))
  }
  return pending
}

async function openAndMigrate(vaultId: string): Promise<VaultDb> {
  const dir = ensureVaultDir(vaultId)
  const db = await SQLite.openDatabaseAsync(DB_FILE_NAME, undefined, dir.uri)
  await db.execAsync('PRAGMA journal_mode = WAL')
  await db.execAsync('PRAGMA foreign_keys = ON')
  await runMigrations(db, vaultId)
  return db
}

async function runMigrations(db: VaultDb, vaultId: string): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version')
  const current = row?.user_version ?? 0

  for (const migration of MOBILE_MIGRATIONS) {
    if (migration.version <= current) continue
    log.info('Applying vault DB migration', { name: migration.name })
    await db.withTransactionAsync(async () => {
      await db.execAsync(migration.sql)
    })
    await db.execAsync(`PRAGMA user_version = ${migration.version}`)
  }

  await db.runAsync(
    `INSERT INTO meta (key, value) VALUES ('vault_id', ?) ON CONFLICT(key) DO NOTHING`,
    [vaultId]
  )
}

/**
 * Close a vault DB deliberately. Drops any FTS5 virtual tables first — the R2
 * benchmark reproduced a segfault in sqlite3Fts5IndexClose when a connection
 * closes while still holding an FTS5 vtab.
 */
export async function closeVaultDb(vaultId: string): Promise<void> {
  const pending = openDbs.get(vaultId)
  if (!pending) return
  openDbs.delete(vaultId)
  const db = await pending
  const ftsTables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%'`
  )
  for (const { name } of ftsTables) {
    await db.execAsync(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`)
  }
  await db.closeAsync()
}

export async function getMeta(db: VaultDb, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    key
  ])
  return row?.value ?? null
}

export async function setMeta(db: VaultDb, key: string, value: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  )
}
