import { render, screen } from '@testing-library/react'
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
      loadConversation: vi.fn()
    })

    render(<ConversationView conversationId="conversation-1" />)

    expect(screen.getByRole('button', { name: /Planning/ })).toBeInTheDocument()
    expect(screen.getByText('Hello from agent')).toBeInTheDocument()
  })
})
