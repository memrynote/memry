import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentBackendStatus,
  BackendStatusesResponse,
  Conversation,
  Message
} from '@memry/contracts/ipc-agent'

const t = (key: string) => key

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t })
}))

import { AgentProvider, useAgent } from '../agent-context'

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
  title: 'Planning',
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

const message: Message = {
  id: 'message-1',
  conversationId: conversation.id,
  role: 'assistant',
  content: { role: 'assistant', data: { text: 'Ready' } },
  toolCallId: null,
  attachments: [],
  status: 'completed',
  vectorClock: {},
  createdAt: 100,
  updatedAt: 100,
  deletedAt: null
}

function wrapper({ children }: { children: ReactNode }) {
  return <AgentProvider>{children}</AgentProvider>
}

describe('AgentProvider', () => {
  let eventHandler: ((event: unknown) => void) | null
  let unsubscribe: ReturnType<typeof vi.fn>
  let agentApi: {
    listConversations: ReturnType<typeof vi.fn>
    createConversation: ReturnType<typeof vi.fn>
    loadConversation: ReturnType<typeof vi.fn>
    sendTurn: ReturnType<typeof vi.fn>
    cancelTurn: ReturnType<typeof vi.fn>
    approveTool: ReturnType<typeof vi.fn>
    editTrustList: ReturnType<typeof vi.fn>
    getBackendStatuses: ReturnType<typeof vi.fn>
    getDisclosureState: ReturnType<typeof vi.fn>
    acceptDisclosure: ReturnType<typeof vi.fn>
    getWindowId: ReturnType<typeof vi.fn>
    onEvent: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    eventHandler = null
    unsubscribe = vi.fn()
    agentApi = {
      listConversations: vi.fn().mockResolvedValue([conversation]),
      createConversation: vi.fn().mockResolvedValue({ ...conversation, id: 'conversation-2' }),
      loadConversation: vi.fn().mockResolvedValue({ conversation, messages: [message] }),
      sendTurn: vi.fn().mockResolvedValue({ ok: true }),
      cancelTurn: vi.fn().mockResolvedValue({ ok: true }),
      approveTool: vi.fn().mockResolvedValue({ ok: true }),
      editTrustList: vi.fn().mockResolvedValue({
        ...conversation,
        trustList: ['vault_create_task']
      }),
      getBackendStatuses: vi.fn().mockResolvedValue(backendStatuses),
      getDisclosureState: vi.fn().mockResolvedValue({ accepted: false }),
      acceptDisclosure: vi.fn().mockResolvedValue({ accepted: true }),
      getWindowId: vi.fn().mockResolvedValue({ windowId: 'window-1' }),
      onEvent: vi.fn((callback: (event: unknown) => void) => {
        eventHandler = callback
        return unsubscribe
      })
    }
    ;(window as typeof window & { api: unknown }).api = {
      ...(window.api ?? {}),
      agent: agentApi
    }
  })

  it('bootstraps state from the agent IPC API', async () => {
    const { result, unmount } = renderHook(() => useAgent(), { wrapper })

    await waitFor(() => {
      expect(result.current.state.sourceWindowId).toBe('window-1')
      expect(result.current.state.backendStatuses).toEqual(backendStatuses)
      expect(result.current.state.disclosureAccepted).toBe(false)
      expect(result.current.state.conversations[conversation.id]).toEqual(conversation)
    })

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('routes conversation actions through the agent IPC API', async () => {
    const { result } = renderHook(() => useAgent(), { wrapper })

    await waitFor(() => expect(result.current.state.sourceWindowId).toBe('window-1'))

    await act(async () => {
      await result.current.refreshConversations()
    })
    expect(agentApi.listConversations).toHaveBeenCalledTimes(2)

    let created: Conversation | undefined
    await act(async () => {
      created = await result.current.createConversation({ backend: 'codex_cli' })
    })
    expect(created?.id).toBe('conversation-2')
    expect(agentApi.createConversation).toHaveBeenCalledWith({ backend: 'codex_cli' })
    await waitFor(() => expect(result.current.state.activeConversationId).toBe('conversation-2'))

    await act(async () => {
      await result.current.loadConversation(conversation.id)
    })
    await waitFor(() =>
      expect(result.current.state.messagesByConversation[conversation.id]).toEqual([message])
    )
    expect(result.current.state.activeConversationId).toBe(conversation.id)

    await act(async () => {
      await result.current.loadConversation(conversation.id, { activate: false })
    })
    await waitFor(() =>
      expect(result.current.state.messagesByConversation[conversation.id]).toEqual([message])
    )
    expect(result.current.state.activeConversationId).toBe(conversation.id)

    await act(async () => {
      result.current.clearActiveConversation()
    })
    expect(result.current.state.activeConversationId).toBeNull()
    expect(result.current.state.messagesByConversation[conversation.id]).toEqual([message])

    await act(async () => {
      await result.current.sendTurn({
        conversationId: conversation.id,
        sourceWindowId: 'window-1',
        text: 'Ship it',
        backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
      })
    })
    expect(agentApi.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: conversation.id, attachments: [] })
    )
  })

  it('routes approval, trust, disclosure, and cancel actions through the agent IPC API', async () => {
    const { result } = renderHook(() => useAgent(), { wrapper })

    await waitFor(() => expect(result.current.state.sourceWindowId).toBe('window-1'))

    act(() => {
      eventHandler?.({
        kind: 'tool_call_pending_approval',
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        name: 'vault_create_task',
        args: { title: 'Task' },
        requiresDiff: false
      })
    })
    expect(result.current.state.pendingApprovals).toHaveLength(1)

    await act(async () => {
      await result.current.approveTool({
        conversationId: conversation.id,
        toolCallId: 'tool-1',
        decision: { kind: 'allow' }
      })
    })
    expect(result.current.state.pendingApprovals).toEqual([])

    await act(async () => {
      await result.current.editTrustList({
        conversationId: conversation.id,
        add: ['vault_create_task']
      })
    })
    expect(result.current.state.conversations[conversation.id].trustList).toEqual([
      'vault_create_task'
    ])

    await act(async () => {
      await result.current.acceptDisclosure()
    })
    expect(result.current.state.disclosureAccepted).toBe(true)

    await act(async () => {
      await result.current.cancelTurn(conversation.id)
    })
    expect(agentApi.cancelTurn).toHaveBeenCalledWith({ conversationId: conversation.id })
  })

  it('surfaces send errors and clears the in-flight flag', async () => {
    agentApi.sendTurn.mockResolvedValueOnce({ ok: false, error: 'busy' })
    const { result } = renderHook(() => useAgent(), { wrapper })

    await waitFor(() => expect(result.current.state.sourceWindowId).toBe('window-1'))

    let thrown: unknown
    await act(async () => {
      try {
        await result.current.sendTurn({
          conversationId: conversation.id,
          sourceWindowId: 'window-1',
          text: 'Retry',
          backendOptions: { backend: 'claude_cli', claudeEffort: 'medium' }
        })
      } catch (error) {
        thrown = error
      }
    })

    expect(thrown).toEqual(new Error('busy'))
    expect(result.current.state.inFlight[conversation.id]).toBeUndefined()
    expect(result.current.state.error).toBe('busy')
  })

  it('requires an AgentProvider', () => {
    expect(() => renderHook(() => useAgent())).toThrow('useAgent must be used within AgentProvider')
  })
})
