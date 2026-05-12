import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'

import { Bot, CalendarDays } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useAgentOptional } from './agent-context'

export type RightSidebarTab = 'day' | 'agent'

const RIGHT_SIDEBAR_TAB_KEY = ['right', 'sidebar', 'tab'].join('-')
const RIGHT_SIDEBAR_TABS: RightSidebarTab[] = ['day', 'agent']

interface SidebarTabsProps {
  children: { day: ReactNode; agent: ReactNode }
  defaultTab?: RightSidebarTab
  dayLabel?: string
  agentLabel?: string
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
  agentLabel
}: SidebarTabsProps): React.JSX.Element {
  const { t } = useT('common')
  const [active, setActive] = useState<RightSidebarTab>(() => readInitialTab(defaultTab))
  const agent = useAgentOptional()
  const dayTabLabel = t('agentChat.sidebar.day')
  const agentTabLabel = t('agentChat.sidebar.agent')
  const activeLabel = active === 'day' ? (dayLabel ?? dayTabLabel) : (agentLabel ?? agentTabLabel)

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
    active !== 'agent' && (pendingApprovalCount > 0 || hasStreamingMessage || hasInFlightTurn)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-sidebar-border px-3">
        <span className="min-w-0 truncate text-xs font-semibold text-sidebar-foreground">
          {activeLabel}
        </span>
        <div
          role="tablist"
          aria-label={t('agentChat.sidebar.label')}
          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-transparent bg-[#212021] p-0.5 hover:border-sidebar-border focus-within:border-sidebar-border"
        >
          <SidebarTabButton
            active={active === 'day'}
            label={dayTabLabel}
            onClick={() => setActive('day')}
          >
            <CalendarDays className="size-4" aria-hidden="true" />
          </SidebarTabButton>
          <SidebarTabButton
            active={active === 'agent'}
            label={agentTabLabel}
            onClick={() => setActive('agent')}
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
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {active === 'day' ? children.day : children.agent}
      </div>
    </div>
  )
}

function SidebarTabButton({
  active,
  label,
  onClick,
  children
}: {
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-label={label}
      aria-selected={active}
      title={label}
      onClick={onClick}
      className={cn(
        'relative inline-flex size-6 items-center justify-center rounded-[5px] transition-colors',
        active
          ? 'bg-[#303030] text-[color-mix(in_srgb,var(--foreground)_35%,white)] shadow-sm'
          : 'text-muted-foreground hover:bg-[#303030] hover:text-[color-mix(in_srgb,var(--foreground)_35%,white)]'
      )}
    >
      {children}
    </button>
  )
}
