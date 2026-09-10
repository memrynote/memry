import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, status: 202 }))
}))

vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))

import { boundedNetFetch } from './bounded-net-fetch'

describe('boundedNetFetch', () => {
  it('gives every request an abort deadline', async () => {
    await boundedNetFetch('https://example.test/telemetry/batch', { method: 'POST' })

    const init = mocks.fetch.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a deadline the caller already chose', async () => {
    const controller = new AbortController()
    await boundedNetFetch('https://example.test/telemetry/batch', { signal: controller.signal })

    expect(mocks.fetch.mock.calls.at(-1)?.[1]?.signal).toBe(controller.signal)
  })
})
