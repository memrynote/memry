import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

vi.mock('../../mcp/lifecycle', () => ({
  setWriteGate: vi.fn()
}))

import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, BackendRunHandle } from '../../backends/types'
import { ClaudeCliBackend } from '../../backends/claude-cli-backend'
import { spawnClaudeTurn } from '../../cli/spawn'
import type { ConversationStore } from '../../storage/conversation-store'
import type { Conversation, Message, MessageStore } from '../../storage/types'
import { AgentRuntime } from '../runtime'
import { runTurn } from '../turn'

const MISSING_BINARY = path.join(tmpdir(), 'memry-missing-cli-binary-1034')

// Byte-for-byte the adapter from agent/bootstrap.ts: its exit promise still
// only listens for 'exit', which is exactly why a child that never starts used
// to strand the turn forever.
const claudeBackendOverMissingBinary = new ClaudeCliBackend({
  spawn: async ({ prompt, effort }) => {
    const sub = await spawnClaudeTurn({ binaryPath: MISSING_BINARY, effort, prompt })
    const stdout = sub.proc.stdout
    const stderr = sub.proc.stderr
    if (!stdout || !stderr) {
      throw new Error('Claude subprocess stdio unavailable')
    }
    const exitCodePromise = new Promise<number>((resolve) => {
      sub.proc.once('exit', (code) => resolve(code ?? 0))
    })

    return {
      stdout,
      stderr,
      pid: sub.pid,
      kill: () => sub.proc.kill('SIGTERM'),
      waitExit: () => exitCodePromise,
      cleanup: sub.cleanup
    }
  }
})

describe('turn lock when the CLI binary cannot be spawned', () => {
  it('releases the lock, tells the user why, and lets the next turn run', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    let backend: AgentBackend = claudeBackendOverMissingBinary
    const backends = { get: () => backend } as unknown as AgentBackendRegistry
    const runtime = new AgentRuntime({ conversations, messages })

    // Mirrors ipc/agent-handlers.ts SEND_TURN: acquire, run, report, release.
    const send = (text: string): Promise<string | null> => {
      runtime.acquireTurnLock('conversation-1')
      return runTurn(
        { conversations, messages, backends },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text,
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )
        .then(() => null)
        .catch((error: unknown) =>
          error instanceof Error && error.message ? error.message : 'Agent turn failed'
        )
        .finally(() => {
          runtime.releaseTurnLock('conversation-1')
        })
    }

    const shownToUser = await send('hi')

    expect(shownToUser).toBe(`Claude CLI failed to start: spawn ${MISSING_BINARY} ENOENT`)
    // No half-written assistant bubble is left behind spinning forever.
    expect(messages.listByConversation('conversation-1').map((m) => m.status)).toEqual([
      'completed'
    ])
    expect(() => runtime.acquireTurnLock('conversation-1')).not.toThrow()
    runtime.releaseTurnLock('conversation-1')

    backend = createStubBackend()
    expect(await send('again')).toBeNull()
    const all = messages.listByConversation('conversation-1')
    expect(all.at(-1)?.status).toBe('completed')
    expect(all.at(-1)?.content).toEqual({ role: 'assistant', data: { text: 'recovered' } })
  }, 15_000)
})

function createStubBackend(): AgentBackend {
  const handle = (): BackendRunHandle => ({
    events: (async function* () {
      yield { kind: 'assistant_delta', text: 'recovered' } as const
      yield { kind: 'message_stop' } as const
    })(),
    pid: 1,
    kill: () => {},
    waitExit: async () => 0,
    cleanup: async () => {}
  })
  return {
    id: 'claude_cli',
    runTurn: async () => handle(),
    generateTitle: async () => handle(),
    summarize: async () => handle(),
    cancel: () => {},
    getStatus: async () => ({
      backend: 'claude_cli' as const,
      available: true,
      reason: null,
      detail: undefined,
      version: undefined,
      minimumRequired: undefined
    })
  }
}

function createFakeConversationStore(): ConversationStore {
  const conversation: Conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'Existing conversation',
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    compactedHistory: null,
    vectorClock: { d: 1 },
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null
  }
  return {
    getById: () => conversation,
    update: (_id, patch) => Object.assign(conversation, patch)
  } as unknown as ConversationStore
}

function createFakeMessageStore(): MessageStore {
  const messages: Message[] = []
  let nextId = 1
  return {
    append(input) {
      const message = {
        id: `message-${nextId++}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: null,
        attachments: input.attachments,
        status: input.status,
        vectorClock: { d: 1 },
        createdAt: nextId,
        updatedAt: nextId,
        deletedAt: null
      } as Message
      messages.push(message)
      return message
    },
    getById: (id) => messages.find((message) => message.id === id) ?? null,
    listByConversation: (conversationId) =>
      messages.filter((message) => message.conversationId === conversationId),
    updateStreaming(id, patch) {
      const message = messages.find((entry) => entry.id === id)
      if (!message) throw new Error(`Message ${id} not found`)
      return Object.assign(message, patch)
    },
    markTerminal(id, status, patch) {
      const message = messages.find((entry) => entry.id === id)
      if (!message) throw new Error(`Message ${id} not found`)
      return Object.assign(message, patch, { status })
    }
  } as unknown as MessageStore
}
