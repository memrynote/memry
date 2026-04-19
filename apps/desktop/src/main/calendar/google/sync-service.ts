import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createLogger } from '../../lib/logger'
import { requireDatabase, type DataDb } from '../../database'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../../sync/local-mutations'
import { initAllFieldClocks } from '../../sync/field-merge'
import { CALENDAR_EVENT_SYNCABLE_FIELDS, mergeCalendarEventFields } from '../field-merge-calendar'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'
import { publishProjectionEvent } from '../../projections'
import { hasGoogleCalendarConnection } from './oauth'
import { isMemryUserSignedIn } from '../../sync/auth-state'
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
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById,
  listCalendarBindingsForSource,
  listCalendarSources,
  upsertCalendarBinding,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import { readCalendarGoogleSettings } from './calendar-google-settings'
import type {
  CalendarSyncTarget,
  GoogleCalendarClient,
  GoogleCalendarRemoteEvent,
  GoogleCalendarUpsertEventInput
} from '../types'

const log = createLogger('Calendar:GoogleSync')
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

let syncInFlight = false

function getNow(): string {
  return new Date().toISOString()
}

function isGoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 410
  )
}

function isPreconditionFailedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 412
  )
}

const MAX_PUSH_CONFLICT_RETRIES = 3

async function pushEventWithConflictRetry(
  db: DataDb,
  target: CalendarSyncTarget,
  client: Pick<GoogleCalendarClient, 'upsertEvent' | 'getEvent'>,
  resolvedCalendarId: string,
  existingBinding: typeof calendarBindings.$inferSelect | undefined
): Promise<GoogleCalendarRemoteEvent> {
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
        mergeRemoteEventIntoLocal(db, target.sourceId, remote)
      }

      ifMatch = remote.etag ?? null
      log.warn('Google upsert returned 412; merged remote and retrying', {
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

  log.error('Google upsert exhausted conflict retries', {
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    attempts: MAX_PUSH_CONFLICT_RETRIES
  })
  throw new Error(
    `Google calendar push gave up after ${MAX_PUSH_CONFLICT_RETRIES} 412 conflicts for ${target.sourceType}:${target.sourceId}`
  )
}

function mergeRemoteEventIntoLocal(
  db: DataDb,
  eventId: string,
  remote: GoogleCalendarRemoteEvent
): void {
  const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).get()
  if (!existing) return

  const remoteData = mapGoogleEventToCalendarEventChanges(remote)
  const localFC: FieldClocks =
    (existing.fieldClocks as FieldClocks | null) ??
    initAllFieldClocks((existing.clock as VectorClock | null) ?? {}, CALENDAR_EVENT_SYNCABLE_FIELDS)
  // We can't tell from Google's REST surface which fields the remote changed.
  // Clone the local per-field clocks so every field merges as a "concurrent"
  // edit at equal tick-sum — the merge function's tiebreak keeps the remote
  // value when it actually differs and leaves matching fields untouched.
  // Cloning (vs. fabricating a synthetic device) avoids polluting the doc-level
  // clock with a fake `google-remote` actor and keeps subsequent retries
  // monotonic: the next 412 reads the *updated* local FC as its base.
  const remoteFC: FieldClocks = {}
  for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
    remoteFC[field] = { ...(localFC[field] ?? {}) }
  }

  const remoteForMerge: Record<string, unknown> = {}
  for (const field of CALENDAR_EVENT_SYNCABLE_FIELDS) {
    const remoteVal = (remoteData as Record<string, unknown>)[field]
    remoteForMerge[field] =
      remoteVal === undefined ? (existing as Record<string, unknown>)[field] : remoteVal
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

  // Field clocks were already merged in this transaction; tell the producer
  // not to re-increment them by passing an empty changed-fields list.
  enqueueLocalSyncUpdate('calendar_event', eventId, [])
  emitCalendarChanged({ entityType: 'calendar_event', id: eventId })
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

function tryEnqueueProjectionSyncUpdate(entityType: 'task' | 'inbox', id: string): void {
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
  const remote =
    discovered.find((calendar) => calendar.title === 'Memry') ??
    (await client.createCalendar({ title: 'Memry', timezone: LOCAL_TIMEZONE }))

  const localId = `google-calendar:${remote.id}`
  const now = getNow()
  const account = listCalendarSources(db, { provider: 'google', kind: 'account' })[0]
  const existingSource = getCalendarSourceById(db, localId)
  const existed = Boolean(existingSource)

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
    clock: existingSource?.clock,
    createdAt: existingSource?.createdAt ?? now,
    modifiedAt: now
  })

  markSyncedTableMutation('calendar_source', saved.id, existed)
  emitCalendarChanged({ entityType: 'calendar_source', id: saved.id })
  return saved
}

function getMemryManagedGoogleSource(db: DataDb): typeof calendarSources.$inferSelect | undefined {
  return listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar'
  }).find((source) => source.isMemryManaged && !source.archivedAt)
}

/**
 * Ensure a Google calendar is registered in `calendar_sources` and flagged for
 * inbound sync (isSelected=true). Called from the push resolver whenever we
 * route an event to a calendar that the user picked directly or set as their
 * default — without this, `syncGoogleCalendarNow` never polls that calendar
 * and two-way sync silently breaks for everything outside the Memry-managed
 * calendar (Codex M2 review finding 2).
 */
export async function ensureGoogleCalendarSourceSelected(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>,
  remoteCalendarId: string
): Promise<typeof calendarSources.$inferSelect | null> {
  const existing = listCalendarSources(db, { provider: 'google', kind: 'calendar' }).find(
    (source) => source.remoteId === remoteCalendarId && !source.archivedAt
  )

  const now = getNow()

  if (existing) {
    if (existing.isSelected) return existing
    const updated = upsertCalendarSource(db, {
      ...existing,
      isSelected: true,
      modifiedAt: now
    })
    markSyncedTableMutation('calendar_source', updated.id, true)
    emitCalendarChanged({ entityType: 'calendar_source', id: updated.id })
    return updated
  }

  const discovered = await client.listCalendars()
  const remote = discovered.find((cal) => cal.id === remoteCalendarId)
  if (!remote) {
    log.warn('Target Google calendar not found while registering source', { remoteCalendarId })
    return null
  }

  const account = listCalendarSources(db, { provider: 'google', kind: 'account' })[0]
  const localId = `google-calendar:${remote.id}`
  const existingById = getCalendarSourceById(db, localId)
  const existed = Boolean(existingById)

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
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'pending',
    lastSyncedAt: null,
    metadata: null,
    clock: existingById?.clock,
    createdAt: existingById?.createdAt ?? now,
    modifiedAt: now
  })

  markSyncedTableMutation('calendar_source', saved.id, existed)
  emitCalendarChanged({ entityType: 'calendar_source', id: saved.id })
  return saved
}

function getGoogleClient(deps?: { client?: GoogleCalendarClient }): GoogleCalendarClient {
  return deps?.client ?? createGoogleCalendarClient()
}

function shouldSourceSyncToGoogleCalendar(db: DataDb, target: CalendarSyncTarget): boolean {
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

function loadSourceAsGoogleEvent(
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

function getEventTargetCalendarId(db: DataDb, target: CalendarSyncTarget): string | null {
  if (target.sourceType !== 'event') return null
  const row = db
    .select({ targetCalendarId: calendarEvents.targetCalendarId })
    .from(calendarEvents)
    .where(eq(calendarEvents.id, target.sourceId))
    .get()
  return row?.targetCalendarId ?? null
}

async function resolveTargetCalendarId(
  db: DataDb,
  target: CalendarSyncTarget,
  existingBinding: typeof calendarBindings.$inferSelect | undefined,
  client: Pick<GoogleCalendarClient, 'listCalendars' | 'createCalendar'>
): Promise<string> {
  // Existing binding wins — retargeting a bound event would require
  // events.move on Google's side and coordinated etag handling (M3+ work).
  if (existingBinding?.remoteCalendarId) return existingBinding.remoteCalendarId

  // Per-event override from the renderer calendar picker. Register the
  // calendar as a selected source so the inbound poll covers it; without
  // this, two-way sync silently breaks for anything outside the Memry
  // calendar (Codex M2 review finding 2).
  const eventTarget = getEventTargetCalendarId(db, target)
  if (eventTarget) {
    await ensureGoogleCalendarSourceSelected(db, client, eventTarget)
    return eventTarget
  }

  // User's onboarding-selected default (covers tasks / reminders / snoozes too).
  const { defaultTargetCalendarId } = readCalendarGoogleSettings(db)
  if (defaultTargetCalendarId) {
    await ensureGoogleCalendarSourceSelected(db, client, defaultTargetCalendarId)
    return defaultTargetCalendarId
  }

  // Final fallback: the auto-created Memry calendar.
  const memrySource =
    getMemryManagedGoogleSource(db) ?? (await ensureMemryCalendarSource(db, client))
  return memrySource.remoteId
}

export async function pushSourceToGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: {
    client?: Pick<
      GoogleCalendarClient,
      'upsertEvent' | 'listCalendars' | 'createCalendar' | 'getEvent'
    >
  } = {}
): Promise<typeof calendarBindings.$inferSelect> {
  const client = getGoogleClient(deps as { client?: GoogleCalendarClient })
  const existingBinding = getExistingGoogleBinding(db, target)
  const resolvedCalendarId = await resolveTargetCalendarId(db, target, existingBinding, client)
  const now = getNow()
  const bindingId =
    existingBinding?.id ?? `calendar_binding:google:${target.sourceType}:${target.sourceId}`

  const remote = await pushEventWithConflictRetry(
    db,
    target,
    client,
    resolvedCalendarId,
    existingBinding
  )

  // After possible merge, re-load the latest local snapshot for the binding record.
  const finalLocalEvent = loadSourceAsGoogleEvent(db, target)

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
    lastLocalSnapshot: { ...finalLocalEvent },
    archivedAt: null,
    clock: existingBinding?.clock,
    syncedAt: now,
    createdAt: existingBinding?.createdAt ?? now,
    modifiedAt: now
  })

  markSyncedTableMutation('calendar_binding', binding.id, Boolean(existingBinding))
  return binding
}

export async function deleteSourceFromGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: { client?: Pick<GoogleCalendarClient, 'deleteEvent'> } = {}
): Promise<boolean> {
  const existingBinding = getExistingGoogleBinding(db, target)
  if (!existingBinding?.remoteCalendarId || !existingBinding.remoteEventId) {
    return false
  }

  const client = getGoogleClient(deps as { client?: GoogleCalendarClient })
  await client.deleteEvent({
    calendarId: existingBinding.remoteCalendarId,
    eventId: existingBinding.remoteEventId
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

export async function syncLocalSourceToGoogleCalendar(
  db: DataDb,
  target: CalendarSyncTarget,
  deps: {
    client?: Pick<
      GoogleCalendarClient,
      'upsertEvent' | 'deleteEvent' | 'listCalendars' | 'createCalendar' | 'getEvent'
    >
  } = {}
): Promise<typeof calendarBindings.$inferSelect | null> {
  if (!(await isMemryUserSignedIn())) return null
  if (!(await hasGoogleCalendarConnection(db))) return null

  if (shouldSourceSyncToGoogleCalendar(db, target)) {
    return await pushSourceToGoogleCalendar(db, target, deps)
  }

  await deleteSourceFromGoogleCalendar(db, target, deps)
  return null
}

export async function applyGoogleCalendarWriteback(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>,
  remote: GoogleCalendarRemoteEvent
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

      // Treat Google → local writeback as edits to whichever fields the remote provided.
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

      db.update(tasks).set(updates).where(eq(tasks.id, binding.sourceId)).run()
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

  updateBindingRemoteVersion(db, binding, remote)
}

export async function applyGoogleCalendarDelete(
  db: DataDb,
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
      db.update(tasks)
        .set({
          dueDate: null,
          dueTime: null,
          modifiedAt: now
        })
        .where(eq(tasks.id, binding.sourceId))
        .run()
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
  const isInitialSync = !source.syncCursor

  // Defensive: current client returns { events: [], nextSyncCursor: null } on 410 (handled
  // below via the cursor-invalidation branch); future client variants may throw — keep as insurance.
  let result: Awaited<ReturnType<GoogleCalendarClient['listEvents']>>
  try {
    result = await client.listEvents({
      calendarId: source.remoteId,
      syncCursor: source.syncCursor ?? null,
      timeMin: isInitialSync ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() : null,
      timeMax: isInitialSync ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null
    })
  } catch (error) {
    if (isGoneError(error) && source.syncCursor) {
      log.warn('Google returned 410 for source; clearing cursor and re-syncing', { sourceId })
      const freshSource = upsertCalendarSource(db, {
        ...source,
        syncCursor: null,
        syncStatus: 'pending',
        modifiedAt: now
      })
      markSyncedTableMutation('calendar_source', freshSource.id, true)
      return await syncGoogleCalendarSource(db, sourceId, deps)
    }
    throw error
  }

  if (!result.nextSyncCursor && source.syncCursor) {
    log.warn('sync cursor invalidated for source, re-syncing from scratch', { sourceId })
    const freshSource = upsertCalendarSource(db, {
      ...source,
      syncCursor: null,
      syncStatus: 'pending',
      modifiedAt: now
    })
    markSyncedTableMutation('calendar_source', freshSource.id, true)
    return await syncGoogleCalendarSource(db, sourceId, deps)
  }

  for (const remoteEvent of result.events) {
    const binding = findCalendarBindingByRemoteEvent(
      db,
      'google',
      remoteEvent.calendarId,
      remoteEvent.id
    )

    if (binding) {
      if (remoteEvent.status === 'cancelled') {
        await applyGoogleCalendarDelete(db, binding)
      } else {
        await applyGoogleCalendarWriteback(db, binding, remoteEvent)
      }
      continue
    }

    const record = mapGoogleEventToExternalEventRecord(source.id, remoteEvent, now)
    const existing = getCalendarExternalEventById(db, record.id)

    if (remoteEvent.status === 'cancelled') {
      if (!existing) continue
      upsertCalendarExternalEvent(db, {
        ...record,
        clock: existing.clock,
        archivedAt: now
      })
      markSyncedTableMutation('calendar_external_event', record.id, true)
      emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
      continue
    }

    upsertCalendarExternalEvent(db, {
      ...record,
      clock: existing?.clock
    })
    markSyncedTableMutation('calendar_external_event', record.id, Boolean(existing))
    emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
  }

  const updatedSource = upsertCalendarSource(db, {
    ...source,
    syncCursor: result.nextSyncCursor,
    syncStatus: 'ok',
    lastSyncedAt: now,
    modifiedAt: now
  })
  markSyncedTableMutation('calendar_source', updatedSource.id, true)
  emitCalendarChanged({ entityType: 'calendar_source', id: updatedSource.id })
}

export async function syncGoogleCalendarNow(
  db: DataDb = requireDatabase(),
  deps: { client?: GoogleCalendarClient } = {}
): Promise<void> {
  if (syncInFlight) return
  if (!(await isMemryUserSignedIn())) return
  if (!(await hasGoogleCalendarConnection(db))) return

  syncInFlight = true
  try {
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
  } finally {
    syncInFlight = false
  }
}

// Runner lifecycle + push-channel poll cadence live in google-sync-runner.ts.
// Re-exported here so existing callers (index.ts, calendar-handlers,
// session-teardown, device-registration, tests) keep their import paths.
export {
  PUSH_BACKOFF_INTERVAL_MS,
  getCurrentPollIntervalMs,
  reEvaluatePollCadence,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner
} from './google-sync-runner'
