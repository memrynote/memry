import { describe, expect, it } from 'vitest'

import type { AgentEvent, Conversation, Message } from '@memry/contracts/ipc-agent'

import {
  agentReducer,
  HYDRATED_CONVERSATION_LIMIT,
  initialAgentState,
  type AgentState
} from '../agent-context.reducer'

function conversation(id: string): Conversation {
  return {
    id,
    vaultId: 'vault-1',
    title: id,
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    lastSyncedAt: null
  }
}

function assistantMessage(input: {
  id: string
  conversationId: string
  text: string
  status?: Message['status']
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: 'assistant',
    content: { role: 'assistant', data: { text: input.text } },
    toolCallId: null,
    attachments: [],
    status: input.status ?? 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

/** Hydrates `count` conversations in order, activating each one in turn. */
function hydrateSequence(count: number, from = 0): AgentState {
  let state = initialAgentState
  for (let index = from; index < from + count; index++) {
    const id = `conversation-${index}`
    state = agentReducer(state, {
      type: 'set_active_conversation',
      conversation: conversation(id),
      messages: [assistantMessage({ id: `message-${index}`, conversationId: id, text: id })]
    })
  }
  return state
}

describe('agentReducer transcript retention', () => {
  it('keeps every hydrated transcript up to the cap', () => {
    const state = hydrateSequence(HYDRATED_CONVERSATION_LIMIT)

    expect(Object.keys(state.messagesByConversation)).toHaveLength(HYDRATED_CONVERSATION_LIMIT)
  })

  it('evicts the least-recently hydrated transcript once the cap is exceeded', () => {
    const state = hydrateSequence(HYDRATED_CONVERSATION_LIMIT + 2)

    expect(Object.keys(state.messagesByConversation)).toHaveLength(HYDRATED_CONVERSATION_LIMIT)
    expect(state.messagesByConversation['conversation-0']).toBeUndefined()
    expect(state.messagesByConversation['conversation-1']).toBeUndefined()
    expect(
      state.messagesByConversation[`conversation-${HYDRATED_CONVERSATION_LIMIT + 1}`]
    ).toBeDefined()
  })

  it('re-hydrating an old conversation makes it most recent again', () => {
    let state = hydrateSequence(HYDRATED_CONVERSATION_LIMIT)
    // Touch the oldest so it is no longer the eviction candidate.
    state = agentReducer(state, {
      type: 'set_active_conversation',
      conversation: conversation('conversation-0'),
      messages: [
        assistantMessage({ id: 'message-0', conversationId: 'conversation-0', text: 'again' })
      ]
    })
    state = agentReducer(state, {
      type: 'set_active_conversation',
      conversation: conversation('conversation-new'),
      messages: []
    })

    expect(state.messagesByConversation['conversation-0']).toBeDefined()
    expect(state.messagesByConversation['conversation-1']).toBeUndefined()
  })

  it('never evicts the active conversation', () => {
    let state = hydrateSequence(1)
    // `conversation-0` stays active while background loads hydrate everything else.
    for (let index = 1; index < HYDRATED_CONVERSATION_LIMIT + 3; index++) {
      const id = `conversation-${index}`
      state = agentReducer(state, {
        type: 'set_conversation_messages',
        conversation: conversation(id),
        messages: [assistantMessage({ id: `message-${index}`, conversationId: id, text: id })]
      })
    }

    expect(state.activeConversationId).toBe('conversation-0')
    expect(state.messagesByConversation['conversation-0']).toBeDefined()
  })

  it('never evicts a conversation with an in-flight turn', () => {
    let state = hydrateSequence(1)
    state = agentReducer(state, {
      type: 'set_in_flight',
      conversationId: 'conversation-0',
      inFlight: true
    })
    state = { ...state, activeConversationId: null }

    for (let index = 1; index < HYDRATED_CONVERSATION_LIMIT + 3; index++) {
      const id = `conversation-${index}`
      state = agentReducer(state, {
        type: 'set_conversation_messages',
        conversation: conversation(id),
        messages: [assistantMessage({ id: `message-${index}`, conversationId: id, text: id })]
      })
    }

    expect(state.messagesByConversation['conversation-0']).toBeDefined()
  })

  it('never evicts a conversation with a pending tool approval', () => {
    let state = hydrateSequence(1)
    const approval: AgentEvent = {
      kind: 'tool_call_pending_approval',
      conversationId: 'conversation-0',
      toolCallId: 'tool-1',
      name: 'vault_create_task',
      args: { title: 'Buy milk' },
      requiresDiff: false
    }
    state = agentReducer(state, { type: 'event', event: approval })
    state = { ...state, activeConversationId: null }

    for (let index = 1; index < HYDRATED_CONVERSATION_LIMIT + 3; index++) {
      const id = `conversation-${index}`
      state = agentReducer(state, {
        type: 'set_conversation_messages',
        conversation: conversation(id),
        messages: [assistantMessage({ id: `message-${index}`, conversationId: id, text: id })]
      })
    }

    expect(state.pendingApprovals).toHaveLength(1)
    expect(state.messagesByConversation['conversation-0']).toBeDefined()
  })

  it('never evicts a transcript holding an unpersisted streaming message', () => {
    let state = agentReducer(initialAgentState, {
      type: 'set_active_conversation',
      conversation: conversation('conversation-0'),
      messages: [
        assistantMessage({
          id: 'assistant-0',
          conversationId: 'conversation-0',
          text: '',
          status: 'streaming'
        })
      ]
    })
    // Main only persists the assistant text when the turn ends, so the deltas
    // accumulated here exist nowhere else.
    state = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'assistant_text_delta',
        conversationId: 'conversation-0',
        messageId: 'assistant-0',
        text: 'partial answer'
      }
    })
    state = { ...state, activeConversationId: null }

    for (let index = 1; index < HYDRATED_CONVERSATION_LIMIT + 3; index++) {
      const id = `conversation-${index}`
      state = agentReducer(state, {
        type: 'set_conversation_messages',
        conversation: conversation(id),
        messages: [assistantMessage({ id: `message-${index}`, conversationId: id, text: id })]
      })
    }

    expect(state.messagesByConversation['conversation-0']?.[0]?.content).toEqual({
      role: 'assistant',
      data: { text: 'partial answer' }
    })
  })

  it('rebuilds an evicted transcript from main on reopen', () => {
    const persisted = [
      assistantMessage({
        id: 'message-0',
        conversationId: 'conversation-0',
        text: 'conversation-0'
      })
    ]
    let state = hydrateSequence(HYDRATED_CONVERSATION_LIMIT + 2)
    expect(state.messagesByConversation['conversation-0']).toBeUndefined()

    state = agentReducer(state, {
      type: 'set_active_conversation',
      conversation: conversation('conversation-0'),
      messages: persisted
    })

    expect(state.messagesByConversation['conversation-0']).toEqual(persisted)
  })

  it('does not duplicate messages when a late event races the reload of an evicted transcript', () => {
    const late = assistantMessage({
      id: 'message-late',
      conversationId: 'conversation-0',
      text: 'late'
    })
    let state = hydrateSequence(HYDRATED_CONVERSATION_LIMIT + 2)
    expect(state.messagesByConversation['conversation-0']).toBeUndefined()

    // Event lands before the reload resolves…
    state = agentReducer(state, {
      type: 'event',
      event: { kind: 'message_upserted', message: late }
    })
    state = agentReducer(state, {
      type: 'set_active_conversation',
      conversation: conversation('conversation-0'),
      messages: [late]
    })
    // …and again after it.
    state = agentReducer(state, {
      type: 'event',
      event: { kind: 'message_upserted', message: late }
    })

    expect(state.messagesByConversation['conversation-0']).toEqual([late])
  })
})
