import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { CalendarService } from '@memry/app-core/calendar'
import type { CalendarSourceRecord } from '@memry/app-core/calendar-types'
import type { IcsFeedErrorCode } from '@memry/contracts/calendar-api'
import { calendarColorHex, CalendarEventColorSchema } from '@memry/contracts/calendar-colors'
import { encodeExternalEventRelationId } from '@memry/contracts/relation-uri'
import {
  calendarBindings,
  calendarEvents,
  calendarExternalEvents,
  calendarSources,
  noteMetadata
} from '@memry/db-schema/data-schema'
import { propertyRefs } from '@memry/db-schema/index-schema'
import type { DataDb, IndexDb } from './database.ts'

export interface CalendarEventSearchItem {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
  kind?: 'external_event'
}

export interface CalendarLinkedNote {
  id: string
  title: string
  emoji: string | null
}

export interface CalendarProviderListing {
  id: string
  connected: boolean
  sourceCount: number
}

export interface CalendarProviderCalendars {
  provider: string
  calendars: Array<{
    id: string
    title: string
    timezone: string | null
    color: string | null
    isPrimary: boolean
  }>
  primary: null
  currentDefaultId: string | null
}

export interface IcsMutationResult {
  success: boolean
  source: CalendarSourceRecord | null
  error?: string
  errorCode?: IcsFeedErrorCode
}

export interface CalendarExtrasService {
  searchEvents(input: {
    query: string
    limit?: number
    includeExternal?: boolean
  }): Promise<{ events: CalendarEventSearchItem[] }>
  linkedNotes(input: {
    sourceType: 'event' | 'external_event'
    sourceId: string
  }): Promise<{ notes: CalendarLinkedNote[] }>
  providers(): Promise<{ providers: CalendarProviderListing[] }>
  providerCalendars(provider: string): Promise<CalendarProviderCalendars>
  setDefaultCalendar(
    provider: string,
    calendarId: string | null,
    markOnboardingComplete?: boolean
  ): Promise<{ success: boolean }>
  refreshProvider(provider: string): Promise<never>
  retrySync(sourceId: string): Promise<never>
  writerCompat(provider: string): Promise<never>
  ics: {
    subscribe(input: { url: string; title?: string }): Promise<IcsMutationResult>
    unsubscribe(sourceId: string): Promise<IcsMutationResult>
    update(input: { sourceId: string; title?: string; color?: string }): Promise<IcsMutationResult>
    refresh(sourceId: string): Promise<never>
  }
}

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const FETCH_TIMEOUT_MS = 30_000
const MAX_FEED_BYTES = 20 * 1024 * 1024

// Provider ids from `@memry/contracts/calendar-api`. That module cannot load under
// Node's type stripping (extension-less imports), so a test pins these to the contract.
export const GOOGLE_CALENDAR_PROVIDER = 'google'
export const CALDAV_CALENDAR_PROVIDER = 'caldav'
export const APPLE_EVENTKIT_CALENDAR_PROVIDER = 'apple-eventkit'
export const ICS_CALENDAR_PROVIDER = 'ics'

// Providers the desktop build knows. `ics` has no account, so it never reads "connected".
const KNOWN_PROVIDERS = [
  GOOGLE_CALENDAR_PROVIDER,
  CALDAV_CALENDAR_PROVIDER,
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  ICS_CALENDAR_PROVIDER
]

const needsDesktop = (what: string): Error =>
  new Error(
    `${what} needs the Memry desktop app: it runs the provider sign-in and network sync. Open Memry and use Settings > Calendar.`
  )

/** Same normalisation as desktop's `normalizeIcsUrl` (calendar/ics/ics-feed.ts). */
export function normalizeIcsUrl(input: string): string | null {
  const rewritten = input.trim().replace(/^webcals?:\/\//i, 'https://')
  let url: URL
  try {
    url = new URL(rewritten)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname) return null
  url.hash = ''
  return url.toString()
}

/** Same id as desktop's `icsSourceIdForUrl`: one URL, one source row on every device. */
export function icsSourceIdForUrl(normalizedUrl: string): string {
  const digest = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 32)
  return `ics-calendar:${digest}`
}

class FeedError extends Error {
  readonly code: IcsFeedErrorCode

  constructor(code: IcsFeedErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

async function readCappedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new FeedError('too_large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function fetchFeed(url: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new FeedError('timeout')
    throw new FeedError('unreachable', error instanceof Error ? error.message : undefined)
  }
  if (response.status === 404 || response.status === 410) {
    throw new FeedError('not_found', `HTTP ${response.status}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new FeedError('unauthorized', `HTTP ${response.status}`)
  }
  if (!response.ok) throw new FeedError('http_error', `HTTP ${response.status}`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_FEED_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new FeedError('too_large')
  }
  const body = await readCappedBody(response)
  if (!/^BEGIN:VCALENDAR/im.test(body)) throw new FeedError('not_a_calendar')
  return body
}

/** The feed's own name (`X-WR-CALNAME` or `NAME`), unfolded, as desktop uses for a default title. */
function feedName(body: string): string | null {
  const unfolded = body.replace(/\r?\n[ \t]/g, '')
  const match = /^(?:X-WR-CALNAME|NAME)(?:;[^:\r\n]*)?:(.+)$/im.exec(unfolded)
  const name = match?.[1]?.trim().replace(/\\,/g, ',').replace(/\\n/gi, ' ')
  return name ? name : null
}

function toSourceRecord(row: typeof calendarSources.$inferSelect): CalendarSourceRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    accountId: row.accountId,
    remoteId: row.remoteId,
    title: row.title,
    timezone: row.timezone,
    color: row.color,
    isPrimary: row.isPrimary,
    isSelected: row.isSelected,
    isMemryManaged: row.isMemryManaged,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
    archivedAt: row.archivedAt
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createCalendarExtrasService({
  dataDb,
  indexDb,
  calendar
}: {
  dataDb: DataDb
  indexDb: IndexDb
  calendar: CalendarService
}): CalendarExtrasService {
  function icsSource(sourceId: string): typeof calendarSources.$inferSelect {
    const source = dataDb
      .select()
      .from(calendarSources)
      .where(eq(calendarSources.id, sourceId))
      .get()
    if (!source || source.provider !== ICS_CALENDAR_PROVIDER) {
      throw new Error(`Subscribed calendar not found: ${sourceId}`)
    }
    return source
  }

  function promotedMirrorIds(eventId: string): string[] {
    return dataDb
      .select({ id: calendarExternalEvents.id })
      .from(calendarBindings)
      .innerJoin(
        calendarSources,
        and(
          eq(calendarSources.provider, calendarBindings.provider),
          eq(calendarSources.remoteId, calendarBindings.remoteCalendarId)
        )
      )
      .innerJoin(
        calendarExternalEvents,
        and(
          eq(calendarExternalEvents.sourceId, calendarSources.id),
          eq(calendarExternalEvents.remoteEventId, calendarBindings.remoteEventId)
        )
      )
      .where(and(eq(calendarBindings.sourceType, 'event'), eq(calendarBindings.sourceId, eventId)))
      .all()
      .map((row) => row.id)
  }

  function incomingRefs(
    targetType: 'event' | 'external-event',
    targetId: string
  ): Array<{ sourceNoteId: string }> {
    return indexDb
      .select({ sourceNoteId: propertyRefs.sourceNoteId })
      .from(propertyRefs)
      .where(and(eq(propertyRefs.targetType, targetType), eq(propertyRefs.targetId, targetId)))
      .all()
  }

  return {
    // Same ranking as desktop's `searchCalendarEventsByTitle`: title substring,
    // upcoming and past each capped at `limit`, ordered by distance from now.
    async searchEvents({ query, limit = DEFAULT_SEARCH_LIMIT, includeExternal = false }) {
      const needle = query.trim().toLowerCase()
      if (!needle) return { events: [] }
      const cap = Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit))
      const nowMs = Date.now()
      const now = new Date(nowMs).toISOString()
      const distance = (startAt: string): number => {
        const parsed = Date.parse(startAt)
        return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : Math.abs(parsed - nowMs)
      }
      const nearest = <T extends { startAt: string }>(rows: T[]): T[] => {
        const upcoming = rows.filter((row) => row.startAt >= now).sort(byStart('asc'))
        const past = rows.filter((row) => row.startAt < now).sort(byStart('desc'))
        return [...upcoming.slice(0, cap), ...past.slice(0, cap)]
          .sort((left, right) => distance(left.startAt) - distance(right.startAt))
          .slice(0, cap)
      }
      function byStart(order: 'asc' | 'desc') {
        return (left: { startAt: string }, right: { startAt: string }) =>
          order === 'asc'
            ? left.startAt.localeCompare(right.startAt)
            : right.startAt.localeCompare(left.startAt)
      }

      const native = nearest(
        dataDb
          .select()
          .from(calendarEvents)
          .orderBy(asc(calendarEvents.startAt))
          .all()
          .filter((row) => !row.archivedAt && row.title.toLowerCase().includes(needle))
      ).map((row): CalendarEventSearchItem => ({
        id: row.id,
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt ?? null,
        isAllDay: row.isAllDay
      }))
      if (!includeExternal) return { events: native }

      const external = nearest(
        dataDb
          .select()
          .from(calendarExternalEvents)
          .orderBy(asc(calendarExternalEvents.startAt))
          .all()
          .filter((row) => !row.archivedAt && row.title.toLowerCase().includes(needle))
      ).map((row): CalendarEventSearchItem => ({
        id: row.id,
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt ?? null,
        isAllDay: row.isAllDay,
        kind: 'external_event'
      }))
      return {
        events: [...native, ...external]
          .sort((left, right) => distance(left.startAt) - distance(right.startAt))
          .slice(0, cap)
      }
    },

    async linkedNotes({ sourceType, sourceId }) {
      const mirrorIds = sourceType === 'event' ? promotedMirrorIds(sourceId) : [sourceId]
      const refs = [
        ...(sourceType === 'event' ? incomingRefs('event', sourceId) : []),
        ...mirrorIds.flatMap((id) =>
          incomingRefs('external-event', encodeExternalEventRelationId(id))
        )
      ]
      const noteIds = [...new Set(refs.map((ref) => ref.sourceNoteId))]
      if (noteIds.length === 0) return { notes: [] }
      const notes = dataDb
        .select({ id: noteMetadata.id, title: noteMetadata.title, emoji: noteMetadata.emoji })
        .from(noteMetadata)
        .where(inArray(noteMetadata.id, noteIds))
        .orderBy(asc(noteMetadata.title))
        .all()
      return { notes }
    },

    async providers() {
      const providers: CalendarProviderListing[] = []
      for (const id of KNOWN_PROVIDERS) {
        const status = await calendar.providerStatus({ provider: id })
        providers.push({ id, connected: status.connected, sourceCount: status.sourceCount })
      }
      return { providers }
    },

    // Reads the calendars this vault already mirrored. Desktop asks the provider
    // live for Google, which needs the account's sign-in.
    async providerCalendars(provider) {
      if (!KNOWN_PROVIDERS.includes(provider))
        throw new Error(`Unknown calendar provider: ${provider}`)
      const { sources } = await calendar.sources.list({ provider, kind: 'calendar' })
      const defaults = await calendar.googleSettings()
      return {
        provider,
        calendars: sources.map((source) => ({
          id: source.remoteId,
          title: source.title,
          timezone: source.timezone,
          color: source.color,
          isPrimary: source.isPrimary
        })),
        primary: null,
        currentDefaultId:
          provider === GOOGLE_CALENDAR_PROVIDER ? defaults.defaultTargetCalendarId : null
      }
    },

    async setDefaultCalendar(provider, calendarId, markOnboardingComplete = true) {
      if (provider !== GOOGLE_CALENDAR_PROVIDER) {
        throw needsDesktop(`Setting the default ${provider} calendar`)
      }
      return calendar.setDefaultGoogleCalendar(calendarId, markOnboardingComplete)
    },

    async refreshProvider(provider) {
      if (!KNOWN_PROVIDERS.includes(provider))
        throw new Error(`Unknown calendar provider: ${provider}`)
      throw needsDesktop(`Refreshing ${provider}`)
    },

    async retrySync(sourceId) {
      const source = dataDb
        .select()
        .from(calendarSources)
        .where(eq(calendarSources.id, sourceId))
        .get()
      if (!source) throw new Error(`Calendar source not found: ${sourceId}`)
      if (source.kind !== 'calendar') {
        throw new Error('Only calendar sources can be retried, not accounts')
      }
      throw needsDesktop('Retrying a calendar sync')
    },

    async writerCompat(provider) {
      if (!KNOWN_PROVIDERS.includes(provider))
        throw new Error(`Unknown calendar provider: ${provider}`)
      throw needsDesktop('The writer compatibility check')
    },

    ics: {
      // Validates the link like desktop does (it must fetch as a calendar) and
      // writes the source row. The desktop's feed runner mirrors the events on
      // its next pass; the CLI has no iCalendar parser.
      async subscribe({ url: rawUrl, title }) {
        const url = normalizeIcsUrl(rawUrl)
        if (!url)
          return { success: false, source: null, errorCode: 'invalid_url', error: 'invalid_url' }
        const id = icsSourceIdForUrl(url)
        const existing = dataDb
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, id))
          .get()
        if (existing && !existing.archivedAt) {
          return { success: true, source: toSourceRecord(existing) }
        }
        let name: string | null
        try {
          name = feedName(await fetchFeed(url))
        } catch (error) {
          if (!(error instanceof FeedError)) throw error
          return { success: false, source: null, errorCode: error.code, error: error.message }
        }
        const time = nowIso()
        const values = {
          id,
          provider: ICS_CALENDAR_PROVIDER,
          kind: 'calendar' as const,
          accountId: null,
          remoteId: url,
          title: title?.trim() || name || new URL(url).hostname,
          timezone: null,
          color: existing?.color ?? null,
          isPrimary: false,
          isSelected: true,
          isMemryManaged: false,
          syncCursor: null,
          syncStatus: 'idle' as const,
          lastSyncedAt: null,
          lastError: null,
          archivedAt: null,
          createdAt: existing?.createdAt ?? time,
          modifiedAt: time
        }
        dataDb
          .insert(calendarSources)
          .values(values)
          .onConflictDoUpdate({ target: calendarSources.id, set: values })
          .run()
        const row = dataDb.select().from(calendarSources).where(eq(calendarSources.id, id)).get()
        return { success: true, source: row ? toSourceRecord(row) : null }
      },

      async unsubscribe(sourceId) {
        const source = icsSource(sourceId)
        const time = nowIso()
        if (!source.archivedAt) {
          dataDb
            .update(calendarSources)
            .set({ archivedAt: time, modifiedAt: time })
            .where(eq(calendarSources.id, sourceId))
            .run()
        }
        dataDb
          .delete(calendarExternalEvents)
          .where(eq(calendarExternalEvents.sourceId, sourceId))
          .run()
        const row = dataDb
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, sourceId))
          .get()
        return { success: true, source: row ? toSourceRecord(row) : null }
      },

      async update({ sourceId, title, color }) {
        const source = icsSource(sourceId)
        if (source.archivedAt) throw new Error(`Subscribed calendar not found: ${sourceId}`)
        const nextTitle = title?.trim() || source.title
        const nextColor = color
          ? calendarColorHex(CalendarEventColorSchema.parse(color))
          : source.color
        if (nextTitle !== source.title || nextColor !== source.color) {
          dataDb
            .update(calendarSources)
            .set({ title: nextTitle, color: nextColor, modifiedAt: nowIso() })
            .where(eq(calendarSources.id, sourceId))
            .run()
        }
        const row = dataDb
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, sourceId))
          .get()
        return { success: true, source: row ? toSourceRecord(row) : null }
      },

      async refresh(sourceId) {
        icsSource(sourceId)
        throw needsDesktop('Refreshing a subscribed calendar')
      }
    }
  }
}
