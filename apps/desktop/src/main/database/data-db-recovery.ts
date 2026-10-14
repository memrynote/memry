import fs from 'fs'
import Database from 'better-sqlite3'

import { createLogger } from '../lib/logger'

const logger = createLogger('DataDbRecovery')

/** SQLite keeps uncheckpointed writes in these siblings; they move with the file. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const

export type SalvagedQueueRow = Record<string, unknown>

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
 * Best-effort read of the pending sync queue out of a corrupt data.db backup.
 *
 * Rows are taken one at a time so a damaged page late in the table still
 * yields everything before it. Whatever cannot be read is logged, never thrown:
 * a failed salvage must not block recovery.
 */
export function salvageSyncQueue(backupPath: string): SalvagedQueueRow[] {
  const rows: SalvagedQueueRow[] = []
  let db: Database.Database | null = null
  try {
    db = new Database(backupPath, { readonly: true, fileMustExist: true })
    for (const row of db.prepare('SELECT * FROM sync_queue').iterate()) {
      rows.push(row as SalvagedQueueRow)
    }
  } catch (error) {
    logger.error(
      `Could not salvage all pending sync queue rows from ${backupPath}; recovered ${rows.length}`,
      error
    )
  } finally {
    db?.close()
  }
  return rows
}

/**
 * Re-insert salvaged queue rows into the rebuilt data.db so unsynced changes
 * still reach the server. Only columns the current schema has are copied;
 * a row the fresh database rejects is logged and skipped.
 */
export function replaySyncQueue(db: Database.Database, rows: SalvagedQueueRow[]): number {
  if (rows.length === 0) return 0
  const columns = new Set(
    (db.pragma('table_info(sync_queue)') as Array<{ name: string }>).map((c) => c.name)
  )
  let replayed = 0
  for (const row of rows) {
    const names = Object.keys(row).filter((name) => columns.has(name))
    try {
      db.prepare(
        `INSERT OR IGNORE INTO sync_queue (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      ).run(...names.map((name) => row[name]))
      replayed += 1
    } catch (error) {
      logger.error(`Could not replay salvaged sync queue row ${String(row.id)}`, error)
    }
  }
  return replayed
}
