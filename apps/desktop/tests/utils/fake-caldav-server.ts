/**
 * An in-memory CalDAV server behind a `fetch` function, for adapter tests.
 * It answers the requests the CalDAV client makes with the XML real servers
 * send (recorded from Radicale and iCloud, trimmed to what the client reads):
 * well-known discovery with an optional cross-host redirect, principal and
 * home-set lookups, collection listing, `sync-collection` with tokens that
 * can be invalidated, `calendar-query`, `calendar-multiget`, and object
 * GET/PUT/DELETE with ETag preconditions.
 */
import { randomUUID } from 'node:crypto'

export interface FakeCalendar {
  path: string
  displayName: string
  color?: string
  components?: string[]
  supportsSyncCollection?: boolean
}

export interface RecordedRequest {
  method: string
  url: string
  authorization: string | null
  headers: Record<string, string>
  body: string
}

interface StoredObject {
  data: string
  etag: string
}

interface Change {
  token: number
  path: string
  deleted: boolean
}

export interface FakeCaldavServerOptions {
  /** The host the user types, e.g. `caldav.icloud.com`. */
  host: string
  /** When set, `/.well-known/caldav` and the principal live on this host (iCloud's partition hosts). */
  partitionHost?: string
  username: string
  password: string
  calendars: FakeCalendar[]
  /** A host the well-known redirect points to instead (to test credential leaks). */
  wellKnownRedirectHost?: string
  /** Offer only Digest authentication. */
  digestOnly?: boolean
  /**
   * Answer PUTs without an ETag and store the object slightly rewritten, as a
   * server that normalises what it stores does (RFC 4791 §5.3.4).
   */
  rewritesOnPut?: boolean
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const NS =
  'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/"'

function multistatus(responses: string[], extra = ''): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${responses.join('')}${extra}</d:multistatus>`,
    { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } }
  )
}

function propResponse(href: string, props: string): string {
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

export class FakeCaldavServer {
  readonly requests: RecordedRequest[] = []
  private readonly objects = new Map<string, Map<string, StoredObject>>()
  private readonly changes = new Map<string, Change[]>()
  private readonly ctags = new Map<string, number>()
  private tokenCounter = 1
  private etagCounter = 1
  private invalidTokensBefore = 0
  private acceptedPassword: string
  /** Paths whose next PUT fails with 412 after the stored object is swapped (a concurrent edit). */
  private readonly racePuts = new Map<string, string>()

  constructor(readonly options: FakeCaldavServerOptions) {
    this.acceptedPassword = options.password
    for (const calendar of options.calendars) {
      this.objects.set(calendar.path, new Map())
      this.changes.set(calendar.path, [])
      this.ctags.set(calendar.path, 1)
    }
  }

  get dataHost(): string {
    return this.options.partitionHost ?? this.options.host
  }

  get principalPath(): string {
    return `/${this.options.username}/`
  }

  collectionUrl(path: string): string {
    return `https://${this.dataHost}${path}`
  }

  objectUrl(calendarPath: string, name: string): string {
    return `https://${this.dataHost}${calendarPath}${name}`
  }

  /** Revoke the password, as resetting an Apple ID does to app passwords. */
  revokePassword(): void {
    this.acceptedPassword = `revoked-${randomUUID()}`
  }

  /** Every token issued so far stops being valid. */
  invalidateSyncTokens(): void {
    this.invalidTokensBefore = this.tokenCounter + 1
  }

  putObject(calendarPath: string, name: string, data: string): string {
    const etag = `"e${this.etagCounter++}"`
    this.objects.get(calendarPath)?.set(name, { data, etag })
    this.recordChange(calendarPath, name, false)
    return etag
  }

  deleteObject(calendarPath: string, name: string): void {
    this.objects.get(calendarPath)?.delete(name)
    this.recordChange(calendarPath, name, true)
  }

  getObject(calendarPath: string, name: string): StoredObject | undefined {
    return this.objects.get(calendarPath)?.get(name)
  }

  listObjectNames(calendarPath: string): string[] {
    return [...(this.objects.get(calendarPath)?.keys() ?? [])]
  }

  /** The next PUT to this object first sees the remote replaced with `data`. */
  raceNextPut(calendarPath: string, name: string, data: string): void {
    this.racePuts.set(`${calendarPath}${name}`, data)
  }

  private recordChange(calendarPath: string, name: string, deleted: boolean): void {
    this.tokenCounter += 1
    this.changes.get(calendarPath)?.push({ token: this.tokenCounter, path: name, deleted })
    this.ctags.set(calendarPath, (this.ctags.get(calendarPath) ?? 0) + 1)
  }

  private syncTokenUrl(value: number): string {
    return `http://fake.caldav/sync/${value}`
  }

  private authorized(request: RecordedRequest): boolean {
    const header = request.authorization
    if (!header) return false
    if (header.startsWith('Basic ')) {
      if (this.options.digestOnly) return false
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
      return decoded === `${this.options.username}:${this.acceptedPassword}`
    }
    if (header.startsWith('Digest ')) {
      return (
        header.includes(`username="${this.options.username}"`) &&
        this.acceptedPassword === this.options.password
      )
    }
    return false
  }

  private unauthorized(): Response {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'www-authenticate': this.options.digestOnly
          ? 'Digest realm="fake", nonce="abc123", qop="auth", algorithm=MD5'
          : 'Basic realm="fake"'
      }
    })
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const headers = new Headers(init.headers)
    const record: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: url.href,
      authorization: headers.get('authorization'),
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === 'string' ? init.body : ''
    }
    this.requests.push(record)

    if (url.hostname === this.options.wellKnownRedirectHost) {
      return new Response('', { status: 404 })
    }
    if (url.hostname !== this.options.host && url.hostname !== this.dataHost) {
      return new Response('', { status: 404 })
    }

    if (url.pathname === '/.well-known/caldav') {
      const target = this.options.wellKnownRedirectHost
        ? `https://${this.options.wellKnownRedirectHost}/`
        : `https://${this.dataHost}/`
      return new Response('', { status: 301, headers: { location: target } })
    }

    if (!this.authorized(record)) return this.unauthorized()

    if (record.method === 'PROPFIND') return this.propfind(url, record)
    if (record.method === 'REPORT') return this.report(url, record)
    return this.objectRequest(url, record)
  }

  private propfind(url: URL, record: RecordedRequest): Response {
    const path = url.pathname
    if (record.body.includes('current-user-principal')) {
      return multistatus([
        propResponse(
          path,
          `<d:current-user-principal><d:href>${this.principalPath}</d:href></d:current-user-principal>`
        )
      ])
    }
    if (record.body.includes('calendar-home-set')) {
      return multistatus([
        propResponse(
          path,
          `<c:calendar-home-set><d:href>https://${this.dataHost}${this.principalPath}</d:href></c:calendar-home-set>`
        )
      ])
    }
    const depth = record.headers.depth
    const calendar = this.options.calendars.find((candidate) => candidate.path === path)
    if (calendar && depth === '1') {
      const items = [...(this.objects.get(path)?.entries() ?? [])].map(([name, object]) =>
        propResponse(`${path}${name}`, `<d:getetag>${escapeXml(object.etag)}</d:getetag>`)
      )
      return multistatus([
        propResponse(path, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'),
        ...items
      ])
    }
    if (calendar) {
      return multistatus([
        propResponse(
          path,
          `<cs:getctag>${this.ctags.get(path)}</cs:getctag>${calendar.supportsSyncCollection === false ? '' : `<d:sync-token>${this.syncTokenUrl(this.tokenCounter)}</d:sync-token>`}`
        )
      ])
    }
    if (path === this.principalPath) {
      const collections = this.options.calendars.map((cal) => {
        const components = (cal.components ?? ['VEVENT'])
          .map((name) => `<c:comp name="${name}"/>`)
          .join('')
        const reports =
          cal.supportsSyncCollection === false
            ? '<d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>'
            : '<d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>'
        return propResponse(
          cal.path,
          `<d:displayname>${escapeXml(cal.displayName)}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><cs:getctag>${this.ctags.get(cal.path)}</cs:getctag>${cal.color ? `<ca:calendar-color>${cal.color}</ca:calendar-color>` : ''}<c:supported-calendar-component-set>${components}</c:supported-calendar-component-set><d:supported-report-set>${reports}</d:supported-report-set>${cal.supportsSyncCollection === false ? '' : `<d:sync-token>${this.syncTokenUrl(this.tokenCounter)}</d:sync-token>`}`
        )
      })
      return multistatus([
        propResponse(path, '<d:resourcetype><d:collection/></d:resourcetype>'),
        ...collections
      ])
    }
    return new Response('', { status: 404 })
  }

  private report(url: URL, record: RecordedRequest): Response {
    const path = url.pathname
    const calendar = this.options.calendars.find((candidate) => candidate.path === path)
    if (!calendar) return new Response('', { status: 404 })
    const objects = this.objects.get(path) ?? new Map()

    if (record.body.includes('sync-collection')) {
      if (calendar.supportsSyncCollection === false) return new Response('', { status: 501 })
      const match = /<d:sync-token>([^<]*)<\/d:sync-token>/.exec(record.body)
      const token = match?.[1] ?? ''
      const since = token ? Number(token.split('/').at(-1)) : 0
      if (token && (!Number.isFinite(since) || since < this.invalidTokensBefore)) {
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`,
          { status: 403, headers: { 'content-type': 'application/xml' } }
        )
      }
      const latest = new Map<string, Change>()
      for (const change of this.changes.get(path) ?? []) {
        if (change.token > since) latest.set(change.path, change)
      }
      const names = token ? [...latest.keys()] : [...objects.keys()]
      const responses = names.map((name) => {
        const object = objects.get(name)
        if (!object) {
          return `<d:response><d:href>${escapeXml(`${path}${name}`)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
        }
        return propResponse(`${path}${name}`, `<d:getetag>${escapeXml(object.etag)}</d:getetag>`)
      })
      return multistatus(
        responses,
        `<d:sync-token>${this.syncTokenUrl(this.tokenCounter)}</d:sync-token>`
      )
    }

    const withData = (name: string, object: StoredObject): string =>
      propResponse(
        `${path}${name}`,
        `<d:getetag>${escapeXml(object.etag)}</d:getetag><c:calendar-data>${escapeXml(object.data)}</c:calendar-data>`
      )

    if (record.body.includes('calendar-multiget')) {
      const hrefs = [...record.body.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => m[1])
      return multistatus(
        hrefs.flatMap((href) => {
          const name = decodeURIComponent(href).slice(path.length)
          const object = objects.get(name)
          return object ? [withData(name, object)] : []
        })
      )
    }

    if (record.body.includes('calendar-query')) {
      // A time-range filter, roughly: a series always matches, a single event
      // when its DTSTART falls inside the range.
      const range = /time-range[^>]*start="(\d{8}T\d{6}Z)"[^>]*end="(\d{8}T\d{6}Z)"/.exec(
        record.body
      )
      const inRange = ([, object]: [string, StoredObject]): boolean => {
        if (!range || object.data.includes('RRULE:')) return true
        const start = /DTSTART[^:\r\n]*:(\d{8}(?:T\d{6}Z?)?)/.exec(object.data)?.[1]
        if (!start) return true
        const compact = start.length === 8 ? `${start}T000000Z` : start.replace(/Z?$/, 'Z')
        return compact >= range[1] && compact < range[2]
      }
      return multistatus(
        [...objects.entries()].filter(inRange).map(([name, object]) => withData(name, object))
      )
    }
    return new Response('', { status: 400 })
  }

  private objectRequest(url: URL, record: RecordedRequest): Response {
    const calendar = this.options.calendars.find((candidate) =>
      url.pathname.startsWith(candidate.path)
    )
    if (!calendar) return new Response('', { status: 404 })
    const name = url.pathname.slice(calendar.path.length)
    const existing = this.objects.get(calendar.path)?.get(name)

    if (record.method === 'GET') {
      if (!existing) return new Response('', { status: 404 })
      return new Response(existing.data, {
        status: 200,
        headers: { etag: existing.etag, 'content-type': 'text/calendar' }
      })
    }

    if (record.method === 'PUT') {
      const raced = this.racePuts.get(url.pathname)
      if (raced !== undefined) {
        this.racePuts.delete(url.pathname)
        this.putObject(calendar.path, name, raced)
        return new Response('', { status: 412 })
      }
      const ifMatch = record.headers['if-match']
      const ifNoneMatch = record.headers['if-none-match']
      if (ifNoneMatch === '*' && existing) return new Response('', { status: 412 })
      if (ifMatch && (!existing || existing.etag !== ifMatch))
        return new Response('', { status: 412 })
      if (this.options.rewritesOnPut) {
        this.putObject(
          calendar.path,
          name,
          record.body.replace('END:VEVENT', 'X-SERVER-NORMALISED:1\r\nEND:VEVENT')
        )
        return new Response(existing ? null : '', { status: existing ? 204 : 201 })
      }
      const etag = this.putObject(calendar.path, name, record.body)
      return new Response(existing ? null : '', { status: existing ? 204 : 201, headers: { etag } })
    }

    if (record.method === 'DELETE') {
      if (!existing) return new Response('', { status: 404 })
      const ifMatch = record.headers['if-match']
      if (ifMatch && existing.etag !== ifMatch) return new Response('', { status: 412 })
      this.deleteObject(calendar.path, name)
      return new Response(null, { status: 204 })
    }
    return new Response('', { status: 405 })
  }
}

export function vevent(input: {
  uid: string
  summary: string
  start: string
  end?: string
  rrule?: string
  extra?: string[]
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fake//CalDAV//EN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    'DTSTAMP:20260901T000000Z',
    `DTSTART:${input.start}`,
    ...(input.end ? [`DTEND:${input.end}`] : []),
    ...(input.rrule ? [`RRULE:${input.rrule}`] : []),
    `SUMMARY:${input.summary}`,
    ...(input.extra ?? []),
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n')
}
