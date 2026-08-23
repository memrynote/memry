import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'

const log = createLogger('CrdtPendingNotes')

const FILE_NAME = 'crdt-pending-notes.json'

/**
 * Where an unreadable store is moved so the next write cannot clobber it.
 *
 * One fixed name rather than the `.corrupt-${Date.now()}` scheme used for the
 * secret store: this file is written on the edit path, so a device that corrupts
 * it repeatedly would accumulate copies in userData forever — a recovery
 * mechanism that is its own leak. Rename overwrites, so there is at most one
 * copy, and it is the newest one. That loses nothing: the read that moved a copy
 * aside also salvaged its ids back into the live file, so a later copy already
 * contains everything an earlier one contributed.
 */
const CORRUPT_FILE_NAME = 'crdt-pending-notes.corrupt.json'

/**
 * Durable record of notes whose CRDT updates never reached the server.
 *
 * Two things fill it, and they are not the same case:
 *
 *  - The in-memory update queue no-ops its flush while paused (offline,
 *    expired token, quota), so quitting in that state used to discard
 *    everything buffered: the edits stayed on this device but silently never
 *    synced. Same for the notes its memory budget releases.
 *  - Local edits made with no update queue at all — signed out, unpaid, or
 *    before the vault opens. The queue never sees those, so its shutdown path
 *    cannot record them; `CrdtProvider.recordUnqueuedUpdate` does it instead,
 *    as the edits happen.
 *
 * The updates themselves are already durable either way — the CRDT provider
 * persists every one of them to the local store — so only the note ids need to
 * survive. `drainPendingCrdtNotes` pushes each note's full doc state, which
 * strictly supersedes any individual buffered updates and is the *only* shape
 * available for a queue-less edit, which produced no incrementals at all.
 */

function storePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function corruptStorePath(): string {
  return path.join(app.getPath('userData'), CORRUPT_FILE_NAME)
}

/**
 * The on-disk shape has never been anything but a JSON array of note ids, and
 * this still reads exactly the file the pre-atomic writer produced — same path,
 * same bytes. Only *how* the file is replaced changed.
 */
export function readPendingCrdtNotes(): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(storePath(), 'utf8')
  } catch {
    // No file is the normal case — nothing was ever left unflushed.
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    }
  } catch (err) {
    return recoverCorruptStore(raw, err)
  }
  // Parsed, but not the array this file has always held. Same treatment: it is
  // not a shape any version of the writer produced, so it is damage, not a
  // format to tolerate.
  return recoverCorruptStore(raw, new Error('Pending CRDT note store is not a JSON array'))
}

/**
 * Pull the note ids out of a store that no longer parses.
 *
 * A truncated JSON array — the shape a torn write leaves — still holds every
 * complete `"id"` token before the cut, and those tokens are the entire content
 * of this file. Returning `[]` instead would report "nothing was pending" for a
 * device that has a backlog, which is the failure being fixed here: the edits
 * themselves survive in the local CRDT store, but nothing would ever push them.
 *
 * Deliberately permissive about what counts as an id. A salvaged string that is
 * not really a note id costs nothing — `drainOnce` asks `isSyncable` first and
 * clears anything that does not resolve — while dropping a real id is silent and
 * permanent.
 */
function salvageNoteIds(raw: string): string[] {
  const ids = new Set<string>()
  for (const [token] of raw.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const value: unknown = JSON.parse(token)
      if (typeof value === 'string' && value.length > 0) ids.add(value)
    } catch {
      // Not a complete JSON string after all; the cut landed inside an escape.
    }
  }
  return Array.from(ids)
}

function recoverCorruptStore(raw: string, err: unknown): string[] {
  const salvaged = salvageNoteIds(raw)
  // Move the damaged bytes aside BEFORE rewriting the live path, so the two can
  // never both hold a partial answer — and so a second read does not report the
  // same corruption again forever.
  try {
    fs.renameSync(storePath(), corruptStorePath())
  } catch (renameErr) {
    log.error('Could not preserve the unreadable pending CRDT note store', { error: renameErr })
  }
  // Repair in place, not just in memory. `drainOnce` reads the store, works,
  // then reads it *again* through `clearPendingCrdtNotes` to remove only what it
  // managed to push; without writing the salvage back, that second read would
  // find the file gone and drop every id the drain had not cleared yet.
  if (salvaged.length > 0) writePendingCrdtNotes(salvaged)
  log.error('Pending CRDT note store was unreadable; preserved it and salvaged what it held', {
    error: err,
    salvaged: salvaged.length
  })
  trackMainError('sync', 'crdt_pending_notes_corrupt', err)
  return salvaged
}

function writePendingCrdtNotes(noteIds: string[]): void {
  try {
    if (noteIds.length === 0) {
      // Unlink stays a plain unlink: it is already atomic, there is no state
      // between "the file holds ids" and "there is no file", and "there is no
      // file" is exactly what "nothing pending" has always meant here.
      fs.rmSync(storePath(), { force: true })
      return
    }
    writeStoreAtomically(JSON.stringify(noteIds))
  } catch (err) {
    log.error('Failed to write the pending CRDT note store', { error: err })
    trackMainError('sync', 'crdt_pending_notes_write', err)
  }
}

/**
 * Write to a temp file in the SAME directory, then rename over the live path.
 *
 * Same directory is the whole point: `rename` is only atomic within a
 * filesystem, so a temp under `os.tmpdir()` would degrade to a copy and put the
 * torn write straight back. Rename replaces the target on all three platforms
 * (libuv passes MOVEFILE_REPLACE_EXISTING on Windows).
 *
 * The temp name is random and opened `wx` with owner-only permissions: a
 * predictable name in a user-writable directory is a symlink-swap target, and a
 * leftover temp from a killed run must not be reused. Mirrors
 * `writeCanvasFileSync`.
 *
 * **fsync is paid on purpose.** Rename alone is atomic against a *process*
 * crash, but after a power cut a filesystem is free to have made the rename
 * durable while the temp file's bytes are not — which lands exactly the
 * truncated (or zero-length) live file this is meant to rule out, and this
 * recorder exists precisely to survive that class of stop. The cost is bounded
 * by the caller, not by typing speed: `CrdtProvider.recordUnqueuedUpdate`
 * dedupes per note for the whole queue-less stretch, so this is one flush per
 * note *touched*, and the payload is a JSON array of ids. On macOS this is
 * `fsync`, not `F_FULLFSYNC` — Node exposes no way to ask for the latter — so it
 * orders the bytes ahead of the rename without paying a full drive-cache flush.
 */
function writeStoreAtomically(contents: string): void {
  const tmpPath = `${storePath()}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // ONE exclusive handle for write + flush: reopening the path to fsync hands
    // a window to anything that can swap it in between.
    const fd = fs.openSync(tmpPath, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, contents, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, storePath())
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // Cleanup is best effort; the original error is what matters.
    }
    throw err
  }
}

/**
 * Add note ids to the durable set. Synchronous on purpose: one caller is the
 * update queue's `stop()`, which runs while the process is quitting and cannot
 * await anything. The provider's queue-less recorder relies on the same
 * property — the id is on disk before the call returns, so a crash a keystroke
 * later still replays — and dedupes per note so this stays one small write per
 * note touched rather than one per update.
 */
export function recordPendingCrdtNotes(noteIds: string[]): void {
  if (noteIds.length === 0) return
  const merged = new Set(readPendingCrdtNotes())
  for (const noteId of noteIds) merged.add(noteId)
  writePendingCrdtNotes(Array.from(merged))
}

export function clearPendingCrdtNotes(noteIds: string[]): void {
  if (noteIds.length === 0) return
  const done = new Set(noteIds)
  writePendingCrdtNotes(readPendingCrdtNotes().filter((noteId) => !done.has(noteId)))
}

import {
  drainPendingNotes,
  type PendingCrdtDrainDeps,
  type PendingNoteStore
} from '@memry/sync-client/crdt/pending-notes'

export type { PendingCrdtDrainDeps } from '@memry/sync-client/crdt/pending-notes'

/**
 * Replay the recorded notes through the platform-free drain in
 * `@memry/sync-client` — desktop supplies the fs-backed store above. The
 * serialisation/coalescing semantics live with the drain; see
 * `packages/sync-client/src/crdt/pending-notes.ts`.
 */
export function drainPendingCrdtNotes(
  deps: PendingCrdtDrainDeps
): ReturnType<typeof drainPendingNotes> {
  return drainPendingNotes(fsPendingNoteStore, deps)
}

const fsPendingNoteStore: PendingNoteStore = {
  read: readPendingCrdtNotes,
  record: recordPendingCrdtNotes,
  clear: clearPendingCrdtNotes
}
