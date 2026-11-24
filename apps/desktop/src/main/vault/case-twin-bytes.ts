/**
 * Which binary files may hold a case twin's bytes, kept in `sync_state` so a
 * restart keeps the hold (#5522, #5560). `case-twin-file.ts` writes the
 * keys; the hold (`case-twin-hold.ts`) reads them for the watcher and the
 * attachment backfill, and a note's own download landing or its row's drop
 * clears it.
 *
 * - `caseTwinHeldChanges`: JSON list of the folded disk paths of shared files
 *   the watcher held a change to.
 * - `caseTwinLandedHashes`: JSON object from the folded disk path of a shared
 *   file to the sha256 of the bytes a download last landed there: bytes a
 *   server holds (#5585).
 * - `caseTwinKeptCopies`: the same (or of a file twins shared before a
 *   split), to `{sha256, copy}`: the bytes a landing last kept from the file
 *   as a conflict copy, and the vault path of that copy. A landing retried
 *   after its rename failed keeps them once (REVIEW-5602), while the copy
 *   still holds them (VERIFY-5602, VERIFY-5602R2).
 * - `caseTwinForeignBytes:<noteId>`: one row per marked note, JSON `{sha256}`
 *   of its file when it was marked, or null when the file held a change on no
 *   server then. A mark is read and written alone, so marking many notes and
 *   landing each note's bytes stay linear (#5580). Builds before kept every
 *   mark in one JSON object under `caseTwinForeignBytes`; the first touch
 *   moves its entries to their rows. An unreleased build (#5591, #5626) also
 *   wrote `{sha256}` of a kept conflict copy into a mark; it still reads as
 *   known bytes.
 *
 * @module vault/case-twin-bytes
 */

import { createHash } from 'crypto'
import fs from 'fs'
import { join } from 'path'
import { and, eq, gt, lt } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { foldNotePath } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'
import { createLogger } from '../lib/logger'

const log = createLogger('CaseTwinBytes')

type Key =
  | typeof SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES
  | typeof SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES
  | typeof SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES
  | typeof SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES

const MARK_PREFIX = `${SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES}:`
/** The first key after every mark row: `;` follows `:`. */
const MARK_END = `${SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES};`

/** The bytes a mark was taken from, or null when they held a change on no server. */
export type MarkedFile = { sha256: string } | null

/**
 * The sha256 (hex, as an attachment manifest's checksum) of the file at
 * `filePath`, or null when nothing is there. Read in 1 MiB chunks, so a large
 * file never sits in memory whole. Synchronous: the split's plan reads it
 * with no await before its step.
 */
export function hashFile(filePath: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let read: number
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

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

/**
 * A stored mark. `{size, mtimeMs}` is the shape of a build that never shipped
 * (#5563 before #5585); it reads as null, so the landing keeps the file's
 * change rather than trust a fingerprint it cannot compare.
 */
function toMarkedFile(value: unknown): MarkedFile | undefined {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  if ('sha256' in value && typeof value.sha256 === 'string') return { sha256: value.sha256 }
  return 'size' in value && 'mtimeMs' in value ? null : undefined
}

/**
 * Moves the marks an older build kept in one object to their own rows, then
 * drops the object; a row this build wrote wins. Every mark read and write
 * calls it first, a point read once the object is gone. A crash before the
 * drop moves the same entries again. Only unreleased builds wrote the object
 * (#5563 to #5591; no release tag holds them), with entries `{sha256}`, null
 * or `{size, mtimeMs}`, so an entry of another shape is dropped, not moved
 * as null.
 */
function moveLegacyMarks(db: DrizzleDb): void {
  const legacy = SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES
  if (!db.select({ key: syncState.key }).from(syncState).where(eq(syncState.key, legacy)).get()) {
    return
  }
  const marks = readValue(db, legacy)
  if (
    marks !== undefined &&
    (typeof marks !== 'object' || marks === null || Array.isArray(marks))
  ) {
    log.warn('Case twin foreign bytes are not an object; reading them as empty', {
      type: Array.isArray(marks) ? 'array' : typeof marks
    })
  } else if (marks !== undefined) {
    const updatedAt = new Date()
    for (const [noteId, value] of Object.entries(marks)) {
      const mark = toMarkedFile(value)
      if (mark === undefined) continue
      db.insert(syncState)
        .values({ key: MARK_PREFIX + noteId, value: JSON.stringify(mark), updatedAt })
        .onConflictDoNothing()
        .run()
    }
  }
  db.delete(syncState).where(eq(syncState.key, legacy)).run()
}

/** A stored mark row; one this build cannot read holds a change, so the landing keeps it. */
function toMark(noteId: string, value: string): MarkedFile {
  let mark: MarkedFile | undefined
  try {
    mark = toMarkedFile(JSON.parse(value))
  } catch {
    mark = undefined
  }
  if (mark !== undefined) return mark
  log.warn('A case twin mark is unreadable; its file is held as changed', { noteId })
  return null
}

/**
 * The file note `noteId` was marked at, or undefined when the note's file
 * holds its own bytes.
 */
export function readCaseTwinForeignBytes(db: DrizzleDb, noteId: string): MarkedFile | undefined {
  moveLegacyMarks(db)
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, MARK_PREFIX + noteId))
    .get()
  return row ? toMark(noteId, row.value) : undefined
}

/** Each note whose file may hold bytes that are not its own. */
export function listCaseTwinForeignBytes(db: DrizzleDb): string[] {
  moveLegacyMarks(db)
  return db
    .select({ key: syncState.key })
    .from(syncState)
    .where(and(gt(syncState.key, MARK_PREFIX), lt(syncState.key, MARK_END)))
    .all()
    .map((row) => row.key.slice(MARK_PREFIX.length))
}

function writeMark(db: DrizzleDb, noteId: string, mark: MarkedFile): void {
  moveLegacyMarks(db)
  const value = JSON.stringify(mark)
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key: MARK_PREFIX + noteId, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

/** The watcher held an outside change to this shared file (disk spelling). */
export function recordHeldCaseTwinChange(db: DrizzleDb, diskPath: string): void {
  const held = readHeld(db)
  const folded = foldNotePath(diskPath)
  if (held.has(folded)) return
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, [...held, folded])
}

/** Whether the watcher held a change to this shared file. */
export function hasHeldCaseTwinChange(db: DrizzleDb, diskPath: string): boolean {
  return readHeld(db).has(foldNotePath(diskPath))
}

/** Whether a change to this shared file was held, forgetting it. */
export function takeHeldCaseTwinChange(db: DrizzleDb, diskPath: string): boolean {
  const held = readHeld(db)
  if (!held.delete(foldNotePath(diskPath))) return false
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, [...held])
  return true
}

function readLandedHashes(db: DrizzleDb): Map<string, string> {
  const hashes = readValue(db, SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES)
  if (typeof hashes !== 'object' || hashes === null || Array.isArray(hashes)) return new Map()
  return new Map(
    Object.entries(hashes).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

/** A download landed bytes with this sha256 on a file case twins share (any spelling). */
export function recordLandedCaseTwinHash(db: DrizzleDb, diskPath: string, sha256: string): void {
  const hashes = readLandedHashes(db)
  const folded = foldNotePath(diskPath)
  if (hashes.get(folded) === sha256) return
  hashes.set(folded, sha256)
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES, Object.fromEntries(hashes))
}

/** The sha256 a download last landed on this shared file. */
export function readLandedCaseTwinHash(db: DrizzleDb, diskPath: string): string | undefined {
  return readLandedHashes(db).get(foldNotePath(diskPath))
}

/** The sha256 a download last landed on this shared file, forgetting it. */
export function takeLandedCaseTwinHash(db: DrizzleDb, diskPath: string): string | undefined {
  const hashes = readLandedHashes(db)
  const folded = foldNotePath(diskPath)
  const sha256 = hashes.get(folded)
  if (sha256 === undefined) return undefined
  hashes.delete(folded)
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES, Object.fromEntries(hashes))
  return sha256
}

/** Bytes a landing kept from a shared file, and the vault path of the conflict copy holding them. */
export interface KeptCopy {
  sha256: string
  copy: string
}

/** A bare hash (an unreleased build of #5602) names no copy: its bytes read as not kept. */
function readKeptCopies(db: DrizzleDb): Map<string, KeptCopy> {
  const copies = readValue(db, SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES)
  if (typeof copies !== 'object' || copies === null || Array.isArray(copies)) return new Map()
  return new Map(
    Object.entries(copies).flatMap(([folded, kept]): Array<[string, KeptCopy]> =>
      typeof kept === 'object' &&
      kept !== null &&
      'sha256' in kept &&
      typeof kept.sha256 === 'string' &&
      'copy' in kept &&
      typeof kept.copy === 'string'
        ? [[folded, { sha256: kept.sha256, copy: kept.copy }]]
        : []
    )
  )
}

/** A landing kept this file's bytes as a conflict copy. */
export function recordKeptCaseTwinCopy(db: DrizzleDb, diskPath: string, kept: KeptCopy): void {
  const copies = readKeptCopies(db)
  copies.set(foldNotePath(diskPath), kept)
  writeValue(db, SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES, Object.fromEntries(copies))
}

/**
 * The sha256 of the bytes a landing last kept from this file, while the copy
 * it kept them in still holds them. A copy the user moved back over the file,
 * changed, deleted, or cannot read leaves them on no other file (VERIFY-5602,
 * VERIFY-5602R2).
 */
export function readKeptCaseTwinCopy(
  db: DrizzleDb,
  vaultPath: string,
  diskPath: string
): string | undefined {
  const kept = readKeptCopies(db).get(foldNotePath(diskPath))
  if (!kept) return undefined
  try {
    return hashFile(join(vaultPath, kept.copy)) === kept.sha256 ? kept.sha256 : undefined
  } catch (error) {
    log.warn('A kept conflict copy cannot be read; its bytes count as not kept', {
      copy: kept.copy,
      error
    })
    return undefined
  }
}

/**
 * Note `noteId`'s file may hold a case twin's bytes: no change to it is
 * pushed. `mark` is the sha256 of the file now, or null when it holds a change
 * on no server; a null mark stays null until the note's own bytes land.
 */
export function markCaseTwinForeignBytes(db: DrizzleDb, noteId: string, mark: MarkedFile): void {
  writeMark(db, noteId, readCaseTwinForeignBytes(db, noteId) === null ? null : mark)
}

export function holdsCaseTwinForeignBytes(db: DrizzleDb, noteId: string): boolean {
  return readCaseTwinForeignBytes(db, noteId) !== undefined
}

/** The note's own attachment landed on its file, or the note's row is gone. */
export function clearCaseTwinForeignBytes(db: DrizzleDb, noteId: string): void {
  moveLegacyMarks(db)
  db.delete(syncState)
    .where(eq(syncState.key, MARK_PREFIX + noteId))
    .run()
}
