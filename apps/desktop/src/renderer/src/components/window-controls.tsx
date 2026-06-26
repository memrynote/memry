'use client'

import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { ChevronLeft, ChevronRight, Search } from '@/lib/icons'
import { TrafficLights } from '@/components/traffic-lights'
import { TabIcon } from '@/components/tabs/tab-icon'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTabs } from '@/contexts/tabs/context'
import { buildHistoryEntries } from '@/contexts/tabs/helpers'
import { cn } from '@/lib/utils'

interface WindowControlsProps {
  className?: string
}

export function WindowControls({ className }: WindowControlsProps): React.JSX.Element {
  const { t: tPhaseF } = useT('common')
  const { t } = useT('common')
  const { state: sidebarState } = useSidebar()
  const sidebarTooltip = sidebarState === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar'

  const { state, navBack, navForward, canNavBack, canNavForward } = useTabs()

  const backEntries = React.useMemo(
    () => buildHistoryEntries(state, state.activeGroupId, 'back'),
    [state]
  )
  const forwardEntries = React.useMemo(
    () => buildHistoryEntries(state, state.activeGroupId, 'forward'),
    [state]
  )

  // ponytail: N (<=10) sequential dispatches; React's useReducer applies a queue in order.
  const goBackSteps = (n: number): void => {
    for (let i = 0; i < n; i++) navBack()
  }
  const goForwardSteps = (n: number): void => {
    for (let i = 0; i < n; i++) navForward()
  }

  return (
    <div className={cn('drag-region flex items-center gap-2 shrink-0 h-9 pl-3 pr-2', className)}>
      <div className="no-drag flex items-center">
        <TrafficLights />
      </div>

      <div className="no-drag flex items-center gap-0.5 ml-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <SidebarTrigger className="text-text-tertiary hover:text-foreground transition-colors duration-150" />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {sidebarTooltip}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('memry:open-search'))}
              aria-label={t('action.search')}
              className="flex items-center justify-center size-7 rounded text-text-tertiary hover:text-foreground hover:bg-sidebar-accent transition-colors duration-150"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {tPhaseF('phaseF.componentsWindowControls.searchK')}
          </TooltipContent>
        </Tooltip>

        <ContextMenu>
          <ContextMenuTrigger asChild disabled={!canNavBack}>
            <button
              type="button"
              onClick={() => navBack()}
              disabled={!canNavBack}
              aria-disabled={!canNavBack}
              aria-label={tPhaseF('phaseF.componentsWindowControls.browserBack')}
              title={tPhaseF('phaseF.componentsWindowControls.back')}
              className={cn(
                'flex items-center justify-center size-7 rounded transition-colors duration-150',
                canNavBack
                  ? 'text-text-tertiary hover:text-foreground hover:bg-sidebar-accent'
                  : 'text-text-tertiary/40 cursor-default'
              )}
            >
              <ChevronLeft className="size-4" />
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-64">
            {backEntries.map((e, i) => (
              <ContextMenuItem key={`${e.tab.id}-${i}`} onSelect={() => goBackSteps(e.steps)}>
                <TabIcon
                  type={e.tab.type}
                  icon={e.tab.icon}
                  emoji={e.tab.emoji}
                  className="size-4 me-2"
                />
                <span className="truncate">{e.tab.title}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>

        <ContextMenu>
          <ContextMenuTrigger asChild disabled={!canNavForward}>
            <button
              type="button"
              onClick={() => navForward()}
              disabled={!canNavForward}
              aria-disabled={!canNavForward}
              aria-label={tPhaseF('phaseF.componentsWindowControls.browserForward')}
              title={tPhaseF('phaseF.componentsWindowControls.forward')}
              className={cn(
                'flex items-center justify-center size-7 rounded transition-colors duration-150',
                canNavForward
                  ? 'text-text-tertiary hover:text-foreground hover:bg-sidebar-accent'
                  : 'text-text-tertiary/40 cursor-default'
              )}
            >
              <ChevronRight className="size-4" />
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-64">
            {forwardEntries.map((e, i) => (
              <ContextMenuItem key={`${e.tab.id}-${i}`} onSelect={() => goForwardSteps(e.steps)}>
                <TabIcon
                  type={e.tab.type}
                  icon={e.tab.icon}
                  emoji={e.tab.emoji}
                  className="size-4 me-2"
                />
                <span className="truncate">{e.tab.title}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </div>
  )
}
