import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
const mockCalendarListEvents = vi.fn()
const readyBackendStatuses = {
  claude_cli: { backend: 'claude_cli', available: true },
  codex_cli: { backend: 'codex_cli', available: true },
  local_openai_compatible: { backend: 'local_openai_compatible', available: true }
}

async function setPromptText(text: string): Promise<HTMLElement> {
  const textbox = screen.getByRole('textbox')
  await userEvent.click(textbox)
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}')
  if (text) {
    await userEvent.type(textbox, text)
  }
  return textbox
}

async function submitPrompt(): Promise<void> {
  await act(async () => {
    await userEvent.keyboard('{Enter}')
    await Promise.resolve()
  })
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
    mockCalendarListEvents.mockReset()
    mockCalendarListEvents.mockResolvedValue({ events: [] })
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
    Object.assign(window.api, {
      calendar: {
        ...((window.api as unknown as { calendar?: Record<string, unknown> }).calendar ?? {}),
        listEvents: mockCalendarListEvents
      }
    })
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

    await setPromptText('hello')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'hello',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('submits from pointer down on the send button', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('hello')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(mockSendTurn).toHaveBeenCalledWith({
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'hello',
        attachments: [],
        backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
      })
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
    expect(providerTrigger).toHaveClass('hover:bg-accent')
    expect(providerTrigger).toHaveClass('hover:text-accent-foreground')
    expect(providerTrigger).toHaveClass('data-[state=open]:bg-accent')

    fireEvent.pointerDown(providerTrigger)

    expect(screen.getByRole('menuitem', { name: /claude/i })).toHaveClass('hover:bg-accent')
    expect(screen.getByRole('menuitem', { name: /claude/i })).toHaveClass('focus:bg-accent')
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

    await setPromptText('quick answer')
    await submitPrompt()

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

    await setPromptText('deep answer')
    await submitPrompt()

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

    await setPromptText('create a task')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium', model: 'gpt-5.5' }
    })
  })

  it('shows supported Codex reasoning settings next to the selected provider', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))
    await screen.findByRole('button', { name: 'Agent model: GPT-5.5' })

    const settingsTrigger = screen.getByRole('button', {
      name: 'Agent settings: Medium'
    })
    expect(settingsTrigger).toHaveClass('rounded-full')

    fireEvent.pointerDown(settingsTrigger)

    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Medium (default)' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'Low' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'High' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Extra High' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Max' })).not.toBeInTheDocument()
  })

  it('passes the selected Codex reasoning with the prompt', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent settings: Medium' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'High' }))

    await setPromptText('create a task')
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'create a task',
      attachments: [],
      backendOptions: { backend: 'codex_cli', reasoningEffort: 'high', model: 'gpt-5.5' }
    })
  })

  it('passes the selected Codex model with the prompt', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent provider: Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }))
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Agent model: GPT-5.5' }))
    expect(screen.queryByRole('menuitem', { name: 'Default' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'GPT-5.4' }))

    await setPromptText('create a task')
    await submitPrompt()

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

    await setPromptText('create a task')
    await submitPrompt()

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

    await setPromptText('custom model')
    await submitPrompt()

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

    await setPromptText('draft a plan')
    await submitPrompt()

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

    await setPromptText('draft a plan')
    await submitPrompt()

    expect(mockCreateConversation).toHaveBeenCalledWith({
      backend: 'claude_cli',
      backendModel: 'sonnet'
    })
  })

  it('keeps the first prompt on the send control while the conversation is being created', async () => {
    mockCreateConversation.mockReturnValue(new Promise(() => {}))
    render(<Composer conversationId={null} sourceWindowId="window-1" />)

    await setPromptText('draft a plan')
    await userEvent.keyboard('{Enter}')

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('allows Shift+Enter to create a newline without submitting', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('hello')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')

    expect(mockSendTurn).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveTextContent('hello')
  })

  it('focuses the prompt editor when the blank input surface is clicked', async () => {
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = screen.getByRole('textbox')
    const promptSurface = textbox.parentElement?.parentElement
    expect(promptSurface).toBeInstanceOf(HTMLElement)

    fireEvent.pointerDown(promptSurface!)

    await waitFor(() => expect(textbox).toHaveFocus())
    await userEvent.keyboard('hello')

    expect(textbox).toHaveTextContent('hello')
  })

  it('submits inline picked refs as readable text and structured attachments', async () => {
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

    await setPromptText('summarize @plan')
    fireEvent.click(await screen.findByRole('option', { name: /planning note/i }))
    expect(screen.getByTestId('agent-mention-note-note-1')).toHaveTextContent('@Planning note')
    expect(screen.queryByRole('button', { name: /remove.*planning note/i })).not.toBeInTheDocument()
    await submitPrompt()

    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'plan', limit: 20 })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Planning note',
      attachments: [{ kind: 'note', ref_id: 'note-1', label: 'Planning note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('selects the first mention result and supports arrow-key navigation', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 3,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Alpha note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Alpha note', tags: [] }
            },
            {
              id: 'note-2',
              type: 'note',
              title: 'Beta note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Beta note', tags: [] }
            },
            {
              id: 'note-3',
              type: 'note',
              title: 'Gamma note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Gamma note', tags: [] }
            }
          ]
        }
      ],
      totalCount: 3,
      queryTimeMs: 1
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('summarize @')

    const alphaOption = await screen.findByRole('option', { name: /alpha note/i })
    const betaOption = screen.getByRole('option', { name: /beta note/i })
    const gammaOption = screen.getByRole('option', { name: /gamma note/i })
    expect(alphaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowDown}')
    expect(betaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    expect(alphaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowUp}')
    expect(gammaOption).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')

    expect(mockSendTurn).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-mention-note-note-3')).toHaveTextContent('@Gamma note')
    expect(mockSearchQuery).toHaveBeenCalledWith({ text: '', limit: 20 })
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Gamma note',
      attachments: [{ kind: 'note', ref_id: 'note-3', label: 'Gamma note' }],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('renders soft inline mention tags for note, task, journal, inbox, and calendar refs', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Note',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Planning note', tags: [], emoji: '🔥' }
            }
          ]
        },
        {
          type: 'task',
          totalInGroup: 1,
          results: [
            {
              id: 'task-1',
              type: 'task',
              title: 'Star Wars Task',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'task',
                projectId: 'project-1',
                projectName: 'Work',
                projectColor: '#111111',
                statusId: 'todo',
                statusName: 'Todo',
                dueDate: null,
                priority: 0,
                completedAt: null
              }
            }
          ]
        },
        {
          type: 'journal',
          totalInGroup: 1,
          results: [
            {
              id: '2026-05-10',
              type: 'journal',
              title: 'Star Wars Journal',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'journal', date: '2026-05-10', path: '/journal', tags: [] }
            }
          ]
        },
        {
          type: 'inbox',
          totalInGroup: 1,
          results: [
            {
              id: 'inbox-1',
              type: 'inbox',
              title: 'Star Wars Link',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'prefix',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: {
                type: 'inbox',
                itemType: 'link',
                sourceUrl: 'https://example.com',
                sourceTitle: 'Example',
                filedAt: null
              }
            }
          ]
        }
      ],
      totalCount: 4,
      queryTimeMs: 1
    })
    mockCalendarListEvents.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          title: 'Star Wars Sync',
          description: 'Roadmap',
          location: 'Office',
          startAt: '2026-05-11T09:00:00.000Z',
          endAt: '2026-05-11T09:30:00.000Z',
          timezone: 'UTC',
          isAllDay: false,
          recurrenceRule: null,
          recurrenceExceptions: null,
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          parentEventId: null,
          originalStartTime: null,
          targetCalendarId: null,
          archivedAt: null,
          syncedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: '2026-05-10T00:00:00.000Z'
        },
        {
          id: 'event-2',
          title: 'Unrelated sync',
          description: null,
          location: null,
          startAt: '2026-05-11T10:00:00.000Z',
          endAt: null,
          timezone: 'UTC',
          isAllDay: false,
          recurrenceRule: null,
          recurrenceExceptions: null,
          attendees: null,
          reminders: null,
          visibility: null,
          colorId: null,
          conferenceData: null,
          parentEventId: null,
          originalStartTime: null,
          targetCalendarId: null,
          archivedAt: null,
          syncedAt: null,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: '2026-05-10T00:00:00.000Z'
        }
      ]
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    const textbox = await setPromptText('summarize @star wars')

    const noteOption = await screen.findByRole('option', { name: /star wars note/i })
    expect(noteOption).toHaveTextContent('🔥')
    expect(
      screen.getByRole('option', { name: /star wars task/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars journal/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars link/i }).querySelector('svg')
    ).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /star wars sync/i }).querySelector('svg')
    ).toBeTruthy()
    expect(screen.queryByRole('option', { name: /unrelated sync/i })).not.toBeInTheDocument()

    fireEvent.click(noteOption)
    for (const label of [
      'Star Wars Task',
      'Star Wars Journal',
      'Star Wars Link',
      'Star Wars Sync'
    ]) {
      await userEvent.type(textbox, '@star wars')
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(label, 'i') }))
    }

    expect(screen.getByTestId('agent-mention-note-note-1')).toHaveClass('bg-sky-500/10')
    expect(screen.getByTestId('agent-mention-task-task-1')).toHaveClass('bg-emerald-500/10')
    expect(screen.getByTestId('agent-mention-journal-2026-05-10')).toHaveClass('bg-rose-500/10')
    expect(screen.getByTestId('agent-mention-inbox-inbox-1')).toHaveClass('bg-amber-500/10')
    expect(screen.getByTestId('agent-mention-calendar_event-event-1')).toHaveClass(
      'bg-violet-500/10'
    )
    expect(screen.queryByRole('button', { name: /remove.*star wars/i })).not.toBeInTheDocument()
    expect(mockSearchQuery).toHaveBeenCalledWith({ text: 'star wars', limit: 20 })
    await submitPrompt()

    expect(mockCalendarListEvents).toHaveBeenCalledWith({ includeArchived: false })
    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize @Star Wars Note @Star Wars Task @Star Wars Journal @Star Wars Link @Star Wars Sync',
      attachments: [
        { kind: 'note', ref_id: 'note-1', label: 'Star Wars Note' },
        { kind: 'task', ref_id: 'task-1', label: 'Star Wars Task' },
        { kind: 'journal', ref_id: '2026-05-10', label: 'Star Wars Journal' },
        { kind: 'inbox', ref_id: 'inbox-1', label: 'Star Wars Link' },
        { kind: 'calendar_event', ref_id: 'event-1', label: 'Star Wars Sync' }
      ],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('removes inline mention tags as atomic nodes', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Movies',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Star Wars Movies', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('summarize @star wars')
    fireEvent.click(await screen.findByRole('option', { name: /star wars movies/i }))
    expect(screen.getByTestId('agent-mention-note-note-1')).toBeInTheDocument()

    await userEvent.keyboard('{Backspace}{Backspace}')

    expect(screen.queryByTestId('agent-mention-note-note-1')).not.toBeInTheDocument()
    await submitPrompt()

    expect(mockSendTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      sourceWindowId: 'window-1',
      text: 'summarize',
      attachments: [],
      backendOptions: { backend: 'claude_cli', claudeEffort: 'xhigh', model: 'opus' }
    })
  })

  it('removes inline mention tags with Delete as one unit', async () => {
    mockSearchQuery.mockResolvedValue({
      groups: [
        {
          type: 'note',
          totalInGroup: 1,
          results: [
            {
              id: 'note-1',
              type: 'note',
              title: 'Star Wars Movies',
              snippet: '',
              score: 1,
              normalizedScore: 1,
              matchType: 'title',
              modifiedAt: '2026-05-10T00:00:00.000Z',
              metadata: { type: 'note', path: '/Star Wars Movies', tags: [] }
            }
          ]
        }
      ],
      totalCount: 1,
      queryTimeMs: 1
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('@star wars')
    fireEvent.click(await screen.findByRole('option', { name: /star wars movies/i }))
    const mention = screen.getByTestId('agent-mention-note-note-1')
    expect(mention).toBeInTheDocument()

    fireEvent.mouseDown(mention)
    await userEvent.keyboard('{Delete}')

    expect(screen.queryByTestId('agent-mention-note-note-1')).not.toBeInTheDocument()
  })

  it('auto-attaches the current note', async () => {
    mockUseActiveTab.mockReturnValue({
      id: 'tab-1',
      type: 'note',
      title: 'Current brief',
      entityId: 'note-2'
    })
    render(<Composer conversationId="conversation-1" sourceWindowId="window-1" />)

    await setPromptText('summarize')
    await submitPrompt()

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
