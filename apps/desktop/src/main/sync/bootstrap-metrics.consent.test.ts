import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TelemetryEvent } from '@memry/contracts/telemetry-api'

import { createTelemetryClient, type TelemetryClientDeps } from '../telemetry/client'
import { resetTelemetryThrottle } from '../telemetry/throttle'

// End-to-end consent check through REAL seams: bootstrap-metrics ->
// trackMainEvent (real) -> runtime.track -> a real telemetry client. Only the
// runtime lookup is mocked, because the real one pulls in Electron. With
// consent off, nothing may be queued and nothing may leave the process — the
// module must not grow its own consent logic that could drift from the
// client's.

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  runtime: null as null | { track: (event: TelemetryEvent) => void }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.log
}))

vi.mock('../telemetry/runtime', () => ({
  getTelemetryRuntime: () => mocks.runtime
}))

import {
  beginBootstrap,
  markBootstrapFullText,
  markBootstrapInteractive,
  recordBootstrapBytes,
  resetBootstrapMetrics,
  setBootstrapStatsProvider
} from './bootstrap-metrics'

const createClient = (
  enabled: boolean
): { client: ReturnType<typeof createTelemetryClient>; fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 })
  )
  const deps: TelemetryClientDeps = {
    fetch: fetchMock as unknown as TelemetryClientDeps['fetch'],
    endpoint: 'https://example.test/telemetry/batch',
    context: {
      installId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      appVersion: '0.1.0',
      buildChannel: 'production',
      platform: 'darwin',
      arch: 'arm64',
      locale: 'en',
      timezoneOffsetMinutes: 0
    },
    initialEnabled: enabled,
    getAuthState: () => 'signed_in',
    getSyncState: () => 'enabled'
  }
  return { client: createTelemetryClient(deps), fetchMock }
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

const runFullBootstrap = async (): Promise<void> => {
  beginBootstrap('vault_download')
  markBootstrapInteractive()
  recordBootstrapBytes('records', 1234)
  markBootstrapFullText()
  await settle()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetBootstrapMetrics()
  resetTelemetryThrottle()
  setBootstrapStatsProvider(async () => ({ noteCount: 10, vaultSizeBytes: 1000 }))
  mocks.runtime = null
})

describe('#given telemetry consent is OFF', () => {
  it('#then a full bootstrap queues nothing and sends nothing', async () => {
    const { client, fetchMock } = createClient(false)
    mocks.runtime = { track: (event) => client.track(event) }

    await runFullBootstrap()
    await client.flush('interval')

    expect(client.getQueueDepth()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('#given telemetry consent is ON', () => {
  it('#then the same bootstrap queues its milestone and throughput events', async () => {
    const { client } = createClient(true)
    mocks.runtime = { track: (event) => client.track(event) }

    await runFullBootstrap()

    // interactive + full_text + one throughput summary per channel
    expect(client.getQueueDepth()).toBe(5)
  })
})
