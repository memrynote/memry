import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

import { SidebarTabs } from '../sidebar-tabs'

function renderTabs(
  props: { dayLabel?: string; agentLabel?: string; defaultTab?: 'day' | 'agent' } = {}
) {
  return render(
    <SidebarTabs {...props}>
      {{
        day: <div>Day content</div>,
        agent: <div>Agent content</div>
      }}
    </SidebarTabs>
  )
}

function mockAgentWithConversations() {
  const loadConversation = vi.fn()
  const createConversation = vi.fn()

  mockUseAgentOptional.mockReturnValue({
    state: {
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
      pendingApprovals: [],
      messagesByConversation: {},
      inFlight: {}
    },
    createConversation,
    loadConversation
  })

  return { createConversation, loadConversation }
}

describe('SidebarTabs', () => {
  beforeEach(() => {
    localStorage.clear()
    mockUseAgentOptional.mockReturnValue(null)
  })

  it('switches tabs and persists the active tab', async () => {
    const user = userEvent.setup()
    renderTabs()

    expect(screen.getByText('Day content')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Agent' }))

    expect(screen.getByText('Agent content')).toBeInTheDocument()
    expect(localStorage.getItem('right-sidebar-tab')).toBe('agent')
  })

  it('keeps the switch compact with icon-only tab buttons and one active label', async () => {
    const user = userEvent.setup()
    renderTabs({ dayLabel: 'Today' })

    const dayTab = screen.getByRole('tab', { name: 'Day' })
    const agentTab = screen.getByRole('tab', { name: 'Agent' })

    expect(within(dayTab).queryByText('Day')).not.toBeInTheDocument()
    expect(within(agentTab).queryByText('Agent')).not.toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()

    await user.click(agentTab)

    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    expect(within(agentTab).queryByText('Agent')).not.toBeInTheDocument()
  })

  it('matches the active label typography and vertical rhythm to tab titles', () => {
    renderTabs({ dayLabel: 'Today' })

    const activeLabel = screen.getByText('Today')
    const labelRow = activeLabel.parentElement

    expect(activeLabel).toHaveClass('text-[13px]')
    expect(activeLabel).toHaveClass('tracking-[-0.01em]')
    expect(activeLabel).toHaveClass('font-medium')
    expect(activeLabel).toHaveClass('text-foreground')
    expect(activeLabel).not.toHaveClass('text-sidebar-foreground')
    expect(labelRow).toHaveClass('h-9')
    expect(labelRow).toHaveClass('pt-0.5')
  })

  it('places the day and agent switch before the active label', () => {
    renderTabs({ dayLabel: 'Today' })

    const tabSwitch = screen.getByRole('tablist', { name: 'Right sidebar' })
    const activeLabel = screen.getByText('Today')

    expect(tabSwitch.compareDocumentPosition(activeLabel)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('restores the persisted active tab', () => {
    localStorage.setItem('right-sidebar-tab', 'agent')

    renderTabs()

    expect(screen.getByText('Agent content')).toBeInTheDocument()
  })

  it('marks background activity while the day tab is active', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        pendingApprovals: [
          {
            kind: 'tool_call_pending_approval',
            conversationId: 'conversation-1',
            toolCallId: 'tool-1',
            name: 'vault_create_task',
            args: {},
            requiresDiff: false
          }
        ],
        messagesByConversation: {},
        inFlight: {}
      }
    })

    renderTabs()

    expect(screen.getByLabelText('1 pending approval')).toBeInTheDocument()
  })

  it('shows new conversation and history actions without the Agent label', () => {
    const { createConversation, loadConversation } = mockAgentWithConversations()

    renderTabs({ defaultTab: 'agent' })

    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    expect(createConversation).toHaveBeenCalledTimes(1)

    const historyTrigger = screen.getByRole('button', { name: 'Conversation history' })
    expect(historyTrigger).toBeInTheDocument()
    expect(historyTrigger).toHaveClass('hover:bg-[#303030]')

    fireEvent.pointerDown(historyTrigger)
    expect(screen.queryByRole('menuitem', { name: 'New conversation' })).not.toBeInTheDocument()
    const historyItem = screen.getByRole('menuitem', { name: 'Inbox cleanup' })
    expect(historyItem).toHaveClass('hover:bg-accent')
    fireEvent.click(historyItem)

    expect(loadConversation).toHaveBeenCalledWith('conversation-2')
  })
})
