import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('../composer', () => ({
  Composer: () => <div data-testid="composer" />
}))

vi.mock('../conversation-header', () => ({
  ConversationHeader: () => <div data-testid="conversation-header" />
}))

import { ConversationView } from '../conversation-view'

describe('ConversationView', () => {
  it('keeps the workspace scrollbar full-width while centering chat content', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        sourceWindowId: 'window-1',
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            title: 'Planning'
          }
        },
        messagesByConversation: {
          'conversation-1': []
        },
        inFlight: {}
      },
      cancelTurn: vi.fn()
    })

    render(<ConversationView conversationId="conversation-1" layout="workspace" />)

    const scrollRegion = screen.getByRole('log')
    expect(scrollRegion).toHaveClass('overflow-y-auto')
    expect(scrollRegion).not.toHaveClass('max-w-[640px]')

    const messageShell = scrollRegion.firstElementChild
    expect(messageShell).toHaveClass('max-w-[64rem]', 'px-8', 'lg:px-24')
    expect(messageShell?.firstElementChild).toHaveClass('max-w-[640px]')

    const header = screen.getByTestId('conversation-header')
    expect(header.parentElement).toHaveClass('max-w-[640px]')
    expect(header.parentElement?.parentElement).toHaveClass('max-w-[64rem]', 'px-8', 'lg:px-24')

    const composer = screen.getByTestId('composer')
    expect(composer.parentElement).toHaveClass('max-w-[640px]')
    expect(composer.parentElement?.parentElement).toHaveClass('max-w-[64rem]', 'pb-10')
  })
})
