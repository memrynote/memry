import { describe, expect, it, vi } from 'vitest'

vi.mock('../event-bus', () => ({
  broadcastAgentEvent: vi.fn()
}))

vi.mock('../../../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

import type { ConversationStore } from '../../storage/conversation-store'
import type { AgentBackendRegistry } from '../../backends/registry'
import type { AgentBackend, BackendRunHandle } from '../../backends/types'
import type { MessageStore } from '../../storage/message-store'
import type {
  Conversation,
  Message,
  MessageContent,
  MessageRole,
  MessageStatus
} from '../../storage/types'
import { broadcastAgentEvent } from '../event-bus'
import { trackMainEvent } from '../../../telemetry/track'
import { runTurn } from '../turn'

describe('runTurn against a stub backend', () => {
  it('persists user and assistant messages from stream-json output', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      turn: [
        { kind: 'assistant_delta', text: 'Hello ' },
        { kind: 'assistant_delta', text: 'world' },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all).toHaveLength(2)
    expect(all[0].role).toBe('user')
    expect(all[1].role).toBe('assistant')
    expect(all[1].status).toBe('completed')
    expect(all[1].content).toEqual({ role: 'assistant', data: { text: 'Hello world' } })
    expect(backend.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        options: { backend: 'claude_cli', claudeEffort: 'low' },
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

  it('passes active permissions to the backend run policy and prompt', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      turn: [{ kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'search then inspect files',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' },
        permissions: { accessMode: 'computer_access', webSearchEnabled: true }
      }
    )

    expect(backend.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { accessMode: 'computer_access', webSearchEnabled: true },
        prompt: expect.stringContaining('# Active Permissions')
      })
    )
    expect(backend.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Computer access requested for this turn.')
      })
    )
  })

  it('marks the assistant message as errored when the subprocess exits non-zero', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      turn: [],
      exitCode: 1,
      stderr: 'Claude auth failed\n'
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh' }
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

  it('dispatches Codex conversations through the selected backend contract', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({
      title: 'Existing conversation',
      backend: 'codex_cli'
    })
    const backend = createFakeBackend({
      id: 'codex_cli',
      turn: [{ kind: 'assistant_delta', text: 'Codex says hi' }, { kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'high' }
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all[1].content).toEqual({ role: 'assistant', data: { text: 'Codex says hi' } })
    expect(backend.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        options: { backend: 'codex_cli', reasoningEffort: 'high' },
        purpose: 'turn'
      })
    )
  })

  it('persists assistant source refs collected from tool results', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      turn: [
        { kind: 'tool_use', toolUseId: 'tool-1', name: 'vault_search_notes', args: {} },
        {
          kind: 'tool_result',
          toolUseId: 'tool-1',
          ok: true,
          data: [{ id: 'note-1', title: 'Movies', snippet: '', folder_path: null, icon: '🎬' }]
        },
        {
          kind: 'assistant_delta',
          text: 'Found [Movies](memry://note/note-1).'
        },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'list movie notes',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all[1].content).toEqual({
      role: 'assistant',
      data: {
        text: 'Found [Movies](memry://note/note-1).',
        sources: [
          { kind: 'note', id: 'note-1', title: 'Movies', href: 'memry://note/note-1', icon: '🎬' }
        ]
      }
    })
  })

  it('persists assistant source refs from wrapped MCP tool results', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const toolResult = [
      {
        id: 'inbox-1',
        title: 'Tweet',
        type: 'social',
        visual_type: 'twitter',
        href: 'memry://inbox/inbox-1',
        source_ref: {
          kind: 'inbox',
          id: 'inbox-1',
          title: 'Tweet',
          href: 'memry://inbox/inbox-1',
          itemType: 'social',
          visualType: 'twitter'
        }
      }
    ]
    const backend = createFakeBackend({
      turn: [
        { kind: 'tool_use', toolUseId: 'tool-1', name: 'vault_list_inbox_items', args: {} },
        {
          kind: 'tool_result',
          toolUseId: 'tool-1',
          ok: true,
          data: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] }
        },
        {
          kind: 'assistant_delta',
          text: 'Found [Tweet](memry://inbox/inbox-1).'
        },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'list inbox',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all[1].content).toEqual({
      role: 'assistant',
      data: {
        text: 'Found [Tweet](memry://inbox/inbox-1).',
        sources: [
          {
            kind: 'inbox',
            id: 'inbox-1',
            title: 'Tweet',
            href: 'memry://inbox/inbox-1',
            itemType: 'social',
            visualType: 'twitter'
          }
        ]
      }
    })
  })

  it('marks the assistant message as errored when a backend emits an error event', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({
      title: 'Existing conversation',
      backend: 'codex_cli'
    })
    const backend = createFakeBackend({
      id: 'codex_cli',
      turn: [{ kind: 'error', message: 'Codex auth failed' }, { kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
      }
    )

    const all = messages.listByConversation('conversation-1')
    expect(all[1].status).toBe('error')
    expect(all[1].content).toEqual({
      role: 'assistant',
      data: { text: 'Codex auth failed' }
    })
    expect(broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'turn_error',
      conversationId: 'conversation-1',
      turnId: expect.any(String),
      message: 'Codex auth failed'
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
    const backend = createFakeBackend({
      summary: [{ kind: 'assistant_delta', text: 'Earlier in this conversation: old summary' }],
      turn: [{ kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'continue',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'high' }
      }
    )

    expect(backend.summarize).toHaveBeenCalledTimes(1)
    expect(backend.runTurn).toHaveBeenCalledTimes(1)
    expect(backend.summarize.mock.calls[0][0].options).toEqual({
      backend: 'claude_cli',
      claudeEffort: 'high'
    })
    expect(backend.runTurn.mock.calls[0][0].options).toEqual({
      backend: 'claude_cli',
      claudeEffort: 'high'
    })
    expect(backend.summarize.mock.calls[0][0].prompt).toContain('Earlier in this conversation')
    expect(backend.runTurn.mock.calls[0][0].prompt).toContain(
      'Earlier in this conversation: old summary'
    )
    expect(
      messages.listByConversation('conversation-1').some((message) => message.role === 'system')
    ).toBe(true)
  })

  // Every list re-runs two AEAD opens, two JSON.parses and a zod parse per row,
  // so a turn that lists three or four times pays O(history) that many times.
  it('lists and decrypts the conversation history once per turn', async () => {
    const messages = createFakeMessageStore([
      seedMessage({
        id: 'old-1',
        role: 'user',
        content: { role: 'user', data: { text: 'earlier question' } },
        createdAt: 1
      }),
      seedMessage({
        id: 'old-2',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'earlier answer' } },
        createdAt: 2
      })
    ])
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })
    const listSpy = vi.spyOn(messages, 'listByConversation')

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'follow up',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(backend.summarize).not.toHaveBeenCalled()
    // The single list still has to carry the whole transcript into the prompt.
    const prompt = backend.runTurn.mock.calls[0][0].prompt
    expect(prompt).toContain('earlier question')
    expect(prompt).toContain('earlier answer')
    expect(prompt).toContain('follow up')
  })

  it('lists the conversation history once even when compaction appends a marker', async () => {
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
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      summary: [{ kind: 'assistant_delta', text: 'Earlier in this conversation: old summary' }],
      turn: [{ kind: 'message_stop' }]
    })
    const listSpy = vi.spyOn(messages, 'listByConversation')

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'continue',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(listSpy).toHaveBeenCalledTimes(1)
    // The compacted prompt is rebuilt from the marker the compactor returned,
    // not from a fresh list, so it must still replace the summarized history.
    const prompt = backend.runTurn.mock.calls[0][0].prompt
    expect(prompt).toContain('Earlier in this conversation: old summary')
    expect(prompt).not.toContain('a'.repeat(210_000))
    expect(prompt).toContain('continue')
  })

  it('uses the selected backend subprocess to title a default conversation from the first prompt', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const backend = createFakeBackend({
      title: [{ kind: 'assistant_delta', text: 'Project Roadmap' }],
      turn: [{ kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Create a roadmap from my project notes',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(backend.generateTitle).toHaveBeenCalledTimes(1)
    expect(backend.runTurn).toHaveBeenCalledTimes(1)
    expect(backend.generateTitle.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-1',
        windowId: 'window-1',
        options: { backend: 'claude_cli', claudeEffort: 'medium' },
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

  it('tracks title generation subprocesses with the same turn handle registry', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const backend = createFakeBackend({
      title: [{ kind: 'assistant_delta', text: 'Project Roadmap' }],
      turn: [{ kind: 'message_stop' }]
    })
    const trackRunHandle = vi.fn((_conversationId, handle) => handle)

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend),
        trackRunHandle
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Create a roadmap from my project notes',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(trackRunHandle).toHaveBeenCalledTimes(2)
    expect(trackRunHandle).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ pid: expect.any(Number) })
    )
  })

  it('uses the selected Codex backend to title a default conversation', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ backend: 'codex_cli' })
    const backend = createFakeBackend({
      id: 'codex_cli',
      title: [{ kind: 'assistant_delta', text: 'Book Notes' }],
      turn: [{ kind: 'assistant_delta', text: 'Codex answer' }, { kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'How many book notes do I have?',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
      }
    )

    expect(backend.generateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { backend: 'codex_cli', reasoningEffort: 'medium' },
        purpose: 'title'
      })
    )
    expect(conversations.update).toHaveBeenCalledWith('conversation-1', { title: 'Book Notes' }, [
      'title'
    ])
  })

  it('falls back to a deterministic title when title generation exits non-zero', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const attachment: MessageAttachment = {
      kind: 'note',
      refId: 'note-1',
      label: 'Inbox Spec',
      snapshotAt: 0,
      snapshot: {
        mode: 'inline_note',
        title: 'Inbox Spec',
        contentMarkdown: 'body',
        truncated: false
      }
    }
    const backend = createFakeBackend({
      title: [{ kind: 'assistant_delta', text: 'Ignored title' }],
      titleExitCode: 2,
      titleStderr: 'title failed\n',
      turn: [{ kind: 'message_stop' }]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Plan agent inbox triage snooze flow today',
        attachments: [attachment],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(backend.generateTitle.mock.calls[0][0].prompt).toContain('Attached references:')
    expect(backend.generateTitle.mock.calls[0][0].prompt).toContain('- note: Inbox Spec')
    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'Plan agent inbox triage snooze flow' },
      ['title']
    )
  })

  it('falls back to a deterministic title when title generation throws', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore()
    const backend = createFakeBackend({
      turn: [{ kind: 'message_stop' }]
    })
    backend.generateTitle.mockRejectedValueOnce(new Error('title backend unavailable'))

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Draft launch checklist',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      }
    )

    expect(conversations.update).toHaveBeenCalledWith(
      'conversation-1',
      { title: 'Draft launch checklist' },
      ['title']
    )
  })

  it('broadcasts failed tool results and ignores unknown backend events', async () => {
    const messages = createFakeMessageStore()
    const conversations = createFakeConversationStore({ title: 'Existing conversation' })
    const backend = createFakeBackend({
      turn: [
        { kind: 'tool_result', toolUseId: 'tool-1', ok: false },
        { kind: 'unknown', raw: { kind: 'custom' } },
        { kind: 'message_stop' }
      ]
    })

    await runTurn(
      {
        conversations,
        messages,
        backends: createFakeRegistry(backend)
      },
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hi',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
      }
    )

    expect(broadcastAgentEvent).toHaveBeenCalledWith({
      kind: 'tool_call_failed',
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      error: { code: 'INTERNAL', message: 'unknown' }
    })
    expect(messages.listByConversation('conversation-1')[1].status).toBe('completed')
  })

  describe('telemetry', () => {
    it('tracks agent_chat_started when a turn starts a new (default-titled) conversation', async () => {
      const messages = createFakeMessageStore()
      const conversations = createFakeConversationStore() // default title = 'New conversation'
      const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })

      await runTurn(
        { conversations, messages, backends: createFakeRegistry(backend) },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'hello',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )

      expect(trackMainEvent).toHaveBeenCalledWith(
        'agent_chat_started',
        expect.objectContaining({ surface: 'ai', action: 'started', source: 'claude_cli' })
      )
    })

    it('does not track agent_chat_started for an existing conversation', async () => {
      const messages = createFakeMessageStore()
      const conversations = createFakeConversationStore({ title: 'Existing conversation' })
      const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })
      vi.mocked(trackMainEvent).mockClear()

      await runTurn(
        { conversations, messages, backends: createFakeRegistry(backend) },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'hello',
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )

      const startedCalls = vi
        .mocked(trackMainEvent)
        .mock.calls.filter(([name]) => name === 'agent_chat_started')
      expect(startedCalls).toHaveLength(0)
    })

    it('tracks agent_chat_message_sent on every turn with the backend discriminant', async () => {
      const messages = createFakeMessageStore()
      const conversations = createFakeConversationStore({ title: 'Existing conversation' })
      const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })

      await runTurn(
        { conversations, messages, backends: createFakeRegistry(backend) },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'hello',
          attachments: [],
          backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
        }
      )

      expect(trackMainEvent).toHaveBeenCalledWith(
        'agent_chat_message_sent',
        expect.objectContaining({ surface: 'ai', action: 'sent', source: 'codex_cli' })
      )
    })

    it('does not include input text in tracked telemetry payloads', async () => {
      const messages = createFakeMessageStore()
      const conversations = createFakeConversationStore({ title: 'Existing conversation' })
      const backend = createFakeBackend({ turn: [{ kind: 'message_stop' }] })
      vi.mocked(trackMainEvent).mockClear()

      const sensitiveText = 'my-secret-message-xyz'
      await runTurn(
        { conversations, messages, backends: createFakeRegistry(backend) },
        {
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: sensitiveText,
          attachments: [],
          backendOptions: { backend: 'claude_cli', claudeEffort: 'low' }
        }
      )

      const allArgs = JSON.stringify(vi.mocked(trackMainEvent).mock.calls)
      expect(allArgs).not.toContain(sensitiveText)
    })
  })
})

function createFakeConversationStore(overrides: Partial<Conversation> = {}): ConversationStore {
  const conversation = {
    id: 'conversation-1',
    vaultId: 'vault-1',
    title: 'New conversation',
    backend: 'claude_cli',
    backendModel: null,
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

function createFakeRegistry(backend: AgentBackend): AgentBackendRegistry {
  return {
    get: vi.fn(() => backend),
    list: vi.fn(() => [backend])
  }
}

function createFakeBackend(input: {
  id?: AgentBackend['id']
  turn?: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never
  title?: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never
  summary?: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never
  exitCode?: number
  stderr?: string
  titleExitCode?: number
  titleStderr?: string
}): AgentBackend & {
  runTurn: ReturnType<typeof vi.fn>
  generateTitle: ReturnType<typeof vi.fn>
  summarize: ReturnType<typeof vi.fn>
} {
  const id = input.id ?? 'claude_cli'
  return {
    id,
    runTurn: vi.fn(async () =>
      createRunHandle(input.turn ?? [], { exitCode: input.exitCode ?? 0, stderr: input.stderr })
    ),
    generateTitle: vi.fn(async () =>
      createRunHandle(input.title ?? [], {
        exitCode: input.titleExitCode ?? 0,
        stderr: input.titleStderr
      })
    ),
    summarize: vi.fn(async () => createRunHandle(input.summary ?? [])),
    cancel: vi.fn(),
    getStatus: vi.fn(async () => ({ backend: id, available: true })),
    probeCapabilities: vi.fn()
  }
}

function createRunHandle(
  events: BackendRunHandle['events'] extends AsyncIterable<infer Event> ? Event[] : never,
  opts: { exitCode?: number; stderr?: string } = {}
): BackendRunHandle {
  return {
    events: (async function* () {
      yield* events
    })(),
    stderr: (async function* () {
      if (opts.stderr) yield Buffer.from(opts.stderr)
    })(),
    pid: Math.floor(Math.random() * 1000) + 1,
    kill: vi.fn(),
    waitExit: vi.fn(async () => opts.exitCode ?? 0),
    cleanup: vi.fn(async () => {})
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
