import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAISettingsContext = vi.hoisted(() =>
  vi.fn(() => ({ enabled: true, isLoading: false, reload: async () => {} }))
)

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null,
  useTabs: () => ({ openTab: vi.fn() })
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ isOpen: true, close: vi.fn() })
}))

vi.mock('@/contexts/ai-settings-context', () => ({
  useAISettingsContext: mockUseAISettingsContext
}))

import { AgentFeatureProvider } from '../agent-feature-provider'
import { SidebarTabs } from '../sidebar-tabs'

function agentApiStub() {
  return {
    getWindowId: vi.fn().mockResolvedValue({ windowId: 'window-1' }),
    getBackendStatuses: vi.fn().mockResolvedValue({}),
    getDisclosureState: vi.fn().mockResolvedValue({ accepted: false }),
    listConversations: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn(() => () => {})
  }
}

function renderApp() {
  return render(
    <AgentFeatureProvider>
      <SidebarTabs>
        {{
          day: <div>Day content</div>,
          agent: <div>Agent content</div>
        }}
      </SidebarTabs>
    </AgentFeatureProvider>
  )
}

describe('AgentFeatureProvider', () => {
  let api: ReturnType<typeof agentApiStub>

  beforeEach(() => {
    localStorage.clear()
    api = agentApiStub()
    ;(window.api as unknown as Record<string, unknown>).agent = api
    mockUseAISettingsContext.mockReturnValue({
      enabled: true,
      isLoading: false,
      reload: async () => {}
    })
  })

  it('opens the agent panel on the first click of the agent tab', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(screen.getByText('Day content')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Agent' }))

    expect(screen.getByText('Agent content')).toBeInTheDocument()
  })

  it('defers the agent bootstrap until an agent surface is opened', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(api.listConversations).not.toHaveBeenCalled()
    expect(api.onEvent).not.toHaveBeenCalled()

    await user.click(screen.getByRole('tab', { name: 'Agent' }))

    await waitFor(() => expect(api.listConversations).toHaveBeenCalled())
    expect(api.onEvent).toHaveBeenCalled()
  })
})
