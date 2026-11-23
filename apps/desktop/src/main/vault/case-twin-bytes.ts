/**
 * Which binary files may hold a case twin's bytes, kept in `sync_state` so a
 * restart keeps the hold (#5522, #5560). `case-twin-file.ts` writes both
 * keys; the watcher reads them, and a note's own download landing clears it.
 *
 * - `caseTwinHeldChanges`: JSON list of the folded disk paths of shared files
 *   the watcher held a change to.
 * - `caseTwinForeignBytes`: JSON object from note id to the size and mtime of
 *   its file when it was marked, or null once the file holds a change that is
 *   on no server (held at the split, or made since).
 *
 * @module vault/case-twin-bytes
 */

import fs from 'fs'
import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { foldNotePath } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'
import { createLogger } from '../lib/logger'

const log = createLogger('CaseTwinBytes')

type Key =
  | typeof SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES
  | typeof SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES

/** The file a mark was taken from, or null when it changed since. */
export type MarkedFile = { size: number; mtimeMs: number } | null

function readValue(db: DrizzleDb, key: Key): unknown {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, key))
    .get()?.value
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch (error) {
    log.warn('Case twin state is corrupt; starting it again', { key, error })
    return undefined
  }
}

function writeValue(db: DrizzleDb, key: Key, entries: unknown[] | Record<string, unknown>): void {
  if (Object.keys(entries).length === 0) {
    db.delete(syncState).where(eq(syncState.key, key)).run()
    return
  }
  const value = JSON.stringify(entries)
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

function readHeld(db: DrizzleDb): Set<string> {
  const paths = readValue(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES)
  return new Set(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [])
}

function isMarkedFile(value: unknown): value is MarkedFile {
  return (
    value === null ||
    (typeof value === 'object' &&
      'size' in value &&
      typeof value.size === 'number' &&
      'mtimeMs' in value &&
      typeof value.mtimeMs === 'number')
  )
}

/** Each note whose file may hold a case twin's bytes, with the file it was marked at. */
export function readCaseTwinForeignBytes(db: DrizzleDb): Map<string, MarkedFile> {
  const marks = readValue(db, SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)
  if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) return new Map()
  return new Map(
    Object.entries(marks).filter((entry): entry is [string, MarkedFile] => isMarkedFile(entry[1]))
  )
}

function writeMarks(db: DrizzleDb, marks: Map<string, MarkedFile>): void {
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES, Object.fromEntries(marks))
}

/** The watcher held an outside change to this shared file (disk spelling). */
export function recordHeldCaseTwinChange(db: DrizzleDb, diskPath: string): void {
  const held = readHeld(db)
  const folded = foldNotePath(diskPath)
  if (held.has(folded)) return
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, [...held, folded])
}

/** Whether a change to this shared file was held, forgetting it. */
export function takeHeldCaseTwinChange(db: DrizzleDb, diskPath: string): boolean {
  const held = readHeld(db)
  if (!held.delete(foldNotePath(diskPath))) return false
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, [...held])
  return true
}

/**
 * Note `noteId`'s file at `filePath` may hold a case twin's bytes: no change to
 * it is pushed. `changed` says the file already holds a change on no server.
 */
export function markCaseTwinForeignBytes(
  db: DrizzleDb,
  noteId: string,
  filePath: string,
  changed: boolean
): void {
  const marks = readCaseTwinForeignBytes(db)
  if (changed || marks.get(noteId) === null) {
    marks.set(noteId, null)
  } else {
    const { size, mtimeMs } = fs.statSync(filePath)
    marks.set(noteId, { size, mtimeMs })
  }
  writeMarks(db, marks)
}

/** Whether note `noteId`'s file may hold a case twin's bytes; if so, a change to it is recorded. */
export function holdCaseTwinForeignChange(db: DrizzleDb, noteId: string): boolean {
  const marks = readCaseTwinForeignBytes(db)
  if (!marks.has(noteId)) return false
  if (marks.get(noteId) !== null) {
    marks.set(noteId, null)
    writeMarks(db, marks)
  }
  return true
}

export function holdsCaseTwinForeignBytes(db: DrizzleDb, noteId: string): boolean {
  return readCaseTwinForeignBytes(db).has(noteId)
}

/** Whether the file at `filePath` changed since it was marked; a missing file holds nothing. */
export function changedSinceMarked(mark: MarkedFile, filePath: string): boolean {
  const stats = fs.statSync(filePath, { throwIfNoEntry: false })
  if (!stats) return false
  return mark === null || stats.size !== mark.size || stats.mtimeMs !== mark.mtimeMs
}

/** The note's own attachment landed on its file. */
export function clearCaseTwinForeignBytes(db: DrizzleDb, noteId: string): void {
  const marks = readCaseTwinForeignBytes(db)
  if (marks.delete(noteId)) writeMarks(db, marks)
}
