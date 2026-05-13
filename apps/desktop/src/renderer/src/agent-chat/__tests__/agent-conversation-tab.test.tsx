import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockLoadConversation = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('../conversation-view', () => ({
  ConversationView: ({ conversationId }: { conversationId: string | null }) => (
    <div data-testid="conversation-view">{conversationId}</div>
  )
}))

import { AgentConversationTab } from '../agent-conversation-tab'

describe('AgentConversationTab', () => {
  it('centers popped-out conversations using the note editor reading column', () => {
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

    const { container } = render(<AgentConversationTab conversationId="conversation-1" />)

    const shell = container.firstElementChild
    expect(shell).toHaveClass('mx-auto', 'max-w-[64rem]', 'px-8', 'lg:px-24')

    const column = shell?.firstElementChild
    expect(column).toHaveClass('mx-auto', 'max-w-[640px]')
    expect(screen.getByTestId('conversation-view')).toHaveTextContent('conversation-1')
    expect(mockLoadConversation).not.toHaveBeenCalled()
  })
})
