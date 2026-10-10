import type { Message } from '@memry/contracts/ipc-agent'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { UserMessage } from '../user-message'

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

function userMessage(text: string): Message {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    role: 'user',
    content: { role: 'user', data: { text } },
    toolCallId: null,
    attachments: [],
    status: 'completed',
    vectorClock: {},
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null
  }
}

describe('UserMessage', () => {
  it('shows an attached file block as a collapsed card that expands to its content', async () => {
    render(
      <UserMessage
        message={userMessage(
          'what failed?\n\n```memry-file name="app.log" bytes=2048\nERROR disk full\n\n```'
        )}
      />
    )

    expect(screen.getByText('what failed?')).toBeInTheDocument()
    const card = screen.getByText('app.log').closest('details')
    expect(card).not.toBeNull()
    expect(card).not.toHaveAttribute('open')
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    expect(screen.queryByText(/memry-file/)).toBeNull()

    await userEvent.click(screen.getByText('app.log'))
    expect(card).toHaveAttribute('open')
    expect(screen.getByText(/ERROR disk full/)).toBeVisible()
  })
})
