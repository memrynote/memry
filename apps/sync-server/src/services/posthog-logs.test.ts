import { describe, expect, it, vi } from 'vitest'

import { desktopLogRecord, pushPostHogLogs } from './posthog-logs'

const env = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging'
}

describe('pushPostHogLogs', () => {
  it('posts OTLP-JSON with the token as a bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await pushPostHogLogs(env, [
      { level: 'error', app: 'desktop', distinctId: 'hash', line: { error_code: 'X' } }
    ])

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/v1/logs')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer phc_test' })

    const body = JSON.parse((init as RequestInit).body as string)
    const resource = body.resourceLogs[0].resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'desktop' } })
    expect(resource).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' }
    })

    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    expect(record.attributes).toContainEqual({
      key: 'posthogDistinctId',
      value: { stringValue: 'hash' }
    })
    vi.unstubAllGlobals()
  })

  it('is a no-op without a key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await pushPostHogLogs({}, [{ level: 'error', app: 'server', line: {} }])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(
      pushPostHogLogs(env, [{ level: 'error', app: 'server', line: {} }])
    ).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('groups records into one resourceLogs entry per app', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await pushPostHogLogs(env, [
      { level: 'error', app: 'desktop', line: { id: 'd1' } },
      { level: 'error', app: 'server', line: { id: 's1' } },
      { level: 'error', app: 'desktop', line: { id: 'd2' } }
    ])

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.resourceLogs).toHaveLength(2)

    type ResourceAttribute = { key: string; value: { stringValue: string } }
    type ResourceLogsEntry = { resource: { attributes: ResourceAttribute[] } }

    const desktopEntry = body.resourceLogs.find((r: ResourceLogsEntry) =>
      r.resource.attributes.some(
        (a) => a.key === 'service.name' && a.value.stringValue === 'desktop'
      )
    )
    const serverEntry = body.resourceLogs.find((r: ResourceLogsEntry) =>
      r.resource.attributes.some(
        (a) => a.key === 'service.name' && a.value.stringValue === 'server'
      )
    )

    expect(
      desktopEntry.scopeLogs[0].logRecords.map(
        (r: { body: { stringValue: string } }) => r.body.stringValue
      )
    ).toEqual([JSON.stringify({ id: 'd1' }), JSON.stringify({ id: 'd2' })])
    expect(
      serverEntry.scopeLogs[0].logRecords.map(
        (r: { body: { stringValue: string } }) => r.body.stringValue
      )
    ).toEqual([JSON.stringify({ id: 's1' })])
    vi.unstubAllGlobals()
  })

  it('resolves instead of rejecting when a line is not JSON-safe', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const line: Record<string, unknown> = {}
    line.self = line

    await expect(
      pushPostHogLogs(env, [{ level: 'error', app: 'server', line }])
    ).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('desktopLogRecord', () => {
  it('re-runs redaction on the message', () => {
    const record = desktopLogRecord(
      {
        ts: '2026-07-22T10:00:00.000Z',
        level: 'error',
        scope: 'Sync',
        message: 'failed for kaan@example.com',
        origin: 'main'
      } as never,
      { appVersion: '1.0.0', buildChannel: 'production', platform: 'darwin', arch: 'arm64' },
      'hash'
    )
    expect(JSON.stringify(record.line)).not.toContain('kaan@example.com')
    expect(record.distinctId).toBe('hash')
    expect(record.kind).toBe('log')
  })
})
