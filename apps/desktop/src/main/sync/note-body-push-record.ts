/**
 * Records what the note body outbox did with a note's body push (#2647). Kept
 * apart from the state reader so the sync runtime imports only this write.
 *
 * Never throws: a database that cannot be written drops the record with a log
 * line, and the push itself is unaffected.
 *
 * @module sync/note-body-push-record
 */

import { noteBodySync, type NoteBodySyncRow } from '@memry/db-schema/schema/note-body-sync'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteBodyPushRecord')

/** `snapshot` is a stored whole-doc state: it confirms the body and clears a rejection. */
export type NoteBodyPushEvent = 'sent' | 'confirmed' | 'snapshot' | 'failed' | 'rejected'

const EVENT_COLUMNS = {
  sent: ['lastSentAt'],
  confirmed: ['lastConfirmedAt'],
  snapshot: ['lastConfirmedAt', 'lastSnapshotAt'],
  failed: ['lastFailedAt'],
  rejected: ['lastRejectedAt']
} as const

/** Record what the note body outbox did with a note's body. */
export function recordNoteBodyPush(
  noteId: string,
  event: NoteBodyPushEvent,
  at: number,
  db: DataDb
): void {
  try {
    const set: Partial<NoteBodySyncRow> = { updatedAt: at }
    for (const column of EVENT_COLUMNS[event]) set[column] = at
    db.insert(noteBodySync)
      .values({ noteId, updatedAt: at, ...set })
      .onConflictDoUpdate({ target: noteBodySync.noteId, set })
      .run()
  } catch (err) {
    log.warn('Could not record a note body push', { noteId, event, error: err })
  }
}
