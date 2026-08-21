import type { AgentSourceRef, Message } from '@memry/contracts/ipc-agent'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AssistantMessage } from '../assistant-message'

const openTab = vi.fn()
vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab })
}))

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

function noteSource(id: string, title: string): AgentSourceRef {
  return { kind: 'note', id, title, href: `memry://note/${id}` }
}

function withSources(text: string, sources: AgentSourceRef[]): Message {
  const message = assistantMessage(text)
  return {
    ...message,
    content: { role: 'assistant', data: { text, sources } }
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
      'px-3',
      'py-0'
    )
    expect(content).not.toHaveClass('rounded-lg', 'border-sidebar-border')
  })

  it('keeps the empty streaming indicator unframed', () => {
    const { container } = render(<AssistantMessage message={streamingAssistantMessage()} />)

    const message = container.querySelector('[data-role="assistant"]')
    expect(message).toHaveClass('max-w-full')

    const content = screen.getByRole('status')
    expect(content).toHaveClass('overflow-visible', 'border-0', 'bg-transparent', 'px-3', 'py-0')
    expect(content).not.toHaveClass('rounded-full', 'border-sidebar-border/70', 'shadow-sm')
  })

  it('offers copy on its own when the turn cited nothing', () => {
    render(<AssistantMessage message={assistantMessage('No lookups needed')} />)

    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /source/ })).not.toBeInTheDocument()
  })

  it('copies the markdown the model wrote, not the rendered text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<AssistantMessage message={assistantMessage('**Ship** it')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('**Ship** it')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('counts the cited sources and lists them behind the count', async () => {
    render(
      <AssistantMessage
        message={withSources('Two lookups', [
          noteSource('a', 'Roadmap'),
          noteSource('b', 'Pricing')
        ])}
      />
    )

    const trigger = screen.getByRole('button', { name: /2 sources/ })
    await userEvent.click(trigger)

    const list = screen.getByRole('link', { name: /Roadmap/ }).parentElement
    expect(list).not.toBeNull()
    expect(within(list as HTMLElement).getByRole('link', { name: /Pricing/ })).toBeInTheDocument()
    expect(within(list as HTMLElement).getAllByText('note')).toHaveLength(2)
  })

  it('stacks at most three source icons however many were cited', async () => {
    render(
      <AssistantMessage
        message={withSources(
          'Four lookups',
          ['a', 'b', 'c', 'd'].map((id) => noteSource(id, `Note ${id}`))
        )}
      />
    )

    const trigger = screen.getByRole('button', { name: /4 sources/ })
    expect(trigger.querySelectorAll('[data-agent-link-icon]')).toHaveLength(3)
  })

  it('renders a cited link as an inline chip and leaves the rest as running text', () => {
    render(
      <AssistantMessage
        message={withSources('See [Roadmap](memry://note/a) and [Backlog](memry://note/z)', [
          noteSource('a', 'Roadmap')
        ])}
      />
    )

    const cited = screen.getByRole('link', { name: /Roadmap/ })
    const uncited = screen.getByRole('link', { name: /Backlog/ })

    expect(cited).toHaveClass('agent-source-chip')
    expect(uncited).not.toHaveClass('agent-source-chip')
  })

  it('upgrades a link to a chip when its source ref lands after the text', () => {
    const text = 'See [Roadmap](memry://note/a)'
    const { rerender } = render(<AssistantMessage message={withSources(text, [])} />)

    expect(screen.getByRole('link', { name: /Roadmap/ })).not.toHaveClass('agent-source-chip')

    rerender(<AssistantMessage message={withSources(text, [noteSource('a', 'Roadmap')])} />)

    expect(screen.getByRole('link', { name: /Roadmap/ })).toHaveClass('agent-source-chip')
  })

  it('holds the action row back until the turn stops streaming', () => {
    render(
      <AssistantMessage message={{ ...assistantMessage('Half an ans'), status: 'streaming' }} />
    )

    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })
})
