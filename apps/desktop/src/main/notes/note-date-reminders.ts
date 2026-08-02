import {
  DATE_MENTION_TOKEN_REGEX,
  parseDateMentionToken,
  computeRemindAt
} from '@memry/shared/date-mention'
import type { RemindersService } from '@memry/app-core/reminders'
import { noteDateReminderId } from '@memry/contracts/reminder-types'
import { createLogger } from '../lib/logger'

const log = createLogger('NoteDateReminders')

/**
 * Reconcile note_date reminder rows for a note against the date pills in its
 * markdown. Only pills whose remind offset is not 'none' produce rows.
 * Idempotent: safe to run on every note write.
 */
export async function syncNoteDateReminders(
  noteId: string,
  markdown: string,
  service: RemindersService
): Promise<void> {
  const desired = new Map<string, { remindAt: string }>()
  for (const m of markdown.matchAll(DATE_MENTION_TOKEN_REGEX)) {
    const data = parseDateMentionToken(m[1])
    if (!data || data.remind === 'none') continue
    const remindAt = computeRemindAt(data)
    if (remindAt === null) continue
    desired.set(data.anchorId, { remindAt })
  }

  const existingList = await service.list({
    targetType: 'note_date',
    targetId: noteId,
    limit: 1000
  })
  const existingByAnchor = new Map<string, (typeof existingList.reminders)[number]>()
  for (const row of existingList.reminders) {
    if (row.anchorId) existingByAnchor.set(row.anchorId, row)
  }

  for (const [anchorId, want] of desired) {
    const row = existingByAnchor.get(anchorId)
    if (!row) {
      await service.create({
        // Deterministic: this reconciler runs on every device over its own
        // CRDT-synced copy of the note, so both devices must derive the SAME
        // row id or one pill ends up as two forever-diverging rows.
        id: noteDateReminderId(noteId, anchorId),
        targetType: 'note_date',
        targetId: noteId,
        anchorId,
        remindAt: want.remindAt
      })
    } else if (row.remindAt !== want.remindAt) {
      await service.update({ id: row.id, remindAt: want.remindAt })
    }
  }

  for (const [anchorId, row] of existingByAnchor) {
    if (!desired.has(anchorId)) {
      await service.delete(row.id)
    }
  }

  log.debug('Synced note_date reminders', { noteId, desired: desired.size })
}

/** Remove all note_date reminders for a note (called on note delete). */
export async function clearNoteDateReminders(
  noteId: string,
  service: RemindersService
): Promise<void> {
  const existing = await service.list({ targetType: 'note_date', targetId: noteId, limit: 1000 })
  for (const row of existing.reminders) {
    await service.delete(row.id)
  }
}
