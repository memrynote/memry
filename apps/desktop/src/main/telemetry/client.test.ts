import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TelemetryEvent } from '@memry/contracts/telemetry-api'

import { createTelemetryClient, TELEMETRY_QUEUE_LIMIT, type TelemetryClientDeps } from './client'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001'

const buildEvent = (id: string, name: TelemetryEvent['name'] = 'app_started'): TelemetryEvent => ({
  id,
  name,
  occurredAt: '2026-05-01T12:00:00.000Z',
  surface: 'app',
  action: 'started',
  result: 'success'
})

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function createDeps(overrides?: Partial<TelemetryClientDeps>): {
  deps: TelemetryClientDeps
  calls: FetchCall[]
  fetchMock: ReturnType<typeof vi.fn>
} {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 })
  })

  const deps: TelemetryClientDeps = {
    fetch: fetchMock as unknown as TelemetryClientDeps['fetch'],
    endpoint: 'https://example.test/telemetry/batch',
    context: {
      installId: VALID_INSTALL_ID,
      sessionId: VALID_SESSION_ID,
      appVersion: '0.1.0',
      buildChannel: 'production',
      platform: 'darwin',
      arch: 'arm64',
      locale: 'en',
      timezoneOffsetMinutes: -180
    },
    initialEnabled: true,
    getAuthState: () => 'anonymous',
    getSyncState: () => 'disabled',
    ...overrides
  }
  return { deps, calls, fetchMock }
}

describe('createTelemetryClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues events when enabled', () => {
    // #given a client with telemetry enabled
    const { deps } = createDeps()
    const client = createTelemetryClient(deps)

    // #when tracking events
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))
    client.track(buildEvent('22222222-2222-2222-2222-222222222222'))

    // #then both events are queued
    expect(client.getQueueDepth()).toBe(2)
  })

  it('drops events when disabled and never queues them', () => {
    // #given a disabled client
    const { deps } = createDeps({ initialEnabled: false })
    const client = createTelemetryClient(deps)

    // #when tracking
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #then no events are queued
    expect(client.getQueueDepth()).toBe(0)
  })

  it('caps the queue at the documented limit and drops oldest entries', () => {
    // #given a client with telemetry enabled
    const { deps } = createDeps()
    const client = createTelemetryClient(deps)

    // #when tracking more than the limit
    for (let i = 0; i < TELEMETRY_QUEUE_LIMIT + 50; i++) {
      const id = `${'0'.repeat(8)}-0000-0000-0000-${String(i).padStart(12, '0')}`
      client.track(buildEvent(id))
    }

    // #then the queue size never exceeds the limit
    expect(client.getQueueDepth()).toBe(TELEMETRY_QUEUE_LIMIT)
  })

  it('flush posts the queued batch to the configured endpoint', async () => {
    // #given a client with one queued event
    const { deps, calls } = createDeps()
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #when flushing
    const result = await client.flush('manual')

    // #then a single POST request was made to the configured endpoint
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(deps.endpoint)
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    )
  })

  it('flush sends install/session/app/platform context with the batch', async () => {
    // #given a client with one queued event
    const { deps, calls } = createDeps()
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #when flushing
    await client.flush('manual')

    // #then the JSON payload contains app metadata + the event
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>
    expect(body.installId).toBe(VALID_INSTALL_ID)
    expect(body.sessionId).toBe(VALID_SESSION_ID)
    expect(body.appVersion).toBe('0.1.0')
    expect(body.platform).toBe('darwin')
    expect(body.arch).toBe('arm64')
    expect(body.locale).toBe('en')
    expect(body.buildChannel).toBe('production')
    expect(body.authState).toBe('anonymous')
    expect(body.syncState).toBe('disabled')
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events as unknown[]).toHaveLength(1)
  })

  it('flush is a no-op when the queue is empty', async () => {
    // #given a client with no queued events
    const { deps, calls } = createDeps()
    const client = createTelemetryClient(deps)

    // #when flushing
    const result = await client.flush('interval')

    // #then no fetch is performed and result reports success
    expect(calls).toHaveLength(0)
    expect(result.success).toBe(true)
  })

  it('flush failure is swallowed and the events remain queued', async () => {
    // #given a fetch that always fails
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const { deps } = createDeps({ fetch: fetchMock as unknown as TelemetryClientDeps['fetch'] })
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))
    client.track(buildEvent('22222222-2222-2222-2222-222222222222'))

    // #when flushing
    const result = await client.flush('manual')

    // #then the call rejects internally but does not throw, and events are kept
    expect(result.success).toBe(false)
    expect(client.getQueueDepth()).toBe(2)
  })

  it('drops the batch on a 400 so a poison-pill event cannot wedge the queue', async () => {
    // #given a server that permanently rejects the payload
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }))
    const { deps } = createDeps({ fetch: fetchMock as unknown as TelemetryClientDeps['fetch'] })
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))
    client.track(buildEvent('22222222-2222-2222-2222-222222222222'))

    // #when flushing
    const result = await client.flush('manual')

    // #then the rejected batch is dropped, not retried forever
    expect(result.success).toBe(false)
    expect(client.getQueueDepth()).toBe(0)
  })

  it('keeps the batch queued on a 429 rate-limit for a later retry', async () => {
    // #given a transient rate-limit response
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429 }))
    const { deps } = createDeps({ fetch: fetchMock as unknown as TelemetryClientDeps['fetch'] })
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #when flushing
    const result = await client.flush('manual')

    // #then the batch stays queued because 429 is retryable
    expect(result.success).toBe(false)
    expect(client.getQueueDepth()).toBe(1)
  })

  it('keeps the batch queued on a 500 server error for a later retry', async () => {
    // #given a transient server error
    const fetchMock = vi.fn(async () => new Response('oops', { status: 500 }))
    const { deps } = createDeps({ fetch: fetchMock as unknown as TelemetryClientDeps['fetch'] })
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #when flushing
    const result = await client.flush('manual')

    // #then the batch stays queued because 5xx is retryable
    expect(result.success).toBe(false)
    expect(client.getQueueDepth()).toBe(1)
  })

  it('setEnabled(false) drops queued events and short-circuits future tracks', () => {
    // #given a client with queued events
    const { deps } = createDeps()
    const client = createTelemetryClient(deps)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))
    expect(client.getQueueDepth()).toBe(1)

    // #when disabling
    client.setEnabled(false)

    // #then the queue is cleared and new tracks are dropped
    expect(client.getQueueDepth()).toBe(0)
    expect(client.getSettings().enabled).toBe(false)

    client.track(buildEvent('22222222-2222-2222-2222-222222222222'))
    expect(client.getQueueDepth()).toBe(0)
  })

  it('setEnabled(true) re-enables tracking', () => {
    // #given a disabled client
    const { deps } = createDeps({ initialEnabled: false })
    const client = createTelemetryClient(deps)

    // #when re-enabling and tracking
    client.setEnabled(true)
    client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

    // #then the event is queued
    expect(client.getSettings().enabled).toBe(true)
    expect(client.getQueueDepth()).toBe(1)
  })

  it('flush respects the documented batch size cap', async () => {
    // #given a client with more than one batch worth of events
    const { deps, calls } = createDeps()
    const client = createTelemetryClient(deps)
    for (let i = 0; i < 70; i++) {
      const id = `${'0'.repeat(8)}-1111-1111-1111-${String(i).padStart(12, '0')}`
      client.track(buildEvent(id))
    }

    // #when flushing once
    await client.flush('interval')

    // #then exactly one batch of 50 was sent and the rest stays queued
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init?.body as string) as { events: unknown[] }
    expect(body.events).toHaveLength(50)
    expect(client.getQueueDepth()).toBe(20)
  })

  describe('getAccessToken', () => {
    it('sends Authorization header when getAccessToken resolves a token', async () => {
      // #given a client with getAccessToken that resolves a JWT
      const { deps, calls } = createDeps({
        getAccessToken: async () => 'jwt-token'
      })
      const client = createTelemetryClient(deps)
      client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

      // #when flushing
      const result = await client.flush('manual')

      // #then fetch is called with correct Authorization header and Content-Type preserved
      expect(result.success).toBe(true)
      const headers = calls[0].init?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer jwt-token')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('sends no Authorization header when getAccessToken resolves null', async () => {
      // #given a client with getAccessToken that resolves null
      const { deps, calls } = createDeps({
        getAccessToken: async () => null
      })
      const client = createTelemetryClient(deps)
      client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

      // #when flushing
      await client.flush('manual')

      // #then no Authorization key is present in headers
      const headers = calls[0].init?.headers as Record<string, string>
      expect('Authorization' in headers).toBe(false)
    })

    it('flush still succeeds when getAccessToken throws', async () => {
      // #given a client with getAccessToken that throws
      const { deps, calls } = createDeps({
        getAccessToken: async () => {
          throw new Error('token fetch failed')
        }
      })
      const client = createTelemetryClient(deps)
      client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

      // #when flushing
      const result = await client.flush('manual')

      // #then flush still succeeds and no Authorization header is sent
      expect(result.success).toBe(true)
      const headers = calls[0].init?.headers as Record<string, string>
      expect('Authorization' in headers).toBe(false)
    })

    it('Authorization header is exactly Bearer <token> with one space', async () => {
      // #given a client with a known token
      const { deps, calls } = createDeps({
        getAccessToken: async () => 'my-access-token'
      })
      const client = createTelemetryClient(deps)
      client.track(buildEvent('11111111-1111-1111-1111-111111111111'))

      // #when flushing
      await client.flush('manual')

      // #then the header value matches exactly — one space, no extra whitespace
      const headers = calls[0].init?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer my-access-token')
      expect(headers['Authorization']).toMatch(/^Bearer [^ ]+$/)
    })
  })
})

describe('createTelemetryClient — crash durability', () => {
  let tempDir: string
  let persistPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-telemetry-client-'))
    persistPath = path.join(tempDir, 'events.json')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('restores events a killed process never got to flush', async () => {
    // #given a session that recorded app_crashed and died before its 30s flush
    const dead = createTelemetryClient(createDeps({ persistPath }).deps)
    dead.track(buildEvent('11111111-1111-1111-1111-111111111111', 'app_crashed'))

    // #when the next launch opens the same mirror
    const { deps, calls } = createDeps({ persistPath })
    const revived = createTelemetryClient(deps)
    expect(revived.getQueueDepth()).toBe(1)

    // #then the crash event ships instead of being lost with the process
    await revived.flush('manual')
    const batch = JSON.parse(String(calls[0].init?.body)) as { events: TelemetryEvent[] }
    expect(batch.events.map((e) => e.name)).toEqual(['app_crashed'])

    // #and it is not sent again on the launch after that
    expect(createTelemetryClient(createDeps({ persistPath }).deps).getQueueDepth()).toBe(0)
  })

  it('never restores events for an install that opted out between launches', () => {
    // #given events mirrored while telemetry was on
    createTelemetryClient(createDeps({ persistPath }).deps).track(
      buildEvent('11111111-1111-1111-1111-111111111111')
    )

    // #when the next launch starts with telemetry disabled
    const client = createTelemetryClient(createDeps({ persistPath, initialEnabled: false }).deps)

    // #then nothing is restored and nothing is left on disk
    expect(client.getQueueDepth()).toBe(0)
    expect(fs.existsSync(persistPath)).toBe(false)
  })
})
