/**
 * The sha256 of the bytes a server holds for a binary note's file, as this
 * device last landed or uploaded them (#5598). A peer's replacement compares
 * the file to it: other bytes, or no hash recorded, are a change on no server,
 * which the landing keeps as a conflict copy.
 *
 * Bytes a download landed came in a record, which every later record has
 * seen. Bytes this device uploaded reach a peer only with a push of this
 * device's after the upload, so they carry that push's clock tick: a record
 * that merged with a change of this device's has seen them only when its
 * clock holds the tick (#5580).
 *
 * One `sync_state` row per binary note, `binarySyncedHash:<noteId>`, deleted
 * with the note's row: JSON `{sha256}` for landed bytes, `{sha256, upload}`
 * for uploaded ones, `upload` null when the tick is unknown. A bare sha256 is
 * the value of a build that never shipped, read as an upload with no tick. No
 * migration: an older build never reads the rows, and a row it left stale
 * names bytes a server held, so it can only read as changed.
 *
 * @module sync/binary-synced-hash
 */

import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../lib/logger'

const log = createLogger('BinarySyncedHash')

const KEY_PREFIX = 'binarySyncedHash:'

/** The push of this device's that first carries uploaded bytes: its clock tick on `deviceId`. */
export interface UploadPush {
  deviceId: string
  tick: number
}

interface SyncedHash {
  sha256: string
  /** Absent for bytes a download landed; null for an upload with no known push. */
  upload?: UploadPush | null
}

function writeSyncedHash(db: DrizzleDb, noteId: string, synced: SyncedHash): void {
  const value = JSON.stringify(synced)
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key: KEY_PREFIX + noteId, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

export function recordLandedBinaryHash(db: DrizzleDb, noteId: string, sha256: string): void {
  writeSyncedHash(db, noteId, { sha256 })
}

export function recordUploadedBinaryHash(
  db: DrizzleDb,
  noteId: string,
  sha256: string,
  push: UploadPush | null
): void {
  writeSyncedHash(db, noteId, { sha256, upload: push })
}

function toUploadPush(value: unknown): UploadPush | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('deviceId' in value) || typeof value.deviceId !== 'string') return null
  return 'tick' in value && typeof value.tick === 'number'
    ? { deviceId: value.deviceId, tick: value.tick }
    : null
}

function parseSyncedHash(noteId: string, value: string): SyncedHash | undefined {
  if (!value.startsWith('{')) return { sha256: value, upload: null }
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null && 'sha256' in parsed) {
      const { sha256 } = parsed
      if (typeof sha256 === 'string') {
        return 'upload' in parsed ? { sha256, upload: toUploadPush(parsed.upload) } : { sha256 }
      }
    }
  } catch {
    // Logged below.
  }
  log.warn('A synced binary hash is unreadable; the file reads as changed', { noteId })
  return undefined
}

/**
 * The sha256 of the bytes a server holds for note `noteId`'s file, or
 * undefined when none is recorded. `mergedWith` is the clock of a record that
 * merged with a change of this device's: uploaded bytes count only when it
 * holds their push.
 */
export function readSyncedBinaryHash(
  db: DrizzleDb,
  noteId: string,
  mergedWith?: VectorClock
): string | undefined {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, KEY_PREFIX + noteId))
    .get()?.value
  const synced = value === undefined ? undefined : parseSyncedHash(noteId, value)
  if (!synced || mergedWith === undefined || synced.upload === undefined) return synced?.sha256
  const push = synced.upload
  return push && (mergedWith[push.deviceId] ?? 0) >= push.tick ? synced.sha256 : undefined
}

export function forgetSyncedBinaryHash(db: DrizzleDb, noteId: string): void {
  db.delete(syncState)
    .where(eq(syncState.key, KEY_PREFIX + noteId))
    .run()
}
