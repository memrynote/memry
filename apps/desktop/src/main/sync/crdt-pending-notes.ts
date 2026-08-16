import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtPendingNotes')

const FILE_NAME = 'crdt-pending-notes.json'

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
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch (err) {
    log.warn('Pending CRDT note store is unreadable, ignoring it', { error: err })
    return []
  }
}

function writePendingCrdtNotes(noteIds: string[]): void {
  try {
    if (noteIds.length === 0) {
      fs.rmSync(storePath(), { force: true })
      return
    }
    fs.writeFileSync(storePath(), JSON.stringify(noteIds), 'utf8')
  } catch (err) {
    log.error('Failed to write the pending CRDT note store', { error: err })
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

export interface PendingCrdtDrainDeps {
  /** Push the note's full CRDT state to the server. `false` means try again. */
  pushSnapshot: (noteId: string) => Promise<boolean>
  /** `false` for notes that no longer exist or never sync via CRDT (binaries). */
  isSyncable: (noteId: string) => boolean
}

let draining = false

/**
 * Replay the notes recorded at the last shutdown. An entry is cleared only once
 * its state has actually reached the server, so a still-offline start leaves it
 * queued for the next attempt rather than losing it.
 */
export async function drainPendingCrdtNotes(
  deps: PendingCrdtDrainDeps
): Promise<{ cleared: number; retained: number }> {
  if (draining) return { cleared: 0, retained: 0 }

  const pending = readPendingCrdtNotes()
  if (pending.length === 0) return { cleared: 0, retained: 0 }

  draining = true
  const cleared: string[] = []
  try {
    for (const noteId of pending) {
      if (!deps.isSyncable(noteId)) {
        cleared.push(noteId)
        continue
      }
      try {
        if (await deps.pushSnapshot(noteId)) cleared.push(noteId)
      } catch (err) {
        log.warn('Failed to replay a CRDT note buffered at shutdown', { noteId, error: err })
      }
    }
  } finally {
    draining = false
    clearPendingCrdtNotes(cleared)
  }

  const retained = pending.length - cleared.length
  if (retained > 0) {
    log.warn('Some CRDT notes buffered at shutdown still have not synced', {
      cleared: cleared.length,
      retained
    })
  } else {
    log.info('Replayed CRDT notes buffered at shutdown', { cleared: cleared.length })
  }
  return { cleared: cleared.length, retained }
}
