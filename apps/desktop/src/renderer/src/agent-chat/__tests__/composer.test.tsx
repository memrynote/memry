import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockUseActiveTab = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: mockUseActiveTab
}))

import { Composer } from '../composer'

const mockSendTurn = vi.fn()
const mockCancelTurn = vi.fn()
const mockCreateConversation = vi.fn()
const mockSearchQuery = vi.fn()
const readyBackendStatuses = {
  claude_cli: { backend: 'claude_cli', available: true },
  codex_cli: { backend: 'codex_cli', available: true },
  local_openai_compatible: { backend: 'local_openai_compatible', available: true }
}

describe('Composer', () => {
  beforeEach(() => {
    mockSendTurn.mockReset()
    mockCancelTurn.mockReset()
    mockCreateConversation.mockReset()
    mockCreateConversation.mockResolvedValue({ id: 'conversation-2' })
    mockSearchQuery.mockReset()
    mockSearchQuery.mockResolvedValue({
      groups: [],
      totalCount: 0,
      queryTimeMs: 0
    })
    mockUseActiveTab.mockReturnValue(null)
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {},
        conversations: {},
        backendStatuses: readyBackendStatuses
      },
      createConversation: mockCreateConversation,
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })
    vi.mocked(window.api.search.query).mockImplementation(mockSearchQuery)
    vi.mocked(window.api.agent.listBackendModels).mockImplementation(async ({ backend }) => ({
      backend,
      supportsCustomModel: true,
      models:
        backend === 'claude_cli'
          ? [
              { id: 'sonnet', label: 'Sonnet' },
              { id: 'haiku', label: 'Haiku' },
              { id: 'opus', label: 'Opus' }
            ]
          : [
              { id: 'gpt-5.4', label: 'GPT-5.4' },
              { id: 'gpt-5.5', label: 'GPT-5.5' },
              { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
            ]
    }))
  })

  it('submits on Enter', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'hello' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hello',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('renders the ai-02 prompt surface', () => {
    const { container } = render(
      <Composer conversationId="conversation-1" sourceWindowId="window-1" />
    )

    expect(container.firstElementChild).not.toHaveClass('border-t')
    expect(screen.getByRole('textbox')).toHaveClass('min-h-[48.4px]')
    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('rounded-full')
    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
  })

  it('opens a borderless provider dropdown from the cloud slot', () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const providerTrigger = screen.getByRole('button', { name: 'Agent provider: Claude' })
    expect(providerTrigger).not.toHaveClass('border')
    expect(providerTrigger).toHaveClass('hover:bg-transparent')
    expect(providerTrigger).toHaveClass('hover:text-foreground')

    fireEvent.pointerDown(providerTrigger)

    expect(screen.getByRole('menuitem', { name: /claude/i })).toHaveClass('focus:bg-transparent')
    expect(screen.getByRole('menuitem', { name: /codex/i })).not.toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: /local/i })).not.toHaveAttribute('data-disabled')
  })

  it('disables unavailable CLI providers from the backend status map', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: {},
        conversations: {},
        backendStatuses: {
          ...readyBackendStatuses,
          codex_cli: {
            backend: 'codex_cli',
            available: false,
            reason: 'missing_binary',
            detail: 'Install Codex CLI.'
          }
        }
      },
      createConversation: mockCreateConversation,
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))

    expect(screen.getByRole('menuitem', { name: /codex/i })).toHaveAttribute('data-disabled', '')
  })

  it('shows supported Claude effort settings next to the selected provider', () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const settingsTrigger = screen.getByRole('button', {
      name: 'Agent settings: Extra High'
    })
    expect(settingsTrigger).toHaveClass('rounded-full')

    fireEvent.pointerDown(settingsTrigger)

    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Extra High (default)' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.queryByText('Context Window')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Ultrathink' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Low' }))

    expect(
      screen.getByRole('button', {
        name: 'Agent settings: Low'
      })
    ).toBeInTheDocument()
  })

  it('passes the selected Claude effort with the prompt', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent settings: Extra High' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Low' }))

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'quick answer' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'quick answer',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'low', model: 'opus' }
    })
  })

  it('passes the selected Claude model with the prompt', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent model: Opus' }))
    expect(screen.queryByRole('menuitem', { name: 'Default' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }))

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'deep answer' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'deep answer',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'sonnet' }
    })
  })

  it('passes Codex backend options when Codex is selected', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'create a task' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.5' }
    })
  })

  it('passes the selected Codex model with the prompt', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent model: GPT-5.5' }))
    expect(screen.queryByRole('menuitem', { name: 'Default' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.4' }))

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'create a task' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.4' }
    })
  })

  it('uses the highest suggested Codex model as the Memry default', async () => {
    vi.mocked(window.api.agent.listBackendModels).mockImplementation(async ({ backend }) => ({
      backend,
      supportsCustomModel: true,
      models:
        backend === 'codex_cli'
          ? [
              { id: 'gpt-5.4', label: 'GPT-5.4' },
              { id: 'gpt-5.6', label: 'GPT-5.6' },
              { id: 'gpt-5.5', label: 'GPT-5.5' }
            ]
          : [
              { id: 'sonnet', label: 'Sonnet' },
              { id: 'haiku', label: 'Haiku' },
              { id: 'opus', label: 'Opus' }
            ]
    }))
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))

    expect(await screen.findByRole('button', { name: 'Agent model: GPT-5.6' })).toBeInTheDocument()

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'create a task' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.6' }
    })
  })

  it('allows a custom Claude model id', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent model: Opus' }))
    fireEvent.change(screen.getByLabelText('Custom model ID'), {
      target: { value: 'claude-sonnet-4-6' }
    })
    fireEvent.keyDown(screen.getByLabelText('Custom model ID'), { key: 'Enter' })

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'custom model' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'custom model',
      attachments: [],
      backendOptions: {
        backend: 'claude_cli',
        claudeEffort: 'xhigh',
        model: 'claude-sonnet-4-6'
      }
    })
  })

  it('creates a conversation before sending the first empty-chat prompt', async () => {
    render(<Composer conversationId={null} sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'draft a plan' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockCreateConversation).toHaveBeenCalledWith({
      backend: 'claude_cli',
      backendModel: 'opus'
    })
    await waitFor(() => {
      expect(mockSendTurn).toHaveBeenCalledWith({
        conversationId: 'conversation-2',
        sourceWindowId: 'window-1',
        text: 'draft a plan',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
      })
    })
  })

  it('creates a new conversation with selected backend model metadata', async () => {
    render(<Composer conversationId={null} sourceWindowId="window-1" />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent model: Opus' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sonnet' }))

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'draft a plan' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockCreateConversation).toHaveBeenCalledWith({
      backend: 'claude_cli',
      backendModel: 'sonnet'
    })
  })

  it('keeps the first prompt on the send control while the conversation is being created', () => {
    mockCreateConversation.mockReturnValue(new Promise(() => {}))
    render(<Composer conversationId={null} sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'draft a plan' } })
    act(() => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
    })

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('allows Shift+Enter to create a newline without submitting', () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'hello' } })
    const wasNotPrevented = fireEvent.keyDown(textbox, {
      key: 'Enter',
      shiftKey: true,
      cancelable: true
    })

    expect(mockSendTurn).not.toHaveBeenCalled()
    expect(wasNotPrevented).toBe(true)
  })

  it('adds picked refs to the submitted attachments', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Planning note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'summarize @plan' } })
    fireEvent.click(await screen.findByRole('option', { name: /planning note/i }))
    fireEvent.change(textbox, { target: { value: 'summarize this' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'plan', limit: 20 })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize this',
      attachments: [{ kind: 'note', ref_id: 'note-1', label: 'Planning note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('auto-attaches the current note', async () => {
    mockUseActiveTab.mockReturnValue({
      id: 'tab-1',
      type: 'note',
      title: 'Current brief',
      entityId: 'note-2'
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'summarize' } })
    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [{ kind: 'current_note', ref_id: '__current__', label: 'Current brief' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('replaces send with stop while a turn is in flight', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        inFlight: { 'conversation-1': true },
        conversations: {},
        backendStatuses: readyBackendStatuses
      },
      sendTurn: mockSendTurn,
      cancelTurn: mockCancelTurn
    })

    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect(mockCancelTurn).toHaveBeenCalledWith('conversation-1')
    expect(mockSendTurn).not.toHaveBeenCalled()
  })
})
