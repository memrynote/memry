import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

import { TELEMETRY_CONFIG_FILENAME } from './config'
import { disposeTelemetryRuntime, initializeTelemetryRuntime } from './runtime'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const createFetch = () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 })
  })
  return { calls, fetchMock }
}

describe('initializeTelemetryRuntime', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-telemetry-runtime-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(async () => {
    await disposeTelemetryRuntime()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('exposes a stable installId and a fresh session id per launch', async () => {
    // #given a fresh userData directory
    const { fetchMock } = createFetch()

    // #when initializing twice (each launch)
    const runtimeA = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch'
    })
    const installA = runtimeA.context.installId
    const sessionA = runtimeA.context.sessionId
    await disposeTelemetryRuntime()
    const runtimeB = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch'
    })

    // #then installId is the same and session id format is a UUID
    expect(runtimeB.context.installId).toBe(installA)
    expect(sessionA).toMatch(UUID_PATTERN)
    expect(runtimeB.context.sessionId).toMatch(UUID_PATTERN)
    expect(runtimeB.context.sessionId).not.toBe(sessionA)
  })

  it('emits an app_started event after initialization', () => {
    const { fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true
    })

    expect(runtime.client.getQueueDepth()).toBe(1)
  })

  it('flush sends the batched payload to the configured endpoint', async () => {
    const { calls, fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true
    })

    await runtime.flush('manual')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://example.test/telemetry/batch')
  })

  it('setEnabled persists the setting and clears queued events on disable', () => {
    const { fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true
    })

    expect(runtime.client.getQueueDepth()).toBeGreaterThan(0)
    runtime.setEnabled(false)

    expect(runtime.client.getQueueDepth()).toBe(0)
    expect(runtime.getSettings().enabled).toBe(false)

    const stored = JSON.parse(
      fs.readFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), 'utf-8')
    ) as { enabled?: boolean }
    expect(stored.enabled).toBe(false)
  })

  it('setEnabled(true) re-enables tracking and persists the setting', () => {
    const { fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: false
    })

    expect(runtime.getSettings().enabled).toBe(false)
    runtime.setEnabled(true)
    expect(runtime.getSettings().enabled).toBe(true)

    const stored = JSON.parse(
      fs.readFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), 'utf-8')
    ) as { enabled?: boolean }
    expect(stored.enabled).toBe(true)
  })

  it('disabled-by-default in non-production unless explicitly enabled', () => {
    const { fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'development',
      endpoint: 'https://example.test/telemetry/batch'
    })

    expect(runtime.getSettings().enabled).toBe(false)
    expect(runtime.client.getQueueDepth()).toBe(0)
  })

  it('enabled-by-default in production unless explicitly disabled', () => {
    const { fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch'
    })

    expect(runtime.getSettings().enabled).toBe(true)
    expect(runtime.client.getQueueDepth()).toBe(1)
  })

  it('respects the persisted disabled setting in production', () => {
    fs.writeFileSync(
      path.join(tempDir, TELEMETRY_CONFIG_FILENAME),
      JSON.stringify({
        installId: '11111111-1111-1111-1111-111111111111',
        enabled: false
      })
    )

    const { fetchMock } = createFetch()
    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch'
    })

    expect(runtime.getSettings().enabled).toBe(false)
    expect(runtime.client.getQueueDepth()).toBe(0)
  })

  it('passes accessTokenProvider through to the client flush', async () => {
    const { calls, fetchMock } = createFetch()

    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true,
      flushIntervalMs: null,
      accessTokenProvider: async () => 'jwt-token'
    })

    await runtime.flush('manual')

    expect(calls).toHaveLength(1)
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer jwt-token'
    )
  })

  it('trackTelemetry adds events through the runtime API', () => {
    const { fetchMock } = createFetch()
    const runtime = initializeTelemetryRuntime({
      fetch: fetchMock,
      buildChannel: 'production',
      endpoint: 'https://example.test/telemetry/batch',
      initialEnabled: true
    })

    runtime.track({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'page_viewed',
      occurredAt: new Date().toISOString(),
      surface: 'notes',
      action: 'viewed',
      result: 'success'
    })

    expect(runtime.client.getQueueDepth()).toBeGreaterThan(1)
  })
})
