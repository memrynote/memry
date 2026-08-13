import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createLogger } from '../../lib/logger'
import type { DataDb } from '../../database/types'
import { enqueueLocalSyncCreate, enqueueLocalSyncUpdate } from '../../sync/local-mutations'
import { getCurrentDeviceId } from '../../sync/current-device-id'
import { loadSourceAsRemoteEvent, pushEventWithConflictRetry } from './push-conflict-retry'
import { applyProviderDelete, applyProviderWriteback, getExistingBinding } from './writeback'
import { isMemryUserSignedIn } from '../../sync/auth-state'
import { increment } from '../../sync/vector-clock'
import { mapGoogleEventToExternalEventRecord } from './remote-event-mappers'
import {
  getCalendarExternalEventById,
  upsertCalendarExternalEvent
} from '../repositories/calendar-external-events-repository'
import {
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById,
  listCalendarSources,
  upsertCalendarBinding,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { emitCalendarChanged } from '../change-events'
import { ProviderGoneError } from '../provider/errors'
import type { CalendarProviderAdapter, ProviderCapabilities } from '../provider/adapter'
import type { CalendarSyncTarget } from '../types'

export { applyProviderDelete, applyProviderWriteback } from './writeback'

const log = createLogger('Calendar:Sync')
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/**
 * Everything the engine needs to know about one provider. Deliberately not the
 * IPC-facing `CalendarProviderDefinition`: the engine only wants the adapter,
 * the account routing, and the two switches that decide whether it may write.
 */
export interface ProviderSyncContext {
  providerId: string
  capabilities: ProviderCapabilities
  createAdapter(accountId: string): CalendarProviderAdapter
  listAccountIds(db: DataDb): string[]
  resolveDefaultAccountId(db: DataDb): string | null
  /** The provider has at least one account with usable local credentials. */
  hasConnection(db: DataDb): Promise<boolean>
  /**
   * The user's outbound-sync toggle for this provider. Independent of
   * `capabilities.supportsWrite`: the capability says the protocol *can*
   * write, this says the user wants us to.
   */
  isPushEnabled(db: DataDb): boolean
  /** Which account a given local item should be pushed to. */
  resolveTargetAccountId(
    db: DataDb,
    target: CalendarSyncTarget,
    existingBinding: typeof calendarBindings.$inferSelect | undefined
  ): string | null
  /** The provider's default target calendar, chosen during onboarding. */
  readDefaultTargetCalendarId(db: DataDb): string | null
}

/**
 * One in-flight slot per provider. This used to be a single module-global
 * boolean, so one slow provider would have blocked every other one.
 */
const syncInFlight = new Set<string>()

function getNow(): string {
  return new Date().toISOString()
}

/**
 * The provider's incremental cursor is dead and the source has to be read from
 * scratch. Adapters signal this with `ProviderGoneError`; the Google client
 * predates the taxonomy and throws a plain error carrying `status: 410`, which
 * is still recognized here so its behavior is unchanged.
 */
function isCursorGoneError(error: unknown): boolean {
  if (error instanceof ProviderGoneError) return true
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 410
  )
}

/**
 * Only modes that hand back a fresh cursor on every successful response can
 * treat a missing cursor as "the cursor was invalidated". A provider that polls
 * a whole feed has no cursor to lose, so the reset branch must not fire for it.
 */
function cursorIsMandatory(capabilities: ProviderCapabilities): boolean {
  return (
    capabilities.incrementalMode === 'sync-token' || capabilities.incrementalMode === 'delta-link'
  )
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

/**
 * Read-only providers must never reach `calendar_bindings`. Enforced here, at
 * the engine, rather than trusting each adapter to omit `upsertEvent`.
 */
function assertWritable(context: ProviderSyncContext, operation: string): void {
  if (context.capabilities.supportsWrite) return
  throw new Error(`Calendar provider ${context.providerId} is read-only; refusing to ${operation}`)
}

function sourceLocalId(providerId: string, remoteId: string): string {
  return `${providerId}-calendar:${remoteId}`
}

async function ensureMemryCalendarSource(
  db: DataDb,
  context: ProviderSyncContext,
  adapter: CalendarProviderAdapter,
  accountId: string
): Promise<typeof calendarSources.$inferSelect> {
  const existing = listCalendarSources(db, {
    provider: context.providerId,
    kind: 'calendar'
  }).find((source) => source.isMemryManaged && source.accountId === accountId)

  if (existing) return existing

  const discovered = await adapter.listCalendars()
  const found = discovered.find((calendar) => calendar.title === 'memrynote')
  if (!found && !adapter.createCalendar) {
    throw new Error(`Calendar provider ${context.providerId} cannot create the memrynote calendar`)
  }
  const remote =
    found ?? (await adapter.createCalendar!({ title: 'memrynote', timezone: LOCAL_TIMEZONE }))

  const localId = sourceLocalId(context.providerId, remote.id)
  const now = getNow()
  const existingSource = getCalendarSourceById(db, localId)
  const existed = Boolean(existingSource)

  const saved = upsertCalendarSource(db, {
    id: localId,
    provider: context.providerId,
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
export async function discoverProviderSources(
  db: DataDb,
  context: ProviderSyncContext,
  adapter: Pick<CalendarProviderAdapter, 'listCalendars'>,
  accountId: string
): Promise<void> {
  const discovered = await adapter.listCalendars()
  const now = getNow()

  for (const remote of discovered) {
    const localId = sourceLocalId(context.providerId, remote.id)
    const existing = getCalendarSourceById(db, localId)

    const saved = upsertCalendarSource(db, {
      ...existing,
      id: localId,
      provider: context.providerId,
      kind: 'calendar',
      accountId,
      remoteId: remote.id,
      title: remote.title,
      timezone: remote.timezone ?? LOCAL_TIMEZONE,
      color: remote.color,
      isPrimary: remote.isPrimary,
      isSelected: existing ? existing.isSelected : remote.isPrimary,
      isMemryManaged: existing?.isMemryManaged ?? false,
      // The provider still lists it, so it is not gone. A stale archivedAt here
      // is the tombstone a previous disconnect left behind, and leaving it set
      // would hide the calendar from the picker on reconnect.
      archivedAt: null,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now
    })

    markSyncedTableMutation('calendar_source', saved.id, Boolean(existing))
    emitCalendarChanged({ entityType: 'calendar_source', id: saved.id })
  }
}

function getMemryManagedSource(
  db: DataDb,
  providerId: string,
  accountId?: string
): typeof calendarSources.$inferSelect | undefined {
  return listCalendarSources(db, {
    provider: providerId,
    kind: 'calendar'
  }).find(
    (source) =>
      source.isMemryManaged &&
      !source.archivedAt &&
      (accountId ? source.accountId === accountId : true)
  )
}

/**
 * Ensure a remote calendar is registered in `calendar_sources` and flagged for
 * inbound sync (isSelected=true). Called from the push resolver whenever we
 * route an event to a calendar that the user picked directly or set as their
 * default — without this, `syncProviderNow` never polls that calendar and
 * two-way sync silently breaks for everything outside the memrynote-managed
 * calendar (Codex M2 review finding 2).
 */
export async function ensureProviderCalendarSourceSelected(
  db: DataDb,
  context: ProviderSyncContext,
  adapter: Pick<CalendarProviderAdapter, 'listCalendars'>,
  remoteCalendarId: string,
  accountId: string
): Promise<typeof calendarSources.$inferSelect | null> {
  const existing = listCalendarSources(db, {
    provider: context.providerId,
    kind: 'calendar'
  }).find((source) => source.remoteId === remoteCalendarId && !source.archivedAt)

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

  const discovered = await adapter.listCalendars()
  const remote = discovered.find((cal) => cal.id === remoteCalendarId)
  if (!remote) {
    log.warn('Target calendar not found while registering source', {
      provider: context.providerId,
      remoteCalendarId
    })
    return null
  }

  const localId = sourceLocalId(context.providerId, remote.id)
  const existingById = getCalendarSourceById(db, localId)
  const existed = Boolean(existingById)

  const saved = upsertCalendarSource(db, {
    id: localId,
    provider: context.providerId,
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

function resolveAdapter(
  context: ProviderSyncContext,
  db: DataDb,
  deps?: { adapter?: CalendarProviderAdapter },
  accountIdOverride?: string | null
): CalendarProviderAdapter {
  if (deps?.adapter) return deps.adapter
  const accountId = accountIdOverride ?? context.resolveDefaultAccountId(db)
  if (!accountId) {
    throw new Error(
      `Cannot create a ${context.providerId} calendar client without a connected account`
    )
  }
  return context.createAdapter(accountId)
}

function shouldSourceSyncToProvider(db: DataDb, target: CalendarSyncTarget): boolean {
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
  context: ProviderSyncContext,
  target: CalendarSyncTarget,
  existingBinding: typeof calendarBindings.$inferSelect | undefined,
  adapter: CalendarProviderAdapter,
  accountId: string
): Promise<string> {
  // Existing binding wins — retargeting a bound event would require a remote
  // move plus coordinated etag handling (M3+ work).
  if (existingBinding?.remoteCalendarId) return existingBinding.remoteCalendarId

  // Per-event override from the renderer calendar picker. Register the
  // calendar as a selected source so the inbound poll covers it; without
  // this, two-way sync silently breaks for anything outside the memrynote
  // calendar (Codex M2 review finding 2).
  const eventTarget = getEventTargetCalendarId(db, target)
  if (eventTarget) {
    await ensureProviderCalendarSourceSelected(db, context, adapter, eventTarget, accountId)
    return eventTarget
  }

  // User's onboarding-selected default (covers tasks / reminders / snoozes too).
  const defaultTargetCalendarId = context.readDefaultTargetCalendarId(db)
  if (defaultTargetCalendarId) {
    await ensureProviderCalendarSourceSelected(
      db,
      context,
      adapter,
      defaultTargetCalendarId,
      accountId
    )
    return defaultTargetCalendarId
  }

  // Final fallback: the auto-created memrynote calendar (per the routed account).
  const memrySource =
    getMemryManagedSource(db, context.providerId, accountId) ??
    (await ensureMemryCalendarSource(db, context, adapter, accountId))
  return memrySource.remoteId
}

export async function pushSourceToProvider(
  db: DataDb,
  context: ProviderSyncContext,
  target: CalendarSyncTarget,
  deps: { adapter?: CalendarProviderAdapter } = {}
): Promise<typeof calendarBindings.$inferSelect> {
  assertWritable(context, 'push an event')

  const existingBinding = getExistingBinding(db, context.providerId, target)
  const routedAccountId = context.resolveTargetAccountId(db, target, existingBinding)
  if (!routedAccountId) {
    throw new Error(`No connected ${context.providerId} account to push to`)
  }
  const adapter = resolveAdapter(context, db, deps, routedAccountId)
  const resolvedCalendarId = await resolveTargetCalendarId(
    db,
    context,
    target,
    existingBinding,
    adapter,
    routedAccountId
  )
  const now = getNow()
  const bindingId =
    existingBinding?.id ??
    `calendar_binding:${context.providerId}:${target.sourceType}:${target.sourceId}`

  const remote = await pushEventWithConflictRetry(
    db,
    target,
    adapter,
    resolvedCalendarId,
    existingBinding
  )

  // After possible merge, re-load the latest local snapshot for the binding record.
  const finalLocalEvent = loadSourceAsRemoteEvent(db, target)

  const binding = upsertCalendarBinding(db, {
    id: bindingId,
    sourceType: target.sourceType,
    sourceId: target.sourceId,
    provider: context.providerId,
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

export async function deleteSourceFromProvider(
  db: DataDb,
  context: ProviderSyncContext,
  target: CalendarSyncTarget,
  deps: { adapter?: CalendarProviderAdapter } = {}
): Promise<boolean> {
  const existingBinding = getExistingBinding(db, context.providerId, target)
  if (!existingBinding?.remoteCalendarId || !existingBinding.remoteEventId) {
    return false
  }

  assertWritable(context, 'delete a remote event')

  const routedAccountId = context.resolveTargetAccountId(db, target, existingBinding)
  const adapter = resolveAdapter(context, db, deps, routedAccountId)
  if (!adapter.deleteEvent) {
    throw new Error(`Calendar provider ${context.providerId} cannot delete remote events`)
  }
  await adapter.deleteEvent({
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

export async function syncLocalSourceToProvider(
  db: DataDb,
  context: ProviderSyncContext,
  target: CalendarSyncTarget,
  deps: { adapter?: CalendarProviderAdapter } = {}
): Promise<typeof calendarBindings.$inferSelect | null> {
  // A read-only provider has no outbound path at all — stop before any
  // binding row could be created, whatever the adapter happens to expose.
  if (!context.capabilities.supportsWrite) return null
  if (!(await isMemryUserSignedIn())) return null
  if (!(await context.hasConnection(db))) return null
  // One-way (inbound-only) mode: pull provider → memrynote stays on, but never
  // push/update/delete memrynote items back out.
  if (!context.isPushEnabled(db)) return null

  if (shouldSourceSyncToProvider(db, target)) {
    return await pushSourceToProvider(db, context, target, deps)
  }

  await deleteSourceFromProvider(db, context, target, deps)
  return null
}

export async function syncProviderSource(
  db: DataDb,
  context: ProviderSyncContext,
  sourceId: string,
  deps: { adapter?: Pick<CalendarProviderAdapter, 'listEvents'> } = {}
): Promise<void> {
  try {
    await syncProviderSourceInner(db, context, sourceId, deps)
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

async function syncProviderSourceInner(
  db: DataDb,
  context: ProviderSyncContext,
  sourceId: string,
  deps: { adapter?: Pick<CalendarProviderAdapter, 'listEvents'> } = {}
): Promise<void> {
  const source = getCalendarSourceById(db, sourceId)
  if (!source) {
    throw new Error(`Calendar source not found: ${sourceId}`)
  }

  const clientAccountId = source.accountId ?? context.resolveDefaultAccountId(db)
  const adapter = resolveAdapter(
    context,
    db,
    deps as { adapter?: CalendarProviderAdapter },
    clientAccountId
  )
  const now = getNow()
  const isInitialSync = !source.syncCursor

  // Defensive: the Google client returns { events: [], nextSyncCursor: null } on
  // 410 (handled below via the cursor-invalidation branch); other adapters
  // raise ProviderGoneError instead. Both land in the same reset.
  let result: Awaited<ReturnType<CalendarProviderAdapter['listEvents']>>
  try {
    result = await adapter.listEvents({
      calendarId: source.remoteId,
      syncCursor: source.syncCursor ?? null,
      timeMin: isInitialSync ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() : null,
      timeMax: isInitialSync ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null
    })
  } catch (error) {
    if (isCursorGoneError(error) && source.syncCursor) {
      log.warn('provider reported a dead cursor; clearing it and re-syncing', {
        provider: context.providerId,
        sourceId
      })
      const freshSource = upsertCalendarSource(db, {
        ...source,
        syncCursor: null,
        syncStatus: 'pending',
        modifiedAt: now
      })
      markSyncedTableMutation('calendar_source', freshSource.id, true)
      return await syncProviderSource(db, context, sourceId, deps)
    }
    throw error
  }

  if (cursorIsMandatory(context.capabilities) && !result.nextSyncCursor && source.syncCursor) {
    log.warn('sync cursor invalidated for source, re-syncing from scratch', {
      provider: context.providerId,
      sourceId
    })
    const freshSource = upsertCalendarSource(db, {
      ...source,
      syncCursor: null,
      syncStatus: 'pending',
      modifiedAt: now
    })
    markSyncedTableMutation('calendar_source', freshSource.id, true)
    return await syncProviderSource(db, context, sourceId, deps)
  }

  const importDeviceId = getCurrentDeviceId(db)

  for (const remoteEvent of result.events) {
    // A read-only provider never writes bindings, so it never has one to
    // resolve — its events always land in the external-event mirror below.
    const binding = context.capabilities.supportsWrite
      ? findCalendarBindingByRemoteEvent(
          db,
          context.providerId,
          remoteEvent.calendarId,
          remoteEvent.id
        )
      : undefined

    if (binding) {
      if (remoteEvent.status === 'cancelled') {
        await applyProviderDelete(db, context, binding)
      } else {
        await applyProviderWriteback(db, context, binding, remoteEvent)
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
      // sweep/push repair still owns its first push.
      clock: existing?.clock ?? (importDeviceId ? increment({}, importDeviceId) : undefined)
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

export async function syncProviderNow(
  db: DataDb,
  context: ProviderSyncContext,
  deps: { adapter?: CalendarProviderAdapter } = {}
): Promise<void> {
  // Per-provider, so a slow provider only ever blocks itself.
  if (syncInFlight.has(context.providerId)) return
  if (!(await isMemryUserSignedIn())) return
  if (!(await context.hasConnection(db))) return

  syncInFlight.add(context.providerId)
  try {
    const accountIds = context.listAccountIds(db)
    const defaultAccountId = context.resolveDefaultAccountId(db)

    // Refresh the calendar list every pass. This is what fills the picker for
    // installs that connected before multi-calendar support existed — they
    // only ever got a source row for their primary — and it is how a calendar
    // created remotely later shows up without a reconnect. Non-fatal: a
    // failure must not stop the event sync below.
    for (const accountId of accountIds) {
      const adapter =
        deps.adapter && accountId === defaultAccountId
          ? deps.adapter
          : context.createAdapter(accountId)
      try {
        await discoverProviderSources(db, context, adapter, accountId)
      } catch (error) {
        log.warn('Calendar discovery failed', { provider: context.providerId, accountId, error })
      }
    }

    // One-way (inbound-only) mode: skip provisioning the managed "memrynote"
    // calendar — ensureMemryCalendarSource may call createCalendar, an outbound
    // write that the sync-direction setting is meant to suppress. The managed
    // source is only a push target, never pulled inbound, so skipping it is
    // safe. A read-only provider never provisions one at all.
    if (context.capabilities.supportsWrite && context.isPushEnabled(db)) {
      for (const accountId of accountIds) {
        const adapter =
          deps.adapter && accountId === defaultAccountId
            ? deps.adapter
            : context.createAdapter(accountId)
        await ensureMemryCalendarSource(db, context, adapter, accountId)
      }
    }

    const sources = listCalendarSources(db, {
      provider: context.providerId,
      kind: 'calendar',
      selectedOnly: true
    }).filter((source) => !source.isMemryManaged)

    for (const source of sources) {
      const sourceDeps = deps.adapter && source.accountId === defaultAccountId ? deps : {}
      await syncProviderSource(db, context, source.id, sourceDeps)
    }
  } finally {
    syncInFlight.delete(context.providerId)
  }
}

/** Test seam: clears every in-flight slot between cases. */
export function __resetSyncInFlightForTests(): void {
  syncInFlight.clear()
}
