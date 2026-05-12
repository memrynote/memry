import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: 'openai-compatible', model }))
  })),
  streamText: vi.fn(),
  stepCountIs: vi.fn((count: number) => ({ type: 'step-count', count }))
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  stepCountIs: mocks.stepCountIs,
  tool: (definition: unknown) => definition
}))

import { LocalOpenAICompatibleBackend } from '../local-openai-compatible-backend'

describe('LocalOpenAICompatibleBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('streams assistant text and tool events through the shared backend event contract', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Creating ' }
        yield {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'vault_create_task',
          input: { title: 'Local task' }
        }
        yield {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'vault_create_task',
          input: { title: 'Local task' },
          output: { ok: true, data: { id: 'task-1' } }
        }
        yield { type: 'text-delta', text: 'done.' }
      })()
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: createProbeFetch()
    })

    const run = await backend.runTurn({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'User: create a task',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: true }
    })

    const events = []
    for await (const event of run.events) events.push(event)

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'local'
    })
    expect(mocks.stepCountIs).toHaveBeenCalledWith(8)
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'User: create a task',
        stopWhen: { type: 'step-count', count: 8 },
        tools: expect.objectContaining({
          vault_create_task: expect.any(Object)
        })
      })
    )
    expect(events).toEqual([
      { kind: 'assistant_delta', text: 'Creating ' },
      {
        kind: 'tool_use',
        toolUseId: 'tool-1',
        name: 'vault_create_task',
        args: { title: 'Local task' }
      },
      {
        kind: 'tool_result',
        toolUseId: 'tool-1',
        ok: true,
        data: { ok: true, data: { id: 'task-1' } }
      },
      { kind: 'assistant_delta', text: 'done.' }
    ])
  })

  it('runs chat-only when local tool probing has disabled tool calls', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Chat only' }
      })()
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never
    })

    await backend.runTurn({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'User: hello',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: false }
    })

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.not.objectContaining({
        tools: expect.anything()
      })
    )
  })

  it('probes models, streaming, tool calls, and tool-result continuation', async () => {
    const fetchImpl = createProbeFetch()

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: fetchImpl as typeof fetch
    })

    await expect(backend.probeCapabilities()).resolves.toMatchObject({
      connected: true,
      modelAvailable: true,
      streamingSupported: true,
      toolCallingSupported: true,
      toolContinuationSupported: true,
      toolsEnabled: true
    })
  })

  it('omits tool schemas when the live capability probe fails tool calling', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Chat only' }
      })()
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: createProbeFetch({ toolCall: false })
    })

    await backend.runTurn({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'User: create a task',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: true }
    })

    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.not.objectContaining({
        tools: expect.anything()
      })
    )
  })
})

function createProbeFetch(input: { toolCall?: boolean } = {}): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    if (href.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'llama3.2' }] })
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as {
      stream?: boolean
      tools?: unknown[]
    }
    if (body.stream) return new Response('data: {"choices":[]}\n\n')
    if (body.tools) {
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls:
                input.toolCall === false
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
    }

    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    })
  }) as unknown as typeof fetch
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' }
  })
}
