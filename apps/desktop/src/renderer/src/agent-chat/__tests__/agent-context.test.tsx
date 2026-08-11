import { describe, expect, it } from 'vitest'

import type {
  AgentEvent,
  AgentBackendStatus,
  BackendStatusesResponse,
  Conversation,
  Message
} from '@memry/contracts/ipc-agent'

import { agentReducer, initialAgentState, type AgentState } from '../agent-context.reducer'

const claudeStatus: AgentBackendStatus = {
  backend: 'claude_cli',
  available: true,
  version: '2.1.0',
  minimumRequired: '2.1.0',
  reason: null,
  detail: null
}

const backendStatuses: BackendStatusesResponse = {
  claude_cli: claudeStatus,
  codex_cli: {
    backend: 'codex_cli',
    available: true,
    version: '0.130.0',
    minimumRequired: '0.130.0',
    reason: null,
    detail: null
  },
  local_openai_compatible: {
    backend: 'local_openai_compatible',
    available: true,
    reason: null,
    detail: 'http://localhost:11434/v1'
  }
}

const conversation: Conversation = {
  id: 'conversation-1',
  vaultId: 'vault-1',
  title: 'New conversation',
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
  it('stores disclosure state', () => {
    const next = agentReducer(initialAgentState, { type: 'set_disclosure', accepted: true })

    expect(next.disclosureAccepted).toBe(true)
  })

  it('stores provider backend statuses', () => {
    const next = agentReducer(initialAgentState, {
      type: 'set_backend_statuses',
      statuses: backendStatuses
    })

    expect(next.backendStatuses).toEqual(backendStatuses)
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

  it('stores loaded messages without activating the conversation', () => {
    const existingConversation: Conversation = {
      ...conversation,
      id: 'conversation-existing',
      title: 'Existing chat'
    }
    const loadedConversation: Conversation = {
      ...conversation,
      id: 'conversation-loaded',
      title: 'Loaded chat'
    }
    const assistant = message({
      id: 'message-1',
      conversationId: loadedConversation.id,
      role: 'assistant',
      text: 'Loaded',
      status: 'completed'
    })
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: existingConversation.id,
      conversations: { [existingConversation.id]: existingConversation },
      messagesByConversation: { [existingConversation.id]: [] }
    }

    const next = agentReducer(state, {
      type: 'set_conversation_messages',
      conversation: loadedConversation,
      messages: [assistant]
    })

    expect(next.activeConversationId).toBe(existingConversation.id)
    expect(next.conversations[loadedConversation.id]).toEqual(loadedConversation)
    expect(next.messagesByConversation[loadedConversation.id]).toEqual([assistant])
  })

  it('clears the active conversation without dropping cached conversations or messages', () => {
    const assistant = message({
      id: 'message-1',
      conversationId: conversation.id,
      role: 'assistant',
      text: 'Cached',
      status: 'completed'
    })
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: { [conversation.id]: [assistant] }
    }

    const next = agentReducer(state, { type: 'clear_active_conversation' })

    expect(next.activeConversationId).toBeNull()
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

  it('upserts messages broadcast by the agent runtime', () => {
    const user = message({
      id: 'user-1',
      conversationId: conversation.id,
      role: 'user',
      text: 'hi',
      status: 'completed'
    })
    const assistant = message({
      id: 'assistant-1',
      conversationId: conversation.id,
      role: 'assistant',
      text: '',
      status: 'streaming'
    })
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: { [conversation.id]: [] }
    }

    const withUser = agentReducer(state, {
      type: 'event',
      event: { kind: 'message_upserted', message: user } as AgentEvent
    })
    const withAssistant = agentReducer(withUser, {
      type: 'event',
      event: { kind: 'message_upserted', message: assistant } as AgentEvent
    })
    const updatedAssistant = agentReducer(withAssistant, {
      type: 'event',
      event: {
        kind: 'message_upserted',
        message: {
          ...assistant,
          status: 'completed',
          content: { role: 'assistant', data: { text: 'Hello' } }
        }
      } as AgentEvent
    })

    expect(withAssistant.messagesByConversation[conversation.id].map((item) => item.id)).toEqual([
      'user-1',
      'assistant-1'
    ])
    expect(updatedAssistant.messagesByConversation[conversation.id][1]?.content).toEqual({
      role: 'assistant',
      data: { text: 'Hello' }
    })
  })

  it('updates conversation titles broadcast by the agent runtime', () => {
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: { [conversation.id]: [] }
    }

    const next = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'conversation_updated',
        conversation: {
          ...conversation,
          title: 'Project Roadmap',
          updatedAt: 200
        }
      } as AgentEvent
    })

    expect(next.conversations[conversation.id].title).toBe('Project Roadmap')
    expect(next.activeConversationId).toBe(conversation.id)
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
    const cleared = agentReducer(queued, {
      type: 'clear_pending',
      conversationId: conversation.id,
      toolCallId: 'tool-1'
    })

    expect(queued.pendingApprovals).toEqual([event])
    expect(cleared.pendingApprovals).toEqual([])
  })

  it('creates an inline tool message for pending MCP approvals', () => {
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
            text: '',
            status: 'streaming'
          })
        ]
      }
    }
    const event: AgentEvent = {
      kind: 'tool_call_pending_approval',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      name: 'vault_create_task',
      args: { title: 'Buy milk' },
      requiresDiff: false
    }

    const next = agentReducer(state, { type: 'event', event })

    expect(next.messagesByConversation[conversation.id]).toEqual([
      state.messagesByConversation[conversation.id][0],
      expect.objectContaining({
        id: 'tool-call-tool-1',
        conversationId: conversation.id,
        role: 'tool_call',
        toolCallId: 'tool-1',
        status: 'streaming',
        content: {
          role: 'tool_call',
          data: {
            tool: 'vault_create_task',
            args: { title: 'Buy milk' },
            status: 'approval-requested'
          }
        }
      })
    ])
  })

  it('marks an inline tool message when pending approval is cleared', () => {
    const event: AgentEvent = {
      kind: 'tool_call_pending_approval',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      name: 'vault_create_task',
      args: { title: 'Buy milk' },
      requiresDiff: false
    }
    const queued = agentReducer(
      {
        ...initialAgentState,
        activeConversationId: conversation.id,
        conversations: { [conversation.id]: conversation },
        messagesByConversation: { [conversation.id]: [] }
      },
      { type: 'event', event }
    )

    const approved = agentReducer(queued, {
      type: 'clear_pending',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      status: 'approved'
    })

    expect(approved.pendingApprovals).toEqual([])
    expect(approved.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_create_task',
        args: { title: 'Buy milk' },
        status: 'approval-responded'
      }
    })
  })

  it('creates an inline tool message for auto-accepted started calls', () => {
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: { [conversation.id]: [] }
    }
    const event: AgentEvent = {
      kind: 'tool_call_started',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      name: 'vault_read_note',
      args: { id: 'note-1' }
    }

    const next = agentReducer(state, { type: 'event', event })

    expect(next.messagesByConversation[conversation.id][0]).toEqual(
      expect.objectContaining({
        id: 'tool-call-tool-1',
        role: 'tool_call',
        toolCallId: 'tool-1',
        status: 'streaming',
        content: {
          role: 'tool_call',
          data: {
            tool: 'vault_read_note',
            args: { id: 'note-1' },
            status: 'input-available'
          }
        }
      })
    )
  })

  it('stores completed and failed tool outputs on the tool message', () => {
    const started = agentReducer(
      {
        ...initialAgentState,
        activeConversationId: conversation.id,
        conversations: { [conversation.id]: conversation },
        messagesByConversation: { [conversation.id]: [] }
      },
      {
        type: 'event',
        event: {
          kind: 'tool_call_started',
          conversationId: conversation.id,
          toolCallId: 'tool-1',
          name: 'vault_read_note',
          args: { id: 'note-1' }
        }
      }
    )

    const completed = agentReducer(started, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        result: { title: 'Planning' }
      }
    })

    expect(completed.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-available',
        output: { title: 'Planning' }
      }
    })

    const failed = agentReducer(started, {
      type: 'event',
      event: {
        kind: 'tool_call_failed',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        error: { code: 'PERMISSION_DENIED', message: 'Denied' }
      }
    })

    expect(failed.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-denied',
        error: { code: 'PERMISSION_DENIED', message: 'Denied' }
      }
    })

    const errored = agentReducer(started, {
      type: 'event',
      event: {
        kind: 'tool_call_failed',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        error: { code: 'INTERNAL', message: 'Connection timeout' }
      }
    })

    expect(errored.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-error',
        error: { code: 'INTERNAL', message: 'Connection timeout' }
      }
    })
  })

  it('applies a tool result only to the conversation that owns the tool call', () => {
    const otherConversation: Conversation = { ...conversation, id: 'conversation-2' }
    const otherMessages = [
      message({
        id: 'assistant-2',
        conversationId: otherConversation.id,
        role: 'assistant',
        text: 'Other transcript',
        status: 'completed'
      })
    ]

    const started = agentReducer(
      {
        ...initialAgentState,
        activeConversationId: conversation.id,
        conversations: {
          [conversation.id]: conversation,
          [otherConversation.id]: otherConversation
        },
        messagesByConversation: {
          [conversation.id]: [],
          [otherConversation.id]: otherMessages
        }
      },
      {
        type: 'event',
        event: {
          kind: 'tool_call_started',
          conversationId: conversation.id,
          toolCallId: 'tool-1',
          name: 'vault_read_note',
          args: { id: 'note-1' }
        }
      }
    )

    const completed = agentReducer(started, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        result: { title: 'Planning' }
      }
    })

    expect(completed.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-available',
        output: { title: 'Planning' }
      }
    })
    expect(completed.messagesByConversation[otherConversation.id]).toBe(
      started.messagesByConversation[otherConversation.id]
    )
  })

  it('keeps each in-flight tool call on its own conversation when results interleave', () => {
    const otherConversation: Conversation = { ...conversation, id: 'conversation-2' }
    const base: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: {
        [conversation.id]: conversation,
        [otherConversation.id]: otherConversation
      },
      messagesByConversation: {
        [conversation.id]: [],
        [otherConversation.id]: []
      }
    }

    const bothStarted = [
      { conversationId: conversation.id, toolCallId: 'tool-1' },
      { conversationId: otherConversation.id, toolCallId: 'tool-2' }
    ].reduce(
      (acc, input) =>
        agentReducer(acc, {
          type: 'event',
          event: {
            kind: 'tool_call_started',
            conversationId: input.conversationId,
            toolCallId: input.toolCallId,
            name: 'vault_read_note',
            args: { id: 'note-1' }
          }
        }),
      base
    )

    const secondDone = agentReducer(bothStarted, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: otherConversation.id,
        toolCallId: 'tool-2',
        result: { title: 'Second' }
      }
    })

    expect(secondDone.messagesByConversation[otherConversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-available',
        output: { title: 'Second' }
      }
    })
    expect(secondDone.messagesByConversation[conversation.id]).toBe(
      bothStarted.messagesByConversation[conversation.id]
    )

    const firstDone = agentReducer(secondDone, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        result: { title: 'First' }
      }
    })

    expect(firstDone.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_read_note',
        args: { id: 'note-1' },
        status: 'output-available',
        output: { title: 'First' }
      }
    })
    expect(firstDone.messagesByConversation[otherConversation.id]).toBe(
      secondDone.messagesByConversation[otherConversation.id]
    )
  })

  it('leaves the transcript map untouched when the tool result targets an unloaded conversation', () => {
    const state: AgentState = {
      ...initialAgentState,
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      messagesByConversation: { [conversation.id]: [] }
    }

    const next = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: 'conversation-not-loaded',
        toolCallId: 'tool-9',
        result: { title: 'Planning' }
      }
    })

    expect(next.messagesByConversation).toBe(state.messagesByConversation)
    expect(Object.keys(next.messagesByConversation)).toEqual([conversation.id])
  })

  it('keeps the transcript reference when no message matches the tool call', () => {
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
            text: 'Hello',
            status: 'completed'
          })
        ]
      }
    }

    const next = agentReducer(state, {
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: conversation.id,
        toolCallId: 'tool-not-in-transcript',
        result: { title: 'Planning' }
      }
    })

    expect(next.messagesByConversation).toBe(state.messagesByConversation)
    expect(next.messagesByConversation[conversation.id]).toBe(
      state.messagesByConversation[conversation.id]
    )
  })

  it('applies an approval response only to the conversation that owns the tool call', () => {
    const otherConversation: Conversation = { ...conversation, id: 'conversation-2' }
    const queued = agentReducer(
      {
        ...initialAgentState,
        activeConversationId: conversation.id,
        conversations: {
          [conversation.id]: conversation,
          [otherConversation.id]: otherConversation
        },
        messagesByConversation: {
          [conversation.id]: [],
          [otherConversation.id]: []
        }
      },
      {
        type: 'event',
        event: {
          kind: 'tool_call_pending_approval',
          conversationId: conversation.id,
          toolCallId: 'tool-1',
          name: 'vault_create_task',
          args: { title: 'Buy milk' },
          requiresDiff: false
        }
      }
    )

    const approved = agentReducer(queued, {
      type: 'clear_pending',
      conversationId: conversation.id,
      toolCallId: 'tool-1',
      status: 'approved'
    })

    expect(approved.messagesByConversation[conversation.id][0]?.content).toEqual({
      role: 'tool_call',
      data: {
        tool: 'vault_create_task',
        args: { title: 'Buy milk' },
        status: 'approval-responded'
      }
    })
    expect(approved.messagesByConversation[otherConversation.id]).toBe(
      queued.messagesByConversation[otherConversation.id]
    )
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
