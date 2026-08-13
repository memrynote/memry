import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { DataDb } from '../../database/types'
import { enqueueLocalSyncDelete, enqueueLocalSyncUpdate } from '../../sync/local-mutations'
import { recordExternalTaskUpdate } from '../../tasks/activity-log'
import { publishProjectionEvent } from '../../projections'
import { CALENDAR_EVENT_SYNCABLE_FIELDS } from '../field-merge-calendar'
import {
  mapGoogleEventToCalendarEventChanges,
  mapGoogleEventToReminderAt,
  mapGoogleEventToTaskSchedule
} from './remote-event-mappers'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import { listCalendarBindingsForSource } from '../repositories/calendar-sources-repository'
import type { CalendarSyncTarget, GoogleCalendarRemoteEvent as RemoteCalendarEvent } from '../types'

/**
 * The inbound half of the engine: what a remote change does to the local row it
 * is bound to. Split out of `engine.ts` for max-lines, the same way
 * `push-conflict-retry.ts` was.
 */

function getNow(): string {
  return new Date().toISOString()
}

function tryEnqueueProjectionSyncUpdate(
  entityType: 'task' | 'inbox' | 'reminder',
  id: string
): void {
  try {
    enqueueLocalSyncUpdate(entityType, id)
  } catch (error) {
    if (error instanceof Error && error.message === 'Database not initialized') {
      return
    }
    throw error
  }
}

function publishTaskCalendarMutation(taskId: string): void {
  tryEnqueueProjectionSyncUpdate('task', taskId)
  publishProjectionEvent({
    type: 'task.upserted',
    taskId
  })
  emitCalendarProjectionChanged(`task:${taskId}`)
}

function publishReminderCalendarMutation(reminderId: string): void {
  // Both callers (writeback update and delete-as-dismiss) only ever mutate an
  // existing row in place — never remove it — so this is always an update,
  // never enqueueLocalSyncDelete.
  tryEnqueueProjectionSyncUpdate('reminder', reminderId)
  emitCalendarProjectionChanged(`reminder:${reminderId}`)
}

function publishInboxCalendarMutation(itemId: string): void {
  tryEnqueueProjectionSyncUpdate('inbox', itemId)
  publishProjectionEvent({
    type: 'inbox.upserted',
    itemId
  })
  emitCalendarProjectionChanged(`inbox:${itemId}`)
}

export function getExistingBinding(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget
): typeof calendarBindings.$inferSelect | undefined {
  return listCalendarBindingsForSource(db, target.sourceType, target.sourceId).find(
    (binding) => binding.provider === providerId && !binding.archivedAt
  )
}

function updateBindingRemoteVersion(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget,
  remote: RemoteCalendarEvent
): void {
  const existing = getExistingBinding(db, providerId, target)
  if (!existing) return

  db.update(calendarBindings)
    .set({
      remoteVersion: remote.etag,
      modifiedAt: getNow()
    })
    .where(eq(calendarBindings.id, existing.id))
    .run()

  enqueueLocalSyncUpdate('calendar_binding', existing.id)
}

export async function applyProviderWriteback(
  db: DataDb,
  context: { providerId: string },
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>,
  remote: RemoteCalendarEvent
): Promise<void> {
  const now = getNow()

  switch (binding.sourceType) {
    case 'event': {
      const remoteChanges = mapGoogleEventToCalendarEventChanges(remote)
      db.update(calendarEvents)
        .set({
          ...remoteChanges,
          modifiedAt: now
        })
        .where(eq(calendarEvents.id, binding.sourceId))
        .run()

      // Treat remote → local writeback as edits to whichever fields the remote provided.
      const changedFields = Object.keys(remoteChanges).filter((field) =>
        (CALENDAR_EVENT_SYNCABLE_FIELDS as readonly string[]).includes(field)
      )
      enqueueLocalSyncUpdate('calendar_event', binding.sourceId, changedFields)
      emitCalendarChanged({ entityType: 'calendar_event', id: binding.sourceId })
      break
    }

    case 'task': {
      const schedule = mapGoogleEventToTaskSchedule(remote)
      const updates: Partial<typeof tasks.$inferInsert> = {
        dueDate: schedule.dueDate,
        dueTime: schedule.dueTime,
        modifiedAt: now
      }

      if (binding.writebackMode === 'broad' || binding.writebackMode === 'time_and_text') {
        updates.title = remote.title
        updates.description = remote.description
      }

      // Publisher bypass: this is a raw writeback, so the activity row is
      // logged here. The actor is the calendar provider, not the user.
      const beforeTask = db.select().from(tasks).where(eq(tasks.id, binding.sourceId)).get()
      db.update(tasks).set(updates).where(eq(tasks.id, binding.sourceId)).run()
      recordExternalTaskUpdate(binding.sourceId, beforeTask, updates, 'google_calendar')
      publishTaskCalendarMutation(binding.sourceId)
      break
    }

    case 'reminder': {
      const existing = db.select().from(reminders).where(eq(reminders.id, binding.sourceId)).get()
      if (!existing) throw new Error(`Reminder not found: ${binding.sourceId}`)

      const updates: Partial<typeof reminders.$inferInsert> = {
        modifiedAt: now
      }

      if (existing.status === 'snoozed' && existing.snoozedUntil) {
        updates.snoozedUntil = mapGoogleEventToReminderAt(remote)
      } else {
        updates.remindAt = mapGoogleEventToReminderAt(remote)
      }

      if (binding.writebackMode === 'broad' || binding.writebackMode === 'time_and_text') {
        updates.title = remote.title
        updates.note = remote.description
      }

      db.update(reminders).set(updates).where(eq(reminders.id, binding.sourceId)).run()
      publishReminderCalendarMutation(binding.sourceId)
      break
    }

    case 'inbox_snooze': {
      const updates: Partial<typeof inboxItems.$inferInsert> = {
        snoozedUntil: remote.startAt,
        modifiedAt: now
      }

      if (binding.writebackMode === 'broad' || binding.writebackMode === 'time_and_text') {
        updates.title = remote.title
        updates.content = remote.description
      }

      db.update(inboxItems).set(updates).where(eq(inboxItems.id, binding.sourceId)).run()
      publishInboxCalendarMutation(binding.sourceId)
      break
    }
  }

  updateBindingRemoteVersion(db, context.providerId, binding, remote)
}

export async function applyProviderDelete(
  db: DataDb,
  context: { providerId: string },
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>
): Promise<void> {
  const now = getNow()

  switch (binding.sourceType) {
    case 'event': {
      const existing = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, binding.sourceId))
        .get()
      if (existing) {
        db.delete(calendarEvents).where(eq(calendarEvents.id, binding.sourceId)).run()
        enqueueLocalSyncDelete('calendar_event', binding.sourceId, JSON.stringify(existing))
        emitCalendarChanged({ entityType: 'calendar_event', id: binding.sourceId })
      }
      break
    }

    case 'task': {
      const beforeTask = db.select().from(tasks).where(eq(tasks.id, binding.sourceId)).get()
      const unschedule = { dueDate: null, dueTime: null, modifiedAt: now }
      db.update(tasks).set(unschedule).where(eq(tasks.id, binding.sourceId)).run()
      // Deleting the remote event unschedules the task; that is a real edit and
      // the log should say the calendar made it.
      recordExternalTaskUpdate(binding.sourceId, beforeTask, unschedule, 'google_calendar')
      publishTaskCalendarMutation(binding.sourceId)
      break
    }

    case 'reminder': {
      db.update(reminders)
        .set({
          status: 'dismissed',
          snoozedUntil: null,
          modifiedAt: now
        })
        .where(eq(reminders.id, binding.sourceId))
        .run()
      publishReminderCalendarMutation(binding.sourceId)
      break
    }

    case 'inbox_snooze': {
      db.update(inboxItems)
        .set({
          snoozedUntil: null,
          modifiedAt: now
        })
        .where(eq(inboxItems.id, binding.sourceId))
        .run()
      publishInboxCalendarMutation(binding.sourceId)
      break
    }
  }

  const existingBinding = getExistingBinding(db, context.providerId, binding)
  if (existingBinding) {
    db.update(calendarBindings)
      .set({
        archivedAt: now,
        modifiedAt: now
      })
      .where(eq(calendarBindings.id, existingBinding.id))
      .run()
    enqueueLocalSyncUpdate('calendar_binding', existingBinding.id)
  }
}
