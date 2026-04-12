import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createLogger } from '../../lib/logger'
import { requireDatabase, type DataDb } from '../../database'
import { enqueueLocalSyncCreate, enqueueLocalSyncUpdate } from '../../sync/local-mutations'
import { syncInboxUpdate } from '../../inbox/runtime-effects'
import { syncTaskUpdate } from '../../tasks/runtime-effects'
import { hasGoogleCalendarLocalAuth } from './oauth'
import { createGoogleCalendarClient } from './client'
import {
  mapCalendarEventToGoogleInput,
  mapGoogleEventToCalendarEventChanges,
  mapGoogleEventToExternalEventRecord,
  mapGoogleEventToReminderAt,
  mapGoogleEventToTaskSchedule,
  mapInboxSnoozeToGoogleInput,
  mapReminderToGoogleInput,
  mapTaskToGoogleInput
} from './mappers'
import {
  getCalendarExternalEventById,
  upsertCalendarExternalEvent
} from '../repositories/calendar-external-events-repository'
import {
  getCalendarSourceById,
  listCalendarBindingsForSource,
  listCalendarSources,
  upsertCalendarBinding,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import type {
  CalendarSyncTarget,
  GoogleCalendarClient,
  GoogleCalendarRemoteEvent,
  GoogleCalendarUpsertEventInput
} from '../types'

const log = createLogger('Calendar:GoogleSync')
const RUN_INTERVAL_MS = 5 * 60 * 1000
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

let syncInterval: NodeJS.Timeout | null = null

function getNow(): string {
  return new Date().toISOString()
}

function markSyncedTableMutation(
  entityType: 'calendar_binding' | 'calendar_source' | 'calendar_external_event',
  id: string,
  existed: boolean
): void {
  if (existed) {
    enqueueLocalSyncUpdate(entityType, id)
  } else {
    enqueueLocalSyncCreate(entityType, id)
  }
}

function trySyncTaskUpdate(taskId: string, changedFields: string[]): void {
  try {
    syncTaskUpdate(taskId, changedFields)
  } catch (error) {
    if (error instanceof Error && error.message === 'Database not initialized') {
      return
    }
    throw error
  }
}

function trySyncInboxUpdate(itemId: string): void {
  try {
    syncInboxUpdate(itemId)
  } catch (error) {
    if (error instanceof Error && error.message === 'Database not initialized') {
      return
    }
    throw error
  }
}

function getExistingGoogleBinding(
  db: DataDb,
  target: CalendarSyncTarget
): typeof calendarBindings.$inferSelect | undefined {
  return listCalendarBindingsForSource(db, target.sourceType, target.sourceId).find(
    (binding) => binding.provider === 'google' && !binding.archivedAt
  )
}

async function ensureMemryCalendarSource(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars' | 'createCalendar'>
): Promise<typeof calendarSources.$inferSelect> {
  const existing = listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar'
  }).find((source) => source.isMemryManaged)

  if (existing) return existing

  const discovered = await client.listCalendars()
  const remote = discovered.find((calendar) => calendar.title === 'Memry')
    ?? (await client.createCalendar({ title: 'Memry', timezone: LOCAL_TIMEZONE }))

  const localId = `google-calendar:${remote.id}`
  const now = getNow()
  const account = listCalendarSources(db, { provider: 'google', kind: 'account' })[0]
  const existed = Boolean(getCalendarSourceById(db, localId))

  const saved = upsertCalendarSource(db, {
    id: localId,
    provider: 'google',
    kind: 'calendar',
    accountId: account?.id ?? null,
    remoteId: remote.id,
    title: remote.title,
    timezone: remote.timezone ?? LOCAL_TIMEZONE,
    color: remote.color,
    isPrimary: remote.isPrimary,
    isSelected: true,
    isMemryManaged: true,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: now,
    metadata: null,
    clock: existed ? getCalendarSourceById(db, localId)?.clock : undefined,
    createdAt: getCalendarSourceById(db, localId)?.createdAt ?? now,
    modifiedAt: now
  })

  markSyncedTableMutation('calendar_source', saved.id, existed)
  return saved
}

function getMemryManagedGoogleSource(db: DataDb): typeof calendarSources.$inferSelect | undefined {
  return listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar'
  }).find((source) => source.isMemryManaged && !source.archivedAt)
}

function getGoogleClient(deps?: { client?: GoogleCalendarClient }): GoogleCalendarClient {
  return deps?.client ?? createGoogleCalendarClient()
}

function loadSourceAsGoogleEvent(
  db: DataDb,
  target: CalendarSyncTarget
): GoogleCalendarUpsertEventInput {
  switch (target.sourceType) {
    case 'event': {
      const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, target.sourceId)).get()
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

function updateBindingRemoteVersion(
  db: DataDb,
  target: CalendarSyncTarget,
  remote: GoogleCalendarRemoteEvent
): void {
  const existing = getExistingGoogleBinding(db, target)
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

export async function pushSourceToGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: { client?: Pick<GoogleCalendarClient, 'upsertEvent' | 'listCalendars' | 'createCalendar'> } = {}
): Promise<typeof calendarBindings.$inferSelect> {
  const client = getGoogleClient(deps as { client?: GoogleCalendarClient })
  const localEvent = loadSourceAsGoogleEvent(db, target)
  const existingBinding = getExistingGoogleBinding(db, target)
  const memrySource = getMemryManagedGoogleSource(db)
    ?? (await ensureMemryCalendarSource(db, client))
  const now = getNow()
  const bindingId = existingBinding?.id ?? `calendar_binding:google:${target.sourceType}:${target.sourceId}`

  const remote = await client.upsertEvent({
    calendarId: existingBinding?.remoteCalendarId ?? memrySource.remoteId,
    eventId: existingBinding?.remoteEventId ?? null,
    event: localEvent
  })

  const binding = upsertCalendarBinding(db, {
    id: bindingId,
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    provider: 'google',
    remoteCalendarId: remote.calendarId,
    remoteEventId: remote.id,
    ownershipMode: 'memry_managed',
    writebackMode: 'broad',
    remoteVersion: remote.etag,
    lastLocalSnapshot: { ...localEvent },
    archivedAt: null,
    clock: existingBinding?.clock,
    syncedAt: now,
    createdAt: existingBinding?.createdAt ?? now,
    modifiedAt: now
  })

  markSyncedTableMutation('calendar_binding', binding.id, Boolean(existingBinding))
  return binding
}

export async function applyGoogleCalendarWriteback(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>,
  remote: GoogleCalendarRemoteEvent
): Promise<void> {
  const now = getNow()

  switch (binding.sourceType) {
    case 'event': {
      db.update(calendarEvents)
        .set({
          ...mapGoogleEventToCalendarEventChanges(remote),
          modifiedAt: now
        })
        .where(eq(calendarEvents.id, binding.sourceId))
        .run()

      enqueueLocalSyncUpdate('calendar_event', binding.sourceId)
      break
    }

    case 'task': {
      const schedule = mapGoogleEventToTaskSchedule(remote)
      const updates: Partial<typeof tasks.$inferInsert> = {
        dueDate: schedule.dueDate,
        dueTime: schedule.dueTime,
        modifiedAt: now
      }

      const changedFields = ['dueDate', 'dueTime']

      if (binding.writebackMode === 'broad' || binding.writebackMode === 'time_and_text') {
        updates.title = remote.title
        updates.description = remote.description
        changedFields.push('title', 'description')
      }

      db.update(tasks).set(updates).where(eq(tasks.id, binding.sourceId)).run()
      trySyncTaskUpdate(binding.sourceId, changedFields)
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

      // Reminder records are not yet in the record-sync pipeline; keep the local row correct.
      db.update(reminders).set(updates).where(eq(reminders.id, binding.sourceId)).run()
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
      trySyncInboxUpdate(binding.sourceId)
      break
    }
  }

  updateBindingRemoteVersion(db, binding, remote)
}

export async function applyGoogleCalendarDelete(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>
): Promise<void> {
  const now = getNow()

  switch (binding.sourceType) {
    case 'event': {
      db.delete(calendarEvents).where(eq(calendarEvents.id, binding.sourceId)).run()
      enqueueLocalSyncUpdate('calendar_event', binding.sourceId)
      break
    }

    case 'task': {
      db.update(tasks)
        .set({
          dueDate: null,
          dueTime: null,
          modifiedAt: now
        })
        .where(eq(tasks.id, binding.sourceId))
        .run()
      trySyncTaskUpdate(binding.sourceId, ['dueDate', 'dueTime'])
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
      trySyncInboxUpdate(binding.sourceId)
      break
    }
  }

  const existingBinding = getExistingGoogleBinding(db, binding)
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

export async function syncGoogleCalendarSource(
  db: DataDb,
  sourceId: string,
  deps: { client?: Pick<GoogleCalendarClient, 'listEvents'> } = {}
): Promise<void> {
  const source = getCalendarSourceById(db, sourceId)
  if (!source) {
    throw new Error(`Calendar source not found: ${sourceId}`)
  }

  const client = getGoogleClient(deps as { client?: GoogleCalendarClient })
  const now = getNow()
  const result = await client.listEvents({
    calendarId: source.remoteId,
    syncCursor: source.syncCursor ?? null
  })

  for (const remoteEvent of result.events) {
    const record = mapGoogleEventToExternalEventRecord(source.id, remoteEvent, now)
    const existed = Boolean(getCalendarExternalEventById(db, record.id))
    upsertCalendarExternalEvent(db, {
      ...record,
      clock: existed ? getCalendarExternalEventById(db, record.id)?.clock : undefined
    })
    markSyncedTableMutation('calendar_external_event', record.id, existed)
  }

  const updatedSource = upsertCalendarSource(db, {
    ...source,
    syncCursor: result.nextSyncCursor,
    syncStatus: 'ok',
    lastSyncedAt: now,
    modifiedAt: now
  })
  markSyncedTableMutation('calendar_source', updatedSource.id, true)
}

export async function syncGoogleCalendarNow(
  db: DataDb = requireDatabase(),
  deps: { client?: GoogleCalendarClient } = {}
): Promise<void> {
  if (!(await hasGoogleCalendarLocalAuth())) {
    return
  }

  const client = getGoogleClient(deps)
  await ensureMemryCalendarSource(db, client)

  const sources = listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar',
    selectedOnly: true
  }).filter((source) => !source.isMemryManaged)

  for (const source of sources) {
    await syncGoogleCalendarSource(db, source.id, { client })
  }
}

export function startGoogleCalendarSyncRunner(): void {
  if (syncInterval) return

  void syncGoogleCalendarNow().catch((error) => {
    log.warn('initial Google Calendar sync failed', error)
  })

  syncInterval = setInterval(() => {
    void syncGoogleCalendarNow().catch((error) => {
      log.warn('periodic Google Calendar sync failed', error)
    })
  }, RUN_INTERVAL_MS)
}

export function stopGoogleCalendarSyncRunner(): void {
  if (!syncInterval) return
  clearInterval(syncInterval)
  syncInterval = null
}
