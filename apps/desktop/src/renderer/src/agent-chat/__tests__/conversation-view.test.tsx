import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null
}))

import { ConversationView } from '../conversation-view'

describe('ConversationView', () => {
  const backendStatuses = {
    claude_cli: { backend: 'claude_cli', available: true },
    codex_cli: { backend: 'codex_cli', available: true },
    local_openai_compatible: { backend: 'local_openai_compatible', available: true }
  }

  it('renders the active conversation header and stored messages', () => {
    const cancelTurn = vi.fn()
    mockUseAgentOptional.mockReturnValue({
      state: {
        backendStatuses,
        disclosureAccepted: true,
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
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
        },
        messagesByConversation: {
          'conversation-1': [
            {
              id: 'message-1',
              conversationId: 'conversation-1',
              role: 'assistant',
              content: { role: 'assistant', data: { text: 'Hello from agent' } },
              toolCallId: null,
              attachments: [],
              status: 'completed',
              vectorClock: {},
              createdAt: 100,
              updatedAt: 100,
              deletedAt: null
            }
          ]
        },
        pendingApprovals: [],
        inFlight: {},
        error: null
      },
      createConversation: vi.fn(),
      loadConversation: vi.fn(),
      cancelTurn
    })

    render(<ConversationView conversationId="conversation-1" />)

    const shell = screen.getByLabelText('Agent chat')

    expect(shell).toHaveClass('bg-background')
    expect(shell).not.toHaveClass('bg-sidebar')
    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument()
    expect(screen.getByText('Hello from agent')).toBeInTheDocument()
  })

  it('keeps the empty conversation view passive before the first prompt is sent', () => {
    const loadConversation = vi.fn()
    mockUseAgentOptional.mockReturnValue({
      state: {
        backendStatuses,
        disclosureAccepted: true,
        sourceWindowId: '42',
        activeConversationId: null,
        conversations: {
          'conversation-1': {
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
        },
        messagesByConversation: {},
        pendingApprovals: [],
        inFlight: {},
        error: null
      },
      createConversation: vi.fn(),
      loadConversation,
      cancelTurn: vi.fn()
    })

    render(<ConversationView conversationId={null} />)

    expect(screen.queryByText('New conversation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument()
    expect(loadConversation).not.toHaveBeenCalled()
  })

  it('cancels an in-flight turn from Stop and Escape', () => {
    const cancelTurn = vi.fn()
    mockUseAgentOptional.mockReturnValue({
      state: {
        backendStatuses,
        disclosureAccepted: true,
        sourceWindowId: '42',
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
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
        },
        messagesByConversation: { 'conversation-1': [] },
        pendingApprovals: [],
        inFlight: { 'conversation-1': true },
        error: null
      },
      createConversation: vi.fn(),
      loadConversation: vi.fn(),
      cancelTurn
    })

    render(<ConversationView conversationId="conversation-1" />)

    const stopButton = screen.getByRole('button', { name: 'Stop' })
    expect(stopButton).toHaveAttribute('type', 'button')
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

    fireEvent.click(stopButton)
    fireEvent.keyDown(screen.getByLabelText('Agent chat'), { key: 'Escape' })

    expect(cancelTurn).toHaveBeenCalledTimes(2)
    expect(cancelTurn).toHaveBeenCalledWith('conversation-1')
  })
})
