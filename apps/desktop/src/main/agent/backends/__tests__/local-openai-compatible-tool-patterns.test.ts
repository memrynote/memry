import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'test-model'
const REASONING = 'The user wants tags, so call vault_get_tags.'

interface ChatMessage {
  role: string
  content?: string | null
  reasoning_content?: string
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
}

interface ChatRequest {
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  messages: ChatMessage[]
}

/**
 * One provider's tool-calling behavior, in the OpenAI-compatible wire shapes it sends.
 * `reject` returns the provider's error message for a request it refuses with HTTP 400.
 */
interface ProviderPattern {
  reject?: (body: ChatRequest) => string | null
  probeReply: ChatMessage
  continuationReply?: ChatMessage
  firstStep: unknown[]
  afterToolStep: unknown[]
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

function sse(chunks: unknown[]): Response {
  const lines = chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')
  return new Response(`${lines}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function textReply(text: string): unknown[] {
  return [chunk({ role: 'assistant', content: text }, 'stop')]
}

const nativeProbeCall: ChatMessage = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'probe-1',
      function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
    }
  ]
}

const nativeTagsStep = [
  chunk({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'vault_get_tags', arguments: '{}' }
      }
    ]
  }),
  chunk({}, 'tool_calls')
]

function providerFetch(pattern: ProviderPattern, requests: ChatRequest[]): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })

    const body = JSON.parse(String(init?.body)) as ChatRequest
    requests.push(body)
    const rejected = pattern.reject?.(body)
    if (rejected) return json({ error: { message: rejected, type: 'invalid_request_error' } }, 400)

    const afterTool = body.messages.some((message) => message.role === 'tool')
    if (!body.stream) {
      const message = afterTool
        ? (pattern.continuationReply ?? { role: 'assistant', content: 'ok' })
        : pattern.probeReply
      return json({ choices: [{ message }] })
    }
    if (!body.tools) return sse(textReply('Plain answer'))
    return sse(afterTool ? pattern.afterToolStep : pattern.firstStep)
  }) as unknown as typeof fetch
}

async function runTagsTurn(pattern: ProviderPattern): Promise<{
  events: BackendEvent[]
  execute: ReturnType<typeof vi.fn>
  chatRequests: ChatRequest[]
}> {
  const requests: ChatRequest[] = []
  vi.stubGlobal('fetch', providerFetch(pattern, requests))
  const execute = vi.fn(async () => ({ ok: true as const, data: { tags: [] } }))
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'custom',
      baseUrl: 'https://provider.test/v1',
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
  expect(await run.waitExit()).toBe(0)
  return {
    events: events.filter((event) => event.kind !== 'reasoning_delta'),
    execute,
    chatRequests: requests.filter((request) => request.stream && request.tools)
  }
}

const tagsTurnEvents = (toolUseId: string): BackendEvent[] => [
  { kind: 'tool_use', toolUseId, name: 'vault_get_tags', args: {} },
  { kind: 'tool_result', toolUseId, ok: true, data: { ok: true, data: { tags: [] } } },
  { kind: 'assistant_delta', text: 'You have no tags.' },
  { kind: 'message_stop' }
]

describe('LocalOpenAICompatibleBackend tool-calling patterns', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps tool_choice auto for a provider that accepts a named tool_choice', async () => {
    const { events, execute, chatRequests } = await runTagsTurn({
      probeReply: nativeProbeCall,
      firstStep: nativeTagsStep,
      afterToolStep: textReply('You have no tags.')
    })

    expect(events).toEqual(tagsTurnEvents('call_1'))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(chatRequests.map((request) => request.tool_choice)).toEqual(['auto', 'auto'])
  })

  it('drops tool_choice and sends reasoning back for a provider that rejects both', async () => {
    const { events, execute, chatRequests } = await runTagsTurn({
      reject: (body) => {
        if ('tool_choice' in body) return 'tool_choice is not supported in thinking mode'
        const stripped = body.messages.find(
          (message) =>
            message.role === 'assistant' && message.tool_calls && !message.reasoning_content
        )
        return stripped ? 'reasoning_content must be passed back in thinking mode' : null
      },
      probeReply: { ...nativeProbeCall, reasoning_content: REASONING },
      firstStep: [chunk({ role: 'assistant', reasoning_content: REASONING }), ...nativeTagsStep],
      afterToolStep: textReply('You have no tags.')
    })

    expect(events).toEqual(tagsTurnEvents('call_1'))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(chatRequests.map((request) => 'tool_choice' in request)).toEqual([false, false])
    expect(chatRequests[1].messages.find((message) => message.role === 'assistant')).toMatchObject({
      reasoning_content: REASONING
    })
  })

  it('runs tool calls that the model writes into its reply as text', async () => {
    const { events, execute, chatRequests } = await runTagsTurn({
      probeReply: {
        role: 'assistant',
        content:
          '<tool_call>\n{"name": "memry_probe_echo", "arguments": {"text": "ok"}}\n</tool_call>'
      },
      firstStep: [
        chunk({ role: 'assistant', content: 'Checking. <tool' }),
        chunk({ content: '_call>\n{"name": "vault_get_tags", ' }),
        chunk({ content: '"arguments": {}}\n</tool_' }),
        chunk({ content: 'call>' }),
        chunk({}, 'stop')
      ],
      afterToolStep: textReply('You have no tags.')
    })

    const toolUse = events.find((event) => event.kind === 'tool_use')
    const toolUseId = toolUse?.kind === 'tool_use' ? toolUse.toolUseId : ''
    expect(events).toEqual([
      { kind: 'assistant_delta', text: 'Checking. ' },
      ...tagsTurnEvents(toolUseId)
    ])
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'vault_get_tags', args: {} })
    )
    expect(chatRequests[1].messages.find((message) => message.role === 'assistant')).toMatchObject({
      tool_calls: [{ id: toolUseId, function: { name: 'vault_get_tags', arguments: '{}' } }]
    })
  })

  it.each([
    {
      name: 'the provider refuses every request with tools',
      pattern: {
        reject: (body: ChatRequest) => (body.tools ? 'this model does not support tools' : null),
        probeReply: nativeProbeCall
      },
      notice: {
        reason: 'tools_rejected',
        detail: '/v1/chat/completions returned HTTP 400: this model does not support tools'
      }
    },
    {
      name: 'the model answers without calling the tool',
      pattern: { probeReply: { role: 'assistant', content: 'ok' } },
      notice: { reason: 'no_tool_call', detail: null }
    },
    {
      name: 'the provider refuses the tool result',
      pattern: {
        reject: (body: ChatRequest) =>
          body.messages.some((message) => message.role === 'tool')
            ? 'tool messages are not supported'
            : null,
        probeReply: nativeProbeCall
      },
      notice: {
        reason: 'tool_result_rejected',
        detail: '/v1/chat/completions returned HTTP 400: tool messages are not supported'
      }
    }
  ])('says why tools are off when $name', async ({ pattern, notice }) => {
    const { events, execute } = await runTagsTurn({
      ...pattern,
      firstStep: [],
      afterToolStep: []
    })

    expect(events).toEqual([
      { kind: 'tools_unavailable', ...notice },
      { kind: 'assistant_delta', text: 'Plain answer' },
      { kind: 'message_stop' }
    ])
    expect(execute).not.toHaveBeenCalled()
  })
})
