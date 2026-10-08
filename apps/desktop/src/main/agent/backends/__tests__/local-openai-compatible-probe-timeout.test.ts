import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() })
}))

const MODEL = 'slow-model'

/** Lists the model and streams fine, but never answers a tool request until aborted. */
const hangingToolProvider = vi.fn(async (url: string | URL, init?: RequestInit) => {
  if (String(url).endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: MODEL }] }))
  }
  const body = JSON.parse(String(init?.body)) as { stream?: boolean }
  if (body.stream) {
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  }
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
}) as unknown as typeof fetch

describe('LocalOpenAICompatibleBackend tool probe on a hung server', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    warn.mockClear()
  })

  it('gives up on the tool probe after the timeout and logs it once', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(20))
    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'custom',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: MODEL,
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never,
      fetch: hangingToolProvider
    })

    const result = await backend.probeCapabilities()

    expect(result).toMatchObject({ connected: true, streamingSupported: true, toolsEnabled: false })
    expect(result.detail).toMatch(/timeout|timed out/i)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]!.map(String).join(' ')
    expect(line).toContain(MODEL)
    expect(line).toMatch(/timeout|timed out/i)
  })
})
