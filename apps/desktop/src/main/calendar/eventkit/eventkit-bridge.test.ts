import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEventKitBridge } from './eventkit-bridge'
import type { EventKitBridge } from './eventkit-types'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

/**
 * A stand-in for `memry-eventkit` that speaks the same line protocol. It runs
 * on every OS, so the client is tested without EventKit or a Mac.
 */
const FAKE_HELPER = String.raw`
const readline = require('node:readline')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
send({ event: 'ready', protocol: 1 })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  switch (method) {
    case 'authorizationStatus':
      return send({ id, result: 'full_access' })
    case 'requestFullAccess':
      return send({ id, result: 'surprise' })
    case 'listCalendars':
      return send({ id, result: [
        { id: 'cal-1', title: 'Work', color: '#ff0000', type: 'caldav', allowsModifications: true,
          sourceId: 'src-1', sourceTitle: 'me@example.com', sourceType: 'caldav' },
        { title: 'no id, dropped' }
      ] })
    case 'listEvents':
      if (params.calendarIds[0] === 'locked') {
        return send({ id, error: { code: 'not_authorized', message: 'denied' } })
      }
      return send({ id, result: [
        { calendarId: params.calendarIds[0], title: 'Stand-up', isAllDay: false,
          start: params.start, end: params.end, status: 'confirmed', availability: 'busy',
          externalId: 'ext-1', eventId: 'evt-1' }
      ] })
    default:
      return send({ id, error: { code: 'unknown_method', message: method } })
  }
})
`

describe('EventKit bridge client (#1405)', () => {
  let dir: string
  let fakePath: string
  const bridges: EventKitBridge[] = []

  function bridge(): EventKitBridge {
    const created = createEventKitBridge({ command: process.execPath, args: [fakePath] })
    bridges.push(created)
    return created
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'memry-eventkit-fake-'))
    fakePath = path.join(dir, 'fake-helper.cjs')
    writeFileSync(fakePath, FAKE_HELPER)
  })

  afterEach(() => {
    for (const created of bridges.splice(0)) created.dispose()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the authorization status and maps an unknown answer to denied', async () => {
    const client = bridge()
    await expect(client.authorizationStatus()).resolves.toBe('full_access')
    await expect(client.requestFullAccess()).resolves.toBe('denied')
  })

  it('normalizes calendars and drops entries without an id', async () => {
    await expect(bridge().listCalendars()).resolves.toEqual([
      {
        id: 'cal-1',
        title: 'Work',
        color: '#ff0000',
        type: 'caldav',
        allowsModifications: true,
        sourceId: 'src-1',
        sourceTitle: 'me@example.com',
        sourceType: 'caldav'
      }
    ])
  })

  it('passes the window through and fills every missing event field with null', async () => {
    const events = await bridge().listEvents({
      calendarIds: ['cal-1'],
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-02-01T00:00:00.000Z'
    })
    expect(events).toEqual([
      {
        calendarId: 'cal-1',
        eventId: 'evt-1',
        externalId: 'ext-1',
        title: 'Stand-up',
        location: null,
        notes: null,
        url: null,
        isAllDay: false,
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-02-01T00:00:00.000Z',
        timeZone: null,
        startDate: null,
        lastDate: null,
        status: 'confirmed',
        availability: 'busy',
        isRecurring: false,
        lastModified: null,
        occurrenceStart: null,
        attendees: [],
        organizer: null,
        alarmMinutes: [],
        recurrenceRule: null
      }
    ])
  })

  it('reads nothing, and starts no helper, for an empty calendar list', async () => {
    const client = createEventKitBridge({ command: path.join(dir, 'does-not-exist') })
    bridges.push(client)
    await expect(
      client.listEvents({
        calendarIds: [],
        start: '2026-01-01T00:00:00Z',
        end: '2026-02-01T00:00:00Z'
      })
    ).resolves.toEqual([])
  })

  it('surfaces a helper error with its code', async () => {
    await expect(
      bridge().listEvents({
        calendarIds: ['locked'],
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-02-01T00:00:00.000Z'
      })
    ).rejects.toMatchObject({ name: 'EventKitBridgeError', code: 'not_authorized' })
  })

  it('reports a helper that cannot start as helper_unavailable', async () => {
    const client = createEventKitBridge({ command: path.join(dir, 'does-not-exist') })
    bridges.push(client)
    await expect(client.authorizationStatus()).rejects.toMatchObject({
      code: 'helper_unavailable'
    })
  })

  it('times out a request the helper never answers', async () => {
    const stalled = createEventKitBridge({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      requestTimeoutMs: 50
    })
    bridges.push(stalled)
    await expect(stalled.listCalendars()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects pending calls when the helper exits and respawns on the next call', async () => {
    const crashing = createEventKitBridge({
      command: process.execPath,
      args: ['-e', 'process.stdin.once("data", () => process.exit(3))']
    })
    bridges.push(crashing)
    await expect(crashing.authorizationStatus()).rejects.toMatchObject({ code: 'helper_exited' })
    await expect(crashing.authorizationStatus()).rejects.toMatchObject({ code: 'helper_exited' })
  })

  it('delivers change notifications to every listener until unsubscribed', async () => {
    const changes = createEventKitBridge({
      command: process.execPath,
      args: [
        '-e',
        'setTimeout(() => process.stdout.write(JSON.stringify({ event: "changed" }) + "\\n"), 20); process.stdin.resume()'
      ]
    })
    bridges.push(changes)
    const first = vi.fn()
    const second = vi.fn()
    changes.onChanged(first)
    const unsubscribe = changes.onChanged(second)
    unsubscribe()
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(second).not.toHaveBeenCalled()
  })

  it('rejects in-flight and later calls once disposed', async () => {
    const stalled = createEventKitBridge({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()']
    })
    const inFlight = stalled.listCalendars()
    stalled.dispose()
    await expect(inFlight).rejects.toMatchObject({ code: 'disposed' })
    await expect(stalled.authorizationStatus()).rejects.toMatchObject({ code: 'disposed' })
  })
})

// The real helper, when this Mac has built it: the Swift side and the client
// must agree on the protocol. Reading the status never prompts.
const REAL_HELPER = path.resolve(__dirname, '../../../../native/eventkit/bin/memry-eventkit')

describe.runIf(process.platform === 'darwin' && existsSync(REAL_HELPER))(
  'EventKit bridge client against the built helper',
  () => {
    it('reads a valid authorization status', async () => {
      const client = createEventKitBridge({ command: REAL_HELPER })
      try {
        await expect(client.authorizationStatus()).resolves.toMatch(
          /^(not_determined|restricted|denied|write_only|full_access)$/
        )
      } finally {
        client.dispose()
      }
    })
  }
)
