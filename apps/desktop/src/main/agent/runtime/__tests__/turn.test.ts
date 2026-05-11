import { describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type {
  Conversation,
  Message,
  MessageContent,
  MessageRole,
  MessageStatus
} from '../../storage/types'
import { broadcastAgentEvent } from '../event-bus'
import { runTurn } from '../turn'

describe('runTurn against a stub backend', () => {
  it('persists user and assistant messages from stream-json output', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const stdout = (async function* () {
      yield Buffer.from(
        `${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello ' }
        })}\n`
      )
      yield Buffer.from(
        `${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'world' }
        })}\n`
      )
      yield Buffer.from(`${JSON.stringify({ type: 'message_stop' })}\n`)
      yield Buffer.from(
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Hello world'
        })}\n`
      )
    })()
    const spawnSubprocess = vi.fn(async () => ({
      stdout,
      stderr: (async function* () {})(),
      pid: 1,
      kill: vi.fn(),
      waitExit: async () => 0,
      cleanup: vi.fn()
    }))

    await runTurn(
      {
        conversations,
        messages,
        spawnSubprocess,
        toolHandlers: { routeToolCall: vi.fn() }
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        claudeEffort: 'low'
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all).toHaveLength(2)
    expect(all[0].role).toBe('user')
    expect(all[1].role).toBe('assistant')
    expect(all[1].status).toBe('completed')
    expect(all[1].content).toEqual({ role: 'assistant', data: { text: 'Hello world' } })
    expect(spawnSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        effort: 'low',
        prompt: expect.stringContaining('User: hi')
      })
    )
    expect(broadcastAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message_upserted', message: all[0] })
    )
    expect(broadcastAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message_upserted', message: all[1] })
    )
  })

  it('marks the assistant message as errored when the subprocess exits non-zero', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const spawnSubprocess = vi.fn(async () => ({
      stdout: (async function* () {})(),
      stderr: (async function* () {
        yield Buffer.from('Claude auth failed\n')
      })(),
      pid: 1,
      kill: vi.fn(),
      waitExit: async () => 1,
      cleanup: vi.fn()
    }))

    await runTurn(
      {
        conversations,
        messages,
        spawnSubprocess,
        toolHandlers: { routeToolCall: vi.fn() }
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        claudeEffort: 'xhigh'
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all[1].status).toBe('error')
    expect(all[1].content).toEqual({
      role: 'assistant',
      data: { text: 'Claude auth failed' }
    })
    expect(broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'turn_error',
      conversationId: 'conversation-1',
      turnId: expect.any(String),
      message: 'Claude auth failed'
    })
  })

  it('compacts oversized history before assembling the turn prompt', async () => {
    const messages = createFakeMessageStore([
      seedMessage({
        id: 'old-1',
        role: 'user',
        content: { role: 'user', data: { text: 'a'.repeat(210_000) } },
        createdAt: 1
      }),
      seedMessage({
        id: 'old-2',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'b'.repeat(210_000) } },
        createdAt: 2
      })
    ])
    const conversations = createFakeConversationStore()
    const spawnSubprocess = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: (async function* () {
          yield Buffer.from(
            `${JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Earlier in this conversation: old summary' }
            })}\n`
          )
          yield Buffer.from(`${JSON.stringify({ type: 'message_stop' })}\n`)
        })(),
        stderr: (async function* () {})(),
        pid: 1,
        kill: vi.fn(),
        waitExit: async () => 0,
        cleanup: vi.fn()
      })
      .mockResolvedValueOnce({
        stdout: (async function* () {
          yield Buffer.from(`${JSON.stringify({ type: 'message_stop' })}\n`)
        })(),
        stderr: (async function* () {})(),
        pid: 2,
        kill: vi.fn(),
        waitExit: async () => 0,
        cleanup: vi.fn()
      })

    await runTurn(
      {
        conversations,
        messages,
        spawnSubprocess,
        toolHandlers: { routeToolCall: vi.fn() }
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'continue',
        attachments: [],
        claudeEffort: 'high'
      }
    )

    expect(spawnSubprocess).toHaveBeenCalledTimes(2)
    expect(spawnSubprocess.mock.calls[0][0].effort).toBe('high')
    expect(spawnSubprocess.mock.calls[1][0].effort).toBe('high')
    expect(spawnSubprocess.mock.calls[0][0].prompt).toContain('Earlier in this conversation')
    expect(spawnSubprocess.mock.calls[1][0].prompt).toContain(
      'Earlier in this conversation: old summary'
    )
    expect(
      messages.listByConversation('conversation-1').some((message) => message.role === 'system')
    ).toBe(true)
  })

  it('uses the selected backend subprocess to title a default conversation from the first prompt', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const spawnSubprocess = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: (async function* () {
          yield Buffer.from(
            `${JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Project Roadmap' }
            })}\n`
          )
          yield Buffer.from(`${JSON.stringify({ type: 'message_stop' })}\n`)
          yield Buffer.from(
            `${JSON.stringify({
              type: 'result',
              subtype: 'success',
              result: 'Project Roadmap'
            })}\n`
          )
        })(),
        stderr: (async function* () {})(),
        pid: 1,
        kill: vi.fn(),
        waitExit: async () => 0,
        cleanup: vi.fn()
      })
      .mockResolvedValueOnce({
        stdout: (async function* () {
          yield Buffer.from(`${JSON.stringify({ type: 'message_stop' })}\n`)
        })(),
        stderr: (async function* () {})(),
        pid: 2,
        kill: vi.fn(),
        waitExit: async () => 0,
        cleanup: vi.fn()
      })

    await runTurn(
      {
        conversations,
        messages,
        spawnSubprocess,
        toolHandlers: { routeToolCall: vi.fn() }
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Create a roadmap from my project notes',
        attachments: [],
        claudeEffort: 'medium'
      }
    )

    expect(spawnSubprocess).toHaveBeenCalledTimes(2)
    expect(spawnSubprocess.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        effort: 'medium',
        purpose: 'title',
        prompt: expect.stringContaining('Create a roadmap from my project notes')
      })
    )
    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'Project Roadmap' },
      ['title']
    )
    expect(broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'conversation_updated',
      conversation: expect.objectContaining({
        id: 'conversation-1',
        title: 'Project Roadmap'
      })
    })
  })
})

function createFakeConversationStore(overrides: Partial<Conversation> = {}): ConversationStore {
  const conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'New conversation',
    backend: 'claude_cli',
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    lastSyncedAt: null,
    ...overrides
  }

  return {
    create: vi.fn(),
    getById: vi.fn(() => conversation),
    listByVault: vi.fn(() => [conversation]),
    update: vi.fn((_id, patch) => ({ ...conversation, ...patch, updatedAt: 2 })),
    softDelete: vi.fn(),
    addToTrustList: vi.fn(),
    removeFromTrustList: vi.fn()
  }
}

function createFakeMessageStore(seed: Message[] = []): MessageStore {
  const messages: Message[] = [...seed]
  let nextId = 1

  const makeMessage = (input: {
    conversationId: string
    role: MessageRole
    content: MessageContent
    status: MessageStatus
    attachments: Message['attachments']
    toolCallId?: string | null
  }): Message => ({
    id: `message-${nextId++}`,
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
  })

  return {
    append(input) {
      const message = makeMessage(input)
      messages.push(message)
      return message
    },
    getById(id) {
      return messages.find((message) => message.id === id) ?? null
    },
    listByConversation(conversationId) {
      return messages.filter((message) => message.conversationId === conversationId)
    },
    updateStreaming(id, patch) {
      const message = this.getById(id)
      if (!message) throw new Error(`Message ${id} not found`)
      Object.assign(message, patch, { updatedAt: message.updatedAt + 1 })
      return message
    },
    markTerminal(id, status, patch) {
      const message = this.getById(id)
      if (!message) throw new Error(`Message ${id} not found`)
      Object.assign(message, patch, { status, updatedAt: message.updatedAt + 1 })
      return message
    }
  }
}

function seedMessage(input: {
  id: string
  role: MessageRole
  content: MessageContent
  createdAt: number
}): Message {
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role: input.role,
    content: input.content,
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: { d: 1 },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null
  }
}
