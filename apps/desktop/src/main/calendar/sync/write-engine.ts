import { eq } from 'drizzle-orm'
import { calendarBindings, type CalendarBinding } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { TaskActivityActor } from '@memry/db-schema/schema/task-activity'
import type { DataDb } from '../../database'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../../sync/local-mutations'
import { recordExternalTaskUpdate } from '../../tasks/activity-log'
import { publishProjectionEvent } from '../../projections'
import { CALENDAR_EVENT_SYNCABLE_FIELDS } from '../field-merge-calendar'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import {
  mapGoogleEventToCalendarEventChanges,
  mapGoogleEventToReminderAt,
  mapGoogleEventToTaskSchedule
} from '../google/mappers'
import { loadSourceAsGoogleEvent, pushEventWithConflictRetry } from '../google/push-conflict-retry'
import {
  listCalendarBindingsForSource,
  upsertCalendarBinding
} from '../repositories/calendar-sources-repository'
import { providerCapabilities } from '../provider/capabilities'
import { findLiveBinding } from '../provider/write-routing'
import type { CalendarSyncTarget, RemoteCalendarEvent, UpsertRemoteEventInput } from '../types'

/**
 * The provider-neutral write engine (#1393). What used to be Google-only in
 * `google/sync-service.ts` is parameterized on the provider id and an
 * adapter: push, delete, remote write-back into Memry items, and the binding
 * bookkeeping. Google's exports are now thin wrappers over this, so Google
 * behaves exactly as before; CalDAV (#1400) is the second writer.
 *
 * Every write path asks `assertProviderWritable` first. A provider without
 * `supportsWrite` can never reach `calendar_bindings` or a push call, however
 * it is wired: the engine refuses, not the adapter.
 */

export interface ProviderWriteAdapter {
  upsertEvent(input: {
    calendarId: string
    eventId: string | null
    event: UpsertRemoteEventInput
    ifMatch?: string | null
  }): Promise<RemoteCalendarEvent>
  getEvent(input: { calendarId: string; eventId: string }): Promise<RemoteCalendarEvent>
  deleteEvent(input: {
    calendarId: string
    eventId: string
    ifMatch?: string | null
  }): Promise<void>
}

export class ProviderReadOnlyError extends Error {
  constructor(readonly providerId: string) {
    super(`Calendar provider ${providerId} cannot write`)
    this.name = 'ProviderReadOnlyError'
  }
}

export function assertProviderWritable(providerId: string): void {
  if (!providerCapabilities(providerId).supportsWrite) throw new ProviderReadOnlyError(providerId)
}

function getNow(): string {
  return new Date().toISOString()
}

/** This provider's live binding for an item, if it has one. */
export function findProviderBinding(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget
): CalendarBinding | undefined {
  return listCalendarBindingsForSource(db, target.sourceType, target.sourceId).find(
    (binding) => binding.provider === providerId && !binding.archivedAt
  )
}

/** Whether a Memry item should currently have a remote event at all. */
export function shouldSourceBeOnCalendar(db: DataDb, target: CalendarSyncTarget): boolean {
  switch (target.sourceType) {
    case 'event': {
      const row = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, target.sourceId))
        .get()
      return Boolean(row && !row.archivedAt)
    }

    case 'task': {
      const row = db.select().from(tasks).where(eq(tasks.id, target.sourceId)).get()
      return Boolean(row && !row.archivedAt && !row.completedAt && row.dueDate)
    }

    case 'reminder': {
      const row = db.select().from(reminders).where(eq(reminders.id, target.sourceId)).get()
      if (!row) return false
      if (row.status === 'dismissed' || row.status === 'triggered') {
        return false
      }
      if (row.status === 'snoozed') {
        return Boolean(row.snoozedUntil)
      }
      return Boolean(row.remindAt)
    }

    case 'inbox_snooze': {
      const row = db.select().from(inboxItems).where(eq(inboxItems.id, target.sourceId)).get()
      return Boolean(row && !row.archivedAt && !row.filedAt && row.snoozedUntil)
    }
  }
}

function markBindingMutation(id: string, existed: boolean): void {
  if (existed) {
    enqueueLocalSyncUpdate('calendar_binding', id)
  } else {
    enqueueLocalSyncCreate('calendar_binding', id)
  }
}

/**
 * Create or update the item's remote event on one provider and record the
 * binding. Refuses when another provider already holds the item (#2372).
 */
export async function pushSourceToProvider(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget,
  input: {
    adapter: Pick<ProviderWriteAdapter, 'upsertEvent' | 'getEvent'>
    calendarId: string
    /** Extra state the provider keeps on the binding (CalDAV: the raw object). */
    snapshotExtras?: (remote: RemoteCalendarEvent) => Record<string, unknown>
  }
): Promise<CalendarBinding> {
  assertProviderWritable(providerId)
  const existingBinding = findProviderBinding(db, providerId, target)
  const liveBinding = findLiveBinding(db, target)
  if (liveBinding && liveBinding.provider !== providerId) {
    throw new Error(`Calendar item is written by ${liveBinding.provider}, not ${providerId}`)
  }

  const now = getNow()
  const bindingId =
    existingBinding?.id ?? `calendar_binding:${providerId}:${target.sourceType}:${target.sourceId}`

  const remote = await pushEventWithConflictRetry(
    db,
    target,
    input.adapter,
    input.calendarId,
    existingBinding,
    { providerId }
  )

  // After a possible merge, re-load the latest local snapshot for the binding record.
  const finalLocalEvent = loadSourceAsGoogleEvent(db, target)

  const binding = upsertCalendarBinding(db, {
    id: bindingId,
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    provider: providerId,
    remoteCalendarId: remote.calendarId,
    remoteEventId: remote.id,
    ownershipMode: 'memry_managed',
    writebackMode: 'broad',
    remoteVersion: remote.etag,
    lastLocalSnapshot: { ...finalLocalEvent, ...(input.snapshotExtras?.(remote) ?? {}) },
    archivedAt: null,
    clock: existingBinding?.clock,
    syncedAt: now,
    createdAt: existingBinding?.createdAt ?? now,
    modifiedAt: now
  })

  markBindingMutation(binding.id, Boolean(existingBinding))
  return binding
}

/** Delete the item's remote event on this provider and retire the binding. */
export async function deleteSourceFromProvider(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget,
  input: {
    adapter: Pick<ProviderWriteAdapter, 'deleteEvent'>
    /** Send the binding's ETag as `If-Match` (CalDAV). Google deletes unconditionally. */
    ifMatchOnDelete?: boolean
  }
): Promise<boolean> {
  assertProviderWritable(providerId)
  const existingBinding = findProviderBinding(db, providerId, target)
  if (!existingBinding?.remoteCalendarId || !existingBinding.remoteEventId) {
    return false
  }

  await input.adapter.deleteEvent({
    calendarId: existingBinding.remoteCalendarId,
    eventId: existingBinding.remoteEventId,
    ...(input.ifMatchOnDelete ? { ifMatch: existingBinding.remoteVersion ?? null } : {})
  })

  const now = getNow()
  db.update(calendarBindings)
    .set({
      archivedAt: now,
      modifiedAt: now
    })
    .where(eq(calendarBindings.id, existingBinding.id))
    .run()
  enqueueLocalSyncUpdate('calendar_binding', existingBinding.id)
  return true
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

function updateBindingRemoteVersion(
  db: DataDb,
  providerId: string,
  target: CalendarSyncTarget,
  remote: RemoteCalendarEvent,
  snapshotExtras?: Record<string, unknown>
): void {
  const existing = findProviderBinding(db, providerId, target)
  if (!existing) return

  db.update(calendarBindings)
    .set({
      remoteVersion: remote.etag,
      ...(snapshotExtras
        ? {
            lastLocalSnapshot: {
              ...(existing.lastLocalSnapshot ?? {}),
              ...snapshotExtras
            }
          }
        : {}),
      modifiedAt: getNow()
    })
    .where(eq(calendarBindings.id, existing.id))
    .run()

  enqueueLocalSyncUpdate('calendar_binding', existing.id)
}

/**
 * A remote change to a bound event flows back into the Memry item it came
 * from: an event's fields, a task's schedule (and text, per the binding's
 * write-back mode), a reminder's time, an inbox snooze.
 */
export async function applyProviderWriteback(
  db: DataDb,
  providerId: string,
  binding: Pick<CalendarBinding, 'sourceType' | 'sourceId' | 'writebackMode'>,
  remote: RemoteCalendarEvent,
  options: { actor: TaskActivityActor; snapshotExtras?: Record<string, unknown> }
): Promise<void> {
  assertProviderWritable(providerId)
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
      // logged here. The actor is the calendar, not the user.
      const beforeTask = db.select().from(tasks).where(eq(tasks.id, binding.sourceId)).get()
      db.update(tasks).set(updates).where(eq(tasks.id, binding.sourceId)).run()
      recordExternalTaskUpdate(binding.sourceId, beforeTask, updates, options.actor)
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

  updateBindingRemoteVersion(db, providerId, binding, remote, options.snapshotExtras)
}

/**
 * The remote event of a bound item was deleted: delete the Memry event, or
 * unschedule the task, dismiss the reminder, clear the snooze. The binding
 * is retired.
 */
export async function applyProviderDelete(
  db: DataDb,
  providerId: string,
  binding: Pick<CalendarBinding, 'sourceType' | 'sourceId' | 'writebackMode'>,
  options: { actor: TaskActivityActor }
): Promise<void> {
  assertProviderWritable(providerId)
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
      recordExternalTaskUpdate(binding.sourceId, beforeTask, unschedule, options.actor)
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

  const existingBinding = findProviderBinding(db, providerId, binding)
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

const inFlight = new Set<string>()

/**
 * Run a sync pass unless one with the same key is already running (#1393).
 * Keys are per provider and account, so one slow provider never blocks
 * another; the old module-global flag held one slot for everything.
 */
export async function runExclusive<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(key)) return undefined
  inFlight.add(key)
  try {
    return await run()
  } finally {
    inFlight.delete(key)
  }
}

export function isSyncInFlight(key: string): boolean {
  return inFlight.has(key)
}
