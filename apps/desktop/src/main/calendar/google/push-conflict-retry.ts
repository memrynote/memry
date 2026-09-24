import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { FieldClocks } from '@memry/contracts/sync-api'
import { createLogger } from '../../lib/logger'
import type { DataDb } from '../../database/types'
import { enqueueLocalSyncUpdate } from '../../sync/local-mutations'
import { initAllFieldClocks } from '@memry/sync-client/field-merge'
import { CALENDAR_EVENT_SYNCABLE_FIELDS, mergeCalendarEventFields } from '../field-merge-calendar'
import { emitCalendarChanged } from '../change-events'
import { ProviderConflictError } from '../provider/errors'
import {
  mapCalendarEventToGoogleInput,
  mapGoogleEventToCalendarEventChanges,
  mapInboxSnoozeToGoogleInput,
  mapReminderToGoogleInput,
  mapTaskToGoogleInput
} from './mappers'
import type {
  CalendarSyncTarget,
  GoogleCalendarClient,
  GoogleCalendarRemoteEvent,
  GoogleCalendarUpsertEventInput
} from '../types'

const log = createLogger('Calendar:GooglePushConflict')
export const MAX_PUSH_CONFLICT_RETRIES = 3

function getNow(): string {
  return new Date().toISOString()
}

function isPreconditionFailedError(error: unknown): boolean {
  if (error instanceof ProviderConflictError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 412
  )
}

export function loadSourceAsGoogleEvent(
  db: DataDb,
  target: CalendarSyncTarget
): GoogleCalendarUpsertEventInput {
  switch (target.sourceType) {
    case 'event': {
      const row = db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, target.sourceId))
        .get()
      if (!row) throw new Error(`Calendar event not found: ${target.sourceId}`)
      return mapCalendarEventToGoogleInput(row)
    }

    case 'task': {
      const row = db.select().from(tasks).where(eq(tasks.id, target.sourceId)).get()
      if (!row) throw new Error(`Task not found: ${target.sourceId}`)
      return mapTaskToGoogleInput(row)
    }

    case 'reminder': {
      const row = db.select().from(reminders).where(eq(reminders.id, target.sourceId)).get()
      if (!row) throw new Error(`Reminder not found: ${target.sourceId}`)
      return mapReminderToGoogleInput(row)
    }

    case 'inbox_snooze': {
      const row = db.select().from(inboxItems).where(eq(inboxItems.id, target.sourceId)).get()
      if (!row) throw new Error(`Inbox item not found: ${target.sourceId}`)
      return mapInboxSnoozeToGoogleInput(row)
    }
  }
}

/**
 * Upsert with `If-Match`; on a precondition failure (HTTP 412 or
 * `ProviderConflictError`), refetch the remote, merge it into the local event
 * field by field, and retry with the new ETag. Shared by every writable
 * provider (#1393); `providerId` only labels the logs and the final error.
 */
export async function pushEventWithConflictRetry(
  db: DataDb,
  target: CalendarSyncTarget,
  client: Pick<GoogleCalendarClient, 'upsertEvent' | 'getEvent'>,
  resolvedCalendarId: string,
  existingBinding: typeof calendarBindings.$inferSelect | undefined,
  options: {
    providerId?: string
    /**
     * Merge against the last pushed snapshot: a field the remote left as it
     * was keeps the local edit, a field the remote changed takes the remote
     * value. Without it the remote wins every field it sends (Google's
     * long-standing behaviour).
     */
    threeWayMerge?: boolean
  } = {}
): Promise<GoogleCalendarRemoteEvent> {
  const label =
    !options.providerId || options.providerId === 'google' ? 'Google' : options.providerId
  let ifMatch: string | null = existingBinding?.remoteVersion ?? null

  for (let attempt = 0; attempt < MAX_PUSH_CONFLICT_RETRIES; attempt++) {
    const localEvent = loadSourceAsGoogleEvent(db, target)
    try {
      return await client.upsertEvent({
        calendarId: resolvedCalendarId,
        eventId: existingBinding?.remoteEventId ?? null,
        event: localEvent,
        ifMatch
      })
    } catch (error) {
      if (!isPreconditionFailedError(error) || !existingBinding?.remoteEventId) {
        throw error
      }

      const remote = await client.getEvent({
        calendarId: resolvedCalendarId,
        eventId: existingBinding.remoteEventId
      })

      if (target.sourceType === 'event') {
        const base = options.threeWayMerge ? (existingBinding.lastLocalSnapshot ?? null) : null
        mergeRemoteEventIntoLocal(db, target.sourceId, remote, base)
      }

      ifMatch = remote.etag ?? null
      log.warn(`${label} upsert returned 412; merged remote and retrying`, {
        sourceType: target.sourceType,
        sourceId: target.sourceId,
        attempt: attempt + 1,
        nextIfMatch: ifMatch
      })
    }
  }

  if (existingBinding) {
    db.update(calendarBindings)
      .set({ remoteVersion: 'conflict', modifiedAt: getNow() })
      .where(eq(calendarBindings.id, existingBinding.id))
      .run()
    enqueueLocalSyncUpdate('calendar_binding', existingBinding.id)
  }

  log.error(`${label} upsert exhausted conflict retries`, {
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    attempts: MAX_PUSH_CONFLICT_RETRIES
  })
  throw new Error(
    `${label} calendar push gave up after ${MAX_PUSH_CONFLICT_RETRIES} 412 conflicts for ${target.sourceType}:${target.sourceId}`
  )
}

function mergeRemoteEventIntoLocal(
  db: DataDb,
  eventId: string,
  remote: GoogleCalendarRemoteEvent,
  base: Record<string, unknown> | null = null
): void {
  const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).get()
  if (!existing) return

  const remoteData = mapGoogleEventToCalendarEventChanges(remote)
  const localFC: FieldClocks =
    existing.fieldClocks ?? initAllFieldClocks(existing.clock ?? {}, CALENDAR_EVENT_SYNCABLE_FIELDS)
  const remoteFC: FieldClocks = {}
  for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
    remoteFC[field] = { ...(localFC[field] ?? {}) }
  }

  const remoteForMerge: Record<string, unknown> = {}
  for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
    const remoteVal = (remoteData as unknown as Record<string, unknown>)[field]
    const remoteUnchanged =
      base !== null &&
      field in base &&
      JSON.stringify(base[field] ?? null) === JSON.stringify(remoteVal ?? null)
    remoteForMerge[field] =
      remoteVal === undefined || remoteUnchanged
        ? (existing as Record<string, unknown>)[field]
        : remoteVal
  }

  const result = mergeCalendarEventFields(
    existing as Record<string, unknown>,
    remoteForMerge,
    localFC,
    remoteFC
  )

  db.update(calendarEvents)
    .set({
      ...result.merged,
      fieldClocks: result.mergedFieldClocks,
      modifiedAt: getNow()
    })
    .where(eq(calendarEvents.id, eventId))
    .run()

  enqueueLocalSyncUpdate('calendar_event', eventId, [])
  emitCalendarChanged({ entityType: 'calendar_event', id: eventId })
}
