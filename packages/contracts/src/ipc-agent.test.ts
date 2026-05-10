import { describe, expect, it } from 'vitest'

import {
  AgentChannels,
  AgentEventSchema,
  ApproveToolRequestSchema,
  BinaryStatusSchema,
  PreviewDiffRequestSchema,
  PreviewDiffResponseSchema,
  SendTurnRequestSchema,
  type AgentEvent
} from './ipc-agent'

describe('AgentChannels', () => {
  it('exposes the expected invoke and event channels', () => {
    expect(AgentChannels).toEqual({
      invoke: {
        LIST_CONVERSATIONS: 'agent:listConversations',
        CREATE_CONVERSATION: 'agent:createConversation',
        LOAD_CONVERSATION: 'agent:loadConversation',
        SEND_TURN: 'agent:sendTurn',
        CANCEL_TURN: 'agent:cancelTurn',
        APPROVE_TOOL: 'agent:approveTool',
        PREVIEW_DIFF: 'agent:previewDiff',
        EDIT_TRUST_LIST: 'agent:editTrustList',
        GET_BINARY_STATUS: 'agent:getBinaryStatus',
        ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
        GET_DISCLOSURE_STATE: 'agent:getDisclosureState',
        GET_WINDOW_ID: 'agent:getWindowId'
      },
      events: {
        AGENT_EVENT: 'agent:event'
      }
    })
  })
})

describe('agent IPC schemas', () => {
  it('validates send-turn requests with attachments', () => {
    expect(
      SendTurnRequestSchema.safeParse({
        conversationId: 'conversation-1',
        sourceWindowId: '1',
        text: 'Create a task',
        attachments: [{ kind: 'current_note', ref_id: 'current', label: 'Current note' }]
      }).success
    ).toBe(true)
  })

  it('validates approval decisions and binary status', () => {
    expect(
      ApproveToolRequestSchema.safeParse({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        decision: { kind: 'edit_allow', editedArgs: { title: 'Updated title' } }
      }).success
    ).toBe(true)

    expect(
      BinaryStatusSchema.safeParse({
        detected: true,
        version: '1.2.3',
        meetsMinimum: true,
        minimumRequired: '1.0.0',
        installHint: null
      }).success
    ).toBe(true)
  })

  it('validates diff preview requests and responses', () => {
    expect(
      PreviewDiffRequestSchema.safeParse({
        conversationId: 'conversation-1',
        toolCallId: 'tool-1'
      }).success
    ).toBe(true)

    expect(
      PreviewDiffResponseSchema.safeParse({
        title: 'Note',
        current: 'old',
        candidate: 'old\n\nnew'
      }).success
    ).toBe(true)
  })

  it('type-checks all renderer event variants', () => {
    const events: AgentEvent[] = [
      {
        kind: 'assistant_text_delta',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        text: 'hello'
      },
      {
        kind: 'tool_call_started',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        name: 'vault_create_task',
        args: { title: 'Ship' }
      },
      {
        kind: 'tool_call_pending_approval',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        name: 'vault_create_task',
        args: { title: 'Ship' },
        requiresDiff: false
      },
      {
        kind: 'tool_call_completed',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        result: { ok: true }
      },
      {
        kind: 'tool_call_failed',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        error: { code: 'PERMISSION_DENIED', message: 'Denied' }
      },
      { kind: 'turn_completed', conversationId: 'conversation-1', turnId: 'turn-1' },
      { kind: 'turn_cancelled', conversationId: 'conversation-1', turnId: 'turn-1' },
      { kind: 'turn_error', conversationId: 'conversation-1', turnId: 'turn-1', message: 'Failed' }
    ]

    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true)
    }
  })
})
