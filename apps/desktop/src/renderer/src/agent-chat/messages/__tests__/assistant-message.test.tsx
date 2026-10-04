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

  it('shows live reasoning under a thinking label, then folds it into a summary', async () => {
    const withReasoning = (
      text: string,
      status: Message['status'],
      reasoningDurationMs?: number
    ): Message => ({
      ...assistantMessage(text),
      status,
      content: {
        role: 'assistant',
        data: { text, reasoning: 'Checking the vault first.', reasoningDurationMs }
      }
    })
    const { rerender } = render(<AssistantMessage message={withReasoning('', 'streaming')} />)

    expect(screen.getByText('Thinking…')).toBeInTheDocument()
    expect(screen.getByText('Checking the vault first.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show or hide reasoning' })).toBeNull()

    rerender(<AssistantMessage message={withReasoning('Answer', 'completed', 4200)} />)

    const toggle = screen.getByRole('button', { name: 'Show or hide reasoning' })
    expect(toggle).toHaveTextContent('Thought for 4s')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('says when the model runs without vault tools, while thinking and after the answer', async () => {
    const withoutTools = (text: string, status: Message['status']): Message => ({
      ...assistantMessage(text),
      status,
      content: {
        role: 'assistant',
        data: { text, toolsUnavailable: { detail: 'HTTP 400' } }
      }
    })
    const notice =
      'Vault tools are off for this model. It failed the tool check, so it can only chat. HTTP 400'
    const { rerender } = render(<AssistantMessage message={withoutTools('', 'streaming')} />)

    expect(screen.getByText(notice)).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Agent is thinking' })).toBeInTheDocument()

    rerender(<AssistantMessage message={withoutTools('Plain answer', 'completed')} />)
    expect(screen.getByText(notice)).toBeInTheDocument()
    expect(await screen.findByText('Plain answer')).toBeInTheDocument()
  })

  it('types in text that arrives mid-stream and keeps the caret until it catches up', async () => {
    const streaming = (text: string): Message => ({
      ...assistantMessage(text),
      status: 'streaming'
    })
    const { container, rerender } = render(<AssistantMessage message={streaming('Hello')} />)

    // Text present at mount is shown at once, not re-typed.
    expect(screen.getByText('Hello')).toBeInTheDocument()

    rerender(<AssistantMessage message={streaming('Hello there, this arrived later')} />)
    expect(screen.queryByText('Hello there, this arrived later')).not.toBeInTheDocument()
    expect(container.querySelector('.aicss-stream-caret-steady')).not.toBeNull()

    expect(await screen.findByText('Hello there, this arrived later')).toBeInTheDocument()
    expect(container.querySelector('.aicss-stream-caret-steady')).toBeNull()
    expect(container.querySelector('.aicss-stream-caret')).not.toBeNull()

    rerender(
      <AssistantMessage
        message={{ ...assistantMessage('Hello there, this arrived later'), status: 'completed' }}
      />
    )
    expect(container.querySelector('.aicss-stream-caret')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
