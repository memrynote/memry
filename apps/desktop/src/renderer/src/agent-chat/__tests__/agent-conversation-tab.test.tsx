import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockLoadConversation = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('../conversation-view', () => ({
  ConversationView: ({
    conversationId,
    layout
  }: {
    conversationId: string | null
    layout?: string
  }) => (
    <div data-testid="conversation-view" data-layout={layout}>
      {conversationId}
    </div>
  )
}))

import { AgentConversationTab } from '../agent-conversation-tab'

describe('AgentConversationTab', () => {
  it('uses the workspace conversation layout for popped-out conversations', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        conversations: {
          'conversation-1': { id: 'conversation-1' }
        },
        messagesByConversation: {
          'conversation-1': []
        }
      },
      loadConversation: mockLoadConversation
    })

    render(<AgentConversationTab conversationId="conversation-1" />)

    expect(screen.getByTestId('conversation-view')).toHaveTextContent('conversation-1')
    expect(screen.getByTestId('conversation-view')).toHaveAttribute('data-layout', 'workspace')
    expect(mockLoadConversation).not.toHaveBeenCalled()
  })
})
