import { eq } from 'drizzle-orm'
import type { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import type { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { TaskActivityActors } from '@memry/db-schema/schema/task-activity'
import { createLogger } from '../../lib/logger'
import { requireDatabase, type DataDb } from '../../database'
import { enqueueLocalSyncCreate, enqueueLocalSyncUpdate } from '../../sync/local-mutations'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import {
  hasGoogleCalendarConnection,
  listGoogleAccountIds,
  resolveDefaultGoogleAccountId
} from './oauth'
import { resolveTargetGoogleAccountId } from './account-routing'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import { nextLocalClock } from '@memry/sync-client/tombstone-clocks'
import { createGoogleCalendarClient } from './client'
import { mapGoogleEventToExternalEventRecord } from './mappers'
import {
  getCalendarExternalEventById,
  upsertCalendarExternalEvent
} from '../repositories/calendar-external-events-repository'
import {
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById,
  listCalendarSources,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { emitCalendarChanged } from '../change-events'
import { readCalendarGoogleSettings } from './calendar-google-settings'
import {
  findLiveBinding,
  readDefaultWriteTarget,
  resolveWriteRoute
} from '../provider/write-routing'
import { ProviderGoneError, classifyProviderError } from '../provider/errors'
import {
  applyProviderDelete,
  applyProviderWriteback,
  deleteSourceFromProvider,
  findProviderBinding,
  isSyncInFlight,
  pushSourceToProvider,
  runExclusive,
  shouldSourceBeOnCalendar
} from '../sync/write-engine'
import type { CalendarSyncTarget, GoogleCalendarClient, GoogleCalendarRemoteEvent } from '../types'

const log = createLogger('Calendar:GoogleSync')
const GOOGLE_SYNC_KEY = 'google'
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function getNow(): string {
  return new Date().toISOString()
}

function isGoneError(error: unknown): boolean {
  return classifyProviderError('google', error) instanceof ProviderGoneError
}

// pushEventWithConflictRetry, mergeRemoteEventIntoLocal, and
// loadSourceAsGoogleEvent extracted to push-conflict-retry.ts for max-lines.

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

function getExistingGoogleBinding(
  db: DataDb,
  target: CalendarSyncTarget
): typeof calendarBindings.$inferSelect | undefined {
  return findProviderBinding(db, 'google', target)
}

async function ensureMemryCalendarSource(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars' | 'createCalendar'>,
  accountId: string
): Promise<typeof calendarSources.$inferSelect> {
  const existing = listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar'
  }).find((source) => source.isMemryManaged && source.accountId === accountId)

  if (existing) return existing

  const discovered = await client.listCalendars()
  const remote =
    discovered.find((calendar) => calendar.title === 'memrynote') ??
    (await client.createCalendar({ title: 'memrynote', timezone: LOCAL_TIMEZONE }))

  const localId = `google-calendar:${remote.id}`
  const now = getNow()
  const existingSource = getCalendarSourceById(db, localId)
  const existed = Boolean(existingSource)

  const saved = upsertCalendarSource(db, {
    id: localId,
    provider: 'google',
    kind: 'calendar',
    accountId,
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

/**
 * Bring every calendar on `accountId` into `calendar_sources`, so the settings
 * picker has something to offer beyond the primary.
 *
 * Selection stays the user's: a row we have never seen is pre-selected only if
 * it is the account's primary, and a row that already exists keeps whatever the
 * user chose along with its cursor and sync state. Re-running this is therefore
 * safe — it refreshes titles and colours, it does not re-enable a calendar the
 * user turned off.
 */
export async function discoverGoogleCalendarSources(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>,
  accountId: string
): Promise<void> {
  const discovered = await client.listCalendars()
  const now = getNow()

  for (const remote of discovered) {
    const localId = `google-calendar:${remote.id}`
    const existing = getCalendarSourceById(db, localId)

    const saved = upsertCalendarSource(db, {
      ...existing,
      id: localId,
      provider: 'google',
      kind: 'calendar',
      accountId,
      remoteId: remote.id,
      title: remote.title,
      timezone: remote.timezone ?? LOCAL_TIMEZONE,
      color: remote.color,
      isPrimary: remote.isPrimary,
      isSelected: existing ? existing.isSelected : remote.isPrimary,
      isMemryManaged: existing?.isMemryManaged ?? false,
      // Google still lists it, so it is not gone. A stale archivedAt here is
      // the tombstone a previous disconnect left behind, and leaving it set
      // would hide the calendar from the picker on reconnect.
      archivedAt: null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now
    })

    markSyncedTableMutation('calendar_source', saved.id, Boolean(existing))
    emitCalendarChanged({ entityType: 'calendar_source', id: saved.id })
  }
}

function getMemryManagedGoogleSource(
  db: DataDb,
  accountId?: string
): typeof calendarSources.$inferSelect | undefined {
  return listCalendarSources(db, {
    provider: 'google',
    kind: 'calendar'
  }).find(
    (source) =>
      source.isMemryManaged &&
      !source.archivedAt &&
      (accountId ? source.accountId === accountId : true)
  )
}

/**
 * Ensure a Google calendar is registered in `calendar_sources` and flagged for
 * inbound sync (isSelected=true). Called from the push resolver whenever we
 * route an event to a calendar that the user picked directly or set as their
 * default — without this, `syncGoogleCalendarNow` never polls that calendar
 * and two-way sync silently breaks for everything outside the memrynote-managed
 * calendar (Codex M2 review finding 2).
 */
export async function ensureGoogleCalendarSourceSelected(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>,
  remoteCalendarId: string,
  accountId: string
): Promise<typeof calendarSources.$inferSelect | null> {
  const existing = listCalendarSources(db, { provider: 'google', kind: 'calendar' }).find(
    (source) => source.remoteId === remoteCalendarId && !source.archivedAt
  )

  const now = getNow()

  if (existing) {
    if (existing.isSelected && existing.accountId === accountId) return existing
    const updated = upsertCalendarSource(db, {
      ...existing,
      accountId,
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

  const localId = `google-calendar:${remote.id}`
  const existingById = getCalendarSourceById(db, localId)
  const existed = Boolean(existingById)

  const saved = upsertCalendarSource(db, {
    id: localId,
    provider: 'google',
    kind: 'calendar',
    accountId,
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

function getGoogleClient(
  db: DataDb,
  deps?: { client?: GoogleCalendarClient },
  accountIdOverride?: string | null
): GoogleCalendarClient {
  if (deps?.client) return deps.client
  const accountId = accountIdOverride ?? resolveDefaultGoogleAccountId(db)
  if (!accountId) {
    throw new Error('Cannot create Google Calendar client without a connected account')
  }
  return createGoogleCalendarClient({ accountId })
}

// loadSourceAsGoogleEvent moved to push-conflict-retry.ts

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
  client: Pick<GoogleCalendarClient, 'listCalendars' | 'createCalendar'>,
  accountId: string
): Promise<string> {
  // Existing binding wins — retargeting a bound event would require
  // events.move on Google's side and coordinated etag handling (M3+ work).
  if (existingBinding?.remoteCalendarId) return existingBinding.remoteCalendarId

  // Per-event override from the renderer calendar picker. Register the
  // calendar as a selected source so the inbound poll covers it; without
  // this, two-way sync silently breaks for anything outside the memrynote
  // calendar (Codex M2 review finding 2).
  const eventTarget = getEventTargetCalendarId(db, target)
  if (eventTarget) {
    await ensureGoogleCalendarSourceSelected(db, client, eventTarget, accountId)
    return eventTarget
  }

  // User's default write target (covers tasks / reminders / snoozes too). It
  // falls back to calendar.google.defaultTargetCalendarId, so installs with
  // only Google settings resolve exactly as before (#2372). A default on
  // another provider never reaches here: routing sent the item there.
  const defaultTarget = readDefaultWriteTarget(db)
  const defaultTargetCalendarId =
    defaultTarget?.provider === 'google' ? defaultTarget.remoteCalendarId : null
  if (defaultTargetCalendarId) {
    await ensureGoogleCalendarSourceSelected(db, client, defaultTargetCalendarId, accountId)
    return defaultTargetCalendarId
  }

  // Final fallback: the auto-created memrynote calendar (per the routed account).
  const memrySource =
    getMemryManagedGoogleSource(db, accountId) ??
    (await ensureMemryCalendarSource(db, client, accountId))
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
  const existingBinding = getExistingGoogleBinding(db, target)
  // One writer per item (#2372): an item another provider already holds is
  // never created in Google as well.
  const liveBinding = findLiveBinding(db, target)
  if (liveBinding && liveBinding.provider !== 'google') {
    throw new Error(`Calendar item is written by ${liveBinding.provider}, not Google`)
  }
  const routedAccountId = resolveTargetGoogleAccountId(db, target, existingBinding)
  if (!routedAccountId) {
    throw new Error('No connected Google account to push to')
  }
  const client = getGoogleClient(db, deps as { client?: GoogleCalendarClient }, routedAccountId)
  const resolvedCalendarId = await resolveTargetCalendarId(
    db,
    target,
    existingBinding,
    client,
    routedAccountId
  )
  return await pushSourceToProvider(db, 'google', target, {
    adapter: client,
    calendarId: resolvedCalendarId
  })
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

  const routedAccountId = resolveTargetGoogleAccountId(db, target, existingBinding)
  const client = getGoogleClient(db, deps as { client?: GoogleCalendarClient }, routedAccountId)
  return await deleteSourceFromProvider(db, 'google', target, { adapter: client })
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
  // One-way (inbound-only) mode: pull Google → memrynote stays on, but never
  // push/update/delete memrynote items out to Google.
  if (!readCalendarGoogleSettings(db).pushEventsToGoogle) return null
  // One writer per item (#2372): a live binding of another provider, an event
  // targeting another provider's calendar, or a default target elsewhere
  // means this item is not Google's to push.
  if (resolveWriteRoute(db, target).provider !== 'google') return null

  if (shouldSourceBeOnCalendar(db, target)) {
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
  await applyProviderWriteback(db, 'google', binding, remote, {
    actor: TaskActivityActors.GOOGLE_CALENDAR
  })
}

export async function applyGoogleCalendarDelete(
  db: DataDb,
  binding: Pick<typeof calendarBindings.$inferSelect, 'sourceType' | 'sourceId' | 'writebackMode'>
): Promise<void> {
  await applyProviderDelete(db, 'google', binding, { actor: TaskActivityActors.GOOGLE_CALENDAR })
}

export async function syncGoogleCalendarSource(
  db: DataDb,
  sourceId: string,
  deps: { client?: Pick<GoogleCalendarClient, 'listEvents'> } = {}
): Promise<void> {
  try {
    await syncGoogleCalendarSourceInner(db, sourceId, deps)
  } catch (error) {
    recordSyncError(db, sourceId, error)
    throw error
  }
}

function recordSyncError(db: DataDb, sourceId: string, error: unknown): void {
  const source = getCalendarSourceById(db, sourceId)
  if (!source) return
  const message = error instanceof Error ? error.message : String(error)
  const truncated = message.slice(0, 200)
  const updated = upsertCalendarSource(db, {
    ...source,
    syncStatus: 'error',
    lastError: truncated,
    modifiedAt: getNow()
  })
  markSyncedTableMutation('calendar_source', updated.id, true)
  emitCalendarChanged({ entityType: 'calendar_source', id: updated.id })
}

async function syncGoogleCalendarSourceInner(
  db: DataDb,
  sourceId: string,
  deps: { client?: Pick<GoogleCalendarClient, 'listEvents'> } = {}
): Promise<void> {
  const source = getCalendarSourceById(db, sourceId)
  if (!source) {
    throw new Error(`Calendar source not found: ${sourceId}`)
  }

  const clientAccountId = source.accountId ?? resolveDefaultGoogleAccountId(db)
  const client = getGoogleClient(db, deps as { client?: GoogleCalendarClient }, clientAccountId)
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

  const importDeviceId = getCurrentDeviceId(db)

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
      // A brand-new event has no `existing` clock to inherit, and `undefined`
      // lands the row with a NULL clock. `calendar_external_event` is in
      // RECORD_CLOCK_REQUIRED_ITEM_TYPES, so the server rejects a clock-less
      // push item — and because RecordPushRequestSchema validates the whole
      // items array, that ONE row fails the entire batch and stalls every other
      // pending change on the device (#1215). Seed the same first clock
      // `seedUnclocked` assigns. With no device row yet (vault not registered)
      // there is no id to tick, so the clock stays NULL and the unclocked
      // sweep/push repair still owns its first push. The first clock is
      // seeded from the id's last tombstone (#2409).
      clock:
        existing?.clock ??
        (importDeviceId
          ? nextLocalClock(db, 'calendar_external_event', record.id, null, importDeviceId, 'create')
          : undefined)
    })
    markSyncedTableMutation('calendar_external_event', record.id, Boolean(existing))
    emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
  }

  const updatedSource = upsertCalendarSource(db, {
    ...source,
    syncCursor: result.nextSyncCursor,
    syncStatus: 'ok',
    lastSyncedAt: now,
    lastError: null,
    modifiedAt: now
  })
  markSyncedTableMutation('calendar_source', updatedSource.id, true)
  emitCalendarChanged({ entityType: 'calendar_source', id: updatedSource.id })
}

export async function syncGoogleCalendarNow(
  db: DataDb = requireDatabase(),
  deps: { client?: GoogleCalendarClient } = {}
): Promise<void> {
  // One pass at a time for Google; other providers keep their own slots (#1393).
  if (isSyncInFlight(GOOGLE_SYNC_KEY)) return
  if (!(await isMemryUserSignedIn())) return
  if (!(await hasGoogleCalendarConnection(db))) return

  await runExclusive(GOOGLE_SYNC_KEY, async () => {
    const accountIds = listGoogleAccountIds(db)
    const defaultAccountId = resolveDefaultGoogleAccountId(db)

    // Refresh the calendar list every pass. This is what fills the picker for
    // installs that connected before multi-calendar support existed — they
    // only ever got a source row for their primary — and it is how a calendar
    // created in Google later shows up without a reconnect. Non-fatal: a
    // failure must not stop the event sync below.
    for (const accountId of accountIds) {
      const client =
        deps.client && accountId === defaultAccountId
          ? deps.client
          : createGoogleCalendarClient({ accountId })
      try {
        await discoverGoogleCalendarSources(db, client, accountId)
      } catch (error) {
        log.warn('Calendar discovery failed', { accountId, error })
      }
    }

    // One-way (inbound-only) mode: skip provisioning the managed "memrynote"
    // calendar — ensureMemryCalendarSource may call createCalendar, an outbound
    // write that the sync-direction setting is meant to suppress. The managed
    // source is only a push target, never pulled inbound, so skipping it is safe.
    if (readCalendarGoogleSettings(db).pushEventsToGoogle) {
      for (const accountId of accountIds) {
        const client =
          deps.client && accountId === defaultAccountId
            ? deps.client
            : createGoogleCalendarClient({ accountId })
        await ensureMemryCalendarSource(db, client, accountId)
      }
    }

    const sources = listCalendarSources(db, {
      provider: 'google',
      kind: 'calendar',
      selectedOnly: true
    }).filter((source) => !source.isMemryManaged)

    for (const source of sources) {
      const sourceDeps = deps.client && source.accountId === defaultAccountId ? deps : {}
      await syncGoogleCalendarSource(db, source.id, sourceDeps)
    }
  })
}

// Runner lifecycle + push-channel poll cadence live in google-sync-runner.ts.
// Re-exported here so existing callers (index.ts, calendar-handlers,
// session-teardown, device-registration, tests) keep their import paths.
export {
  PUSH_BACKOFF_INTERVAL_MS,
  getCurrentPollIntervalMs,
  reEvaluatePollCadence,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  triggerGoogleCalendarSyncNow
} from './google-sync-runner'
