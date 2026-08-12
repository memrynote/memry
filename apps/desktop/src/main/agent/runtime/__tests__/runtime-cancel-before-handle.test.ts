import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBackendOptions } from '@memry/contracts/ipc-agent'

const mocks = vi.hoisted(() => ({
  setWriteGate: vi.fn(),
  broadcastAgentEvent: vi.fn(),
  streamText: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: mocks.setWriteGate
}))

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: mocks.broadcastAgentEvent
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

vi.mock('../../../telemetry/diagnostics', () => ({
  trackMainError: vi.fn(),
  trackMainLog: vi.fn()
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ provider: 'openai-compatible', model }))
  }))
}))

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => vi.fn((model: string) => ({ provider: 'ollama', model })))
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
  stepCountIs: vi.fn((count: number) => ({ type: 'step-count', count })),
  tool: (definition: unknown) => definition
}))

import { ClaudeCliBackend } from '../../backends/claude-cli-backend'
import { CodexCliBackend } from '../../backends/codex-cli-backend'
import { LocalOpenAICompatibleBackend } from '../../backends/local-openai-compatible-backend'
import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, RawSubprocessHandle } from '../../backends/types'
import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type { Message } from '../../storage/types'
import { AgentRuntime } from '../runtime'
import { runTurn, type TurnDeps } from '../turn'

const CONVERSATION_ID = 'conversation-1'
const MODEL = 'llama3.2'

/**
 * The window this file is about: a stop pressed after the turn started but
 * before `backend.runTurn()` produced its handle. `subprocesses` is empty for
 * that whole stretch, so the cancel used to walk an empty map, find nothing and
 * let the turn run to completion — assistant reply, tokens and all.
 *
 * Every case below drives the REAL backend class and the REAL `runTurn`, with
 * only the outermost I/O faked (fetch for the local probe, spawn for the CLIs),
 * and asserts the user-visible outcome: a cancelled turn, not a completed one.
 */
describe('cancelling a turn before the backend produces its run handle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The widest window of the three, and the one users actually hit: the local
  // backend awaits a capability probe (a /v1/models call plus a streaming
  // completion) before it ever constructs its handle, so a slow or wedged local
  // provider parks the turn here for as long as it likes.
  it('aborts the local backend when stop lands during its capability probe', async () => {
    const signals: AbortSignal[] = []
    mocks.streamText.mockImplementation((options: { abortSignal?: AbortSignal }) => {
      const signal = options.abortSignal
      if (signal) signals.push(signal)
      return {
        fullStream: (async function* () {
          // What the AI SDK does with an already-aborted signal: it never
          // streams a token. Pre-fix the signal is clean here and the reply
          // lands in the transcript.
          if (signal?.aborted) throw new Error('The operation was aborted.')
          yield { type: 'text-delta', text: 'assistant reply' }
          yield { type: 'finish' }
        })()
      }
    })

    const probeEntered = gate()
    const releaseProbe = gate()
    const fetchImpl = (async (input: URL | RequestInfo) => {
      if (String(input).includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: MODEL }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      // Round trip two of the probe. Held open, then failed, so the probe
      // reports "no streaming" and `run()` proceeds without the tool probe.
      probeEntered.open()
      await releaseProbe.promise
      throw new Error('probe connection reset')
    }) as unknown as typeof fetch

    const backend = new LocalOpenAICompatibleBackend({
      getSettings: async () => ({
        preset: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        model: MODEL,
        apiKeyConfigured: false,
        allowNonLoopback: false
      }),
      getApiKey: async () => null,
      toolBridge: { execute: vi.fn() } as never,
      fetch: fetchImpl
    })

    const messages = await runCancelledTurn({
      backend,
      backendOptions: { backend: 'local_openai_compatible', model: MODEL, toolsEnabled: true },
      reachedBackend: probeEntered.promise,
      release: () => releaseProbe.open()
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expectCancelledTurn(messages)
  })

  it('kills the Claude CLI child when stop lands during its spawn', async () => {
    const child = createFakeChild()
    const backend = new ClaudeCliBackend({ spawn: child.spawn })

    const messages = await runCancelledTurn({
      backend,
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low' },
      reachedBackend: child.entered,
      release: child.release
    })

    expect(child.killCount()).toBe(1)
    expectCancelledTurn(messages)
  })

  it('kills the Codex CLI child when stop lands during its spawn', async () => {
    const child = createFakeChild()
    const backend = new CodexCliBackend({ spawn: child.spawn })

    const messages = await runCancelledTurn({
      backend,
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' },
      reachedBackend: child.entered,
      release: child.release
    })

    expect(child.killCount()).toBe(1)
    expectCancelledTurn(messages)
  })
})

describe('AgentRuntime cancel-before-handle bookkeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('kills a run handle that registers after the stop was pressed', () => {
    const runtime = createRuntime()
    const kill = vi.fn()

    runtime.acquireTurnLock(CONVERSATION_ID)
    runtime.cancelTurn(CONVERSATION_ID)
    runtime.trackSubprocess(CONVERSATION_ID, { pid: 1, kill, waitExit: async () => 0 })

    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('leaves handles of other conversations alone', () => {
    const runtime = createRuntime()
    const kill = vi.fn()

    runtime.cancelTurn(CONVERSATION_ID)
    runtime.trackSubprocess('conversation-2', { pid: 2, kill, waitExit: async () => 0 })

    expect(kill).not.toHaveBeenCalled()
  })

  // The flag must never outlive the turn it was pressed against, or the next
  // message the user sends would be stopped before it started.
  it('does not carry a stop over into the next turn', () => {
    const runtime = createRuntime()
    const kill = vi.fn()

    runtime.acquireTurnLock(CONVERSATION_ID)
    runtime.cancelTurn(CONVERSATION_ID)
    runtime.releaseTurnLock(CONVERSATION_ID)

    runtime.acquireTurnLock(CONVERSATION_ID)
    runtime.trackSubprocess(CONVERSATION_ID, { pid: 3, kill, waitExit: async () => 0 })

    expect(kill).not.toHaveBeenCalled()
  })
})

function createRuntime(): AgentRuntime {
  return new AgentRuntime({
    conversations: {} as ConversationStore,
    messages: {} as MessageStore
  })
}

async function runCancelledTurn(input: {
  backend: AgentBackend
  backendOptions: AgentBackendOptions
  reachedBackend: Promise<void>
  release: () => void
}): Promise<Message[]> {
  const runtime = createRuntime()
  const messages = createMessageStore()

  // Mirrors agent-handlers.ts SEND_TURN: the lock is taken, then the turn runs
  // with trackRunHandle wired straight into the runtime's subprocess map.
  runtime.acquireTurnLock(CONVERSATION_ID)
  const turn = runTurn(
    {
      conversations: createConversationStore(),
      messages: messages.store,
      backends: createRegistry(input.backend),
      trackRunHandle: trackRunHandleLike(runtime)
    },
    {
      conversationId: CONVERSATION_ID,
      sourceWindowId: 'window-1',
      text: 'hi',
      attachments: [],
      backendOptions: input.backendOptions
    }
  ).finally(() => runtime.releaseTurnLock(CONVERSATION_ID))

  await input.reachedBackend
  runtime.cancelTurn(CONVERSATION_ID)
  input.release()
  await turn

  return messages.stored
}

function expectCancelledTurn(stored: Message[]): void {
  const assistant = stored.find((message) => message.role === 'assistant')
  expect(assistant?.status).toBe('error')

  const kinds = mocks.broadcastAgentEvent.mock.calls.map(
    (call) => (call[0] as { kind: string }).kind
  )
  expect(kinds).toContain('turn_error')
  expect(kinds).not.toContain('turn_completed')
}

// Exactly the wrapper agent-handlers.ts installs, so the test exercises the real
// registration path rather than a stand-in for it.
function trackRunHandleLike(runtime: AgentRuntime): NonNullable<TurnDeps['trackRunHandle']> {
  return (conversationId, subprocess) => {
    runtime.trackSubprocess(conversationId, subprocess)
    return {
      ...subprocess,
      cleanup: async () => {
        try {
          await subprocess.cleanup()
        } finally {
          runtime.untrackSubprocess(subprocess.pid)
        }
      }
    }
  }
}

/**
 * A CLI child that cannot exist until the test lets the spawn finish. Killed
 * before its stdout is read it produces nothing and exits 143; left alone it
 * exits 0, which is the "stop was dropped" outcome.
 */
function createFakeChild(): {
  spawn: () => Promise<RawSubprocessHandle>
  entered: Promise<void>
  release: () => void
  killCount: () => number
} {
  const entered = gate()
  const release = gate()
  let kills = 0
  let killed = false

  return {
    entered: entered.promise,
    release: () => release.open(),
    killCount: () => kills,
    spawn: async () => {
      entered.open()
      await release.promise
      return {
        stdout: (async function* () {
          if (killed) return
          yield Buffer.from('')
        })(),
        stderr: (async function* () {})(),
        pid: 4242,
        kill: () => {
          kills += 1
          killed = true
        },
        waitExit: async () => (killed ? 143 : 0),
        cleanup: async () => {}
      }
    }
  }
}

function createRegistry(backend: AgentBackend): AgentBackendRegistry {
  return { get: vi.fn(() => backend), list: vi.fn(() => [backend]) }
}

function createMessageStore(): { store: MessageStore; stored: Message[] } {
  let nextId = 0
  const stored: Message[] = []
  const store = {
    append: (input: Parameters<MessageStore['append']>[0]): Message => {
      const message: Message = {
        id: `message-${(nextId += 1)}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock: { d: 1 },
        createdAt: nextId,
        updatedAt: nextId,
        deletedAt: null
      }
      stored.push(message)
      return message
    },
    getById: (id: string) => stored.find((message) => message.id === id) ?? null,
    listByConversation: () => [...stored],
    updateStreaming: vi.fn(),
    markTerminal: (id: string, status: Message['status']) => {
      const message = stored.find((entry) => entry.id === id)
      if (!message) throw new Error(`Message ${id} not found`)
      message.status = status
      return message
    }
  } as unknown as MessageStore

  return { store, stored }
}

function createConversationStore(): ConversationStore {
  const conversation = {
    id: CONVERSATION_ID,
    vaultId: 'vault-1',
    // Not the default title, so the turn never starts a second run for the title.
    title: 'Existing conversation',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    lastSyncedAt: null
  }
  return {
    create: vi.fn(),
    getById: vi.fn(() => conversation),
    listByVault: vi.fn(() => [conversation]),
    update: vi.fn(),
    softDelete: vi.fn(),
    addToTrustList: vi.fn(),
    removeFromTrustList: vi.fn()
  } as unknown as ConversationStore
}

// A one-shot latch. Every wait in this file is for "the code reached here" or
// "the test says go", so nothing needs to carry a value.
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = () => resolve()
  })
  return { promise, open }
}
