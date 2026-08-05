import { describe, expect, it } from 'vitest'

import {
  AgentAccessModeSchema,
  AgentBackendIdSchema,
  AgentBackendModelListSchema,
  BackendStatusesResponseSchema,
  AgentBackendOptionsSchema,
  AgentChannels,
  AgentEventSchema,
  AgentLocalProviderProbeResultSchema,
  AgentLocalProviderSettingsSchema,
  AgentPreferencesSchema,
  AgentPreferencesUpdateSchema,
  AgentToolApprovalModeSchema,
  ApproveToolRequestSchema,
  BinaryStatusSchema,
  ConversationSchema,
  MessageAttachmentSchema,
  MessageContentSchema,
  PreviewDiffRequestSchema,
  PreviewDiffResponseSchema,
  SendTurnResponseSchema,
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
        GET_BACKEND_STATUSES: 'agent:getBackendStatuses',
        LIST_BACKEND_MODELS: 'agent:listBackendModels',
        GET_LOCAL_PROVIDER_SETTINGS: 'agent:getLocalProviderSettings',
        SET_LOCAL_PROVIDER_SETTINGS: 'agent:setLocalProviderSettings',
        GET_PREFERENCES: 'agent:getPreferences',
        SET_PREFERENCES: 'agent:setPreferences',
        LIST_LOCAL_MODELS: 'agent:listLocalModels',
        TEST_LOCAL_PROVIDER: 'agent:testLocalProvider',
        PROBE_LOCAL_PROVIDER: 'agent:probeLocalProvider',
        ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
        GET_DISCLOSURE_STATE: 'agent:getDisclosureState',
        GET_WINDOW_ID: 'agent:getWindowId'
      },
      events: {
        AGENT_EVENT: 'agent:event',
        CONVERSATIONS_CHANGED: 'agent:conversations-changed',
        MESSAGES_CHANGED: 'agent:messages-changed'
      }
    })
  })
})

describe('agent IPC schemas', () => {
  it('validates supported backend ids and rejects unknown providers', () => {
    expect(AgentBackendIdSchema.safeParse('claude_cli').success).toBe(true)
    expect(AgentBackendIdSchema.safeParse('codex_cli').success).toBe(true)
    expect(AgentBackendIdSchema.safeParse('local_openai_compatible').success).toBe(true)
    expect(AgentBackendIdSchema.safeParse('ollama').success).toBe(false)
  })

  it('validates provider-specific backend options', () => {
    expect(
      AgentBackendOptionsSchema.safeParse({
        backend: 'claude_cli',
        claudeEffort: 'xhigh',
        model: 'sonnet'
      }).success
    ).toBe(true)
    expect(
      AgentBackendOptionsSchema.safeParse({
        backend: 'codex_cli',
        reasoningEffort: 'high',
        model: 'gpt-5.5'
      }).success
    ).toBe(true)
    expect(
      AgentBackendOptionsSchema.safeParse({
        backend: 'local_openai_compatible',
        model: 'llama3.2',
        toolsEnabled: true
      }).success
    ).toBe(true)
    expect(
      AgentBackendOptionsSchema.safeParse({
        backend: 'local_openai_compatible',
        claudeEffort: 'xhigh'
      }).success
    ).toBe(false)
    expect(
      AgentBackendOptionsSchema.safeParse({
        backend: 'claude_cli',
        claudeEffort: 'xhigh',
        reasoningEffort: 'medium'
      }).success
    ).toBe(false)
  })

  it('validates CLI backend model suggestion lists with custom entry support', () => {
    expect(
      AgentBackendModelListSchema.safeParse({
        backend: 'codex_cli',
        supportsCustomModel: true,
        models: [
          { id: 'gpt-5.5', label: 'GPT-5.5' },
          { id: 'gpt-5.4', label: 'GPT-5.4' }
        ]
      }).success
    ).toBe(true)

    expect(
      AgentBackendModelListSchema.safeParse({
        backend: 'local_openai_compatible',
        supportsCustomModel: true,
        models: []
      }).success
    ).toBe(false)
  })

  it('validates send-turn requests with attachments', () => {
    expect(
      SendTurnRequestSchema.safeParse({
        conversationId: 'conversation-1',
        sourceWindowId: '1',
        text: 'Create a task',
        attachments: [{ kind: 'current_note', ref_id: 'current', label: 'Current note' }],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh' }
      }).success
    ).toBe(true)
    expect(
      SendTurnRequestSchema.safeParse({
        conversationId: 'conversation-1',
        sourceWindowId: '1',
        text: 'Summarize these refs',
        attachments: [
          { kind: 'inbox', ref_id: 'inbox-1', label: 'Read later' },
          { kind: 'calendar_event', ref_id: 'event-1', label: 'Planning sync' }
        ],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh' }
      }).success
    ).toBe(true)
    expect(
      SendTurnRequestSchema.safeParse({
        conversationId: 'conversation-1',
        sourceWindowId: '1',
        text: 'Create a task',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'ultrathink' }
      }).success
    ).toBe(false)
  })

  it('validates per-turn agent permissions', () => {
    expect(AgentAccessModeSchema.safeParse('vault_only').success).toBe(true)
    expect(AgentAccessModeSchema.safeParse('computer_access').success).toBe(true)
    expect(AgentAccessModeSchema.safeParse('vault_web').success).toBe(false)

    expect(
      SendTurnRequestSchema.safeParse({
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'search this',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh' },
        permissions: { accessMode: 'vault_only', webSearchEnabled: true }
      }).success
    ).toBe(true)
  })

  it('validates stored message attachments for inbox and calendar refs', () => {
    for (const kind of ['inbox', 'calendar_event'] as const) {
      expect(
        MessageAttachmentSchema.safeParse({
          kind,
          refId: `${kind}-1`,
          label: 'Mentioned item',
          snapshotAt: 100,
          snapshot: { mode: 'reference_only', id: `${kind}-1` }
        }).success
      ).toBe(true)
    }
  })

  it('validates conversation backend model metadata', () => {
    expect(
      ConversationSchema.safeParse({
        id: 'conversation-1',
        vaultId: 'vault-1',
        title: 'Local chat',
        backend: 'local_openai_compatible',
        backendModel: 'llama3.2',
        trustList: [],
        pinned: false,
        vectorClock: {},
        fieldClocks: {},
        createdAt: 100,
        updatedAt: 100,
        deletedAt: null,
        lastSyncedAt: null
      }).success
    ).toBe(true)
  })

  it('validates local provider settings and probe results', () => {
    expect(
      AgentLocalProviderSettingsSchema.safeParse({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.2',
        apiKeyConfigured: false,
        allowNonLoopback: false
      }).success
    ).toBe(true)
    expect(
      AgentLocalProviderSettingsSchema.safeParse({
        preset: 'custom',
        baseUrl: 'https://models.example.com/v1',
        model: 'my-model',
        apiKeyConfigured: true,
        allowNonLoopback: true
      }).success
    ).toBe(true)
    expect(
      AgentLocalProviderProbeResultSchema.safeParse({
        connected: true,
        modelAvailable: true,
        streamingSupported: true,
        toolCallingSupported: true,
        toolContinuationSupported: true,
        toolsEnabled: true,
        detail: null
      }).success
    ).toBe(true)
  })

  it('validates backend status maps for all providers', () => {
    expect(
      BackendStatusesResponseSchema.safeParse({
        claude_cli: {
          backend: 'claude_cli',
          available: true,
          reason: null,
          detail: null,
          version: '2.1.138',
          minimumRequired: '2.1.0'
        },
        codex_cli: {
          backend: 'codex_cli',
          available: true,
          reason: null,
          detail: null,
          version: '0.130.0',
          minimumRequired: '0.130.0'
        },
        local_openai_compatible: {
          backend: 'local_openai_compatible',
          available: true,
          reason: null,
          detail: 'http://localhost:11434/v1'
        }
      }).success
    ).toBe(true)

    expect(
      BackendStatusesResponseSchema.safeParse({
        claude_cli: { backend: 'claude_cli', available: true },
        codex_cli: { backend: 'codex_cli', available: true }
      }).success
    ).toBe(false)
  })

  it('validates send-turn busy responses', () => {
    expect(SendTurnResponseSchema.safeParse({ ok: true }).success).toBe(true)
    expect(
      SendTurnResponseSchema.safeParse({
        ok: false,
        error: 'There is already a turn in flight for this conversation.'
      }).success
    ).toBe(true)
  })

  it('validates approval decisions and binary status', () => {
    expect(AgentToolApprovalModeSchema.safeParse('always_accept').success).toBe(true)
    expect(AgentToolApprovalModeSchema.safeParse('ask').success).toBe(true)
    expect(AgentToolApprovalModeSchema.safeParse('prompt').success).toBe(false)
    expect(
      AgentPreferencesSchema.safeParse({
        accessMode: 'vault_only',
        toolApprovalMode: 'always_accept'
      }).success
    ).toBe(true)
    expect(AgentPreferencesUpdateSchema.parse({})).toEqual({})

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

  it('validates assistant message source refs', () => {
    expect(
      MessageContentSchema.safeParse({
        role: 'assistant',
        data: {
          text: 'See [Movies](memry://note/note-1)',
          sources: [
            {
              kind: 'note',
              id: 'note-1',
              title: 'Movies',
              href: 'memry://note/note-1',
              icon: '🎬'
            },
            {
              kind: 'inbox',
              id: 'inbox-1',
              title: 'Inbox PDF',
              href: 'memry://inbox/inbox-1',
              itemType: 'pdf'
            },
            {
              kind: 'calendar_event',
              id: 'event-1',
              title: 'Planning',
              href: 'memry://calendar/event/event-1?date=2026-05-13',
              visualType: 'event'
            }
          ]
        }
      }).success
    ).toBe(true)
  })

  it('type-checks all renderer event variants', () => {
    const events: AgentEvent[] = [
      {
        kind: 'message_upserted',
        message: {
          id: 'message-1',
          conversationId: 'conversation-1',
          role: 'assistant',
          content: { role: 'assistant', data: { text: 'hello' } },
          toolCallId: null,
          attachments: [],
          status: 'streaming',
          vectorClock: {},
          createdAt: 100,
          updatedAt: 100,
          deletedAt: null
        }
      },
      {
        kind: 'conversation_updated',
        conversation: {
          id: 'conversation-1',
          vaultId: 'vault-1',
          title: 'Project Roadmap',
          backend: 'claude_cli',
          backendModel: null,
          trustList: [],
          pinned: false,
          vectorClock: {},
          fieldClocks: {},
          createdAt: 100,
          updatedAt: 200,
          deletedAt: null,
          lastSyncedAt: null
        }
      },
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
