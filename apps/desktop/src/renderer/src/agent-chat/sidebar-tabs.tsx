import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { Bot, CalendarDays } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useAgentOptional } from './agent-context'

export type RightSidebarTab = 'day' | 'agent'

const RIGHT_SIDEBAR_TAB_KEY = ['right', 'sidebar', 'tab'].join('-')
const RIGHT_SIDEBAR_TABS: RightSidebarTab[] = ['day', 'agent']

interface SidebarTabsProps {
  children: { day: ReactNode; agent: ReactNode }
  defaultTab?: RightSidebarTab
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

export function SidebarTabs({ children, defaultTab = 'day' }: SidebarTabsProps): React.JSX.Element {
  const [active, setActive] = useState<RightSidebarTab>(() => readInitialTab(defaultTab))
  const agent = useAgentOptional()

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
      <div className="border-b border-sidebar-border px-3 py-2">
        <div
          role="tablist"
          aria-label="Right sidebar"
          className="grid h-8 grid-cols-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 p-0.5"
        >
          <SidebarTabButton active={active === 'day'} onClick={() => setActive('day')}>
            <CalendarDays className="size-3.5" aria-hidden="true" />
            <span>Day</span>
          </SidebarTabButton>
          <SidebarTabButton active={active === 'agent'} onClick={() => setActive('agent')}>
            <Bot className="size-3.5" aria-hidden="true" />
            <span>Agent</span>
            {hasBackgroundActivity && (
              <span
                className="ms-1 size-1.5 rounded-full bg-primary"
                aria-label={
                  pendingApprovalCount > 0
                    ? `${pendingApprovalCount} pending approval`
                    : 'Agent turn in progress'
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
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
