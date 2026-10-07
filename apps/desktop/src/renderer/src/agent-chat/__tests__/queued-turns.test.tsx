import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent } from '@memry/contracts/ipc-agent'

vi.mock('@/contexts/tabs', () => ({
  useTabActionsOptional: () => null,
  useActiveTab: () => null
}))

import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { runVaultLeaveFlushes } from '@/lib/vault-workspace-lifecycle'
import { AgentProvider } from '../agent-context'
import { Composer } from '../composer'

const CONVERSATION_ID = 'conversation-1'

let emit: (event: AgentEvent) => void = () => {}

function renderChat(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsModalProvider>
        <AgentProvider>
          <Composer conversationId={CONVERSATION_ID} sourceWindowId="window-1" />
        </AgentProvider>
      </SettingsModalProvider>
    </QueryClientProvider>
  )
}

async function send(text: string): Promise<void> {
  const textbox = screen.getByRole('textbox', { name: /do anything/i })
  await userEvent.click(textbox)
  await userEvent.type(textbox, text)
  await act(async () => {
    await userEvent.keyboard('{Enter}')
  })
}

function endTurn(): void {
  act(() => emit({ kind: 'turn_completed', conversationId: CONVERSATION_ID, turnId: 'turn' }))
}

function deferredSend(): (value: { ok: true; turnId: string }) => void {
  let answer: (value: { ok: true; turnId: string }) => void = () => {}
  vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve
    })
  )
  return (value) => answer(value)
}

function sentTexts(): string[] {
  return vi.mocked(window.api.agent.sendTurn).mock.calls.map(([input]) => input.text)
}

function queuedTexts(): string[] {
  const queue = screen.queryByRole('region', { name: 'Queued messages' })
  if (!queue) return []
  return within(queue)
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent ?? '')
}

async function startTurn(): Promise<void> {
  renderChat()
  await waitFor(() => expect(screen.getByRole('textbox', { name: /do anything/i })).toBeVisible())
  await send('first')
  await screen.findByRole('button', { name: 'Stop' })
}

describe('queued agent messages', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(window.api.agent.sendTurn).mockReset()
    vi.mocked(window.api.agent.sendTurn).mockResolvedValue({ ok: true })
    vi.mocked(window.api.agent.cancelTurn).mockReset()
    vi.mocked(window.api.agent.cancelTurn).mockResolvedValue({ ok: true })
    vi.mocked(window.api.agent.getWindowId).mockResolvedValue({ windowId: 'window-1' })
    vi.mocked(window.api.agent.getBackendStatuses).mockResolvedValue({
      claude_cli: {
        backend: 'claude_cli',
        available: true,
        reason: null,
        detail: null,
        version: '2.1.0',
        minimumRequired: '2.1.0'
      },
      codex_cli: {
        backend: 'codex_cli',
        available: false,
        reason: 'missing_binary',
        detail: null,
        version: null,
        minimumRequired: '0.130.0'
      },
      antigravity_cli: {
        backend: 'antigravity_cli',
        available: false,
        reason: 'missing_binary',
        detail: null,
        version: null,
        minimumRequired: '1.2.7'
      },
      local_openai_compatible: {
        backend: 'local_openai_compatible',
        available: true,
        reason: null,
        detail: null
      }
    })
    vi.mocked(window.api.agent.onEvent).mockImplementation((callback) => {
      emit = callback
      return () => {}
    })
  })

  it('keeps the prompt editable during a turn and sends queued messages in order as turns end', async () => {
    await startTurn()

    expect(screen.getByRole('textbox', { name: /do anything/i })).toHaveAttribute(
      'contenteditable',
      'true'
    )
    await send('second')
    await send('third')

    expect(queuedTexts()).toEqual(['second', 'third'])
    expect(sentTexts()).toEqual(['first'])

    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    await waitFor(() => expect(queuedTexts()).toEqual(['third']))

    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second', 'third']))
    await waitFor(() => expect(queuedTexts()).toEqual([]))
  })

  it('sends the edited text and skips a removed message', async () => {
    await startTurn()
    await send('draft one')
    await send('draft two')

    const [firstRow, secondRow] = within(
      screen.getByRole('region', { name: 'Queued messages' })
    ).getAllByRole('listitem')
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Edit queued message' }))
    const editor = screen.getByRole('textbox', { name: 'Queued message text' })
    await userEvent.clear(editor)
    await userEvent.type(editor, 'final one{Enter}')
    fireEvent.click(within(secondRow).getByRole('button', { name: 'Remove queued message' }))

    expect(queuedTexts()).toEqual(['final one'])

    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'final one']))
  })

  it('retries a queued message while main still holds the finished turn', async () => {
    await startTurn()
    await send('second')
    vi.mocked(window.api.agent.sendTurn)
      .mockResolvedValueOnce({
        ok: false,
        error: 'There is already a turn in flight',
        reason: 'turn_in_flight'
      })
      .mockResolvedValueOnce({ ok: true })

    endTurn()

    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second', 'second']), {
      timeout: 2000
    })
    await waitFor(() => expect(queuedTexts()).toEqual([]))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('holds the queue on a message main rejects until the user edits it', async () => {
    await startTurn()
    await send('second')
    await send('third')
    vi.mocked(window.api.agent.sendTurn).mockRejectedValueOnce(new Error('IPC closed'))

    endTurn()

    await screen.findByText('Not sent. Edit to send again, or remove it.')
    expect(sentTexts()).toEqual(['first', 'second'])
    expect(queuedTexts()).toEqual(['second', 'third'])

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0])
    await userEvent.type(screen.getByRole('textbox', { name: 'Queued message text' }), '{Enter}')

    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second', 'second']))
    await waitFor(() => expect(queuedTexts()).toEqual(['third']))
  })

  it('queues a new message behind one that was not sent', async () => {
    await startTurn()
    await send('second')
    vi.mocked(window.api.agent.sendTurn).mockRejectedValueOnce(new Error('IPC closed'))
    endTurn()
    await screen.findByText('Not sent. Edit to send again, or remove it.')

    await send('newer')

    expect(sentTexts()).toEqual(['first', 'second'])
    expect(queuedTexts()).toEqual(['second', 'newer'])
  })

  it('does not retry a refusal that is not a running turn', async () => {
    await startTurn()
    await send('second')
    vi.mocked(window.api.agent.sendTurn).mockResolvedValueOnce({
      ok: false,
      error: 'Model is not installed'
    })

    endTurn()

    await screen.findByText('Not sent. Edit to send again, or remove it.')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    expect(sentTexts()).toEqual(['first', 'second'])
  })

  it('ends a queued turn that failed before main answered the send', async () => {
    await startTurn()
    await send('second')
    let answer: (value: { ok: true; turnId: string }) => void = () => {}
    vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))

    act(() =>
      emit({ kind: 'turn_error', conversationId: CONVERSATION_ID, turnId: 'turn-b', message: 'x' })
    )
    await act(async () => answer({ ok: true, turnId: 'turn-b' }))

    await waitFor(() => expect(queuedTexts()).toEqual([]))
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('keeps a queued turn running when only the stopped turn reports its end late', async () => {
    await startTurn()
    await send('second')
    let answer: (value: { ok: true; turnId: string }) => void = () => {}
    vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))

    act(() =>
      emit({ kind: 'turn_error', conversationId: CONVERSATION_ID, turnId: 'turn-a', message: 'x' })
    )
    await act(async () => answer({ ok: true, turnId: 'turn-b' }))

    await waitFor(() => expect(queuedTexts()).toEqual([]))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('stops a queued turn that main started after Stop was pressed', async () => {
    await startTurn()
    await send('second')
    let answer: (value: { ok: true; turnId: string }) => void = () => {}
    vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1))
    await act(async () => answer({ ok: true, turnId: 'turn-b' }))

    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(queuedTexts()).toEqual([]))
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })

  it('does not cancel a message re-sent after a Stop that met a refused send', async () => {
    await startTurn()
    await send('second')
    let answer: (value: { ok: false; error: string }) => void = () => {}
    vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1))
    await act(async () => answer({ ok: false, error: 'Model is not installed' }))
    await screen.findByText('Not sent. Edit to send again, or remove it.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0])
    await userEvent.type(screen.getByRole('textbox', { name: 'Queued message text' }), '{Enter}')
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second', 'second']))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('holds the queue while its next message is being edited and sends the saved text', async () => {
    await startTurn()
    await send('original')
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
    const editor = screen.getByRole('textbox', { name: 'Queued message text' })
    await userEvent.clear(editor)
    await userEvent.type(editor, 'half typed edit')

    endTurn()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(sentTexts()).toEqual(['first'])
    expect(screen.getByRole('textbox', { name: 'Queued message text' })).toHaveValue(
      'half typed edit'
    )

    await userEvent.type(screen.getByRole('textbox', { name: 'Queued message text' }), '{Enter}')
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'half typed edit']))
  })

  it('keeps Stop on a queued send that main answers late, without a second version', async () => {
    await startTurn()
    await send('second')
    let answer: (value: { ok: true; turnId: string }) => void = () => {}
    vi.mocked(window.api.agent.sendTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('button', { name: 'Edit queued message' })).not.toBeInTheDocument()

    await act(async () => answer({ ok: true, turnId: 'turn-b' }))
    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(2))
    expect(sentTexts()).toEqual(['first', 'second'])
    expect(queuedTexts()).toEqual([])
  })

  it.each([
    ['saving an edit', 'save'],
    ['cancelling an edit', 'cancel'],
    ['pressing Escape in the editor', 'escape'],
    ['removing a queued message', 'remove']
  ] as const)('returns focus to the prompt after %s', async (_label, action) => {
    await startTurn()
    await send('queued')
    const prompt = screen.getByRole('textbox', { name: /do anything/i })

    if (action === 'remove') {
      await userEvent.click(screen.getByRole('button', { name: 'Remove queued message' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
      const editor = screen.getByRole('textbox', { name: 'Queued message text' })
      if (action === 'save') await userEvent.type(editor, ' more{Enter}')
      if (action === 'escape') await userEvent.type(editor, '{Escape}')
      if (action === 'cancel') await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    }

    await waitFor(() => expect(document.activeElement).toBe(prompt))
  })

  it('clears the previous turn error when a queued message goes out', async () => {
    await startTurn()
    await send('second')
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))

    act(() =>
      emit({ kind: 'turn_error', conversationId: CONVERSATION_ID, turnId: 'turn', message: 'boom' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')

    await userEvent.type(screen.getByRole('textbox', { name: 'Queued message text' }), '{Enter}')

    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('sends the next queued message after Stop', async () => {
    await startTurn()
    await send('after stop')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    await waitFor(() => expect(sentTexts()).toEqual(['first', 'after stop']))
    expect(window.api.agent.cancelTurn).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID })
  })

  it('keeps Stop and shows the error when cancelling a late queued turn fails', async () => {
    await startTurn()
    await send('second')
    const answer = deferredSend()
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1))
    vi.mocked(window.api.agent.cancelTurn).mockRejectedValueOnce(new Error('IPC closed'))

    await act(async () => answer({ ok: true, turnId: 'turn-b' }))

    await waitFor(() => expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('alert')).toHaveTextContent('IPC closed')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(queuedTexts()).toEqual([])
  })

  it('does not stop a queued message that went out after Stop was pressed', async () => {
    await startTurn()
    await send('second')
    let cancelled: (value: { ok: boolean }) => void = () => {}
    vi.mocked(window.api.agent.cancelTurn).mockReturnValueOnce(
      new Promise((resolve) => {
        cancelled = resolve
      })
    )
    const answer = deferredSend()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    endTurn()
    await waitFor(() => expect(sentTexts()).toEqual(['first', 'second']))
    await act(async () => cancelled({ ok: true }))
    await act(async () => answer({ ok: true, turnId: 'turn-b' }))

    await waitFor(() => expect(queuedTexts()).toEqual([]))
    expect(window.api.agent.cancelTurn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('holds queued messages unsent when the vault is left', async () => {
    await startTurn()
    await send('second')

    await act(async () => {
      await runVaultLeaveFlushes()
    })
    endTurn()

    await screen.findByText('Not sent. Edit to send again, or remove it.')
    expect(sentTexts()).toEqual(['first'])
    expect(queuedTexts()).toEqual(['second'])
  })

  it('returns focus to the prompt after Stop', async () => {
    await startTurn()
    const prompt = screen.getByRole('textbox', { name: /do anything/i })

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    )
    expect(document.activeElement).toBe(prompt)
  })
})
