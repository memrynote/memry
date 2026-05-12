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
  it('renders the active conversation header and stored messages', () => {
    const cancelTurn = vi.fn()
    mockUseAgentOptional.mockReturnValue({
      state: {
        binaryStatus: null,
        disclosureAccepted: true,
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            vaultId: 'vault-1',
            title: 'Planning',
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

    expect(screen.getByRole('button', { name: /Planning/ })).toBeInTheDocument()
    expect(screen.getByText('Hello from agent')).toBeInTheDocument()
  })

  it('cancels an in-flight turn from Stop and Escape', () => {
    const cancelTurn = vi.fn()
    mockUseAgentOptional.mockReturnValue({
      state: {
        binaryStatus: null,
        disclosureAccepted: true,
        sourceWindowId: '42',
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            vaultId: 'vault-1',
            title: 'Planning',
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
