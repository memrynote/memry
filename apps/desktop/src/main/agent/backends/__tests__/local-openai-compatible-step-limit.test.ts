import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'test-model'

interface ChatRequest {
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  messages: Array<{ role: string; content?: unknown }>
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function sse(delta: Record<string, unknown>, finishReason: string): Response {
  const chunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finishReason }]
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

// A provider that calls a tool on each of the first `toolRounds` requests that offer
// tools, and otherwise answers in text.
function provider(chatRequests: ChatRequest[], toolRounds = Infinity): typeof fetch {
  let callId = 0
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })
    const body = JSON.parse(String(init?.body)) as ChatRequest
    if (!body.stream) {
      const afterTool = body.messages.some((message) => message.role === 'tool')
      return json({
        choices: [
          {
            message: afterTool
              ? { role: 'assistant', content: 'ok' }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'probe-1',
                      type: 'function',
                      function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
                    }
                  ]
                }
          }
        ]
      })
    }
    // The probe also checks streaming; only the turn's own requests carry its prompt.
    if (!JSON.stringify(body.messages).includes('tidy my tags')) {
      return sse({ content: 'ok' }, 'stop')
    }
    chatRequests.push(body)
    if (!body.tools || callId >= toolRounds)
      return sse({ content: 'Done: listed tags. Left: nothing.' }, 'stop')
    callId += 1
    return sse(
      {
        tool_calls: [
          {
            index: 0,
            id: `call-${callId}`,
            type: 'function',
            function: { name: 'vault_get_tags', arguments: '{}' }
          }
        ]
      },
      'tool_calls'
    )
  }) as unknown as typeof fetch
}

function systemText(request: ChatRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n')
}

async function runTurn(execute: ReturnType<typeof vi.fn>): Promise<BackendEvent[]> {
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'custom',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: MODEL,
      apiKeyConfigured: false,
      allowNonLoopback: false,
      thinking: 'default'
    }),
    getApiKey: async () => null,
    toolBridge: { execute } as never
  })
  const run = await backend.runTurn({
    conversationId: 'conversation-1',
    writeGrant: 'turn-grant-1' as TurnWriteGrant,
    windowId: 'window-1',
    prompt: 'User: tidy my tags',
    options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true }
  })
  const events: BackendEvent[] = []
  for await (const event of run.events) events.push(event)
  expect(await run.waitExit()).toBe(0)
  return events
}

describe('LocalOpenAICompatibleBackend step limit', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stops a tool loop at 24 calls, ends with a tool-free handoff and reports the limit', async () => {
    const chatRequests: ChatRequest[] = []
    vi.stubGlobal('fetch', provider(chatRequests))
    const execute = vi.fn(async () => ({ ok: true as const, data: { tags: [] } }))
    const events = await runTurn(execute)

    expect(chatRequests).toHaveLength(24)
    expect(execute).toHaveBeenCalledTimes(23)
    expect(systemText(chatRequests[0])).toMatch(/24 model calls/)
    expect(chatRequests[22].tools).toBeDefined()

    const last = chatRequests[23]
    expect(last.tools).toBeUndefined()
    expect(last.tool_choice).toBeUndefined()
    expect(systemText(last)).toMatch(/tools are off/i)
    expect(systemText(last)).toMatch(/what is done, what is left/)

    const kinds = events.map((event) => event.kind)
    expect(kinds.slice(-2)).toEqual(['step_limit', 'message_stop'])
    expect(kinds.filter((kind) => kind === 'step_limit')).toHaveLength(1)
  })

  it('reports no limit for a turn that answers before the cap', async () => {
    const chatRequests: ChatRequest[] = []
    vi.stubGlobal('fetch', provider(chatRequests, 2))
    const events = await runTurn(vi.fn(async () => ({ ok: true as const, data: { tags: [] } })))

    expect(chatRequests).toHaveLength(3)
    expect(chatRequests.every((request) => request.tools)).toBe(true)
    expect(events.map((event) => event.kind)).not.toContain('step_limit')
  })
})
