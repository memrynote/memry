import { describe, expect, it, vi } from 'vitest'

import { capturePostHogEvents } from './posthog'

const env = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging'
}

describe('capturePostHogEvents', () => {
  it('posts a batch with the api key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await capturePostHogEvents(env, [
      { event: 'note_created', distinct_id: 'abc', properties: { surface: 'notes' } }
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/batch/')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.api_key).toBe('phc_test')
    expect(body.batch[0].event).toBe('note_created')
    vi.unstubAllGlobals()
  })

  it('is a no-op without a key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await capturePostHogEvents({ ENVIRONMENT: 'staging' }, [
      { event: 'x', distinct_id: 'a', properties: {} }
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('is a no-op for an empty batch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await capturePostHogEvents(env, [])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(
      capturePostHogEvents(env, [{ event: 'x', distinct_id: 'a', properties: {} }])
    ).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})
