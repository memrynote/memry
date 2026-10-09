import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  warn: vi.fn()
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  stepCountIs: (count: number) => ({ type: 'step-count', count }),
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
  tool: (definition: unknown) => definition
}))

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'
import type { BackendEvent } from '../../cli/types'
import type { TurnWriteGrant } from '../../turn-grants'

const MODEL = 'probe-model'

type ToolStep = 'ok' | 'no_call' | Response | Error

/** A provider that answers the nth tool-step call with `toolStep(n)` and the tool-result call with `resultStep(n)`. */
function provider(
  input: { toolStep?: (n: number) => ToolStep; resultStep?: (n: number) => ToolStep } = {}
): ReturnType<typeof vi.fn> {
  let toolCalls = 0
  let resultCalls = 0
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return json({ data: [{ id: MODEL }] })
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; tools?: unknown }
    if (body.stream) return new Response('data: {"choices":[]}\n\n')
    const step = body.tools
      ? (input.toolStep?.(toolCalls++) ?? 'ok')
      : (input.resultStep?.(resultCalls++) ?? 'ok')
    if (step instanceof Error) throw step
    if (step instanceof Response) return step
    if (!body.tools) return json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    return json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls:
              step === 'no_call'
                ? []
                : [
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
  })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function backendFor(fetchImpl: ReturnType<typeof vi.fn>, apiKey = { value: 'key-1' }) {
  return new LocalOpenAICompatibleBackend({
    getSettings: async () => ({
      preset: 'custom',
      baseUrl: 'https://api.example.test/v1',
      model: MODEL,
      apiKeyConfigured: true,
      allowNonLoopback: true
    }),
    getApiKey: async () => apiKey.value,
    toolBridge: { execute: vi.fn() } as never,
    fetch: fetchImpl as unknown as typeof fetch
  })
}

async function turn(backend: LocalOpenAICompatibleBackend) {
  const run = await backend.runTurn({
    conversationId: 'conversation-1',
    writeGrant: 'grant' as TurnWriteGrant,
    windowId: 'window-1',
    prompt: 'User: hello',
    options: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true }
  })
  const events: BackendEvent[] = []
  for await (const event of run.events) events.push(event)
  const call = mocks.streamText.mock.calls.at(-1)![0] as { tools?: unknown; system?: unknown }
  return { events, tools: call.tools, system: call.system }
}

describe('local provider probe cache and failure classes', () => {
  beforeEach(() => {
    mocks.streamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'finish' }
      })()
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  const transient: Array<[string, () => ToolStep]> = [
    ['a network error', () => new TypeError('fetch failed')],
    ['a timeout', () => new DOMException('The operation timed out.', 'TimeoutError')],
    ['HTTP 429', () => json({ error: { message: 'rate limited' } }, 429)],
    ['HTTP 503', () => json({ error: { message: 'overloaded' } }, 503)]
  ]

  it.each(transient)(
    'keeps tools on after %s at the tool step and probes again next turn',
    async (_, step) => {
      const fetchImpl = provider({ toolStep: (n) => (n === 0 ? step() : 'ok') })
      const backend = backendFor(fetchImpl)

      const first = await turn(backend)
      expect(first.tools).toBeDefined()
      expect(first.system).toBeUndefined()
      expect(first.events).not.toContainEqual(
        expect.objectContaining({ kind: 'tools_unavailable' })
      )
      const line = mocks.warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
      expect(line).toMatch(/transient/i)
      expect(line).toContain(MODEL)

      const callsAfterFirst = fetchImpl.mock.calls.length
      await turn(backend)
      expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    }
  )

  it('keeps tools on after a transient error on the tool-result call', async () => {
    const fetchImpl = provider({ resultStep: (n) => (n === 0 ? json({}, 502) : 'ok') })
    const first = await turn(backendFor(fetchImpl))
    expect(first.tools).toBeDefined()
    expect(first.events).not.toContainEqual(expect.objectContaining({ kind: 'tools_unavailable' }))
  })

  const modelProperty: Array<[string, Parameters<typeof provider>[0], string]> = [
    [
      'a 4xx on both tool-choice shapes',
      { toolStep: () => json({ error: { message: 'tools unsupported' } }, 400) },
      'tools_rejected'
    ],
    ['no tool call', { toolStep: () => 'no_call' }, 'no_tool_call'],
    [
      'a rejected tool result',
      { resultStep: () => json({ error: { message: 'bad tool message' } }, 400) },
      'tool_result_rejected'
    ]
  ]

  it.each(modelProperty)('caches tools off after %s', async (_, input, reason) => {
    const fetchImpl = provider(input)
    const backend = backendFor(fetchImpl)

    const first = await turn(backend)
    expect(first.tools).toBeUndefined()
    expect(first.events[0]).toMatchObject({ kind: 'tools_unavailable', reason })
    const calls = fetchImpl.mock.calls.length

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60 * 60_000)
    const second = await turn(backend)
    expect(fetchImpl.mock.calls.length).toBe(calls)
    expect(second.events[0]).toMatchObject({ kind: 'tools_unavailable', reason })
  })

  it('reuses a pass until the key changes, however long ago it ran', async () => {
    const fetchImpl = provider()
    const apiKey = { value: 'key-1' }
    const backend = backendFor(fetchImpl, apiKey)

    await turn(backend)
    const calls = fetchImpl.mock.calls.length

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
    expect((await turn(backend)).tools).toBeDefined()
    expect(fetchImpl.mock.calls.length).toBe(calls)

    apiKey.value = 'key-2'
    await turn(backend)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(calls)
  })
})
