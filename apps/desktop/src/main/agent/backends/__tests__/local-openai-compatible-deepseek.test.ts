import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'deepseek-v4-flash'
const REASONING = 'The user wants tags, so call vault_get_tags.'

interface ChatMessage {
  role: string
  content?: string | null
  reasoning_content?: string
  tool_calls?: unknown[]
}

interface ChatRequest {
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  messages: ChatMessage[]
}

// Mirrors the two DeepSeek thinking-mode rules from FB-006: a named tool_choice is
// rejected, and so is an assistant tool-call message without its reasoning_content.
function rejectReason(body: ChatRequest): string | null {
  if (body.tools && typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    return 'tool_choice is not supported in thinking mode'
  }
  const stripped = body.messages.find(
    (message) => message.role === 'assistant' && message.tool_calls && !message.reasoning_content
  )
  return stripped ? 'reasoning_content must be passed back in thinking mode' : null
}

function sse(chunks: unknown[]): Response {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  return new Response(`${lines}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'vault_get_tags', arguments: '{}' }
}

function createDeepSeekFetch(requests: ChatRequest[]): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })

    const body = JSON.parse(String(init?.body)) as ChatRequest
    requests.push(body)
    const rejected = rejectReason(body)
    if (rejected) return json({ error: { message: rejected, type: 'invalid_request_error' } }, 400)

    const hasToolResult = body.messages.some((message) => message.role === 'tool')
    if (!body.stream) {
      return json({
        choices: [
          {
            message: hasToolResult
              ? { role: 'assistant', content: 'ok' }
              : {
                  role: 'assistant',
                  content: null,
                  reasoning_content: REASONING,
                  tool_calls: [
                    {
                      ...toolCall,
                      id: 'probe-1',
                      function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
                    }
                  ]
                }
          }
        ]
      })
    }
    if (!body.tools) return sse([chunk({ role: 'assistant', content: 'ok' }, 'stop')])
    if (hasToolResult)
      return sse([chunk({ role: 'assistant', content: 'You have no tags.' }, 'stop')])
    return sse([
      chunk({ role: 'assistant', reasoning_content: REASONING }),
      chunk({ tool_calls: [{ index: 0, ...toolCall }] }),
      chunk({}, 'tool_calls')
    ])
  }) as unknown as typeof fetch
}

describe('LocalOpenAICompatibleBackend against a DeepSeek-style provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the vault tools and keeps reasoning_content through the tool loop', async () => {
    const requests: ChatRequest[] = []
    vi.stubGlobal('fetch', createDeepSeekFetch(requests))
    const execute = vi.fn(async () => ({ ok: true as const, data: { tags: [] } }))
    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'custom',
        baseUrl: 'https://deepseek.test/v1',
        model: MODEL,
        apiKeyConfigured: true,
        allowNonLoopback: true
      }),
      getApiKey: async () => 'sk-test',
      toolBridge: { execute } as never
    })

    const run = await backend.runTurn({
      conversationId: 'conversation-1',
      writeGrant: 'turn-grant-1' as TurnWriteGrant,
      windowId: 'window-1',
      prompt: 'User: list my tags',
      options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true }
    })
    const events: BackendEvent[] = []
    for await (const event of run.events) events.push(event)
    const stderr: string[] = []
    for await (const piece of run.stderr ?? []) stderr.push(piece.toString())

    expect(stderr).toEqual([])
    expect(await run.waitExit()).toBe(0)
    expect(execute).toHaveBeenCalledWith({
      writeGrant: 'turn-grant-1',
      windowId: 'window-1',
      name: 'vault_get_tags',
      args: {}
    })
    expect(events.filter((event) => event.kind !== 'reasoning_delta')).toEqual([
      { kind: 'tool_use', toolUseId: 'call_1', name: 'vault_get_tags', args: {} },
      {
        kind: 'tool_result',
        toolUseId: 'call_1',
        ok: true,
        data: { ok: true, data: { tags: [] } }
      },
      { kind: 'assistant_delta', text: 'You have no tags.' },
      { kind: 'message_stop' }
    ])
    const continuation = requests.at(-1)
    expect(continuation?.messages.find((message) => message.role === 'assistant')).toMatchObject({
      reasoning_content: REASONING
    })
  })
})
