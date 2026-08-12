import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: 'openai-compatible', model }))
  })),
  createOllama: vi.fn(() => vi.fn((model: string) => ({ provider: 'ollama', model }))),
  streamText: vi.fn(),
  stepCountIs: vi.fn((count: number) => ({ type: 'step-count', count }))
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI
}))

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: mocks.createOllama
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
        yield {
          type: 'tool-result',
          toolCallId: 'tool-2',
          toolName: 'vault_update_task',
          input: { id: 'task-1' },
          output: { ok: false, error: { code: 'APPROVAL_REQUIRED', message: 'Needs approval.' } }
        }
        yield {
          type: 'tool-error',
          toolCallId: 'tool-3',
          toolName: 'vault_create_task',
          input: { title: 'Local task' },
          error: 'Tool transport failed.'
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

    expect(mocks.createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:11434/api' })
    )
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
      {
        kind: 'tool_result',
        toolUseId: 'tool-2',
        ok: false,
        data: { ok: false, error: { code: 'APPROVAL_REQUIRED', message: 'Needs approval.' } },
        error: { code: 'APPROVAL_REQUIRED', message: 'Needs approval.' }
      },
      {
        kind: 'tool_result',
        toolUseId: 'tool-3',
        ok: false,
        error: { code: 'TOOL_ERROR', message: 'Tool transport failed.' }
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

  it('runs title and summary turns without tools and exposes stream errors on stderr', async () => {
    mocks.streamText
      .mockReturnValueOnce({
        fullStream: (async function* () {
          yield null
          yield { type: 'finish' }
          throw new Error('local stream failed')
        })()
      })
      .mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'Summary' }
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

    const titleRun = await backend.generateTitle({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'Title this',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: true }
    })
    titleRun.kill()
    const titleEvents = []
    for await (const event of titleRun.events) titleEvents.push(event)
    const stderr = []
    for await (const chunk of titleRun.stderr) stderr.push(chunk.toString())
    await titleRun.cleanup()

    const summaryRun = await backend.summarize({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'Summarize this',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: true }
    })
    const summaryEvents = []
    for await (const event of summaryRun.events) summaryEvents.push(event)

    expect(titleEvents).toEqual([{ kind: 'message_stop' }])
    expect(await titleRun.waitExit()).toBe(1)
    expect(stderr).toEqual(['local stream failed'])
    expect(summaryEvents).toEqual([{ kind: 'assistant_delta', text: 'Summary' }])
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.not.objectContaining({
        tools: expect.anything()
      })
    )
  })

  it('reports backend status when the local provider connection fails', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 })
    ) as unknown as typeof fetch
    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'custom',
        baseUrl: 'http://localhost:11434/v1',
        model: 'missing-model',
        apiKeyConfigured: true,
        allowNonLoopback: false
      }),
      getApiKey: async () => 'secret',
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: fetchImpl
    })

    await expect(backend.getStatus()).resolves.toEqual({
      backend: 'local_openai_compatible',
      available: false,
      reason: 'connection_failed',
      detail: '/v1/models returned HTTP 503'
    })
    expect(fetchImpl).toHaveBeenCalledWith(new URL('models', 'http://localhost:11434/v1/'), {
      headers: { Authorization: 'Bearer secret' }
    })
  })

  it('keeps tools disabled when the selected model is missing or streaming is unavailable', async () => {
    const settings = {
      preset: 'ollama' as const,
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }
    const modelMissingBackend = new LocalOpenAICompatibleBackend({
      getSettings: async () => settings,
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: vi.fn(async () =>
        jsonResponse({ data: [{ id: 'other-model' }] })
      ) as unknown as typeof fetch
    })

    await expect(modelMissingBackend.probeCapabilities()).resolves.toMatchObject({
      connected: true,
      modelAvailable: false,
      streamingSupported: true,
      toolsEnabled: false,
      detail: 'Model llama3.2 was not returned by /v1/models.'
    })

    const noStreamBodyBackend = new LocalOpenAICompatibleBackend({
      getSettings: async () => settings,
      getApiKey: async () => null,
      toolBridge: {
        execute: vi.fn()
      } as never,
      fetch: createProbeFetch({ streamBody: false })
    })

    await expect(noStreamBodyBackend.probeCapabilities()).resolves.toMatchObject({
      connected: true,
      modelAvailable: true,
      streamingSupported: false,
      toolsEnabled: false,
      detail: 'Streaming response body was empty.'
    })
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

  it('reports tool probing failures without enabling local tools', async () => {
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
      fetch: createProbeFetch({ toolProbeStatus: 500 })
    })

    await expect(backend.probeCapabilities()).resolves.toMatchObject({
      connected: true,
      modelAvailable: true,
      streamingSupported: true,
      toolCallingSupported: false,
      toolContinuationSupported: false,
      toolsEnabled: false,
      detail: '/v1/chat/completions returned HTTP 500'
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

  it('ollama preset uses the native /api endpoint with num_ctx 8192', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'ok' }
      })()
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'gemma4',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never,
      fetch: createProbeFetch()
    })

    await backend.runTurn({
      prompt: 'hi',
      conversationId: 'c1',
      windowId: 'window-1',
      options: { backend: 'local_openai_compatible' }
    })

    expect(mocks.createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:11434/api' })
    )
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    const streamArgs = mocks.streamText.mock.calls[0][0]
    expect(streamArgs.providerOptions).toEqual({ ollama: { options: { num_ctx: 8192 } } })
  })

  describe('capability probe caching', () => {
    const baseSettings = {
      preset: 'ollama' as const,
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }

    function alwaysStream(): void {
      mocks.streamText.mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: 'finish' }
        })()
      }))
    }

    function probeCallCount(fetchImpl: typeof fetch): number {
      return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    }

    async function turn(backend: LocalOpenAICompatibleBackend): Promise<void> {
      await backend.runTurn({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        prompt: 'User: hello',
        options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: true }
      })
    }

    it('probes once and reuses the result across turns', async () => {
      alwaysStream()
      const fetchImpl = createProbeFetch()
      const backend = new LocalOpenAICompatibleBackend({
        getSettings: async () => baseSettings,
        getApiKey: async () => null,
        toolBridge: { execute: vi.fn() } as never,
        fetch: fetchImpl
      })

      await turn(backend)
      // /v1/models + streaming completion + two tool round-trip completions
      expect(probeCallCount(fetchImpl)).toBe(4)

      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(4)
      expect(mocks.streamText).toHaveBeenLastCalledWith(
        expect.objectContaining({ tools: expect.anything() })
      )
    })

    it('re-probes when the model, base URL, or API key changes', async () => {
      alwaysStream()
      const fetchImpl = createProbeFetch({ models: ['llama3.2', 'qwen3'] })
      let settings = { ...baseSettings }
      let apiKey: string | null = null
      const backend = new LocalOpenAICompatibleBackend({
        getSettings: async () => settings,
        getApiKey: async () => apiKey,
        toolBridge: { execute: vi.fn() } as never,
        fetch: fetchImpl
      })

      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(4)

      settings = { ...settings, model: 'qwen3' }
      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(8)

      settings = { ...settings, baseUrl: 'http://localhost:1234/v1' }
      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(12)

      apiKey = 'rotated'
      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(16)
    })

    it('never caches an unreachable provider so starting the server takes effect next turn', async () => {
      alwaysStream()
      const live = createProbeFetch()
      let serverUp = false
      const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) =>
        serverUp ? live(url, init) : new Response('down', { status: 503 })
      ) as unknown as typeof fetch

      const backend = new LocalOpenAICompatibleBackend({
        getSettings: async () => baseSettings,
        getApiKey: async () => null,
        toolBridge: { execute: vi.fn() } as never,
        fetch: fetchImpl
      })

      await turn(backend)
      await turn(backend)
      // Both turns hit /v1/models — the failure must never be cached.
      expect(probeCallCount(fetchImpl)).toBe(2)
      expect(mocks.streamText).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ tools: expect.anything() })
      )

      serverUp = true
      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(6)
      expect(mocks.streamText).toHaveBeenLastCalledWith(
        expect.objectContaining({ tools: expect.anything() })
      )
    })

    it('collapses concurrent turns onto a single in-flight probe', async () => {
      alwaysStream()
      const fetchImpl = createProbeFetch()
      const backend = new LocalOpenAICompatibleBackend({
        getSettings: async () => baseSettings,
        getApiKey: async () => null,
        toolBridge: { execute: vi.fn() } as never,
        fetch: fetchImpl
      })

      await Promise.all([turn(backend), turn(backend), turn(backend)])

      expect(probeCallCount(fetchImpl)).toBe(4)
    })

    it('forces a live probe for the settings screen and refreshes the cache', async () => {
      alwaysStream()
      const fetchImpl = createProbeFetch()
      const backend = new LocalOpenAICompatibleBackend({
        getSettings: async () => baseSettings,
        getApiKey: async () => null,
        toolBridge: { execute: vi.fn() } as never,
        fetch: fetchImpl
      })

      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(4)

      await expect(backend.probeCapabilities()).resolves.toMatchObject({ toolsEnabled: true })
      expect(probeCallCount(fetchImpl)).toBe(8)

      await turn(backend)
      expect(probeCallCount(fetchImpl)).toBe(8)
    })

    it('expires a cached probe after the TTL', async () => {
      alwaysStream()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'))
        const fetchImpl = createProbeFetch()
        const backend = new LocalOpenAICompatibleBackend({
          getSettings: async () => baseSettings,
          getApiKey: async () => null,
          toolBridge: { execute: vi.fn() } as never,
          fetch: fetchImpl
        })

        await turn(backend)
        expect(probeCallCount(fetchImpl)).toBe(4)

        vi.setSystemTime(new Date('2026-08-07T00:09:00.000Z'))
        await turn(backend)
        expect(probeCallCount(fetchImpl)).toBe(4)

        vi.setSystemTime(new Date('2026-08-07T00:10:01.000Z'))
        await turn(backend)
        expect(probeCallCount(fetchImpl)).toBe(8)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('non-ollama preset stays on the /v1 openai-compat path without num_ctx', async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'ok' }
      })()
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'lm_studio',
        baseUrl: 'http://localhost:1234/v1',
        model: 'qwen2.5',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never,
      fetch: createProbeFetch()
    })

    await backend.runTurn({
      prompt: 'hi',
      conversationId: 'c1',
      windowId: 'window-1',
      options: { backend: 'local_openai_compatible' }
    })

    expect(mocks.createOpenAI).toHaveBeenCalled()
    expect(mocks.createOllama).not.toHaveBeenCalled()
    expect(mocks.streamText.mock.calls[0][0].providerOptions).toBeUndefined()
  })
})

function createProbeFetch(
  input: {
    toolCall?: boolean
    toolProbeStatus?: number
    streamBody?: boolean
    models?: string[]
  } = {}
): typeof fetch {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    if (href.endsWith('/models')) {
      return jsonResponse({ data: (input.models ?? ['llama3.2']).map((id) => ({ id })) })
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as {
      stream?: boolean
      tools?: unknown[]
    }
    if (body.stream)
      return input.streamBody === false
        ? new Response(null)
        : new Response('data: {"choices":[]}\n\n')
    if (body.tools) {
      if (input.toolProbeStatus)
        return new Response('probe failed', { status: input.toolProbeStatus })
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
