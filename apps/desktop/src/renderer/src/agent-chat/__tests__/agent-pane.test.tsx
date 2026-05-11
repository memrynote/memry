import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BinaryStatus } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockAcceptDisclosure = vi.hoisted(() => vi.fn())
const mockCreateConversation = vi.hoisted(() => vi.fn())
const mockLoadConversation = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null
}))

import { AgentPane } from '../agent-pane'

const readyBinary: BinaryStatus = {
  detected: true,
  version: '2.1.0',
  meetsMinimum: true,
  minimumRequired: '2.1.0',
  installHint: null
}

function mockAgentState(
  overrides: Partial<{
    binaryStatus: BinaryStatus | null
    disclosureAccepted: boolean | null
    activeConversationId: string | null
  }>
) {
  mockUseAgentOptional.mockReturnValue({
    state: {
      binaryStatus: readyBinary,
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

    render(<AgentPane />)

    expect(screen.getByText('Enable Memry Agent')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Enable Claude CLI chat' }))

    expect(mockAcceptDisclosure).toHaveBeenCalledTimes(1)
  })

  it('renders an empty chat composer instead of the startup status', () => {
    mockAgentState({})

    render(<AgentPane />)

    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask Agent')
    expect(screen.queryByText('Start chatting with your vault')).not.toBeInTheDocument()
    expect(screen.queryByText(/claude .*detected and ready/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument()
  })

  it('keeps the empty chat composer visible when the Claude CLI is unavailable', () => {
    mockAgentState({
      binaryStatus: {
        detected: false,
        version: null,
        meetsMinimum: false,
        minimumRequired: '2.1.0',
        installHint: 'Install Claude Code.'
      }
    })

    render(<AgentPane />)

    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask Agent')
    expect(screen.queryByText(/claude not found/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument()
  })

  it('renders the active conversation header and switches conversations', async () => {
    const user = userEvent.setup()
    mockUseAgentOptional.mockReturnValue({
      state: {
        binaryStatus: readyBinary,
        disclosureAccepted: true,
        activeConversationId: 'conversation-1',
        conversations: {
          'conversation-1': {
            id: 'conversation-1',
            vaultId: 'vault-1',
            title: 'Planning',
            backend: 'claude_cli',
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

    render(<AgentPane />)

    await user.click(screen.getByRole('button', { name: /Planning/ }))
    await user.click(screen.getByRole('button', { name: 'Inbox cleanup' }))

    expect(mockLoadConversation).toHaveBeenCalledWith('conversation-2')
  })
})
