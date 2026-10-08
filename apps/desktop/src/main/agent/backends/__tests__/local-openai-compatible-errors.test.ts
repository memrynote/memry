import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'llama3.2'

function rejectingProvider(message: string): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: MODEL }] }), {
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
  }) as unknown as typeof fetch
}

describe('LocalOpenAICompatibleBackend provider errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a provider that rejects the chat request as a backend error', async () => {
    vi.stubGlobal('fetch', rejectingProvider('tool_choice is not supported'))
    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'custom',
        baseUrl: 'http://127.0.0.1:18631/v1',
        model: MODEL,
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never
    })

    const run = await backend.runTurn({
      conversationId: 'conversation-1',
      writeGrant: 'turn-grant-1' as TurnWriteGrant,
      windowId: 'window-1',
      prompt: 'User: hello',
      options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: false }
    })
    const events: BackendEvent[] = []
    for await (const event of run.events) events.push(event)

    expect(events).toContainEqual({ kind: 'error', message: 'tool_choice is not supported' })
  })
})
