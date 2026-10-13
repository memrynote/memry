/**
 * Records what the note body outbox did with a note's body push (#2647). Kept
 * apart from the state reader so the sync runtime imports only this write.
 *
 * Never throws: a database that cannot be written drops the record with a log
 * line, and the push itself is unaffected.
 *
 * @module sync/note-body-push-record
 */

import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { noteBodySync, type NoteBodySyncRow } from '@memry/db-schema/schema/note-body-sync'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteBodyPushRecord')

export type NoteBodyPushEvent = 'sent' | 'confirmed' | 'snapshot' | 'failed' | 'rejected'

const EVENT_COLUMNS = {
  sent: ['lastSentAt'],
  confirmed: ['lastConfirmedAt'],
  snapshot: ['lastConfirmedAt', 'lastSnapshotAt'],
  failed: ['lastFailedAt'],
  rejected: ['lastRejectedAt']
} as const

/**
 * Record what the note body outbox did with a note's body. `pushed` is the
 * Yjs updates the server just confirmed; their state vector is merged into
 * `pushedStateVector` for the delete keep rule (#3037).
 */
export function recordNoteBodyPush(
  noteId: string,
  event: NoteBodyPushEvent,
  at: number,
  db: DataDb,
  pushed?: readonly Uint8Array[]
): void {
  try {
    const set: Partial<NoteBodySyncRow> = {}
    for (const column of EVENT_COLUMNS[event]) set[column] = at
    if (pushed && pushed.length > 0) {
      const held = db
        .select({ vector: noteBodySync.pushedStateVector })
        .from(noteBodySync)
        .where(eq(noteBodySync.noteId, noteId))
        .get()
      set.pushedStateVector = mergePushedStateVector(held?.vector ?? null, pushed)
    }
    db.insert(noteBodySync)
      .values({ noteId, ...set, updatedAt: at })
      .onConflictDoUpdate({ target: noteBodySync.noteId, set: { ...set, updatedAt: at } })
      .run()
  } catch (err) {
    log.warn('Could not record a note body push', { noteId, event, error: err })
  }
}

/** `held` with every client clock raised to the one `pushed` reaches. Base64. */
export function mergePushedStateVector(held: string | null, pushed: readonly Uint8Array[]): string {
  const merged = held ? Y.decodeStateVector(Buffer.from(held, 'base64')) : new Map<number, number>()
  for (const update of pushed) {
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))) {
      if (clock > (merged.get(client) ?? 0)) merged.set(client, clock)
    }
  }
  return Buffer.from(Y.encodeStateVector(merged)).toString('base64')
}
