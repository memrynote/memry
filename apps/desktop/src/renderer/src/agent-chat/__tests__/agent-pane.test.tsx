import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentBackendStatus, BackendStatusesResponse } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockAcceptDisclosure = vi.hoisted(() => vi.fn())
const mockCreateConversation = vi.hoisted(() => vi.fn())
const mockLoadConversation = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  // The transcript keeps its scroll position in tab state; these tests render
  // it outside a tab, where that degrades to no persistence at all.
  useTabActionsOptional: () => null,
  useActiveTab: () => null
}))

import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import { AgentPane } from '../agent-pane'

function renderPane(): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsModalProvider>
        <AgentPane />
      </SettingsModalProvider>
    </QueryClientProvider>
  )
}

const readyClaudeStatus: AgentBackendStatus = {
  backend: 'claude_cli',
  available: true,
  version: '2.1.0',
  minimumRequired: '2.1.0',
  reason: null,
  detail: null
}

const readyStatuses: BackendStatusesResponse = {
  claude_cli: readyClaudeStatus,
  codex_cli: {
    backend: 'codex_cli',
    available: true,
    version: '0.130.0',
    minimumRequired: '0.130.0',
    reason: null,
    detail: null
  },
  local_openai_compatible: {
    backend: 'local_openai_compatible',
    available: true,
    reason: null,
    detail: 'http://localhost:11434/v1'
  }
}

function mockAgentState(
  overrides: Partial<{
    backendStatuses: BackendStatusesResponse | null
    disclosureAccepted: boolean | null
    activeConversationId: string | null
  }>
) {
  mockUseAgentOptional.mockReturnValue({
    state: {
      backendStatuses: readyStatuses,
      disclosureAccepted: true,
      sourceWindowId: 'window-1',
      activeConversationId: null,
      conversations: {},
      messagesByConversation: {},
      pendingApprovals: [],
      inFlight: {},
      error: null,
      ...overrides
    },
    acceptDisclosure: mockAcceptDisclosure,
    createConversation: mockCreateConversation,
    loadConversation: mockLoadConversation
  })
}

describe('AgentPane', () => {
  beforeEach(() => {
    mockUseAgentOptional.mockReset()
    mockAcceptDisclosure.mockReset()
    mockCreateConversation.mockReset()
    mockLoadConversation.mockReset()
  })

  it('shows the disclosure gate until the user accepts it', async () => {
    const user = userEvent.setup()
    mockAgentState({ disclosureAccepted: false })

    renderPane()

    expect(screen.getByText('Enable memrynote Agent')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Enable Agent chat' }))

    expect(mockAcceptDisclosure).toHaveBeenCalledTimes(1)
  })

  it('renders an empty chat composer instead of the startup status', () => {
    mockAgentState({})

    renderPane()

    expect(screen.getByRole('textbox')).toHaveAccessibleName(
      'Do anything with memrynote... @ to mention notes, tasks, and events'
    )
    expect(screen.queryByText('Start chatting with your vault')).not.toBeInTheDocument()
    expect(screen.queryByText(/claude .*detected and ready/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument()
  })

  it('uses the main layout background for the agent shell', () => {
    mockUseAgentOptional.mockReturnValue(null)

    renderPane()

    const shell = screen.getByLabelText('Agent chat')

    expect(shell).toHaveClass('bg-background')
    expect(shell).not.toHaveClass('bg-sidebar')
  })

  it('keeps the empty chat composer visible when the Claude CLI is unavailable', () => {
    mockAgentState({
      backendStatuses: {
        ...readyStatuses,
        claude_cli: {
          backend: 'claude_cli',
          available: false,
          reason: 'missing_binary',
          detail: 'Install Claude Code.',
          version: null,
          minimumRequired: '2.1.0'
        }
      }
    })

    renderPane()

    expect(screen.getByRole('textbox')).toHaveAccessibleName(
      'Do anything with memrynote... @ to mention notes, tasks, and events'
    )
    expect(screen.queryByText(/claude not found/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument()
  })

  it('renders the active conversation header', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        backendStatuses: readyStatuses,
        disclosureAccepted: true,
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            vaultId: 'vault-1',
            title: 'Planning',
            backend: 'claude_cli',
            backendModel: null,
            trustList: [],
            pinned: false,
            vectorClock: {},
            fieldClocks: {},
            createdAt: 100,
            updatedAt: 100,
            deletedAt: null,
            lastSyncedAt: null
          },
          'conversation-2': {
            id: 'conversation-2',
            vaultId: 'vault-1',
            title: 'Inbox cleanup',
            backend: 'claude_cli',
            backendModel: null,
            trustList: [],
            pinned: false,
            vectorClock: {},
            fieldClocks: {},
            createdAt: 200,
            updatedAt: 200,
            deletedAt: null,
            lastSyncedAt: null
          }
        },
        messagesByConversation: {},
        pendingApprovals: [],
        inFlight: {},
        error: null
      },
      acceptDisclosure: mockAcceptDisclosure,
      createConversation: mockCreateConversation,
      loadConversation: mockLoadConversation
    })

    renderPane()

    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Conversation history' })).not.toBeInTheDocument()
  })
})
