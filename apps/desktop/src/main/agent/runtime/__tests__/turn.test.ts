import { describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

import type { ConversationStore } from '../../storage/conversation-store'
import type { MessageStore } from '../../storage/message-store'
import type { Message, MessageContent, MessageRole, MessageStatus } from '../../storage/types'
import { runTurn } from '../turn'

describe('runTurn against a stub backend', () => {
  it('persists user and assistant messages from stream-json output', async () => {
    const messages = createFakeMessageStore()
    const conversations = {} as ConversationStore
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
        attachments: []
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
        prompt: expect.stringContaining('User: hi')
      })
    )
  })
})

function createFakeMessageStore(): MessageStore {
  const messages: Message[] = []
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
