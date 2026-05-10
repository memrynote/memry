import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

import { SidebarTabs } from '../sidebar-tabs'

function renderTabs() {
  return render(
    <SidebarTabs>
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
