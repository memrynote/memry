import { calendarMultiGet, calendarQuery, createAccount, davRequest, propfind } from 'tsdav'
import type { DAVResponse } from 'tsdav'
import { CALDAV_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import {
  ProviderAuthError,
  ProviderConflictError,
  ProviderGoneError,
  ProviderRateLimitError,
  ProviderTransientError,
  type ProviderError
} from '../provider/errors'
import type { CaldavTransport } from './caldav-transport'

/**
 * CalDAV operations over `tsdav` (#1399, #1400). `tsdav` builds and parses
 * the WebDAV XML and walks discovery; every request goes through the
 * account's transport, which owns auth, redirects and timeouts. Failures are
 * mapped onto the provider error taxonomy here, so nothing above this file
 * reads an HTTP status.
 */

const PROVIDER = CALDAV_CALENDAR_PROVIDER

export interface CaldavCalendarInfo {
  url: string
  displayName: string
  color: string | null
  timezone: string | null
  ctag: string | null
  syncToken: string | null
  supportsSyncCollection: boolean
}

export interface CaldavAccountInfo {
  serverUrl: string
  principalUrl: string
  homeUrl: string
  calendars: CaldavCalendarInfo[]
}

export interface CaldavObject {
  href: string
  etag: string | null
  data: string
}

export interface CaldavObjectEtag {
  href: string
  etag: string | null
}

function providerErrorForStatus(
  status: number,
  retryAfter: string | null,
  options: { forbiddenIsAuth?: boolean } = {}
): ProviderError | null {
  if (status === 401 || (status === 403 && options.forbiddenIsAuth !== false)) {
    return new ProviderAuthError(PROVIDER, `CalDAV server refused the credentials (${status})`, {
      status
    })
  }
  if (status === 412) return new ProviderConflictError(PROVIDER)
  if (status === 429 || status === 503) {
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN
    if (status === 429 || Number.isFinite(seconds)) {
      return new ProviderRateLimitError(
        PROVIDER,
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000
      )
    }
  }
  if (status >= 500) return new ProviderTransientError(PROVIDER, `CalDAV server error (${status})`)
  return null
}

/** Map a failed request onto the taxonomy, or null for "not a provider failure". */
export function classifyCaldavFailure(
  error: unknown,
  transport: CaldavTransport
): ProviderError | null {
  if (error instanceof ProviderAuthError || error instanceof ProviderGoneError) return error
  if (
    error instanceof ProviderConflictError ||
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderTransientError
  ) {
    return error
  }
  const status = transport.lastFailure()
  if (status) {
    const mapped = providerErrorForStatus(status.status, status.retryAfter)
    if (mapped) return mapped
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ProviderTransientError(PROVIDER, 'CalDAV server did not respond in time')
  }
  if (error instanceof TypeError) {
    return new ProviderTransientError(PROVIDER, 'Could not reach the CalDAV server', {
      cause: error
    })
  }
  return null
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    const record = value as { _cdata?: unknown; _text?: unknown }
    if (typeof record._cdata === 'string') return record._cdata
    if (typeof record._text === 'string') return record._text
  }
  return null
}

/** `#RRGGBBAA` (Apple) and `#RRGGBB` both become `#rrggbb`; anything else is dropped. */
function normalizeColor(value: unknown): string | null {
  const text = textOf(value)?.trim()
  if (!text) return null
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text)
  return match ? `#${match[1].toLowerCase()}` : null
}

function componentNames(comp: unknown): string[] {
  const list = Array.isArray(comp) ? comp : comp ? [comp] : []
  return list
    .map((entry) => (entry as { _attributes?: { name?: unknown } })?._attributes?.name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.toUpperCase())
}

function reportNames(value: unknown): string[] {
  const supported = (value as { supportedReport?: unknown } | undefined)?.supportedReport
  const list = Array.isArray(supported) ? supported : supported ? [supported] : []
  return list.flatMap((entry) => {
    const report = (entry as { report?: Record<string, unknown> })?.report
    return report ? Object.keys(report) : []
  })
}

function resolveHref(href: string, base: string): string {
  return new URL(href, base).href
}

function ensureOk(responses: DAVResponse[], what: string): void {
  const failed = responses.find((response) => !response.ok && response.status !== 404)
  if (failed) throw new Error(`${what} failed: ${failed.status ?? 'unknown'}`)
}

/**
 * Discovery: `/.well-known/caldav` → `current-user-principal` →
 * `calendar-home-set` → collections. Hosts come from the server's answers,
 * never from a hardcoded list; the transport decides where credentials go.
 * Collections that cannot hold events (VTODO-only task lists) are skipped.
 */
export async function discoverCaldavAccount(
  serverUrl: string,
  transport: CaldavTransport
): Promise<CaldavAccountInfo> {
  const account = await createAccount({
    account: { serverUrl, accountType: 'caldav' },
    fetch: transport.fetch
  })
  if (!account.principalUrl || !account.homeUrl) {
    throw new Error('CalDAV discovery found no calendar home')
  }

  const responses = await propfind({
    url: account.homeUrl,
    props: {
      'd:displayname': {},
      'd:resourcetype': {},
      'cs:getctag': {},
      'd:sync-token': {},
      'ca:calendar-color': {},
      'c:calendar-timezone': {},
      'c:supported-calendar-component-set': {},
      'd:supported-report-set': {}
    },
    depth: '1',
    fetch: transport.fetch
  })
  ensureOk(responses, 'Calendar listing')

  const calendars: CaldavCalendarInfo[] = []
  for (const response of responses) {
    const props = (response.props ?? {}) as Record<string, unknown>
    const resourceTypes = Object.keys((props.resourcetype as Record<string, unknown>) ?? {})
    if (!resourceTypes.includes('calendar') || !response.href) continue
    const components = componentNames(
      (props.supportedCalendarComponentSet as { comp?: unknown } | undefined)?.comp
    )
    if (components.length > 0 && !components.includes('VEVENT')) continue
    const url = resolveHref(response.href, account.homeUrl)
    const reports = reportNames(props.supportedReportSet)
    calendars.push({
      url,
      displayName:
        textOf(props.displayname)?.trim() ||
        new URL(url).pathname.split('/').filter(Boolean).at(-1) ||
        url,
      color: normalizeColor(props.calendarColor),
      timezone: extractTimezoneId(textOf(props.calendarTimezone)),
      ctag: textOf(props.getctag),
      syncToken: textOf(props.syncToken),
      supportsSyncCollection: reports.includes('syncCollection') || textOf(props.syncToken) !== null
    })
  }

  return {
    serverUrl,
    principalUrl: account.principalUrl,
    homeUrl: account.homeUrl,
    calendars
  }
}

/** `calendar-timezone` is a whole VCALENDAR; only its TZID is useful here. */
function extractTimezoneId(vcalendar: string | null): string | null {
  if (!vcalendar) return null
  const match = /^TZID:(.+)$/im.exec(vcalendar)
  return match ? match[1].trim() : null
}

function isObjectHref(href: string, collectionUrl: string): boolean {
  const resolved = resolveHref(href, collectionUrl)
  return resolved !== collectionUrl && !resolved.endsWith('/')
}

function objectsFrom(responses: DAVResponse[], collectionUrl: string): CaldavObject[] {
  const objects: CaldavObject[] = []
  for (const response of responses) {
    if (!response.href || !response.ok) continue
    const props = (response.props ?? {}) as Record<string, unknown>
    const data = textOf(props.calendarData)
    if (!data) continue
    objects.push({
      href: resolveHref(response.href, collectionUrl),
      etag: textOf(props.getetag),
      data
    })
  }
  return objects
}

/**
 * The collection's objects whose events touch `window`, with data. Used for
 * the first pull: `sync-collection` has no time-range filter, so starting from
 * it would download a calendar's whole history just to throw most away.
 */
export async function queryObjectsInWindow(
  collectionUrl: string,
  window: { startAt: string; endAt: string },
  transport: CaldavTransport
): Promise<CaldavObject[]> {
  const toCaldavTime = (iso: string): string =>
    `${iso
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
      .slice(0, 15)}Z`
  const responses = await calendarQuery({
    url: collectionUrl,
    props: { 'd:getetag': {}, 'c:calendar-data': {} },
    filters: {
      'comp-filter': {
        _attributes: { name: 'VCALENDAR' },
        'comp-filter': {
          _attributes: { name: 'VEVENT' },
          'time-range': {
            _attributes: { start: toCaldavTime(window.startAt), end: toCaldavTime(window.endAt) }
          }
        }
      }
    },
    depth: '1',
    fetch: transport.fetch
  })
  return objectsFrom(responses, collectionUrl)
}

/** `calendar-multiget` for exactly these objects. */
export async function fetchObjects(
  collectionUrl: string,
  hrefs: string[],
  transport: CaldavTransport
): Promise<CaldavObject[]> {
  if (hrefs.length === 0) return []
  const objects: CaldavObject[] = []
  // Servers cap multiget sizes; 100 per request stays inside every limit seen.
  for (let offset = 0; offset < hrefs.length; offset += 100) {
    const batch = hrefs.slice(offset, offset + 100).map((href) => new URL(href).pathname)
    const responses = await calendarMultiGet({
      url: collectionUrl,
      props: { 'd:getetag': {}, 'c:calendar-data': {} },
      objectUrls: batch,
      depth: '1',
      fetch: transport.fetch
    })
    objects.push(...objectsFrom(responses, collectionUrl))
  }
  return objects
}

/** Every object's href and ETag, without data (the ctag fallback's diff input). */
export async function listObjectEtags(
  collectionUrl: string,
  transport: CaldavTransport
): Promise<CaldavObjectEtag[]> {
  const responses = await propfind({
    url: collectionUrl,
    props: { 'd:getetag': {} },
    depth: '1',
    fetch: transport.fetch
  })
  ensureOk(responses, 'Object listing')
  return responses
    .filter((response) => response.href && isObjectHref(response.href, collectionUrl))
    .map((response) => ({
      href: resolveHref(response.href as string, collectionUrl),
      etag: textOf((response.props as Record<string, unknown> | undefined)?.getetag)
    }))
}

/** The collection's current ctag, or null when the server does not publish one. */
export async function fetchCollectionCtag(
  collectionUrl: string,
  transport: CaldavTransport
): Promise<string | null> {
  const responses = await propfind({
    url: collectionUrl,
    props: { 'cs:getctag': {}, 'd:sync-token': {} },
    depth: '0',
    fetch: transport.fetch
  })
  ensureOk(responses, 'Collection check')
  const props = (responses[0]?.props ?? {}) as Record<string, unknown>
  return textOf(props.getctag) ?? textOf(props.syncToken)
}

export interface SyncCollectionResult {
  changed: CaldavObjectEtag[]
  deleted: string[]
  syncToken: string | null
}

/**
 * RFC 6578 `sync-collection`. An empty token lists everything and returns
 * the current token. A token the server no longer accepts (the
 * `valid-sync-token` precondition) is `ProviderGoneError`: clear the cursor
 * and pull in full.
 */
export async function syncCollectionChanges(
  collectionUrl: string,
  syncToken: string,
  transport: CaldavTransport
): Promise<SyncCollectionResult> {
  const responses = await davRequest({
    url: collectionUrl,
    init: {
      method: 'REPORT',
      namespace: 'd',
      headers: { depth: '1' },
      body: {
        'sync-collection': {
          _attributes: { 'xmlns:d': 'DAV:', 'xmlns:c': 'urn:ietf:params:xml:ns:caldav' },
          'sync-token': syncToken,
          'sync-level': 1,
          prop: { 'd:getetag': {} }
        }
      }
    },
    fetch: transport.fetch
  })

  const first = responses[0]
  const raw = typeof first?.raw === 'string' ? first.raw : JSON.stringify(first?.raw ?? '')
  if (
    first &&
    !first.ok &&
    (first.status === 403 || first.status === 409 || first.status === 400)
  ) {
    if (/valid-sync-token/i.test(raw)) {
      throw new ProviderGoneError(PROVIDER, 'CalDAV sync token is no longer valid')
    }
  }
  if (first && !first.ok && !first.href?.length && first.status !== 207) {
    const mapped = providerErrorForStatus(first.status ?? 0, null)
    if (mapped) throw mapped
    throw new Error(`sync-collection failed: ${first.status}`)
  }

  const multistatus = (first?.raw as { multistatus?: { syncToken?: unknown } } | undefined)
    ?.multistatus
  const changed: CaldavObjectEtag[] = []
  const deleted: string[] = []
  for (const response of responses) {
    if (!response.href || !isObjectHref(response.href, collectionUrl)) continue
    const href = resolveHref(response.href, collectionUrl)
    if (response.status === 404) {
      deleted.push(href)
    } else if (response.ok) {
      changed.push({
        href,
        etag: textOf((response.props as Record<string, unknown> | undefined)?.getetag)
      })
    }
  }
  return { changed, deleted, syncToken: textOf(multistatus?.syncToken) }
}

/** GET one object with its ETag. */
export async function getObject(
  href: string,
  transport: CaldavTransport
): Promise<CaldavObject | null> {
  const response = await transport.fetch(href, { method: 'GET' })
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) {
    throw (
      providerErrorForStatus(response.status, response.headers.get('retry-after')) ??
      new Error(`GET object failed: ${response.status}`)
    )
  }
  return { href, etag: response.headers.get('etag'), data: await response.text() }
}

/**
 * PUT an object. A create sends `If-None-Match: *`, an update `If-Match` with
 * the ETag the change was based on; either precondition failing is
 * `ProviderConflictError` (HTTP 412). Returns the new ETag when the server
 * sends one (some do not, and then the next sync reads it).
 */
export async function putObject(
  href: string,
  data: string,
  precondition: { create: true } | { etag: string },
  transport: CaldavTransport
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' }
  if ('create' in precondition) headers['If-None-Match'] = '*'
  else headers['If-Match'] = precondition.etag
  const response = await transport.fetch(href, { method: 'PUT', headers, body: data })
  await response.body?.cancel()
  if (!response.ok) {
    // A 403 on a write means this calendar does not accept it (a read-only
    // shared calendar), not that the password stopped working.
    throw (
      providerErrorForStatus(response.status, response.headers.get('retry-after'), {
        forbiddenIsAuth: false
      }) ?? new Error(`PUT object failed: ${response.status}`)
    )
  }
  return response.headers.get('etag')
}

/** DELETE an object with `If-Match`. An object that is already gone counts as deleted. */
export async function deleteObject(
  href: string,
  etag: string | null,
  transport: CaldavTransport
): Promise<void> {
  const response = await transport.fetch(href, {
    method: 'DELETE',
    headers: etag ? { 'If-Match': etag } : {}
  })
  await response.body?.cancel()
  if (response.ok || response.status === 404 || response.status === 410) return
  throw (
    providerErrorForStatus(response.status, response.headers.get('retry-after'), {
      forbiddenIsAuth: false
    }) ?? new Error(`DELETE object failed: ${response.status}`)
  )
}
