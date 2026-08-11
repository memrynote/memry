import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Message } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockOpenTab = vi.hoisted(() => vi.fn())
const renderCounts = vi.hoisted(() => ({ user: 0, assistant: 0 }))

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mockOpenTab })
}))

vi.mock('../messages/user-message', () => ({
  UserMessage: ({ message }: { message: Message }) => {
    renderCounts.user += 1
    return <div data-testid={`user-${message.id}`} />
  }
}))

vi.mock('../messages/assistant-message', () => ({
  AssistantMessage: ({ message }: { message: Message }) => {
    renderCounts.assistant += 1
    return (
      <div data-testid={`assistant-${message.id}`}>
        {message.content.role === 'assistant' ? message.content.data.text : ''}
      </div>
    )
  }
}))

import { MessageStream } from '../message-stream'

function baseMessage(input: {
  id: string
  role: Message['role']
  content: Message['content']
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
    vectorClock: {},
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deletedAt: null
  }
}

describe('MessageStream render scoping', () => {
  beforeEach(() => {
    renderCounts.user = 0
    renderCounts.assistant = 0
    mockUseAgentOptional.mockReturnValue(null)
  })

  it('re-renders only the streamed message when a delta lands', () => {
    const users = Array.from({ length: 5 }, (_, index) =>
      baseMessage({
        id: `user-${index}`,
        role: 'user',
        content: { role: 'user', data: { text: `ask ${index}` } },
        createdAt: index
      })
    )
    const assistant = baseMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: { role: 'assistant', data: { text: 'Rea' } },
      createdAt: 100
    })

    const { rerender } = render(<MessageStream messages={[...users, assistant]} />)
    expect(renderCounts.user).toBe(users.length)
    expect(renderCounts.assistant).toBe(1)

    // Exactly what the reducer produces for a delta: a new array where every
    // message except the streamed one keeps its object identity.
    const streamed: Message = {
      ...assistant,
      content: { role: 'assistant', data: { text: 'Ready' } }
    }
    rerender(<MessageStream messages={[...users, streamed]} />)

    expect(renderCounts.user).toBe(users.length)
    expect(renderCounts.assistant).toBe(2)
    expect(screen.getByTestId('assistant-assistant-1')).toHaveTextContent('Ready')
  })

  it('does not re-render any row when the message array identity is unchanged', () => {
    const messages = [
      baseMessage({
        id: 'user-1',
        role: 'user',
        content: { role: 'user', data: { text: 'ask' } },
        createdAt: 1
      }),
      baseMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: { role: 'assistant', data: { text: 'Ready' } },
        createdAt: 2
      })
    ]

    const { rerender } = render(<MessageStream messages={messages} inFlight={false} />)
    expect(renderCounts.user).toBe(1)
    expect(renderCounts.assistant).toBe(1)

    rerender(<MessageStream messages={messages} inFlight />)

    expect(renderCounts.user).toBe(1)
    expect(renderCounts.assistant).toBe(1)
  })
})
