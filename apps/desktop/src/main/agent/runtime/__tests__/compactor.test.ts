import { describe, expect, it, vi } from 'vitest'

import type { MessageStore } from '../../storage/message-store'
import type { Message, MessageContent, MessageRole, MessageStatus } from '../../storage/types'
import { COMPACT_PROMPT, maybeCompact } from '../compactor'

function message(input: {
  id: string
  role?: MessageRole
  content?: MessageContent
  createdAt: number
}): Message {
  const role = input.role ?? 'user'
  return {
    id: input.id,
    conversationId: 'conversation-1',
    role,
    content:
      input.content ??
      ({
        role: 'user',
        data: { text: input.id }
      } as MessageContent),
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: { d: 1 },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null
  }
}

function fakeStore(seed: Message[]): MessageStore {
  const messages = [...seed]
  return {
    append(input) {
      const next: Message = {
        id: `message-${messages.length + 1}`,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCallId: input.toolCallId ?? null,
        attachments: input.attachments,
        status: input.status,
        vectorClock: { d: 1 },
        createdAt: messages.length + 1,
        updatedAt: messages.length + 1,
        deletedAt: null
      }
      messages.push(next)
      return next
    },
    getById(id) {
      return messages.find((item) => item.id === id) ?? null
    },
    listByConversation(conversationId) {
      return messages.filter((item) => item.conversationId === conversationId)
    },
    updateStreaming(id, patch) {
      const existing = this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      Object.assign(existing, patch)
      return existing
    },
    markTerminal(id, status, patch) {
      const existing = this.getById(id)
      if (!existing) throw new Error(`Message ${id} not found`)
      Object.assign(existing, patch, { status })
      return existing
    }
  }
}

describe('Conversation compactor', () => {
  it('does nothing when prompt size is under the threshold', async () => {
    const messages = fakeStore([message({ id: 'm1', createdAt: 1 })])
    const summarize = vi.fn(async () => 'summary')

    const compaction = await maybeCompact({
      conversationId: 'conversation-1',
      messages,
      history: messages.listByConversation('conversation-1'),
      summarize,
      estimateLimit: 100_000,
      currentEstimate: 1_000
    })

    expect(compaction).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
    expect(messages.listByConversation('conversation-1')).toHaveLength(1)
  })

  it('reads the caller-supplied history instead of re-listing the conversation', async () => {
    const seed = Array.from({ length: 6 }, (_, index) =>
      message({
        id: `m${index}`,
        content: { role: 'user', data: { text: `msg-${index}` } },
        createdAt: index
      })
    )
    const messages = fakeStore(seed)
    const listSpy = vi.spyOn(messages, 'listByConversation')
    const history = seed.slice()

    await maybeCompact({
      conversationId: 'conversation-1',
      messages,
      history,
      summarize: vi.fn(async () => 'summary'),
      estimateLimit: 1,
      currentEstimate: 2
    })

    expect(listSpy).not.toHaveBeenCalled()
    // The caller keeps using this array for the rest of the turn, so compaction
    // must not sort it out from under them.
    expect(history).toEqual(seed)
  })

  it('returns the appended compaction marker so callers can skip a re-list', async () => {
    const messages = fakeStore(
      Array.from({ length: 4 }, (_, index) =>
        message({
          id: `m${index}`,
          content: { role: 'user', data: { text: `msg-${index}` } },
          createdAt: index
        })
      )
    )

    const compaction = await maybeCompact({
      conversationId: 'conversation-1',
      messages,
      history: messages.listByConversation('conversation-1'),
      summarize: vi.fn(async () => 'Earlier in this conversation: stuff'),
      estimateLimit: 1,
      currentEstimate: 2
    })

    expect(compaction).not.toBeNull()
    expect(compaction?.role).toBe('system')
    const stored = messages.listByConversation('conversation-1').at(-1)
    expect(compaction).toBe(stored)
  })

  it('summarizes the oldest half and persists a compacted system message', async () => {
    const messages = fakeStore(
      Array.from({ length: 6 }, (_, index) =>
        message({
          id: `m${index}`,
          content: { role: 'user', data: { text: `msg-${index}` } },
          createdAt: index
        })
      )
    )
    const summarize = vi.fn(async (text: string) => `summary: ${text.slice(0, 20)}`)

    await maybeCompact({
      conversationId: 'conversation-1',
      messages,
      history: messages.listByConversation('conversation-1'),
      summarize,
      estimateLimit: 1,
      currentEstimate: 2
    })

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarize).toHaveBeenCalledWith(expect.stringContaining(COMPACT_PROMPT))
    expect(summarize).toHaveBeenCalledWith(expect.stringContaining('msg-0'))
    expect(summarize).toHaveBeenCalledWith(expect.stringContaining('msg-2'))
    expect(summarize).not.toHaveBeenCalledWith(expect.stringContaining('msg-3'))

    const all = messages.listByConversation('conversation-1')
    const systemNote = all.find((item) => item.role === 'system')
    expect(systemNote?.content).toEqual({
      role: 'system',
      data: {
        kind: 'compacted',
        payload: {
          summary: expect.stringContaining('summary:'),
          summarizedThroughId: 'm2',
          summarizedAt: expect.any(Number)
        }
      }
    })
    expect(all.filter((item) => item.role === 'user')).toHaveLength(6)
  })

  it('uses the fixed compaction instruction', () => {
    expect(COMPACT_PROMPT).toContain('Earlier in this conversation')
  })
})
