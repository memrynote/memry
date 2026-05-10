import { describe, expect, it } from 'vitest'

import type { AgentEvent, BinaryStatus, Conversation, Message } from '@memry/contracts/ipc-agent'

import { agentReducer, initialAgentState, type AgentState } from '../agent-context.reducer'

const binaryStatus: BinaryStatus = {
  detected: true,
  version: '2.1.0',
  meetsMinimum: true,
  minimumRequired: '2.1.0',
  installHint: null
}

const conversation: Conversation = {
  id: 'conversation-1',
  vaultId: 'vault-1',
  title: 'New conversation',
  backend: 'claude_cli',
  trustList: [],
  pinned: false,
  vectorClock: {},
  fieldClocks: {},
  createdAt: 100,
  updatedAt: 100,
  deletedAt: null,
  lastSyncedAt: null
}

function message(input: {
  id: string
  conversationId: string
  role: Message['role']
  text: string
  status: Message['status']
}): Message {
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: {
      role: input.role as 'user' | 'assistant',
      data: { text: input.text }
    } as Message['content'],
    toolCallId: null,
    attachments: [],
    status: input.status,
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

describe('agentReducer', () => {
  it('stores binary and disclosure state', () => {
    const withBinary = agentReducer(initialAgentState, {
      type: 'set_binary_status',
      status: binaryStatus
    })
    const next = agentReducer(withBinary, { type: 'set_disclosure', accepted: true })

    expect(next.binaryStatus).toEqual(binaryStatus)
    expect(next.disclosureAccepted).toBe(true)
  })

  it('stores the source window id for MCP current-note calls', () => {
    const next = agentReducer(initialAgentState, {
      type: 'set_source_window_id',
      sourceWindowId: '42'
    })

    expect(next.sourceWindowId).toBe('42')
  })

  it('sets the active conversation with loaded messages', () => {
    const assistant = message({
      id: 'message-1',
      conversationId: conversation.id,
      role: 'assistant',
      text: 'Hello',
      status: 'completed'
    })

    const next = agentReducer(initialAgentState, {
      type: 'set_active_conversation',
      conversation,
      messages: [assistant]
    })

    expect(next.activeConversationId).toBe(conversation.id)
    expect(next.conversations[conversation.id]).toEqual(conversation)
    expect(next.messagesByConversation[conversation.id]).toEqual([assistant])
  })

  it('appends assistant text deltas to an existing streaming message', () => {
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: {
        [conversation.id]: [
          message({
            id: 'assistant-1',
            conversationId: conversation.id,
            role: 'assistant',
            text: 'Hel',
            status: 'streaming'
          })
        ]
      }
    }

    const event: AgentEvent = {
      kind: 'assistant_text_delta',
      conversationId: conversation.id,
      messageId: 'assistant-1',
      text: 'lo'
    }

    const next = agentReducer(state, { type: 'event', event })

    expect(next.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'assistant',
      data: { text: 'Hello' }
    })
  })

  it('queues pending approvals and clears them by tool call id', () => {
    const event: AgentEvent = {
      kind: 'tool_call_pending_approval',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      name: 'vault_create_task',
      args: { title: 'Buy milk' },
      requiresDiff: false
    }

    const queued = agentReducer(initialAgentState, { type: 'event', event })
    const cleared = agentReducer(queued, { type: 'clear_pending', toolCallId: 'tool-1' })

    expect(queued.pendingApprovals).toEqual([event])
    expect(cleared.pendingApprovals).toEqual([])
  })

  it('clears in-flight state when a turn ends', () => {
    const state: AgentState = {
      ...initialAgentState,
      inFlight: { [conversation.id]: true }
    }

    const next = agentReducer(state, {
      type: 'event',
      event: { kind: 'turn_completed', conversationId: conversation.id, turnId: 'turn-1' }
    })

    expect(next.inFlight[conversation.id]).toBeUndefined()
  })
})
