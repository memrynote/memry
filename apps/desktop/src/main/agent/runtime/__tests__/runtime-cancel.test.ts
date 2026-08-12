import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn(),
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: 'openai-compatible', model }))
  })),
  streamText: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: mocks.setWriteGate
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.createOpenAI
}))

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => vi.fn((model: string) => ({ provider: 'ollama', model })))
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  stepCountIs: vi.fn((count: number) => ({ type: 'step-count', count })),
  tool: (definition: unknown) => definition
}))

import { LocalOpenAICompatibleBackend } from '../../backends/local-openai-compatible-backend'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import { AgentRuntime } from '../runtime'

function runtime(): AgentRuntime {
  return new AgentRuntime({
    conversations: {} as ConversationStore,
    messages: {} as MessageStore,
    spawn: vi.fn() as never
  })
}

describe('AgentRuntime subprocess cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('kills only subprocesses for the cancelled conversation', () => {
    const agentRuntime = runtime()
    const firstKill = vi.fn()
    const secondKill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', {
      pid: 1,
      kill: firstKill,
      waitExit: async () => 0
    })
    agentRuntime.trackSubprocess('conversation-2', {
      pid: 2,
      kill: secondKill,
      waitExit: async () => 0
    })

    agentRuntime.cancelTurn('conversation-1')

    expect(firstKill).toHaveBeenCalledTimes(1)
    expect(secondKill).not.toHaveBeenCalled()
  })

  it('does not kill a subprocess after it is untracked', () => {
    const agentRuntime = runtime()
    const kill = vi.fn()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill, waitExit: async () => 0 })
    agentRuntime.untrackSubprocess(1)
    agentRuntime.cancelTurn('conversation-1')

    expect(kill).not.toHaveBeenCalled()
  })

  // The runtime has no separate AbortController registry — killing the tracked run
  // handle is the whole of cancellation. This is the case that registry was meant to
  // cover: an in-process backend with no OS child, whose only handle on the work is an
  // AbortController. It is tracked and cancelled through exactly the same path as a CLI
  // child, so cancellation reaches it too.
  it('cancels an in-process backend that owns an AbortController instead of an OS child', async () => {
    let signal: AbortSignal | undefined
    mocks.streamText.mockImplementationOnce((options: { abortSignal?: AbortSignal }) => {
      signal = options.abortSignal
      return { fullStream: (async function* () {})() }
    })

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never
    })
    const handle = await backend.runTurn({
      conversationId: 'conversation-1',
      windowId: 'window-1',
      prompt: 'User: hello',
      options: { backend: 'local_openai_compatible', model: 'llama3.2', toolsEnabled: false }
    })

    const agentRuntime = runtime()
    // Mirrors trackRunHandle in agent-handlers.ts, which every backend run passes through.
    agentRuntime.trackSubprocess('conversation-1', handle)

    expect(signal?.aborted).toBe(false)

    agentRuntime.cancelTurn('conversation-2')
    expect(signal?.aborted).toBe(false)

    agentRuntime.cancelTurn('conversation-1')
    expect(signal?.aborted).toBe(true)
  })

  it('kills subprocesses, waits for active turns, and clears the MCP write gate on shutdown', async () => {
    const agentRuntime = runtime()
    const kill = vi.fn()
    const activeTurn = deferred<void>()

    agentRuntime.trackSubprocess('conversation-1', { pid: 1, kill, waitExit: async () => 0 })
    agentRuntime.trackTurn('conversation-1', activeTurn.promise)

    let shutdownSettled = false
    const shutdown = agentRuntime.killAll().then(() => {
      shutdownSettled = true
    })

    await Promise.resolve()

    expect(kill).toHaveBeenCalledTimes(1)
    expect(shutdownSettled).toBe(false)

    activeTurn.resolve()
    await shutdown

    expect(shutdownSettled).toBe(true)
    expect(mocks.setWriteGate).toHaveBeenLastCalledWith(null)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
