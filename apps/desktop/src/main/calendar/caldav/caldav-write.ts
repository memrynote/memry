import { randomUUID } from 'node:crypto'
import { and, eq, isNull, like, or } from 'drizzle-orm'
import { CALDAV_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import { calendarBindings, type CalendarBinding } from '@memry/db-schema/schema/calendar-bindings'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources, type CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import { TaskActivityActors } from '@memry/db-schema/schema/task-activity'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import {
  excludeOccurrence,
  eventToICalendar,
  icalToRemoteEvent,
  patchICalendar
} from '../ical/ical-write'
import type { ICalExpansionWindow } from '../ical/ical-events'
import { ProviderConflictError } from '../provider/errors'
import { isProviderPushEnabled } from '../provider/provider-settings'
import type { WriteRoute } from '../provider/write-routing'
import {
  applyProviderDelete,
  applyProviderWriteback,
  deleteSourceFromProvider,
  findProviderBinding,
  pushSourceToProvider,
  shouldSourceBeOnCalendar,
  type ProviderWriteAdapter
} from '../sync/write-engine'
import type { CalendarSyncTarget } from '../types'
import {
  hasCaldavAuthFailure,
  listCaldavAccountSources,
  transportForAccount,
  type CaldavTransportDeps
} from './caldav-accounts'
import { deleteObject, getObject, putObject, type CaldavObject } from './caldav-client'
import { hrefOfRemoteEventId } from './caldav-mirror'
import type { CaldavTransport } from './caldav-transport'

const log = createLogger('Calendar:CaldavWrite')
const CALDAV = CALDAV_CALENDAR_PROVIDER

/**
 * CalDAV write-back (#1400). Bindings: `provider = 'caldav'`,
 * `remote_calendar_id` = collection URL, `remote_event_id` = object URL (or
 * `<object URL>::<recurrence-id>` for one occurrence of a series),
 * `remote_version` = ETag. The binding's `lastLocalSnapshot.caldavRaw` keeps
 * the object as last written or read, so an update patches it instead of
 * regenerating it.
 */

function recurrenceIdOf(remoteEventId: string): string | null {
  const separator = remoteEventId.indexOf('::')
  return separator === -1 ? null : remoteEventId.slice(separator + 2)
}

/**
 * The stored object a binding points at: its own snapshot first, else the
 * mirror row the event was promoted from.
 */
export function storedObjectFor(db: DataDb, binding: CalendarBinding | undefined): string | null {
  if (!binding) return null
  const snapshot = binding.lastLocalSnapshot as { caldavRaw?: unknown } | null
  if (typeof snapshot?.caldavRaw === 'string') return snapshot.caldavRaw
  const href = hrefOfRemoteEventId(binding.remoteEventId)
  const rows = db
    .select({
      rawPayload: calendarExternalEvents.rawPayload,
      remoteEventId: calendarExternalEvents.remoteEventId
    })
    .from(calendarExternalEvents)
    .where(
      or(
        eq(calendarExternalEvents.remoteEventId, href),
        like(calendarExternalEvents.remoteEventId, `${href}::%`)
      )
    )
    .all()
    .filter((row) => hrefOfRemoteEventId(row.remoteEventId) === href)
  for (const row of rows) {
    const ical = (row.rawPayload as { ical?: unknown } | null)?.ical
    if (typeof ical === 'string') return ical
  }
  return null
}

/**
 * The write adapter for one account. It remembers the newest object it has
 * seen per href, so the conflict loop's retry patches what the server holds
 * now, not the stale copy that caused the 412.
 */
export function createCaldavWriteAdapter(
  transport: CaldavTransport,
  stored: (href: string) => string | null
): ProviderWriteAdapter {
  const fresh = new Map<string, CaldavObject>()

  async function currentObject(href: string): Promise<CaldavObject | null> {
    const cached = fresh.get(href)
    if (cached) return cached
    const fetched = await getObject(href, transport)
    if (fetched) fresh.set(href, fetched)
    return fetched
  }

  return {
    async upsertEvent({ calendarId, eventId, event, ifMatch }) {
      if (!eventId) {
        const uid = randomUUID()
        const href = new URL(`${uid}.ics`, calendarId.endsWith('/') ? calendarId : `${calendarId}/`)
          .href
        const data = eventToICalendar(event, { uid })
        const etag = await putObject(href, data, { create: true }, transport)
        fresh.set(href, { href, etag, data })
        return icalToRemoteEvent(data, { href, calendarId, etag, remoteEventId: href })
      }

      const href = hrefOfRemoteEventId(eventId)
      const recurrenceId = recurrenceIdOf(eventId)
      const cached = fresh.get(href)
      const base = cached?.data ?? stored(href) ?? (await currentObject(href))?.data
      if (!base) throw new ProviderConflictError(CALDAV, 'The calendar object no longer exists')
      const etag = cached?.etag ?? ifMatch ?? null
      const data = patchICalendar(base, event, { recurrenceId })
      const precondition = etag ? { etag } : null
      const nextEtag = precondition
        ? await putObject(href, data, precondition, transport)
        : await putObject(href, data, { etag: '*' }, transport)
      fresh.set(href, { href, etag: nextEtag, data })
      return icalToRemoteEvent(data, {
        href,
        calendarId,
        etag: nextEtag,
        remoteEventId: eventId,
        recurrenceId
      })
    },

    async getEvent({ calendarId, eventId }) {
      const href = hrefOfRemoteEventId(eventId)
      fresh.delete(href)
      const object = await currentObject(href)
      if (!object) throw new ProviderConflictError(CALDAV, 'The calendar object no longer exists')
      return icalToRemoteEvent(object.data, {
        href,
        calendarId,
        etag: object.etag,
        remoteEventId: eventId,
        recurrenceId: recurrenceIdOf(eventId)
      })
    },

    async deleteEvent({ eventId, ifMatch }) {
      const href = hrefOfRemoteEventId(eventId)
      const recurrenceId = recurrenceIdOf(eventId)
      if (recurrenceId) {
        // One occurrence of a series: exclude it, keep the series.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const object =
            attempt === 0 && stored(href) && ifMatch
              ? { href, etag: ifMatch, data: stored(href) as string }
              : await currentObject(href)
          if (!object) return
          try {
            await putObject(
              href,
              excludeOccurrence(object.data, recurrenceId),
              { etag: object.etag ?? '*' },
              transport
            )
            return
          } catch (error) {
            if (!(error instanceof ProviderConflictError) || attempt === 1) throw error
            fresh.delete(href)
          }
        }
        return
      }
      try {
        await deleteObject(href, ifMatch ?? null, transport)
      } catch (error) {
        // Changed remotely since we last saw it; the user deleted it here, so
        // delete what is there now.
        if (!(error instanceof ProviderConflictError)) throw error
        const current = await getObject(href, transport)
        if (current) await deleteObject(href, current.etag, transport)
      }
    }
  }
}

function calendarSourceFor(db: DataDb, remoteCalendarId: string): CalendarSource | null {
  return (
    db
      .select()
      .from(calendarSources)
      .where(
        and(
          eq(calendarSources.provider, CALDAV),
          eq(calendarSources.kind, 'calendar'),
          eq(calendarSources.remoteId, remoteCalendarId),
          isNull(calendarSources.archivedAt)
        )
      )
      .get() ?? null
  )
}

/**
 * The account a write goes through, or null when nothing may be written: the
 * calendar or its account was disconnected (archived), or this device has no
 * usable password. No PUT or DELETE ever leaves without both.
 */
async function writableTransportFor(
  db: DataDb,
  remoteCalendarId: string,
  deps: CaldavTransportDeps
): Promise<CaldavTransport | null> {
  const source = calendarSourceFor(db, remoteCalendarId)
  if (!source?.accountId || hasCaldavAuthFailure(db, source.accountId)) return null
  const account = listCaldavAccountSources(db).find((row) => row.accountId === source.accountId)
  if (!account) return null
  return await transportForAccount(account, deps)
}

/**
 * The CalDAV writer the write router calls (#2372): push or delete one Memry
 * item. The one-way switch (`calendar.caldav.pushEventsToProvider`) turns all
 * of it off.
 */
export async function syncLocalSourceToCaldav(
  db: DataDb,
  target: CalendarSyncTarget,
  route: WriteRoute,
  deps: CaldavTransportDeps = {}
): Promise<CalendarBinding | null> {
  if (!isProviderPushEnabled(db, CALDAV)) return null
  const binding = findProviderBinding(db, CALDAV, target)
  const calendarId = binding?.remoteCalendarId ?? route.remoteCalendarId
  if (!calendarId) return null
  const transport = await writableTransportFor(db, calendarId, deps)
  if (!transport) {
    log.info('Skipping CalDAV write: calendar disconnected or no usable password on this device', {
      sourceType: target.sourceType
    })
    return null
  }
  const adapter = createCaldavWriteAdapter(transport, () => storedObjectFor(db, binding))

  if (shouldSourceBeOnCalendar(db, target)) {
    return await pushSourceToProvider(db, CALDAV, target, {
      adapter,
      calendarId,
      snapshotExtras: (remote) => ({ caldavRaw: (remote.raw as { ical?: string }).ical ?? null }),
      threeWayMerge: true
    })
  }
  await deleteSourceFromProvider(db, CALDAV, target, { adapter, ifMatchOnDelete: true })
  return null
}

function bindingsForObject(db: DataDb, source: CalendarSource, href: string): CalendarBinding[] {
  return db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.provider, CALDAV),
        eq(calendarBindings.remoteCalendarId, source.remoteId),
        isNull(calendarBindings.archivedAt)
      )
    )
    .all()
    .filter((binding) => hrefOfRemoteEventId(binding.remoteEventId) === href)
}

/**
 * During a pull: an object a Memry item is bound to flows back into that
 * item instead of the mirror. Returns the instance ids it handled, so the
 * rest of a series still mirrors; a binding on the whole object handles all
 * of it. Our own writes come back with the ETag we stored and are skipped.
 */
export async function applyBoundCaldavObject(
  db: DataDb,
  source: CalendarSource,
  object: CaldavObject | { href: string; deleted: true },
  _window: ICalExpansionWindow
): Promise<{ all: boolean; handled: Set<string> }> {
  const bindings = bindingsForObject(db, source, object.href)
  const handled = new Set<string>()
  if (bindings.length === 0) return { all: false, handled }

  for (const binding of bindings) {
    handled.add(binding.remoteEventId)
    if ('deleted' in object) {
      await applyProviderDelete(db, CALDAV, binding, { actor: TaskActivityActors.SYNC })
      continue
    }
    if (binding.remoteVersion && binding.remoteVersion === object.etag) continue
    const remote = icalToRemoteEvent(object.data, {
      href: object.href,
      calendarId: source.remoteId,
      etag: object.etag,
      remoteEventId: binding.remoteEventId,
      recurrenceId: recurrenceIdOf(binding.remoteEventId)
    })
    if (remote.status === 'cancelled') {
      await applyProviderDelete(db, CALDAV, binding, { actor: TaskActivityActors.SYNC })
    } else {
      await applyProviderWriteback(db, CALDAV, binding, remote, {
        actor: TaskActivityActors.SYNC,
        snapshotExtras: { caldavRaw: object.data }
      })
    }
  }
  const all = bindings.some((binding) => binding.remoteEventId === object.href)
  return { all, handled }
}
