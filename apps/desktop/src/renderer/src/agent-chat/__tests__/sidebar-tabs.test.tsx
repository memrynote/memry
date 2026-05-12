import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

import { SidebarTabs } from '../sidebar-tabs'

function renderTabs(props: { dayLabel?: string; agentLabel?: string } = {}) {
  return render(
    <SidebarTabs {...props}>
      {{
        day: <div>Day content</div>,
        agent: <div>Agent content</div>
      }}
    </SidebarTabs>
  )
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

    expect(screen.getByText('Agent')).toBeInTheDocument()
    expect(within(agentTab).queryByText('Agent')).not.toBeInTheDocument()
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
})
