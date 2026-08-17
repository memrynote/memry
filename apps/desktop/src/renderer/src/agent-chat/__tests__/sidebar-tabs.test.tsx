import userEvent from '@testing-library/user-event'
import { useReducer, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Conversation, Message, MessageStatus } from '@memry/contracts/ipc-agent'

const mockUseAgentOptional = vi.hoisted(() => vi.fn())
const mockOpenTab = vi.hoisted(() => vi.fn())
const mockCloseDayPanel = vi.hoisted(() => vi.fn())
const mockUseAISettingsContext = vi.hoisted(() =>
  vi.fn(() => ({ enabled: true, isLoading: false, reload: async () => {} }))
)
const readyBackendStatuses = {
  claude_cli: { backend: 'claude_cli', available: true },
  codex_cli: { backend: 'codex_cli', available: true },
  local_openai_compatible: { backend: 'local_openai_compatible', available: true }
}

vi.mock('../agent-context', () => ({
  useAgentOptional: mockUseAgentOptional
}))

vi.mock('@/contexts/tabs', () => ({
  // The transcript keeps its scroll position in tab state; these tests render
  // it outside a tab, where that degrades to no persistence at all.
  useTabActionsOptional: () => null,
  useActiveTab: () => null,
  useTabs: () => ({ openTab: mockOpenTab })
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ close: mockCloseDayPanel })
}))

vi.mock('@/contexts/ai-settings-context', () => ({
  useAISettingsContext: mockUseAISettingsContext
}))

import { SettingsModalProvider } from '@/contexts/settings-modal-context'
import {
  agentReducer,
  initialAgentState,
  type AgentAction,
  type AgentState
} from '../agent-context.reducer'
import { SidebarTabs } from '../sidebar-tabs'
import { AgentPane } from '../agent-pane'

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderTabs(
  props: {
    dayLabel?: string
    agentLabel?: string
    defaultTab?: 'day' | 'agent'
  } = {}
) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <SidebarTabs {...props}>
        {{
          day: <div>Day content</div>,
          agent: <div>Agent content</div>
        }}
      </SidebarTabs>
    </QueryClientProvider>
  )
}

function mockAgentWithConversations() {
  const loadConversation = vi.fn()
  const createConversation = vi.fn()
  const clearActiveConversation = vi.fn()

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
    loadConversation,
    clearActiveConversation
  })

  return { createConversation, loadConversation, clearActiveConversation }
}

function conversation(id: string, title: string, updatedAt: number): Conversation {
  return {
    id,
    vaultId: 'vault-1',
    title,
    backend: 'claude_cli',
    backendModel: null,
    trustList: [],
    pinned: false,
    vectorClock: {},
    fieldClocks: {},
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
    lastSyncedAt: null
  }
}

function assistantMessage(
  id: string,
  conversationId: string,
  status: MessageStatus,
  createdAt: number
): Message {
  return {
    id,
    conversationId,
    role: 'assistant',
    content: { role: 'assistant', data: { text: '' } },
    toolCallId: null,
    attachments: [],
    status,
    vectorClock: {},
    createdAt,
    updatedAt: createdAt,
    deletedAt: null
  }
}

/** Message whose `status` read is observable, so a transcript rescan is measurable. */
function statusProbeMessage(message: Message, onStatusRead: () => void): Message {
  const { status, ...rest } = message
  const probe = { ...rest } as Message
  Object.defineProperty(probe, 'status', {
    enumerable: true,
    configurable: true,
    get() {
      onStatusRead()
      return status
    }
  })
  return probe
}

let harnessDispatch: React.Dispatch<AgentAction> | null = null

/** Drives SidebarTabs from the real reducer instead of a hand-built state object. */
function ReducerHarness({ seed }: { seed: AgentState }): React.JSX.Element {
  const [state, dispatch] = useReducer(agentReducer, seed)
  harnessDispatch = dispatch
  mockUseAgentOptional.mockReturnValue({
    state,
    createConversation: vi.fn(),
    loadConversation: vi.fn(),
    clearActiveConversation: vi.fn()
  })
  return (
    <SidebarTabs>
      {{
        day: <div>Day content</div>,
        agent: <div>Agent content</div>
      }}
    </SidebarTabs>
  )
}

function renderReducerHarness(seed: AgentState = initialAgentState) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <ReducerHarness seed={seed} />
    </QueryClientProvider>
  )
}

function dispatchToHarness(action: AgentAction): void {
  act(() => {
    harnessDispatch?.(action)
  })
}

describe('SidebarTabs', () => {
  beforeEach(() => {
    localStorage.clear()
    harnessDispatch = null
    mockUseAgentOptional.mockReturnValue(null)
    mockOpenTab.mockReset()
    mockCloseDayPanel.mockReset()
    mockUseAISettingsContext.mockReturnValue({
      enabled: true,
      isLoading: false,
      reload: async () => {}
    })
  })

  it('switches tabs and persists the active tab', async () => {
    const user = userEvent.setup()
    renderTabs()

    expect(screen.getByText('Day content')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Agent' }))

    expect(screen.getByText('Agent content')).toBeInTheDocument()
    expect(localStorage.getItem('right-sidebar-tab')).toBe('agent')
  })

  it('falls back the agent tab to day when AI is disabled with a persisted agent tab', () => {
    mockUseAISettingsContext.mockReturnValue({
      enabled: false,
      isLoading: false,
      reload: async () => {}
    })
    localStorage.setItem('right-sidebar-tab', 'agent')

    renderTabs()

    expect(screen.getByText('Day content')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Agent' })).not.toBeInTheDocument()
  })

  it('keeps the switch compact with icon-only tab buttons and one active label', async () => {
    const user = userEvent.setup()
    renderTabs({ dayLabel: 'Today' })

    const tabSwitch = screen.getByRole('tablist', { name: 'Right sidebar' })
    const dayTab = screen.getByRole('tab', { name: 'Day' })
    const agentTab = screen.getByRole('tab', { name: 'Agent' })

    expect(tabSwitch).toHaveClass('bg-sidebar-surface')
    expect(tabSwitch).not.toHaveClass('bg-[#212021]')
    expect(within(dayTab).queryByText('Day')).not.toBeInTheDocument()
    expect(within(agentTab).queryByText('Agent')).not.toBeInTheDocument()
    expect(dayTab).toHaveClass('bg-background')
    expect(dayTab).toHaveClass('text-foreground')
    expect(dayTab).not.toHaveClass('bg-[#303030]')
    expect(screen.getByText('Today')).toBeInTheDocument()

    await user.click(agentTab)

    expect(screen.queryByText('Agent')).not.toBeInTheDocument()
    expect(within(agentTab).queryByText('Agent')).not.toBeInTheDocument()
    expect(agentTab).toHaveClass('bg-background')
    expect(agentTab).toHaveClass('text-foreground')
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
    expect(historyTrigger).toHaveClass('hover:bg-sidebar-accent')
    expect(historyTrigger).not.toHaveClass('hover:bg-[#303030]')

    fireEvent.pointerDown(historyTrigger)
    expect(screen.queryByRole('menuitem', { name: 'New conversation' })).not.toBeInTheDocument()
    const historyItem = screen.getByRole('menuitem', { name: 'Inbox cleanup' })
    expect(historyItem).toHaveClass('hover:bg-accent')
    fireEvent.click(historyItem)

    expect(loadConversation).toHaveBeenCalledWith('conversation-2')
  })

  it('focuses the composer after creating a conversation from the plus action', async () => {
    const user = userEvent.setup()
    const createConversation = vi.fn()
    const createdConversation = conversation('conversation-2', 'New conversation', 200)

    function Harness(): React.JSX.Element {
      const [activeConversationId, setActiveConversationId] = useState<string | null>(
        'conversation-1'
      )
      const conversations =
        activeConversationId === 'conversation-2'
          ? {
              'conversation-1': conversation('conversation-1', 'Planning', 100),
              'conversation-2': createdConversation
            }
          : {
              'conversation-1': conversation('conversation-1', 'Planning', 100)
            }

      mockUseAgentOptional.mockReturnValue({
        state: {
          backendStatuses: readyBackendStatuses,
          disclosureAccepted: true,
          sourceWindowId: 'window-1',
          activeConversationId,
          conversations,
          pendingApprovals: [],
          messagesByConversation: {},
          inFlight: {},
          error: null
        },
        createConversation: createConversation.mockImplementation(async () => {
          setActiveConversationId(createdConversation.id)
          return createdConversation
        }),
        loadConversation: vi.fn(),
        clearActiveConversation: vi.fn(),
        acceptDisclosure: vi.fn(),
        cancelTurn: vi.fn(),
        sendTurn: vi.fn()
      })

      return (
        <SidebarTabs defaultTab="agent">
          {{
            day: <div>Day content</div>,
            agent: <AgentPane />
          }}
        </SidebarTabs>
      )
    }

    render(
      <QueryClientProvider client={testQueryClient()}>
        <SettingsModalProvider>
          <Harness />
        </SettingsModalProvider>
      </QueryClientProvider>
    )

    await user.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(createConversation).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
    await user.keyboard('hello')

    expect(screen.getByRole('textbox')).toHaveTextContent('hello')
  })

  it('opens the active conversation in a workspace tab and resets the sidebar chat', () => {
    const { clearActiveConversation } = mockAgentWithConversations()

    renderTabs({ defaultTab: 'agent' })

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation in tab' }))

    expect(mockOpenTab).toHaveBeenCalledWith({
      type: 'agent-chat',
      title: 'Planning',
      icon: 'bot',
      path: '/agent-chat/conversation-1',
      entityId: 'conversation-1',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
    expect(mockCloseDayPanel).toHaveBeenCalledTimes(1)
    expect(clearActiveConversation).toHaveBeenCalledTimes(1)
  })

  it('does not show the pop-out action before a conversation exists', () => {
    mockUseAgentOptional.mockReturnValue({
      state: {
        disclosureAccepted: true,
        activeConversationId: null,
        conversations: {},
        pendingApprovals: [],
        messagesByConversation: {},
        inFlight: {}
      },
      createConversation: vi.fn(),
      loadConversation: vi.fn(),
      clearActiveConversation: vi.fn()
    })

    renderTabs({ defaultTab: 'agent' })

    expect(
      screen.queryByRole('button', { name: 'Open conversation in tab' })
    ).not.toBeInTheDocument()
  })

  it('raises and clears the activity dot as a message starts and stops streaming', () => {
    renderReducerHarness()

    expect(screen.queryByLabelText('Agent turn in progress')).not.toBeInTheDocument()

    dispatchToHarness({
      type: 'event',
      event: {
        kind: 'message_upserted',
        message: assistantMessage('message-1', 'conversation-1', 'streaming', 1)
      }
    })

    expect(screen.getByLabelText('Agent turn in progress')).toBeInTheDocument()

    dispatchToHarness({
      type: 'event',
      event: {
        kind: 'message_upserted',
        message: assistantMessage('message-1', 'conversation-1', 'completed', 1)
      }
    })

    expect(screen.queryByLabelText('Agent turn in progress')).not.toBeInTheDocument()
  })

  it('raises and clears the activity dot as a tool call runs and finishes', () => {
    renderReducerHarness()

    dispatchToHarness({
      type: 'event',
      event: {
        kind: 'tool_call_started',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        name: 'vault_create_task',
        args: {}
      }
    })

    expect(screen.getByLabelText('Agent turn in progress')).toBeInTheDocument()

    dispatchToHarness({
      type: 'event',
      event: {
        kind: 'tool_call_completed',
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        result: {}
      }
    })

    expect(screen.queryByLabelText('Agent turn in progress')).not.toBeInTheDocument()
  })

  it('raises the activity dot when a loaded conversation already has a streaming message', () => {
    renderReducerHarness()

    dispatchToHarness({
      type: 'set_active_conversation',
      conversation: conversation('conversation-1', 'Planning', 100),
      messages: [assistantMessage('message-1', 'conversation-1', 'streaming', 1)]
    })

    expect(screen.getByLabelText('Agent turn in progress')).toBeInTheDocument()
  })

  it('does not rescan other conversations on every streamed token', () => {
    let statusReads = 0
    const otherTranscript = [
      assistantMessage('other-1', 'conversation-2', 'completed', 1),
      assistantMessage('other-2', 'conversation-2', 'completed', 2)
    ].map((message) =>
      statusProbeMessage(message, () => {
        statusReads += 1
      })
    )

    renderReducerHarness({
      ...initialAgentState,
      messagesByConversation: { 'conversation-2': otherTranscript }
    })

    dispatchToHarness({
      type: 'event',
      event: {
        kind: 'message_upserted',
        message: assistantMessage('message-1', 'conversation-1', 'streaming', 10)
      }
    })

    expect(screen.getByLabelText('Agent turn in progress')).toBeInTheDocument()

    const readsBeforeTokens = statusReads
    for (let token = 0; token < 20; token += 1) {
      dispatchToHarness({
        type: 'event',
        event: {
          kind: 'assistant_text_delta',
          conversationId: 'conversation-1',
          messageId: 'message-1',
          text: 'x'
        }
      })
    }

    expect(statusReads).toBe(readsBeforeTokens)
    expect(screen.getByLabelText('Agent turn in progress')).toBeInTheDocument()
  })
})
