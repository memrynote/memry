/**
 * Per-note sync state that covers the body (#2647).
 *
 * `note_cache.synced_at` only moves with record pushes and pulls, and the body
 * travels as CRDT updates, so it cannot say whether a note's latest text
 * reached the server. The state here is built from three local facts:
 *
 * - waiting changes: `note_body` and record rows in `sync_queue`, and the
 *   `crdt_owed_file_bodies` marker (a file the doc has not taken yet, which is
 *   also how the first launch after #2646 records a note);
 * - what the note body outbox did with them: `note_body_sync`, written when a
 *   body push starts and ends;
 * - whether this install syncs at all, and whether the note is local-only.
 *
 * Only a 2xx from a CRDT body route (an update push, or a snapshot of the whole
 * doc) sets the confirmed time. A record push the
 * server answers with `SYNC_REPLAY_DETECTED` touches none of this.
 *
 * Reads and writes never throw: a database that cannot be used reads as "no
 * record" and the write is dropped with a log line.
 *
 * @module sync/note-sync-state
 */

import { and, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { crdtOwedFileBodies } from '@memry/db-schema/schema/crdt-owed-file-bodies'
import { noteBodySync, type NoteBodySyncRow } from '@memry/db-schema/schema/note-body-sync'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { NOTE_BODY_QUEUE_TYPE } from '@memry/sync-client/queue'
import { isSyncEligible } from '@memry/sync-client/sync-eligibility'
import type {
  NoteSyncState,
  NoteSyncStateValue,
  UnsentNoteEntry,
  UnsentNoteReason,
  UnsentNotesResult
} from '@memry/contracts/ipc-sync-ops'
import { getDatabase, getIndexDatabase, type DataDb, type IndexDb } from '../database/client'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteSyncState')

/** Record types whose queued rows are a note's own record changes. */
const NOTE_RECORD_TYPES = ['note', 'journal'] as const
const QUEUE_TYPES = [NOTE_BODY_QUEUE_TYPE, ...NOTE_RECORD_TYPES]
const IN_LIST_CHUNK = 500
/** The settings list names the oldest notes; `total` still counts every one. */
export const MAX_UNSENT_NOTES = 200

interface WaitingChanges {
  body: number | null
  record: number | null
  fileNotTaken: number | null
}

interface NoteFacts {
  localOnly: boolean
  waiting: WaitingChanges
  pushes: NoteBodySyncRow | null
}

const NO_WAITING: WaitingChanges = { body: null, record: null, fileNotTaken: null }

function oldest(...times: Array<number | null>): number | null {
  const present = times.filter((time): time is number => time !== null)
  return present.length === 0 ? null : Math.min(...present)
}

export function deriveNoteSyncState(facts: NoteFacts, syncEligible: boolean): NoteSyncState {
  const pushes = facts.pushes
  const waitingSince = oldest(facts.waiting.body, facts.waiting.record, facts.waiting.fileNotTaken)
  const confirmed = pushes?.lastConfirmedAt ?? null
  const failed = pushes?.lastFailedAt ?? null
  const rejected = pushes?.lastRejectedAt ?? null
  const sent = pushes?.lastSentAt ?? null

  let state: NoteSyncStateValue
  if (!syncEligible) state = 'not_syncing'
  else if (facts.localOnly) state = 'local_only'
  else if (waitingSince !== null) {
    // A failure since the last stored push means the outbox is retrying: the
    // change is still waiting even while a retry is out.
    const retrying = failed !== null && failed > (confirmed ?? -1)
    const answered = Math.max(confirmed ?? -1, rejected ?? -1)
    state = !retrying && sent !== null && sent > answered ? 'sent' : 'pending'
  } else if (rejected !== null && rejected > (confirmed ?? -1)) state = 'rejected'
  else state = confirmed === null ? 'not_recorded' : 'confirmed'

  return {
    state,
    waitingSince,
    lastSentAt: sent,
    bodyConfirmedAt: confirmed,
    lastFailedAt: failed,
    lastRejectedAt: rejected
  }
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += IN_LIST_CHUNK) out.push(items.slice(i, i + IN_LIST_CHUNK))
  return out
}

/** Oldest waiting change per note and kind. `sync_queue.created_at` is whole seconds. */
function readWaiting(db: DataDb, noteIds: string[]): Map<string, WaitingChanges> {
  const waiting = new Map<string, WaitingChanges>()
  const entry = (noteId: string): WaitingChanges => {
    let found = waiting.get(noteId)
    if (!found) {
      found = { ...NO_WAITING }
      waiting.set(noteId, found)
    }
    return found
  }
  for (const ids of chunks(noteIds)) {
    const queued = db
      .select({
        itemId: syncQueue.itemId,
        type: syncQueue.type,
        createdAt: sql<number>`min(${syncQueue.createdAt})`
      })
      .from(syncQueue)
      .where(and(inArray(syncQueue.itemId, ids), inArray(syncQueue.type, QUEUE_TYPES)))
      .groupBy(syncQueue.itemId, syncQueue.type)
      .all()
    for (const row of queued) {
      const changes = entry(row.itemId)
      const at = row.createdAt * 1000
      if (row.type === NOTE_BODY_QUEUE_TYPE) changes.body = oldest(changes.body, at)
      else changes.record = oldest(changes.record, at)
    }
    const owed = db
      .select()
      .from(crdtOwedFileBodies)
      .where(inArray(crdtOwedFileBodies.noteId, ids))
      .all()
    for (const row of owed) entry(row.noteId).fileNotTaken = row.createdAt
  }
  return waiting
}

function readPushes(db: DataDb, noteIds: string[]): Map<string, NoteBodySyncRow> {
  const pushes = new Map<string, NoteBodySyncRow>()
  for (const ids of chunks(noteIds)) {
    for (const row of db
      .select()
      .from(noteBodySync)
      .where(inArray(noteBodySync.noteId, ids))
      .all()) {
      pushes.set(row.noteId, row)
    }
  }
  return pushes
}

interface NoteMeta {
  id: string
  title: string
  path: string
  localOnly: boolean | null
}

function readNoteMeta(indexDb: IndexDb, noteIds: string[]): Map<string, NoteMeta> {
  const meta = new Map<string, NoteMeta>()
  for (const ids of chunks(noteIds)) {
    for (const row of indexDb
      .select({
        id: noteCache.id,
        title: noteCache.title,
        path: noteCache.path,
        localOnly: noteCache.localOnly
      })
      .from(noteCache)
      .where(inArray(noteCache.id, ids))
      .all()) {
      meta.set(row.id, row)
    }
  }
  return meta
}

export interface NoteSyncStateDbs {
  data: DataDb
  index: IndexDb
}

function resolveDbs(dbs?: NoteSyncStateDbs): NoteSyncStateDbs {
  return dbs ?? { data: getDatabase(), index: getIndexDatabase() }
}

/** State for each id that has an index row. Unknown ids are left out. */
export function getNoteSyncStates(
  noteIds: string[],
  options: { dbs?: NoteSyncStateDbs; syncEligible?: boolean } = {}
): Map<string, NoteSyncState> {
  const states = new Map<string, NoteSyncState>()
  const ids = [...new Set(noteIds)]
  if (ids.length === 0) return states
  try {
    const { data, index } = resolveDbs(options.dbs)
    const syncEligible = options.syncEligible ?? isSyncEligible()
    const meta = readNoteMeta(index, ids)
    const known = ids.filter((id) => meta.has(id))
    const waiting = readWaiting(data, known)
    const pushes = readPushes(data, known)
    for (const id of known) {
      states.set(
        id,
        deriveNoteSyncState(
          {
            localOnly: meta.get(id)?.localOnly === true,
            waiting: waiting.get(id) ?? NO_WAITING,
            pushes: pushes.get(id) ?? null
          },
          syncEligible
        )
      )
    }
  } catch (err) {
    log.warn('Could not read note sync states', { count: ids.length, error: err })
  }
  return states
}

export function getNoteSyncState(
  noteId: string,
  options: { dbs?: NoteSyncStateDbs; syncEligible?: boolean } = {}
): NoteSyncState | null {
  return getNoteSyncStates([noteId], options).get(noteId) ?? null
}

function reasonsFor(state: NoteSyncState, waiting: WaitingChanges): UnsentNoteReason[] {
  const reasons: UnsentNoteReason[] = []
  if (waiting.body !== null) reasons.push('body')
  if (waiting.record !== null) reasons.push('record')
  if (waiting.fileNotTaken !== null) reasons.push('file_not_taken')
  if (state.state === 'rejected') reasons.push('rejected')
  return reasons
}

/**
 * Every note in this vault with changes the server has not stored: queued
 * body or record rows, a file the doc has not taken, or a refused body push.
 * Rejected notes first, then oldest waiting change first.
 */
export function listUnsentNotes(
  options: { dbs?: NoteSyncStateDbs; syncEligible?: boolean; limit?: number } = {}
): UnsentNotesResult {
  try {
    const { data, index } = resolveDbs(options.dbs)
    const syncEligible = options.syncEligible ?? isSyncEligible()
    const candidates = new Set<string>()
    for (const row of data
      .selectDistinct({ itemId: syncQueue.itemId })
      .from(syncQueue)
      .where(inArray(syncQueue.type, QUEUE_TYPES))
      .all()) {
      candidates.add(row.itemId)
    }
    for (const row of data
      .select({ noteId: crdtOwedFileBodies.noteId })
      .from(crdtOwedFileBodies)
      .all()) {
      candidates.add(row.noteId)
    }
    for (const row of data
      .select({ noteId: noteBodySync.noteId })
      .from(noteBodySync)
      .where(
        or(
          and(
            sql`${noteBodySync.lastRejectedAt} IS NOT NULL`,
            isNull(noteBodySync.lastConfirmedAt)
          ),
          gt(noteBodySync.lastRejectedAt, noteBodySync.lastConfirmedAt)
        )
      )
      .all()) {
      candidates.add(row.noteId)
    }

    const ids = [...candidates]
    const meta = readNoteMeta(index, ids)
    const known = ids.filter((id) => meta.has(id) && meta.get(id)?.localOnly !== true)
    const waiting = readWaiting(data, known)
    const pushes = readPushes(data, known)

    const notes: UnsentNoteEntry[] = []
    for (const id of known) {
      const note = meta.get(id)!
      const changes = waiting.get(id) ?? NO_WAITING
      const state = deriveNoteSyncState(
        { localOnly: false, waiting: changes, pushes: pushes.get(id) ?? null },
        syncEligible
      )
      const reasons = reasonsFor(state, changes)
      if (reasons.length === 0) continue
      notes.push({
        id,
        title: note.title,
        path: note.path,
        state: state.state,
        waitingSince: state.waitingSince,
        reasons
      })
    }
    notes.sort((a, b) => {
      const aRejected = a.reasons.includes('rejected') ? 0 : 1
      const bRejected = b.reasons.includes('rejected') ? 0 : 1
      if (aRejected !== bRejected) return aRejected - bRejected
      return (
        (a.waitingSince ?? Number.MAX_SAFE_INTEGER) - (b.waitingSince ?? Number.MAX_SAFE_INTEGER)
      )
    })
    return { total: notes.length, notes: notes.slice(0, options.limit ?? MAX_UNSENT_NOTES) }
  } catch (err) {
    log.warn('Could not list notes with unsent changes', { error: err })
    return { total: 0, notes: [] }
  }
}
