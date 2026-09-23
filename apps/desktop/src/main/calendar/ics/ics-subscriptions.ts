import { eq } from 'drizzle-orm'
import {
  ICS_CALENDAR_PROVIDER,
  type SubscribeIcsCalendarInput
} from '@memry/contracts/calendar-api'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import {
  calendarExternalEvents,
  type CalendarExternalEvent,
  type NewCalendarExternalEvent
} from '@memry/db-schema/schema/calendar-external-events'
import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged, emitCalendarProjectionChanged } from '../change-events'
import {
  getCalendarSourceById,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
import { syncCalendarSourceCreate, syncCalendarSourceUpdate } from '../runtime-effects'
import { fetchIcsFeed, type FetchLike, type IcsValidators } from './ics-fetch'
import {
  IcsFeedError,
  icsSourceIdForUrl,
  normalizeIcsUrl,
  parseIcsFeed,
  type IcsEventInstance,
  type IcsExpansionWindow,
  type IcsFeed
} from './ics-feed'

const log = createLogger('Calendar:IcsSubscriptions')

const DAY_MS = 24 * 60 * 60 * 1000
// Same span the Google mirror pulls on its first sync.
const WINDOW_PAST_MS = 90 * DAY_MS
const WINDOW_FUTURE_MS = 365 * DAY_MS
const DEFAULT_REFRESH_MS = 60 * 60 * 1000
const MIN_REFRESH_MS = 15 * 60 * 1000
const MAX_REFRESH_MS = DAY_MS

export interface IcsDeps {
  fetch?: FetchLike
  now?: () => Date
}

/**
 * What this device last saw from each feed. Deliberately in memory and per
 * database: a validator is only valid for the events this device wrote from
 * that response, so it must never travel with the synced source row or leak
 * into another vault that subscribes to the same URL.
 */
interface FeedState {
  validators: IcsValidators | null
  refreshIntervalMs: number
  nextRefreshAt: number
}

const feedStates = new WeakMap<DataDb, Map<string, FeedState>>()

function statesFor(db: DataDb): Map<string, FeedState> {
  let states = feedStates.get(db)
  if (!states) {
    states = new Map()
    feedStates.set(db, states)
  }
  return states
}

function nowOf(deps: IcsDeps): Date {
  return deps.now?.() ?? new Date()
}

function expansionWindow(now: Date): IcsExpansionWindow {
  return {
    startAt: new Date(now.getTime() - WINDOW_PAST_MS).toISOString(),
    endAt: new Date(now.getTime() + WINDOW_FUTURE_MS).toISOString()
  }
}

function clampRefreshInterval(hintMs: number | null): number {
  if (!hintMs || hintMs <= 0) return DEFAULT_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, hintMs))
}

export function isIcsCalendarSource(source: Pick<CalendarSource, 'provider'>): boolean {
  return source.provider === ICS_CALENDAR_PROVIDER
}

function requireIcsSource(db: DataDb, sourceId: string): CalendarSource {
  const source = getCalendarSourceById(db, sourceId)
  if (!source || !isIcsCalendarSource(source)) {
    throw new Error(`Subscribed calendar not found: ${sourceId}`)
  }
  return source
}

function externalEventId(sourceId: string, remoteEventId: string): string {
  return `calendar_external_event:${sourceId}:${remoteEventId}`
}

function sameContent(row: CalendarExternalEvent, instance: IcsEventInstance): boolean {
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
    (row.remoteUpdatedAt ?? null) === instance.remoteUpdatedAt
  )
}

/**
 * Make this source's mirrored events equal the feed inside `window`: write
 * what is new or changed, delete what the feed no longer has. Rows that ended
 * before the window are history the feed may have pruned, so they stay.
 *
 * Mirrored ICS events never enter the sync queue. Every device reads the feed
 * itself, and the source row is what carries the subscription across devices.
 */
function applyFeed(
  db: DataDb,
  sourceId: string,
  feed: IcsFeed,
  window: IcsExpansionWindow,
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

    for (const instance of feed.events) {
      const id = externalEventId(sourceId, instance.remoteEventId)
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
        recurrenceRule: null,
        attendees: null,
        reminders: null,
        visibility: null,
        colorId: null,
        conferenceData: null,
        rawPayload: null,
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

/**
 * Fetch status is this device's view of the feed, so it is written locally
 * and not enqueued: syncing it would have devices overwrite each other's
 * "last updated" every poll.
 */
function recordFetchOutcome(
  db: DataDb,
  sourceId: string,
  outcome: { ok: true; at: string } | { ok: false; error: IcsFeedError }
): CalendarSource {
  db.update(calendarSources)
    .set(
      outcome.ok
        ? { syncStatus: 'ok', lastSyncedAt: outcome.at, lastError: null }
        : { syncStatus: 'error', lastError: outcome.error.code }
    )
    .where(eq(calendarSources.id, sourceId))
    .run()
  emitCalendarChanged({ entityType: 'calendar_source', id: sourceId })
  return getCalendarSourceById(db, sourceId) as CalendarSource
}

async function readFeed(
  url: string,
  validators: IcsValidators | null,
  window: IcsExpansionWindow,
  deps: IcsDeps
): Promise<{ feed: IcsFeed; validators: IcsValidators } | null> {
  const response = await fetchIcsFeed(url, validators, deps.fetch)
  if (response.status === 'not_modified') return null
  try {
    return { feed: parseIcsFeed(response.body, window), validators: response.validators }
  } catch (error) {
    // ical.js throws plain errors on malformed content (a broken RRULE, a bad
    // date); to the user that is the same as a link that is not a calendar.
    if (error instanceof IcsFeedError) throw error
    throw new IcsFeedError('not_a_calendar', error instanceof Error ? error.message : undefined)
  }
}

export function purgeIcsCalendarEvents(db: DataDb, sourceId: string): number {
  statesFor(db).delete(sourceId)
  const { changes } = db
    .delete(calendarExternalEvents)
    .where(eq(calendarExternalEvents.sourceId, sourceId))
    .run()
  if (changes > 0) emitCalendarProjectionChanged(`ics:${sourceId}`)
  return changes
}

/**
 * Subscribe by URL. The feed is fetched and parsed before anything is saved,
 * so a wrong link fails here with a reason instead of leaving an empty
 * calendar behind. Subscribing to a URL that is already subscribed returns
 * that source; one that was removed earlier is restored.
 */
export async function subscribeIcsCalendar(
  db: DataDb,
  input: SubscribeIcsCalendarInput,
  deps: IcsDeps = {}
): Promise<CalendarSource> {
  const url = normalizeIcsUrl(input.url)
  if (!url) throw new IcsFeedError('invalid_url')

  const id = icsSourceIdForUrl(url)
  const existing = getCalendarSourceById(db, id)
  if (existing && !existing.archivedAt) return existing

  const now = nowOf(deps)
  const nowIso = now.toISOString()
  const window = expansionWindow(now)
  const result = await readFeed(url, null, window, deps)
  if (!result) throw new IcsFeedError('http_error', 'Unexpected 304 without validators')

  const source = upsertCalendarSource(db, {
    id,
    provider: ICS_CALENDAR_PROVIDER,
    kind: 'calendar',
    accountId: null,
    remoteId: url,
    title: input.title || result.feed.name || new URL(url).hostname,
    timezone: result.feed.timezone,
    color: existing?.color ?? null,
    isPrimary: false,
    isSelected: true,
    isMemryManaged: false,
    syncCursor: null,
    syncStatus: 'ok',
    lastSyncedAt: nowIso,
    lastError: null,
    metadata: null,
    archivedAt: null,
    clock: existing?.clock,
    createdAt: existing?.createdAt ?? nowIso,
    modifiedAt: nowIso
  })
  if (existing) {
    syncCalendarSourceUpdate(id)
  } else {
    syncCalendarSourceCreate(id)
  }

  if (applyFeed(db, id, result.feed, window, nowIso) > 0) {
    emitCalendarProjectionChanged(`ics:${id}`)
  }
  const refreshIntervalMs = clampRefreshInterval(result.feed.refreshIntervalMs)
  statesFor(db).set(id, {
    validators: result.validators,
    refreshIntervalMs,
    nextRefreshAt: now.getTime() + refreshIntervalMs
  })
  emitCalendarChanged({ entityType: 'calendar_source', id })
  log.info('Subscribed to calendar feed', {
    sourceId: id,
    host: new URL(url).hostname,
    events: result.feed.events.length
  })
  return getCalendarSourceById(db, id) ?? source
}

/** Tombstone the subscription (synced) and drop this device's mirrored events. */
export function unsubscribeIcsCalendar(
  db: DataDb,
  sourceId: string,
  deps: IcsDeps = {}
): CalendarSource {
  const source = requireIcsSource(db, sourceId)
  const nowIso = nowOf(deps).toISOString()
  const updated = source.archivedAt
    ? source
    : upsertCalendarSource(db, { ...source, archivedAt: nowIso, modifiedAt: nowIso })
  if (!source.archivedAt) syncCalendarSourceUpdate(sourceId)
  purgeIcsCalendarEvents(db, sourceId)
  emitCalendarChanged({ entityType: 'calendar_source', id: sourceId })
  return updated
}

/**
 * Re-read one feed now. Records the outcome on the source either way, then
 * rethrows a failure so a manual refresh can show why.
 */
export async function refreshIcsCalendarSource(
  db: DataDb,
  sourceId: string,
  deps: IcsDeps = {}
): Promise<CalendarSource> {
  const source = requireIcsSource(db, sourceId)
  const now = nowOf(deps)
  const states = statesFor(db)
  const state = states.get(sourceId)
  const window = expansionWindow(now)

  let result: Awaited<ReturnType<typeof readFeed>>
  try {
    result = await readFeed(source.remoteId, state?.validators ?? null, window, deps)
  } catch (error) {
    if (!(error instanceof IcsFeedError)) throw error
    states.set(sourceId, {
      validators: state?.validators ?? null,
      refreshIntervalMs: state?.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      nextRefreshAt: now.getTime() + MIN_REFRESH_MS
    })
    recordFetchOutcome(db, sourceId, { ok: false, error })
    throw error
  }

  const refreshIntervalMs = result
    ? clampRefreshInterval(result.feed.refreshIntervalMs)
    : (state?.refreshIntervalMs ?? DEFAULT_REFRESH_MS)
  if (result && applyFeed(db, sourceId, result.feed, window, now.toISOString()) > 0) {
    emitCalendarProjectionChanged(`ics:${sourceId}`)
  }
  states.set(sourceId, {
    validators: result ? result.validators : (state?.validators ?? null),
    refreshIntervalMs,
    nextRefreshAt: now.getTime() + refreshIntervalMs
  })
  return recordFetchOutcome(db, sourceId, { ok: true, at: now.toISOString() })
}

/**
 * One runner pass. Converges every ICS source row this device has, including
 * ones another device changed: removed or hidden sources lose their mirrored
 * events, visible ones are re-read once their refresh interval has passed.
 */
export async function refreshDueIcsCalendars(db: DataDb, deps: IcsDeps = {}): Promise<void> {
  const sources = db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.provider, ICS_CALENDAR_PROVIDER))
    .all()
  const states = statesFor(db)
  const nowMs = nowOf(deps).getTime()

  for (const source of sources) {
    if (source.archivedAt || !source.isSelected) {
      purgeIcsCalendarEvents(db, source.id)
      continue
    }
    const state = states.get(source.id)
    if (state && state.nextRefreshAt > nowMs) continue
    try {
      await refreshIcsCalendarSource(db, source.id, deps)
    } catch (error) {
      log.warn('Calendar feed refresh failed', {
        sourceId: source.id,
        code: error instanceof IcsFeedError ? error.code : 'unknown'
      })
    }
  }
}
