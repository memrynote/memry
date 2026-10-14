import fs from 'fs'
import Database from 'better-sqlite3'

import { createLogger } from '../lib/logger'

const logger = createLogger('DataDbRecovery')

/** SQLite keeps uncheckpointed writes in these siblings; they move with the file. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

export type SalvagedRow = Record<string, unknown>

/**
 * Tables carried from the corrupt backup into the rebuilt data.db (#3248).
 * Everything else refills from the vault files or the next sync pull. These do
 * not: `vault_metadata` holds the vault uuid the server, the CRDT store and the
 * account directory know this vault by; `settings` holds the account binding and
 * the vault-key verifier; `sync_devices` is this device's registration; and
 * `sync_queue` is every change not yet pushed. A fresh uuid would make sync ask
 * the user to merge their own vault and orphan its CRDT history.
 */
export const SALVAGED_TABLES = ['vault_metadata', 'settings', 'sync_devices', 'sync_queue'] as const
export type SalvagedTable = (typeof SALVAGED_TABLES)[number]

/**
 * Rename a corrupt data.db (and its WAL/SHM) to `data.db.corrupt-<timestamp>`.
 *
 * Never deletes: the file is production data and the only copy of anything
 * that had not synced. The WAL keeps its `-wal` suffix on the new name so
 * SQLite still replays it when the backup is opened for salvage.
 */
export function moveAsideCorruptDataDb(dbPath: string, now: number = Date.now()): string {
  let backupPath = `${dbPath}.corrupt-${now}`
  for (let n = 1; fs.existsSync(backupPath); n += 1) backupPath = `${dbPath}.corrupt-${now}-${n}`

  fs.renameSync(dbPath, backupPath)
  for (const suffix of SIDECAR_SUFFIXES) {
    if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, backupPath + suffix)
  }
  return backupPath
}

/**
 * Best-effort read of one table out of a corrupt data.db backup.
 *
 * Rows are taken one at a time so a damaged page late in the table still
 * yields everything before it. Whatever cannot be read is logged, never thrown:
 * a failed salvage must not block recovery.
 */
export function salvageRows(backupPath: string, table: SalvagedTable): SalvagedRow[] {
  const rows: SalvagedRow[] = []
  let db: Database.Database | null = null
  try {
    db = new Database(backupPath, { readonly: true, fileMustExist: true })
    for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate()) {
      rows.push(row as SalvagedRow)
    }
  } catch (error) {
    logger.error(
      `Could not salvage all ${table} rows from ${backupPath}; recovered ${rows.length}`,
      error
    )
  } finally {
    db?.close()
  }
  return rows
}

/**
 * Write salvaged rows into the rebuilt data.db. Only columns the current schema
 * has are copied. A salvaged row replaces a default the fresh migrations seeded
 * under the same key, since the salvaged value is the user's. A row the fresh
 * database rejects is logged and skipped.
 */
export function replayRows(
  db: Database.Database,
  table: SalvagedTable,
  rows: SalvagedRow[]
): number {
  if (rows.length === 0) return 0
  const columns = new Set(
    (db.pragma(`table_info("${table}")`) as Array<{ name: string }>).map((c) => c.name)
  )
  let replayed = 0
  for (const row of rows) {
    const names = Object.keys(row).filter((name) => columns.has(name))
    try {
      db.prepare(
        `INSERT OR REPLACE INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      ).run(...names.map((name) => row[name]))
      replayed += 1
    } catch (error) {
      logger.error(`Could not replay salvaged ${table} row`, error)
    }
  }
  return replayed
}
