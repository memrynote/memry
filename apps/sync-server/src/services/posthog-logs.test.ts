import { describe, expect, it, vi } from 'vitest'

import { pushPostHogLogs } from './posthog-logs'

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
})
