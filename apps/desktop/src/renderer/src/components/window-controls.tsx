'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight, Search } from '@/lib/icons'
import { TrafficLights } from '@/components/traffic-lights'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface WindowControlsProps {
  className?: string
}

export function WindowControls({ className }: WindowControlsProps): React.JSX.Element {
  const { state } = useSidebar()
  const sidebarTooltip = state === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar'

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
              aria-label="Search"
              className="flex items-center justify-center size-7 rounded text-text-tertiary hover:text-foreground hover:bg-sidebar-accent transition-colors duration-150"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Search (⌘K)
          </TooltipContent>
        </Tooltip>

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label="Go back"
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title="Back"
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label="Go forward"
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title="Forward"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
