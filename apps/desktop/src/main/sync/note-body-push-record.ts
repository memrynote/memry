/**
 * Records what the note body outbox did with a note's body push (#2647). Kept
 * apart from the state reader so the sync runtime imports only this write.
 *
 * Never throws: a database that cannot be written drops the record with a log
 * line, and the push itself is unaffected.
 *
 * @module sync/note-body-push-record
 */

import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteBodyPushRecord')

export type NoteBodyPushEvent = 'sent' | 'confirmed' | 'failed' | 'rejected'

const EVENT_COLUMN = {
  sent: 'lastSentAt',
  confirmed: 'lastConfirmedAt',
  failed: 'lastFailedAt',
  rejected: 'lastRejectedAt'
} as const

/** Record what the note body outbox did with a note's body. */
export function recordNoteBodyPush(
  noteId: string,
  event: NoteBodyPushEvent,
  at: number,
  db: DataDb
): void {
  try {
    const column = EVENT_COLUMN[event]
    db.insert(noteBodySync)
      .values({ noteId, [column]: at, updatedAt: at })
      .onConflictDoUpdate({ target: noteBodySync.noteId, set: { [column]: at, updatedAt: at } })
      .run()
  } catch (err) {
    log.warn('Could not record a note body push', { noteId, event, error: err })
  }
}
