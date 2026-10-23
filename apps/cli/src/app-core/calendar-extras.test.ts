import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import test from 'node:test'

import { calendarExternalEvents, calendarSources } from '@memry/db-schema/data-schema'
import { noteCache, propertyRefs } from '@memry/db-schema/index-schema'

import { runCli } from '../run.ts'
import {
  APPLE_EVENTKIT_CALENDAR_PROVIDER,
  CALDAV_CALENDAR_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
  ICS_CALENDAR_PROVIDER,
  icsSourceIdForUrl,
  normalizeIcsUrl
} from './calendar-extras.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-calendar-extras')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function run(vaultPath: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function runOk<T>(vaultPath: string, args: string[]): Promise<T> {
  const result = await run(vaultPath, args)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}

function withDatabases<T>(
  vaultPath: string,
  callback: (databases: ReturnType<typeof openDatabases>) => T
): T {
  const databases = openDatabases(vaultPath)
  try {
    return callback(databases)
  } finally {
    databases.close()
  }
}

const now = '2026-05-13T00:00:00.000Z'

function seedSource(
  vaultPath: string,
  values: Partial<typeof calendarSources.$inferInsert> & { id: string }
): void {
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(calendarSources)
      .values({
        provider: 'google',
        kind: 'calendar',
        accountId: 'kaan@example.com',
        remoteId: `remote-${values.id}`,
        title: values.id,
        timezone: 'UTC',
        isSelected: true,
        createdAt: now,
        modifiedAt: now,
        ...values
      })
      .run()
  })
}

function seedExternal(
  vaultPath: string,
  id: string,
  sourceId: string,
  title: string,
  startAt: string
) {
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(calendarExternalEvents)
      .values({
        id,
        sourceId,
        remoteEventId: `remote-${id}`,
        title,
        startAt,
        endAt: null,
        isAllDay: false,
        status: 'confirmed',
        createdAt: now,
        modifiedAt: now
      })
      .run()
  })
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

async function createEvent(vaultPath: string, title: string, startAt: string): Promise<string> {
  const event = await runOk<{ id: string }>(vaultPath, [
    'calendar',
    'events',
    'create',
    title,
    '--start',
    startAt
  ])
  return event.id
}

async function serveFeeds(
  routes: Record<string, { status?: number; body: string }>
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const route = routes[request.url ?? '']
    response.statusCode = route ? (route.status ?? 200) : 404
    response.end(route?.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('provider ids and the feed id derivation match the shared contract', async () => {
  const contract = await fs.readFile(
    path.join(process.cwd(), '../../packages/contracts/src/calendar-api.ts'),
    'utf-8'
  )
  const constant = (name: string) =>
    new RegExp(`export const ${name} = '([^']+)'`).exec(contract)?.[1]
  assert.equal(constant('ICS_CALENDAR_PROVIDER'), ICS_CALENDAR_PROVIDER)
  assert.equal(constant('GOOGLE_CALENDAR_PROVIDER'), GOOGLE_CALENDAR_PROVIDER)
  assert.equal(constant('CALDAV_CALENDAR_PROVIDER'), CALDAV_CALENDAR_PROVIDER)
  assert.equal(constant('APPLE_EVENTKIT_CALENDAR_PROVIDER'), APPLE_EVENTKIT_CALENDAR_PROVIDER)

  assert.equal(normalizeIcsUrl(' webcal://example.com/a.ics#frag '), 'https://example.com/a.ics')
  assert.equal(normalizeIcsUrl('ftp://example.com/a.ics'), null)
  assert.equal(normalizeIcsUrl('not a url'), null)
  const digest = createHash('sha256').update('https://example.com/a.ics').digest('hex').slice(0, 32)
  assert.equal(icsSourceIdForUrl('https://example.com/a.ics'), `ics-calendar:${digest}`)
})

test('calendar events search ranks by distance from now, honors --limit, and can include mirrors', async () => {
  const vault = await makeVault()
  const soon = await createEvent(vault, 'Team Standup', daysFromNow(1))
  const later = await createEvent(vault, 'team offsite', daysFromNow(30))
  const past = await createEvent(vault, 'TEAM retro', daysFromNow(-3))
  await createEvent(vault, 'Dentist', daysFromNow(2))
  seedSource(vault, { id: 'src_google' })
  seedExternal(vault, 'ext_1', 'src_google', 'Team lunch (Google)', daysFromNow(0.5))

  const hits = await runOk<{ events: Array<{ id: string; kind?: string }> }>(vault, [
    'calendar',
    'events',
    'search',
    'TEAM'
  ])
  assert.deepEqual(
    hits.events.map((event) => event.id),
    [soon, past, later]
  )

  const limited = await runOk<{ events: Array<{ id: string }> }>(vault, [
    'calendar',
    'events',
    'search',
    'team',
    '--limit',
    '1'
  ])
  assert.deepEqual(
    limited.events.map((event) => event.id),
    [soon]
  )

  const withExternal = await runOk<{ events: Array<{ id: string; kind?: string }> }>(vault, [
    'calendar',
    'events',
    'search',
    'team',
    '--include-external'
  ])
  assert.equal(withExternal.events[0]?.id, 'ext_1')
  assert.equal(withExternal.events[0]?.kind, 'external_event')

  const none = await runOk<{ events: unknown[] }>(vault, ['calendar', 'events', 'search', 'zzz'])
  assert.deepEqual(none.events, [])
  const missing = await run(vault, ['calendar', 'events', 'search'])
  assert.equal(missing.code, 1)
})

test('calendar linked-notes lists notes whose relation properties point at the event', async () => {
  const vault = await makeVault()
  const eventId = await createEvent(vault, 'Kickoff', daysFromNow(1))
  const linked = await runOk<{ id: string; path: string }>(vault, [
    'notes',
    'create',
    'Kickoff notes'
  ])
  const other = await runOk<{ id: string }>(vault, ['notes', 'create', 'Unrelated'])
  // Relation refs are the desktop indexer's output; the CLI only reads them.
  withDatabases(vault, ({ indexDb }) => {
    indexDb
      .insert(noteCache)
      .values({
        id: linked.id,
        path: linked.path,
        title: 'Kickoff notes',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb
      .insert(propertyRefs)
      .values({
        sourceNoteId: linked.id,
        propertyName: 'Event',
        targetType: 'event',
        targetId: eventId
      })
      .run()
  })

  const result = await runOk<{ notes: Array<{ id: string; title: string }> }>(vault, [
    'calendar',
    'linked-notes',
    eventId
  ])
  assert.deepEqual(
    result.notes.map((note) => note.id),
    [linked.id]
  )
  assert.equal(result.notes[0]?.title, 'Kickoff notes')
  assert.ok(!result.notes.some((note) => note.id === other.id))

  const empty = await runOk<{ notes: unknown[] }>(vault, ['calendar', 'linked-notes', 'nope'])
  assert.deepEqual(empty.notes, [])
})

test('providers, provider-calendars and set-default-calendar read and write the mirrored state', async () => {
  const vault = await makeVault()
  seedSource(vault, { id: 'acct_google', kind: 'account', remoteId: 'kaan@example.com' })
  seedSource(vault, { id: 'cal_work', remoteId: 'work-cal', title: 'Work', isPrimary: true })

  const { providers } = await runOk<{
    providers: Array<{ id: string; connected: boolean; sourceCount: number }>
  }>(vault, ['calendar', 'providers'])
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['google', 'caldav', 'apple-eventkit', 'ics']
  )
  assert.deepEqual(providers[0], { id: 'google', connected: true, sourceCount: 2 })
  assert.equal(providers[1]?.connected, false)

  const calendars = await runOk<{
    provider: string
    calendars: Array<{ id: string; title: string; isPrimary: boolean }>
    currentDefaultId: string | null
  }>(vault, ['calendar', 'provider-calendars', '--provider', 'google'])
  assert.deepEqual(
    calendars.calendars.map((item) => item.id),
    ['work-cal']
  )
  assert.equal(calendars.currentDefaultId, null)

  await runOk(vault, [
    'calendar',
    'set-default-calendar',
    '--provider',
    'google',
    '--calendar',
    'work-cal'
  ])
  const after = await runOk<{ currentDefaultId: string | null }>(vault, [
    'calendar',
    'provider-calendars',
    '--provider',
    'google'
  ])
  assert.equal(after.currentDefaultId, 'work-cal')
  await runOk(vault, ['calendar', 'set-default-calendar', 'null'])
  const cleared = await runOk<{ currentDefaultId: string | null }>(vault, [
    'calendar',
    'provider-calendars',
    '--provider',
    'google'
  ])
  assert.equal(cleared.currentDefaultId, null)

  const unknown = await run(vault, ['calendar', 'provider-calendars', '--provider', 'outlook'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /Unknown calendar provider/)
  const caldav = await run(vault, [
    'calendar',
    'set-default-calendar',
    '--provider',
    'caldav',
    '--calendar',
    'x'
  ])
  assert.equal(caldav.code, 1)
  assert.match(caldav.stderr, /needs the Memry desktop app/)
  const noProvider = await run(vault, ['calendar', 'provider-calendars'])
  assert.equal(noProvider.code, 1)
  assert.match(noProvider.stderr, /Missing --provider/)
})

test('refresh, retry-sync and writer-compat explain that the desktop app does the network work', async () => {
  const vault = await makeVault()
  seedSource(vault, { id: 'acct_google', kind: 'account', remoteId: 'kaan@example.com' })
  seedSource(vault, { id: 'cal_work', remoteId: 'work-cal' })

  for (const args of [
    ['calendar', 'refresh', '--provider', 'google'],
    ['calendar', 'retry-sync', 'cal_work'],
    ['calendar', 'writer-compat', '--provider', 'google']
  ]) {
    const result = await run(vault, args)
    assert.equal(result.code, 1, args.join(' '))
    assert.match(result.stderr, /needs the Memry desktop app/)
  }
  const account = await run(vault, ['calendar', 'retry-sync', 'acct_google'])
  assert.match(account.stderr, /Only calendar sources/)
  const missing = await run(vault, ['calendar', 'retry-sync', 'nope'])
  assert.match(missing.stderr, /not found/)
})

test('ics subscribe validates the feed, is idempotent, updates, and unsubscribe purges mirrored events', async () => {
  const vault = await makeVault()
  const feeds = await serveFeeds({
    '/team.ics': {
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\n Calendar\r\nEND:VCALENDAR\r\n'
    },
    '/plain.html': { body: '<html>nope</html>' },
    '/denied.ics': { status: 403, body: 'no' }
  })
  try {
    const url = `${feeds.origin}/team.ics`
    const subscribed = await runOk<{
      success: boolean
      source: { id: string; title: string; provider: string; isSelected: boolean; remoteId: string }
    }>(vault, ['calendar', 'ics', 'subscribe', url])
    assert.equal(subscribed.source.id, icsSourceIdForUrl(url))
    assert.equal(subscribed.source.provider, 'ics')
    assert.equal(subscribed.source.title, 'TeamCalendar')
    assert.equal(subscribed.source.remoteId, url)
    assert.equal(subscribed.source.isSelected, true)

    const sources = await runOk<{ sources: Array<{ id: string }> }>(vault, [
      'calendar',
      'sources',
      '--provider',
      'ics'
    ])
    assert.deepEqual(
      sources.sources.map((source) => source.id),
      [subscribed.source.id]
    )

    const again = await runOk<{ source: { id: string; title: string } }>(vault, [
      'calendar',
      'ics',
      'subscribe',
      url,
      '--name',
      'Ignored'
    ])
    assert.equal(again.source.id, subscribed.source.id)
    assert.equal(again.source.title, 'TeamCalendar')

    const notCalendar = await run(vault, [
      'calendar',
      'ics',
      'subscribe',
      `${feeds.origin}/plain.html`
    ])
    assert.equal(notCalendar.code, 1)
    assert.match(notCalendar.stderr, /not_a_calendar/)
    const denied = await run(vault, ['calendar', 'ics', 'subscribe', `${feeds.origin}/denied.ics`])
    assert.equal(denied.code, 1)
    assert.match(denied.stderr, /HTTP 403/)
    const invalid = await run(vault, ['calendar', 'ics', 'subscribe', 'ftp://nope'])
    assert.equal(invalid.code, 1)
    assert.match(invalid.stderr, /invalid_url/)

    const renamed = await runOk<{ source: { title: string; color: string } }>(vault, [
      'calendar',
      'ics',
      'update',
      subscribed.source.id,
      '--name',
      'Team',
      '--color',
      'tomato'
    ])
    assert.equal(renamed.source.title, 'Team')
    assert.equal(renamed.source.color, '#d50000')
    const badColor = await run(vault, [
      'calendar',
      'ics',
      'update',
      subscribed.source.id,
      '--color',
      'chartreuse'
    ])
    assert.equal(badColor.code, 1)
    const nothing = await run(vault, ['calendar', 'ics', 'update', subscribed.source.id])
    assert.equal(nothing.code, 1)

    seedExternal(vault, 'ext_ics', subscribed.source.id, 'Mirrored', daysFromNow(1))
    const refused = await run(vault, ['calendar', 'ics', 'unsubscribe', subscribed.source.id])
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /--yes/)
    const removed = await runOk<{ source: { archivedAt: string | null } }>(vault, [
      'calendar',
      'ics',
      'unsubscribe',
      subscribed.source.id,
      '--yes'
    ])
    assert.ok(removed.source.archivedAt)
    const listed = await runOk<{ sources: unknown[] }>(vault, [
      'calendar',
      'sources',
      '--provider',
      'ics'
    ])
    assert.deepEqual(listed.sources, [])
    const mirrors = withDatabases(vault, ({ dataDb }) =>
      dataDb.select().from(calendarExternalEvents).all()
    )
    assert.equal(mirrors.length, 0)

    const restored = await runOk<{ source: { id: string; archivedAt: string | null } }>(vault, [
      'calendar',
      'ics',
      'subscribe',
      url
    ])
    assert.equal(restored.source.id, subscribed.source.id)
    assert.equal(restored.source.archivedAt, null)

    const refresh = await run(vault, ['calendar', 'ics', 'refresh', subscribed.source.id])
    assert.equal(refresh.code, 1)
    assert.match(refresh.stderr, /needs the Memry desktop app/)
    const unknownSource = await run(vault, ['calendar', 'ics', 'refresh', 'nope'])
    assert.match(unknownSource.stderr, /Subscribed calendar not found/)
  } finally {
    await feeds.close()
  }
})
