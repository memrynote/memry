import type { AgentSourceRef, Message } from '@memry/contracts/ipc-agent'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('shows a failed turn as an error with the provider message', () => {
    render(
      <AssistantMessage
        message={{ ...assistantMessage('tool_choice is not supported'), status: 'error' }}
      />
    )

    expect(
      screen.getByText(
        'The reply stopped with an error. Your message is kept, so you can send it again.'
      )
    ).toHaveClass('font-medium')
    expect(screen.getByText('tool_choice is not supported').parentElement).toHaveClass(
      'text-destructive'
    )
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
  })

  it('still says a turn failed when the error carries no message', () => {
    render(<AssistantMessage message={{ ...assistantMessage(''), status: 'error' }} />)

    expect(
      screen.getByText(
        'The reply stopped with an error. Your message is kept, so you can send it again.'
      )
    ).toBeInTheDocument()
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

  it.each([
    {
      reason: 'tools_rejected' as const,
      detail: '/v1/chat/completions returned HTTP 400: this model does not support tools',
      notice:
        'Vault tools are off for this model. The provider refused a test request that included tools, so the model can only chat. The provider said: /v1/chat/completions returned HTTP 400: this model does not support tools'
    },
    {
      reason: 'no_tool_call' as const,
      detail: null,
      notice:
        'Vault tools are off for this model. It answered a test request without calling the tool, so it can only chat.'
    },
    {
      reason: 'tool_result_rejected' as const,
      detail: null,
      notice:
        'Vault tools are off for this model. It called a test tool but failed after getting the result back, so it can only chat.'
    },
    {
      reason: 'streaming_unsupported' as const,
      detail: null,
      notice:
        'Vault tools are off for this model. The provider did not stream a test reply, so the model can only chat.'
    }
  ])('explains in plain words why tools are off: $reason', ({ reason, detail, notice }) => {
    render(
      <AssistantMessage
        message={{
          ...assistantMessage('Plain answer'),
          content: {
            role: 'assistant',
            data: { text: 'Plain answer', toolsUnavailable: { reason, detail } }
          }
        }}
      />
    )

    expect(screen.getByText(notice)).toBeInTheDocument()
  })

  it.each([
    'I will search.\n<\uff5c\uff5cDSML\uff5c\uff5c calls>\n<\uff5c\uff5cDSML\uff5c\uff5c invoke name="vault_search_notes">',
    '<tool_calls><vault_search_notes query="X" /></tool_calls>',
    '<tool_call>{"name":"vault_search_notes"}</tool_call>',
    '<function_calls><invoke name="vault_search_notes"></invoke></function_calls>'
  ])('says nothing ran when a tools-off answer writes a tool call as text: %s', (text) => {
    const nothingRan = /wrote a tool call as text, and nothing ran/
    const message = (toolsUnavailable?: { reason: 'no_tool_call'; detail: null }): Message => ({
      ...assistantMessage(text),
      content: { role: 'assistant', data: { text, ...(toolsUnavailable && { toolsUnavailable }) } }
    })
    const { rerender } = render(
      <AssistantMessage message={message({ reason: 'no_tool_call', detail: null })} />
    )
    expect(screen.getByText(nothingRan)).toBeInTheDocument()

    rerender(<AssistantMessage message={message()} />)
    expect(screen.queryByText(nothingRan)).not.toBeInTheDocument()
  })

  it('adds no nothing-ran sentence to a plain tools-off answer', () => {
    render(
      <AssistantMessage
        message={{
          ...assistantMessage('Plain answer'),
          content: {
            role: 'assistant',
            data: {
              text: 'Plain answer',
              toolsUnavailable: { reason: 'no_tool_call', detail: null }
            }
          }
        }}
      />
    )
    expect(screen.queryByText(/nothing ran/)).not.toBeInTheDocument()
  })

  it('says the turn stopped at the step limit and continues from a button', async () => {
    const stopped = (text: string): Message => ({
      ...assistantMessage(text),
      content: { role: 'assistant', data: { text, stepLimitReached: true } }
    })
    const onContinue = vi.fn()
    const { rerender } = render(
      <AssistantMessage message={stopped('Done: A. Left: B.')} onContinue={onContinue} />
    )

    expect(screen.getByText('Stopped at the step limit.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/nothing ran/)).not.toBeInTheDocument()

    rerender(<AssistantMessage message={stopped('Done: A. Left: B.')} />)
    expect(screen.getByText('Stopped at the step limit.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()

    rerender(
      <AssistantMessage
        message={stopped('<tool_call>{"name":"vault_get_tags"}</tool_call>')}
        onContinue={onContinue}
      />
    )
    expect(screen.getByText(/wrote a tool call as text, and nothing ran/)).toBeInTheDocument()

    rerender(<AssistantMessage message={assistantMessage('Done.')} onContinue={onContinue} />)
    expect(screen.queryByText('Stopped at the step limit.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
  })

  it('shows a waiting timer under a started answer after 3 s without a delta', () => {
    vi.useFakeTimers()
    try {
      const streaming = (text: string): Message => ({
        ...assistantMessage(text),
        status: 'streaming'
      })
      const waiting = (): HTMLElement | null =>
        screen.queryByRole('status', { name: 'Agent is thinking' })
      const { rerender } = render(<AssistantMessage message={streaming('Handing this off.')} />)

      act(() => vi.advanceTimersByTime(2900))
      expect(waiting()).toBeNull()

      act(() => vi.advanceTimersByTime(1200))
      expect(screen.getByText('Handing this off.')).toBeInTheDocument()
      expect(waiting()).toHaveTextContent('4.1s')

      rerender(<AssistantMessage message={streaming('Handing this off. Done')} />)
      expect(waiting()).toBeNull()

      act(() => vi.advanceTimersByTime(3500))
      expect(waiting()).toHaveTextContent('3.5s')

      rerender(
        <AssistantMessage
          message={{ ...assistantMessage('Handing this off. Done'), status: 'completed' }}
        />
      )
      expect(waiting()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('reasoning that grows after the answer started', () => {
    const turn = (text: string, reasoning: string): Message => ({
      ...assistantMessage(text),
      status: 'streaming',
      content: { role: 'assistant', data: { text, reasoning } }
    })
    const toggle = (): HTMLElement => screen.getByRole('button', { name: 'Show or hide reasoning' })

    // A browser-like viewport: a 180 px box whose scrollTop clamps, and whose
    // content height changes reach the component only through ResizeObserver,
    // the way Streamdown commits new lines in a transition after render.
    const observers: ResizeObserverCallback[] = []
    beforeEach(() => {
      observers.length = 0
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: ResizeObserverCallback) {
            observers.push(callback)
          }
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        }
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function stubViewport(container: HTMLElement): {
      el: HTMLElement
      landUnobserved: (h: number) => void
      grow: (h: number) => void
    } {
      const el = container.querySelector<HTMLElement>('.aicss-tr-viewport')
      if (!el) throw new Error('no reasoning viewport')
      let height = 500
      let top = 0
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 180 })
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height })
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => (top = Math.max(0, Math.min(v, height - 180)))
      })
      const landUnobserved = (h: number): void => {
        height = h
      }
      const grow = (h: number): void => {
        landUnobserved(h)
        act(() => {
          for (const callback of observers) callback([], {} as ResizeObserver)
        })
      }
      return { el, landUnobserved, grow }
    }

    it('puts the header back into its live state without unfolding the block', () => {
      const { rerender } = render(<AssistantMessage message={turn('', 'Step one.')} />)
      rerender(<AssistantMessage message={turn('Let me read the note.', 'Step one.')} />)
      expect(toggle()).toHaveTextContent('Thought')

      rerender(<AssistantMessage message={turn('Let me read the note.', 'Step one. Step two.')} />)
      expect(toggle()).toHaveTextContent('Thinking…')
      expect(toggle()).toHaveAttribute('aria-expanded', 'false')

      rerender(
        <AssistantMessage message={turn('Let me read the note. Done.', 'Step one. Step two.')} />
      )
      expect(toggle()).not.toHaveTextContent('Thinking…')
    })

    it('keeps reasoning that first arrives after the answer folded', () => {
      const { rerender } = render(<AssistantMessage message={turn('Let me read the note.', '')} />)
      rerender(<AssistantMessage message={turn('Let me read the note.', 'Step two.')} />)
      expect(toggle()).toHaveTextContent('Thinking…')
      expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    })

    it('keeps the newest line of an opened block in view as reasoning grows', async () => {
      const { container, rerender } = render(<AssistantMessage message={turn('', 'Step one.')} />)
      rerender(<AssistantMessage message={turn('Answer', 'Step one.')} />)
      const { el, landUnobserved, grow } = stubViewport(container)
      await userEvent.click(toggle())
      expect(el.scrollTop).toBe(320)

      landUnobserved(548)
      fireEvent.scroll(el)
      grow(548)
      expect(el.scrollTop).toBe(368)

      grow(900)
      expect(el.scrollTop).toBe(720)
    })

    it('leaves a reader who scrolled up where they are, and follows again at the bottom', async () => {
      const { container, rerender } = render(<AssistantMessage message={turn('', 'Step one.')} />)
      rerender(<AssistantMessage message={turn('Answer', 'Step one.')} />)
      const { el, landUnobserved, grow } = stubViewport(container)
      await userEvent.click(toggle())

      el.scrollTop = 100
      fireEvent.scroll(el)
      grow(900)
      expect(el.scrollTop).toBe(100)

      el.scrollTop = 720
      landUnobserved(1000)
      fireEvent.scroll(el)
      grow(1000)
      expect(el.scrollTop).toBe(820)
    })

    it('lets the reader scroll while the model is still thinking', () => {
      const { container } = render(<AssistantMessage message={turn('', 'Step one.')} />)
      expect(container.querySelector('.aicss-tr-viewport')).toHaveClass('is-scroll')
    })
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
