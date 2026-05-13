import type { Message } from '@memry/contracts/ipc-agent'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AssistantMessage } from '../assistant-message'

function assistantMessage(text: string): Message {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    role: 'assistant',
    content: { role: 'assistant', data: { text } },
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

function streamingAssistantMessage(): Message {
  return {
    ...assistantMessage(''),
    status: 'streaming'
  }
}

describe('AssistantMessage', () => {
  it('renders assistant responses full width without bubble chrome', () => {
    const { container } = render(<AssistantMessage message={assistantMessage('Plan looks good')} />)

    expect(screen.getByText('Plan looks good')).toBeInTheDocument()

    const message = container.querySelector('[data-role="assistant"]')
    expect(message).toHaveClass('max-w-full')

    const content = message?.firstElementChild
    expect(content).toHaveClass(
      'w-full',
      'max-w-none',
      'overflow-visible',
      'border-0',
      'bg-transparent',
      'px-0',
      'py-0'
    )
    expect(content).not.toHaveClass('rounded-lg', 'border-sidebar-border')
  })

  it('keeps the empty streaming indicator unframed', () => {
    const { container } = render(<AssistantMessage message={streamingAssistantMessage()} />)

    const message = container.querySelector('[data-role="assistant"]')
    expect(message).toHaveClass('max-w-full')

    const content = screen.getByRole('status')
    expect(content).toHaveClass('overflow-visible', 'border-0', 'bg-transparent', 'px-0', 'py-0')
    expect(content).not.toHaveClass('rounded-full', 'border-sidebar-border/70', 'shadow-sm')
  })
})
