import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import { TOOL_IMAGE_NOT_SENT } from '../tool-images'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'vision-model'
const IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type Part = { type: string; text?: string; image_url?: { url: string } }

interface ChatMessage {
  role: string
  content?: string | Part[] | null
  tool_calls?: unknown[]
}

interface ChatRequest {
  stream?: boolean
  tools?: unknown[]
  messages: ChatMessage[]
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

function carriesImage(body: ChatRequest): boolean {
  return body.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
  )
}

/** An OpenAI-compatible server; a text-only one answers any image input with HTTP 400. */
function createProvider(requests: ChatRequest[], options: { takesImages: boolean }): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })

    const body = JSON.parse(String(init?.body)) as ChatRequest
    requests.push(body)
    if (!options.takesImages && carriesImage(body)) {
      return json({ error: { message: 'image input is not supported' } }, 400)
    }

    const hasToolResult = body.messages.some((message) => message.role === 'tool')
    if (!body.stream) {
      if (!body.tools) return json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
      return json({
        choices: [
          {
            message: hasToolResult
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
    if (!body.tools) return sse([chunk({ role: 'assistant', content: 'ok' }, 'stop')])
    if (hasToolResult) return sse([chunk({ role: 'assistant', content: 'It says hello.' }, 'stop')])
    return sse([
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'vault_view_file', arguments: '{"id":"file-1"}' }
          }
        ]
      }),
      chunk({}, 'tool_calls')
    ])
  }) as unknown as typeof fetch
}

async function runViewTurn(takesImages: boolean) {
  const requests: ChatRequest[] = []
  const provider = createProvider(requests, { takesImages })
  vi.stubGlobal('fetch', provider)
  const execute = vi.fn(async () => ({
    ok: true as const,
    data: { id: 'file-1', width: 1, height: 1 },
    images: [{ type: 'image' as const, data: IMAGE, mimeType: 'image/png' }]
  }))
  const backend = new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'custom',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: MODEL,
      apiKeyConfigured: false,
      allowNonLoopback: false
    }),
    getApiKey: async () => null,
    toolBridge: { execute } as never,
    fetch: provider
  })

  const run = await backend.runTurn({
    conversationId: 'conversation-1',
    writeGrant: 'turn-grant-1' as TurnWriteGrant,
    windowId: 'window-1',
    prompt: 'User: what does the login screenshot say?',
    options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true }
  })
  const events: BackendEvent[] = []
  for await (const event of run.events) events.push(event)
  return { requests, events, exitCode: await run.waitExit() }
}

function lastToolTurn(requests: ChatRequest[]): ChatRequest {
  const turn = requests.filter(
    (request) => request.stream && request.messages.some((message) => message.role === 'tool')
  )
  expect(turn).toHaveLength(1)
  return turn[0]!
}

describe('LocalOpenAICompatibleBackend with a viewed image', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the image to a model that takes images, after the tool result', async () => {
    const { requests, events, exitCode } = await runViewTurn(true)

    expect(exitCode).toBe(0)
    const continuation = lastToolTurn(requests)
    const toolIndex = continuation.messages.findIndex((message) => message.role === 'tool')
    const tool = continuation.messages[toolIndex]!
    const after = continuation.messages[toolIndex + 1]!

    expect(typeof tool.content).toBe('string')
    expect(tool.content).not.toContain(IMAGE)
    expect(JSON.parse(tool.content as string)).toEqual({
      ok: true,
      data: { id: 'file-1', width: 1, height: 1 }
    })
    expect(after.role).toBe('user')
    expect(after.content).toEqual([
      { type: 'text', text: 'Image returned by vault_view_file (call call_1):' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } }
    ])
    expect(events.find((event) => event.kind === 'assistant_delta')).toEqual({
      kind: 'assistant_delta',
      text: 'It says hello.'
    })
  })

  it('tells a text-only model the image was not sent instead of failing the turn', async () => {
    const { requests, events, exitCode } = await runViewTurn(false)

    expect(exitCode).toBe(0)
    const continuation = lastToolTurn(requests)
    expect(carriesImage(continuation)).toBe(false)
    expect(JSON.stringify(continuation)).not.toContain(IMAGE)
    const tool = continuation.messages.find((message) => message.role === 'tool')!
    expect(tool.content).toContain(TOOL_IMAGE_NOT_SENT)
    expect(events.find((event) => event.kind === 'assistant_delta')).toEqual({
      kind: 'assistant_delta',
      text: 'It says hello.'
    })
    expect(requests.filter((request) => carriesImage(request))).toHaveLength(1)
  })
})
