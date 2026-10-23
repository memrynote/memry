import { and, eq, inArray, ne } from 'drizzle-orm'
import {
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  CALDAV_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER
} from '@memry/contracts/calendar-api'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import {
  calendarExternalEvents,
  type CalendarExternalEvent,
  type NewCalendarExternalEvent
} from '@memry/db-schema/schema/calendar-external-events'
import type { DataDb } from '../../database/types'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import {
  getCalendarSourceById,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders
} from '@memry/db-schema/schema/calendar-events'
import {
  eventKitAttendees,
  eventKitConference,
  eventKitRecurrence,
  eventKitReminders
} from './eventkit-details'
import type { EventKitAuthorizationStatus, EventKitCalendar, EventKitEvent } from './eventkit-types'

/**
 * The macOS Calendar mirror (#2374). Everything here is device-local: source
 * rows and events are written straight to the data DB and never enqueued, so
 * no other device, platform or build ever receives them. The sync-client
 * services refuse them too (`DEVICE_LOCAL_CALENDAR_PROVIDERS`); this file
 * simply never asks.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Same span the Google and ICS mirrors read. */
export const EVENTKIT_WINDOW_PAST_MS = 90 * DAY_MS
export const EVENTKIT_WINDOW_FUTURE_MS = 365 * DAY_MS
/** EventKit silently truncates a predicate longer than this. The window must stay under it. */
export const EVENTKIT_MAX_PREDICATE_SPAN_MS = 4 * 365 * DAY_MS

/** The one "This Mac" connection. macOS owns the accounts behind it. */
export const APPLE_ACCOUNT_ID = 'this-mac'
export const APPLE_ACCOUNT_SOURCE_ID = 'apple-eventkit-account:this-mac'

export function appleCalendarSourceId(calendarIdentifier: string): string {
  return `${APPLE_EVENTKIT_CALENDAR_PROVIDER}:${calendarIdentifier}`
}

export interface EventKitWindow {
  startAt: string
  endAt: string
}

export function eventKitWindow(now: Date): EventKitWindow {
  return {
    startAt: new Date(now.getTime() - EVENTKIT_WINDOW_PAST_MS).toISOString(),
    endAt: new Date(now.getTime() + EVENTKIT_WINDOW_FUTURE_MS).toISOString()
  }
}

export interface AppleAccountMetadata {
  /** The last authorization status this device saw. Only `full_access` can read. */
  permission: EventKitAuthorizationStatus
  [key: string]: unknown
}

export interface AppleCalendarMetadata {
  sourceId: string | null
  sourceTitle: string | null
  sourceType: string | null
  calendarType: string
  /** Set when the calendar's account is also connected directly in Memry. */
  connectedVia: string | null
  [key: string]: unknown
}

/** The `lastError` code the settings panel localizes for a permission state. */
export function permissionErrorCode(status: EventKitAuthorizationStatus): string | null {
  return status === 'full_access' ? null : `permission_${status}`
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function getAppleAccount(db: DataDb): CalendarSource | undefined {
  return getCalendarSourceById(db, APPLE_ACCOUNT_SOURCE_ID)
}

export function listAppleCalendarSources(db: DataDb): CalendarSource[] {
  return db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.provider, APPLE_EVENTKIT_CALENDAR_PROVIDER),
        eq(calendarSources.kind, 'calendar')
      )
    )
    .all()
}

export function appleAccountPermission(
  account: Pick<CalendarSource, 'metadata'> | undefined
): EventKitAuthorizationStatus | null {
  const permission = (account?.metadata as Partial<AppleAccountMetadata> | null)?.permission
  return typeof permission === 'string' ? permission : null
}

/**
 * Update the "This Mac" account row with what this device last saw, or create
 * it when `create` is set (connect). `lastError` carries a permission or
 * availability code; null means readable. Without `create`, a disconnected
 * device stays disconnected: a pass that ends after Disconnect writes nothing.
 */
export function recordAppleAccountState(
  db: DataDb,
  state: {
    /** Omitted when it could not be read (the helper is down): the last known one stays. */
    permission?: EventKitAuthorizationStatus
    error?: string | null
    syncedAt?: string | null
    now: string
    create?: boolean
  }
): CalendarSource | undefined {
  const existing = getAppleAccount(db)
  if (!existing && !state.create) return undefined
  const permission = state.permission ?? appleAccountPermission(existing) ?? 'not_determined'
  const error = state.error !== undefined ? state.error : permissionErrorCode(permission)
  const metadata: AppleAccountMetadata = {
    ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
    permission
  }
  const next = {
    syncStatus: error ? ('error' as const) : ('ok' as const),
    lastError: error,
    lastSyncedAt: state.syncedAt ?? existing?.lastSyncedAt ?? null,
    metadata
  }
  if (
    existing &&
    existing.syncStatus === next.syncStatus &&
    (existing.lastError ?? null) === next.lastError &&
    (existing.lastSyncedAt ?? null) === next.lastSyncedAt &&
    appleAccountPermission(existing) === permission
  ) {
    return existing
  }
  const saved = upsertCalendarSource(db, {
    id: APPLE_ACCOUNT_SOURCE_ID,
    provider: APPLE_EVENTKIT_CALENDAR_PROVIDER,
    kind: 'account',
    accountId: APPLE_ACCOUNT_ID,
    remoteId: APPLE_ACCOUNT_ID,
    title: existing?.title ?? 'This Mac',
    timezone: null,
    color: null,
    isPrimary: false,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: null,
    ...next,
    archivedAt: null,
    createdAt: existing?.createdAt ?? state.now,
    modifiedAt: state.now
  })
  emitCalendarChanged({ entityType: 'calendar_source', id: APPLE_ACCOUNT_SOURCE_ID })
  return saved
}

// ---------------------------------------------------------------------------
// Overlap with directly connected accounts
// ---------------------------------------------------------------------------

/** Providers whose accounts Calendar.app can also hold. ICS feeds have no account. */
const DIRECT_PROVIDERS = new Set([GOOGLE_CALENDAR_PROVIDER, CALDAV_CALENDAR_PROVIDER])

/**
 * Identities of accounts connected directly in Memry (Google, CalDAV), mapped
 * to their provider. A Calendar.app calendar whose `EKSource` title matches
 * one would show every event twice, so it starts unchecked.
 */
export function directlyConnectedIdentities(db: DataDb): Map<string, string> {
  const identities = new Map<string, string>()
  const accounts = db
    .select()
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.kind, 'account'),
        ne(calendarSources.provider, APPLE_EVENTKIT_CALENDAR_PROVIDER)
      )
    )
    .all()
    .filter((account) => !account.archivedAt)
  for (const account of accounts) {
    if (!DIRECT_PROVIDERS.has(account.provider)) continue
    const metadata = account.metadata ?? {}
    for (const value of [metadata.email, metadata.username, account.title]) {
      if (typeof value === 'string' && value.includes('@')) {
        identities.set(value.trim().toLowerCase(), account.provider)
      }
    }
    // Calendar.app names an iCloud account "iCloud", not by its Apple ID.
    const serverUrl = typeof metadata.serverUrl === 'string' ? metadata.serverUrl : ''
    if (metadata.preset === 'icloud' || /(^|\.)icloud\.com/i.test(safeHost(serverUrl))) {
      identities.set('icloud', account.provider)
    }
  }
  return identities
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function connectedViaFor(
  calendar: Pick<EventKitCalendar, 'sourceTitle'>,
  identities: Map<string, string>
): string | null {
  const title = calendar.sourceTitle?.trim().toLowerCase()
  return title ? (identities.get(title) ?? null) : null
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

function calendarMetadata(
  calendar: EventKitCalendar,
  connectedVia: string | null
): AppleCalendarMetadata {
  return {
    sourceId: calendar.sourceId,
    sourceTitle: calendar.sourceTitle,
    sourceType: calendar.sourceType,
    calendarType: calendar.type,
    connectedVia
  }
}

export interface ReconcileResult {
  added: string[]
  removed: string[]
  changed: string[]
}

/**
 * Make this device's calendar rows equal what EventKit reports. New calendars
 * are shown unless their account is already connected directly; a calendar
 * gone from Calendar.app (or a data DB restored onto another Mac) loses its
 * row and events. The user's show/hide choice on an existing row is kept.
 */
export function reconcileAppleCalendars(
  db: DataDb,
  calendars: EventKitCalendar[],
  options: { now: string; identities?: Map<string, string> }
): ReconcileResult {
  const identities = options.identities ?? directlyConnectedIdentities(db)
  const existing = new Map(listAppleCalendarSources(db).map((row) => [row.remoteId, row]))
  const result: ReconcileResult = { added: [], removed: [], changed: [] }
  const seen = new Set<string>()

  for (const calendar of calendars) {
    if (seen.has(calendar.id)) continue
    seen.add(calendar.id)
    const previous = existing.get(calendar.id)
    const previousMeta = (previous?.metadata as Partial<AppleCalendarMetadata> | null) ?? null
    // The overlap is decided when a calendar first appears; afterwards the
    // user's choice stands and the label only records why it started off.
    const connectedVia = previous
      ? (previousMeta?.connectedVia ?? null)
      : connectedViaFor(calendar, identities)
    const metadata = calendarMetadata(calendar, connectedVia)
    if (
      previous &&
      previous.title === calendar.title &&
      (previous.color ?? null) === calendar.color &&
      JSON.stringify(previous.metadata ?? null) === JSON.stringify(metadata)
    ) {
      continue
    }
    const id = appleCalendarSourceId(calendar.id)
    upsertCalendarSource(db, {
      id,
      provider: APPLE_EVENTKIT_CALENDAR_PROVIDER,
      kind: 'calendar',
      accountId: APPLE_ACCOUNT_ID,
      remoteId: calendar.id,
      title: calendar.title,
      timezone: null,
      color: calendar.color,
      isPrimary: false,
      isSelected: previous ? previous.isSelected : connectedVia === null,
      isMemryManaged: false,
      syncCursor: null,
      syncStatus: previous?.syncStatus ?? 'idle',
      lastSyncedAt: previous?.lastSyncedAt ?? null,
      lastError: previous?.lastError ?? null,
      metadata,
      archivedAt: null,
      createdAt: previous?.createdAt ?? options.now,
      modifiedAt: options.now
    })
    emitCalendarChanged({ entityType: 'calendar_source', id })
    ;(previous ? result.changed : result.added).push(id)
  }

  const stale = [...existing.values()].filter((row) => !seen.has(row.remoteId))
  if (stale.length > 0) {
    const ids = stale.map((row) => row.id)
    db.transaction((tx) => {
      tx.delete(calendarExternalEvents).where(inArray(calendarExternalEvents.sourceId, ids)).run()
      tx.delete(calendarSources).where(inArray(calendarSources.id, ids)).run()
    })
    for (const id of ids) emitCalendarChanged({ entityType: 'calendar_source', id })
    emitCalendarProjectionChanged(`${APPLE_EVENTKIT_CALENDAR_PROVIDER}:reconcile`)
    result.removed.push(...ids)
  }
  return result
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface EventKitInstance {
  remoteEventId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  timezone: string | null
  isAllDay: boolean
  status: 'confirmed' | 'tentative'
  remoteUpdatedAt: string | null
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  recurrenceRule: Record<string, unknown> | null
  conferenceData: CalendarConferenceData | null
  rawPayload: Record<string, unknown>
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function dateOnlyToIso(date: string, addDays = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + addDays * DAY_MS
  return new Date(ms).toISOString()
}

/**
 * One EventKit occurrence as a mirror row. All-day events are stored like
 * every other provider stores them: UTC midnight of the first date to UTC
 * midnight after the last. Cancelled occurrences are dropped, as ICS does.
 *
 * The row key is `<identity>::<occurrence start>`. The identity is
 * `calendarItemExternalIdentifier` when EventKit has one (stable across
 * Calendar.app re-syncs), otherwise `eventIdentifier`; `rawPayload.idKind`
 * records which.
 */
export function toEventKitInstance(event: EventKitEvent): EventKitInstance | null {
  if (event.status === 'canceled') return null
  const identity = event.externalId ?? event.eventId
  if (!identity) return null

  let startAt: string | null
  let endAt: string | null
  if (event.isAllDay) {
    startAt = event.startDate ? dateOnlyToIso(event.startDate) : null
    endAt = event.lastDate ? dateOnlyToIso(event.lastDate, 1) : null
  } else {
    startAt = isoOrNull(event.start)
    endAt = isoOrNull(event.end)
  }
  if (!startAt) return null
  const occurrence = event.isAllDay ? startAt : (isoOrNull(event.occurrenceStart) ?? startAt)

  return {
    remoteEventId: `${identity}::${occurrence}`,
    title: event.title.trim() || 'Untitled event',
    description: event.notes,
    location: event.location,
    startAt,
    endAt: endAt && endAt > startAt ? endAt : null,
    timezone: event.isAllDay ? null : event.timeZone,
    isAllDay: event.isAllDay,
    status: event.status === 'tentative' ? 'tentative' : 'confirmed',
    remoteUpdatedAt: isoOrNull(event.lastModified),
    attendees: eventKitAttendees(event),
    reminders: eventKitReminders(event),
    recurrenceRule: eventKitRecurrence(event),
    conferenceData: eventKitConference(event),
    rawPayload: {
      idKind: event.externalId ? 'external' : 'event',
      availability: event.availability,
      isRecurring: event.isRecurring,
      ...(event.url ? { url: event.url } : {})
    }
  }
}

function externalEventRowId(sourceId: string, remoteEventId: string): string {
  return `calendar_external_event:${sourceId}:${remoteEventId}`
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function sameContent(row: CalendarExternalEvent, instance: EventKitInstance): boolean {
  return (
    !row.archivedAt &&
    row.title === instance.title &&
    (row.description ?? null) === instance.description &&
    (row.location ?? null) === instance.location &&
    row.startAt === instance.startAt &&
    (row.endAt ?? null) === instance.endAt &&
    (row.timezone ?? null) === instance.timezone &&
    row.isAllDay === instance.isAllDay &&
    row.status === instance.status &&
    (row.remoteUpdatedAt ?? null) === instance.remoteUpdatedAt &&
    sameJson(row.attendees, instance.attendees) &&
    sameJson(row.reminders, instance.reminders) &&
    sameJson(row.recurrenceRule, instance.recurrenceRule) &&
    sameJson(row.conferenceData, instance.conferenceData) &&
    sameJson(row.rawPayload, instance.rawPayload)
  )
}

/**
 * Make one calendar's mirrored events equal EventKit's inside `window`: write
 * what is new or changed, delete what EventKit no longer has. Rows that ended
 * before the window stay, as they do for every other mirror. Returns how many
 * rows changed.
 */
export function applyEventKitEvents(
  db: DataDb,
  sourceId: string,
  events: EventKitEvent[],
  window: EventKitWindow,
  nowIso: string
): number {
  let changed = 0
  db.transaction((tx) => {
    const existing = new Map(
      tx
        .select()
        .from(calendarExternalEvents)
        .where(eq(calendarExternalEvents.sourceId, sourceId))
        .all()
        .map((row) => [row.id, row])
    )
    const seen = new Set<string>()

    for (const event of events) {
      const instance = toEventKitInstance(event)
      if (!instance) continue
      const id = externalEventRowId(sourceId, instance.remoteEventId)
      if (seen.has(id)) continue
      seen.add(id)
      const previous = existing.get(id)
      if (previous && sameContent(previous, instance)) continue

      const row: NewCalendarExternalEvent = {
        id,
        sourceId,
        remoteEventId: instance.remoteEventId,
        remoteEtag: null,
        remoteUpdatedAt: instance.remoteUpdatedAt,
        title: instance.title,
        description: instance.description,
        location: instance.location,
        startAt: instance.startAt,
        endAt: instance.endAt,
        timezone: instance.timezone,
        isAllDay: instance.isAllDay,
        status: instance.status,
        recurrenceRule: instance.recurrenceRule,
        attendees: instance.attendees,
        reminders: instance.reminders,
        // EventKit has no privacy flag; availability (busy/free) is not
        // visibility, so it stays in rawPayload rather than mislabel events.
        visibility: null,
        colorId: null,
        conferenceData: instance.conferenceData,
        rawPayload: instance.rawPayload,
        archivedAt: null,
        createdAt: previous?.createdAt ?? nowIso,
        modifiedAt: nowIso
      }
      tx.insert(calendarExternalEvents)
        .values(row)
        .onConflictDoUpdate({ target: calendarExternalEvents.id, set: row })
        .run()
      changed += 1
    }

    for (const row of existing.values()) {
      if (seen.has(row.id)) continue
      if ((row.endAt ?? row.startAt) < window.startAt) continue
      tx.delete(calendarExternalEvents).where(eq(calendarExternalEvents.id, row.id)).run()
      changed += 1
    }
  })
  return changed
}

/** Drop mirrored events locally. Nothing is enqueued: they were never pushed. */
export function purgeAppleCalendarEvents(db: DataDb, sourceIds?: string[]): number {
  const ids = sourceIds ?? listAppleCalendarSources(db).map((row) => row.id)
  if (ids.length === 0) return 0
  const { changes } = db
    .delete(calendarExternalEvents)
    .where(inArray(calendarExternalEvents.sourceId, ids))
    .run()
  if (changes > 0) emitCalendarProjectionChanged(`${APPLE_EVENTKIT_CALENDAR_PROVIDER}:purge`)
  return changes
}

/** Disconnect: every row this provider wrote, gone from this device. Nothing is enqueued. */
export function removeAppleCalendarData(db: DataDb): void {
  const rows = db
    .select({ id: calendarSources.id })
    .from(calendarSources)
    .where(eq(calendarSources.provider, APPLE_EVENTKIT_CALENDAR_PROVIDER))
    .all()
  if (rows.length === 0) return
  const ids = rows.map((row) => row.id)
  db.transaction((tx) => {
    tx.delete(calendarExternalEvents).where(inArray(calendarExternalEvents.sourceId, ids)).run()
    tx.delete(calendarSources).where(inArray(calendarSources.id, ids)).run()
  })
  for (const id of ids) emitCalendarChanged({ entityType: 'calendar_source', id })
  emitCalendarProjectionChanged(`${APPLE_EVENTKIT_CALENDAR_PROVIDER}:disconnect`)
}

/** Record one calendar's read outcome locally (never enqueued). */
export function recordAppleCalendarRead(
  db: DataDb,
  sourceId: string,
  outcome: { ok: true; at: string } | { ok: false; error: string }
): void {
  db.update(calendarSources)
    .set(
      outcome.ok
        ? { syncStatus: 'ok', lastSyncedAt: outcome.at, lastError: null }
        : { syncStatus: 'error', lastError: outcome.error }
    )
    .where(eq(calendarSources.id, sourceId))
    .run()
  emitCalendarChanged({ entityType: 'calendar_source', id: sourceId })
}
