import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { History } from 'lucide-react'
import { useT } from '@memry/i18n/renderer'

import { useAISettingsContext } from '@/contexts/ai-settings-context'
import { useDayPanel } from '@/contexts/day-panel-context'
import { useTabs } from '@/contexts/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Bot, CalendarDays, Expand, PlusSignIcon, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useAgentOptional } from './agent-context'
import { preferredConversationDefaults } from './agent-model-preference'
import { ConversationList } from './conversation-list'

export type RightSidebarTab = 'day' | 'agent'

export const RIGHT_SIDEBAR_TAB_KEY = ['right', 'sidebar', 'tab'].join('-')
const RIGHT_SIDEBAR_TABS: RightSidebarTab[] = ['day', 'agent']

interface SidebarTabsProps {
  children: { day: ReactNode; agent: ReactNode }
  defaultTab?: RightSidebarTab
  dayLabel?: string
  agentLabel?: string
  endAccessory?: ReactNode
}

function readInitialTab(defaultTab: RightSidebarTab): RightSidebarTab {
  try {
    const stored = localStorage.getItem(RIGHT_SIDEBAR_TAB_KEY)
    if (RIGHT_SIDEBAR_TABS.includes(stored as RightSidebarTab)) return stored as RightSidebarTab
  } catch {
    // localStorage may be unavailable in tests or restricted renderer contexts.
  }
  return defaultTab
}

export function SidebarTabs({
  children,
  defaultTab = 'day',
  dayLabel,
  agentLabel,
  endAccessory
}: SidebarTabsProps): React.JSX.Element {
  const { t } = useT('common')
  const [active, setActive] = useState<RightSidebarTab>(() => readInitialTab(defaultTab))
  const { enabled: aiEnabled } = useAISettingsContext()
  const agent = useAgentOptional()
  const dayTabLabel = t('agentChat.sidebar.day')
  const agentTabLabel = t('agentChat.sidebar.agent')
  const resolvedActive = aiEnabled ? active : active === 'agent' ? 'day' : active
  const activeLabel =
    resolvedActive === 'day' ? (dayLabel ?? dayTabLabel) : (agentLabel ?? agentTabLabel)

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_SIDEBAR_TAB_KEY, active)
    } catch {
      // localStorage may be unavailable in tests or restricted renderer contexts.
    }
  }, [active])

  const pendingApprovalCount = agent?.state.pendingApprovals.length ?? 0
  const hasStreamingMessage = useMemo(
    () =>
      Object.values(agent?.state.messagesByConversation ?? {}).some((messages) =>
        messages.some((message) => message.status === 'streaming')
      ),
    [agent?.state.messagesByConversation]
  )
  const hasInFlightTurn = Object.values(agent?.state.inFlight ?? {}).some(Boolean)
  const hasBackgroundActivity =
    aiEnabled &&
    resolvedActive !== 'agent' &&
    (pendingApprovalCount > 0 || hasStreamingMessage || hasInFlightTurn)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex h-9 shrink-0 items-center gap-3 ps-3', !endAccessory && 'pe-3')}>
        <div
          role="tablist"
          aria-label={t('agentChat.sidebar.label')}
          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-transparent bg-sidebar-surface p-0.5 hover:border-sidebar-border focus-within:border-sidebar-border"
        >
          <SidebarTabButton
            active={resolvedActive === 'day'}
            dataTour="rsb-day"
            label={dayTabLabel}
            onClick={() => setActive('day')}
          >
            <CalendarDays className="size-4" aria-hidden="true" />
          </SidebarTabButton>
          {aiEnabled && (
            <SidebarTabButton
              active={resolvedActive === 'agent'}
              dataTour="rsb-agent"
              label={agentTabLabel}
              onClick={() => {
                window.dispatchEvent(new Event('memry:agent-surface-opened'))
                setActive('agent')
              }}
            >
              <Bot className="size-4" aria-hidden="true" />
              {hasBackgroundActivity && (
                <span
                  className="absolute end-1 top-1 size-1.5 rounded-full bg-primary"
                  aria-label={
                    pendingApprovalCount > 0
                      ? t('agentChat.sidebar.pendingApproval', { count: pendingApprovalCount })
                      : t('agentChat.sidebar.inProgress')
                  }
                />
              )}
            </SidebarTabButton>
          )}
        </div>
        <div
          data-slot="day-panel-header-actions"
          className="ms-auto flex shrink-0 items-center gap-2"
        >
          <div className="flex h-9 min-w-0 items-center gap-1.5 pt-0.5">
            {resolvedActive !== 'agent' ? (
              <span className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-foreground transition-colors duration-150">
                {activeLabel}
              </span>
            ) : (
              <>
                <AgentConversationActions />
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('agentChat.sidebar.close')}
                        title={t('agentChat.sidebar.close')}
                        onClick={() => setActive('day')}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      {t('agentChat.sidebar.close')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </div>
          {endAccessory && (
            <div data-slot="day-panel-toggle-slot" className="flex shrink-0 items-center pe-[13px]">
              {endAccessory}
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {resolvedActive === 'day' ? children.day : children.agent}
      </div>
    </div>
  )
}

function AgentConversationActions(): React.JSX.Element | null {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const { openTab } = useTabs()
  const { close } = useDayPanel()

  if (!agent || agent.state.disclosureAccepted !== true) return null

  const currentAgent = agent
  const newConversationLabel = t('agentChat.newConversation')
  const openInTabLabel = t('agentChat.openInTab')
  const activeConversationId = currentAgent.state.activeConversationId
  const activeConversation = activeConversationId
    ? currentAgent.state.conversations[activeConversationId]
    : null

  function openActiveConversationInTab(): void {
    if (!activeConversation) return
    openTab({
      type: 'agent-chat',
      title: activeConversation.title,
      icon: 'bot',
      path: `/agent-chat/${activeConversation.id}`,
      entityId: activeConversation.id,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
    close()
    currentAgent.clearActiveConversation()
  }

  return (
    <div className="flex items-center gap-1">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={newConversationLabel}
              title={newConversationLabel}
              onClick={() => void currentAgent.createConversation(preferredConversationDefaults())}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <PlusSignIcon className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {newConversationLabel}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {activeConversation && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={openInTabLabel}
                title={openInTabLabel}
                onClick={openActiveConversationInTab}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Expand className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {openInTabLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <AgentHistoryMenu />
    </div>
  )
}

function AgentHistoryMenu(): React.JSX.Element | null {
  const { t } = useT('common')
  const agent = useAgentOptional()

  if (!agent || agent.state.disclosureAccepted !== true) return null

  const conversations = Object.values(agent.state.conversations).sort((left, right) => {
    return right.updatedAt - left.updatedAt
  })
  const historyLabel = t('agentChat.history')

  return (
    <TooltipProvider delayDuration={300}>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={historyLabel}
                title={historyLabel}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
              >
                <History className="size-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {historyLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-72 border-0 p-1">
          <ConversationList
            conversations={conversations}
            activeConversationId={agent.state.activeConversationId}
            onSelectConversation={(id) => void agent.loadConversation(id)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

function SidebarTabButton({
  active,
  label,
  onClick,
  children,
  dataTour
}: {
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
  dataTour?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      data-tour={dataTour}
      aria-label={label}
      aria-selected={active}
      title={label}
      onClick={onClick}
      className={cn(
        'relative inline-flex size-6 items-center justify-center rounded-[5px] transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
