import { eq } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import type {
  PromoteExternalEventInput,
  PromoteExternalEventResponse
} from '@memry/contracts/calendar-api'
import { createLogger } from '../lib/logger'
import { generateId } from '../lib/id'
import { enqueueLocalSyncCreate, enqueueLocalSyncUpdate } from '../sync/local-mutations'
import type { DataDb } from '../database'
import { upsertCalendarEvent } from './repositories/calendar-events-repository'
import {
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById,
  upsertCalendarBinding
} from './repositories/calendar-sources-repository'
import { getCalendarExternalEventById } from './repositories/calendar-external-events-repository'
import { emitCalendarChanged, emitCalendarProjectionChanged } from './change-events'

const log = createLogger('Calendar:PromoteExternal')

export class ExternalEventNotFoundError extends Error {
  constructor(externalEventId: string) {
    super(`External calendar event not found: ${externalEventId}`)
    this.name = 'ExternalEventNotFoundError'
  }
}

export class ExternalEventSourceMissingError extends Error {
  constructor(externalEventId: string, sourceId: string) {
    super(
      `External calendar event ${externalEventId} references missing calendar source ${sourceId}`
    )
    this.name = 'ExternalEventSourceMissingError'
  }
}

export function promoteExternalEvent(
  db: DataDb,
  input: PromoteExternalEventInput
): PromoteExternalEventResponse {
  const mirror = getCalendarExternalEventById(db, input.externalEventId)
  if (!mirror) {
    throw new ExternalEventNotFoundError(input.externalEventId)
  }

  const sourceRow = getCalendarSourceById(db, mirror.sourceId)
  if (!sourceRow) {
    throw new ExternalEventSourceMissingError(input.externalEventId, mirror.sourceId)
  }

  const remoteCalendarId = sourceRow.remoteId
  const now = new Date().toISOString()

  // Idempotency: repeat calls should return the existing promoted event
  // without creating duplicate rows or re-emitting create events.
  const existingBinding = findCalendarBindingByRemoteEvent(
    db,
    'google',
    remoteCalendarId,
    mirror.remoteEventId
  )
  if (existingBinding) {
    if (!mirror.archivedAt) {
      db.update(calendarExternalEvents)
        .set({ archivedAt: now, modifiedAt: now })
        .where(eq(calendarExternalEvents.id, mirror.id))
        .run()
      enqueueLocalSyncUpdate('calendar_external_event', mirror.id)
      emitCalendarProjectionChanged(`external_event:${mirror.id}`)
    }
    return { success: true, eventId: existingBinding.sourceId }
  }

  const eventId = generateId()
  const bindingId = generateId()

  upsertCalendarEvent(db, {
    id: eventId,
    title: mirror.title,
    description: mirror.description ?? null,
    location: mirror.location ?? null,
    startAt: mirror.startAt,
    endAt: mirror.endAt ?? null,
    timezone: mirror.timezone ?? 'UTC',
    isAllDay: mirror.isAllDay,
    recurrenceRule: mirror.recurrenceRule ?? null,
    recurrenceExceptions: null,
    targetCalendarId: remoteCalendarId,
    clock: { ...(mirror.clock ?? {}) },
    createdAt: now,
    modifiedAt: now
  })

  upsertCalendarBinding(db, {
    id: bindingId,
    sourceType: 'event',
    sourceId: eventId,
    provider: 'google',
    remoteCalendarId,
    remoteEventId: mirror.remoteEventId,
    ownershipMode: 'provider_managed',
    writebackMode: 'time_and_text',
    remoteVersion: mirror.remoteEtag,
    lastLocalSnapshot: null,
    clock: { ...(mirror.clock ?? {}) },
    createdAt: now,
    modifiedAt: now
  })

  db.update(calendarExternalEvents)
    .set({ archivedAt: now, modifiedAt: now })
    .where(eq(calendarExternalEvents.id, mirror.id))
    .run()

  enqueueLocalSyncCreate('calendar_event', eventId)
  enqueueLocalSyncCreate('calendar_binding', bindingId)
  enqueueLocalSyncUpdate('calendar_external_event', mirror.id)
  emitCalendarChanged({ entityType: 'calendar_event', id: eventId })
  emitCalendarProjectionChanged(`event:${eventId}`)

  log.info('Promoted external Google event to Memry event', {
    externalEventId: input.externalEventId,
    eventId,
    remoteCalendarId,
    remoteEventId: mirror.remoteEventId
  })

  return { success: true, eventId }
}
