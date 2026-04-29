'use client'

import * as React from 'react'
import { useT } from '@memry/i18n/renderer'
import { ChevronLeft, ChevronRight, Search } from '@/lib/icons'
import { TrafficLights } from '@/components/traffic-lights'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface WindowControlsProps {
  className?: string
}

export function WindowControls({ className }: WindowControlsProps): React.JSX.Element {
  const { t } = useT('common')
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
              aria-label={t('action.search')}
              className="flex items-center justify-center size-7 rounded text-text-tertiary hover:text-foreground hover:bg-sidebar-accent transition-colors duration-150"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {/* TODO(i18n): wrap in t() */}
            Search (⌘K)
          </TooltipContent>
        </Tooltip>

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label={'Browser back' /* TODO(i18n): wrap aria-label in t() */}
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title={'Back' /* TODO(i18n): wrap title in t() */}
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label={'Browser forward' /* TODO(i18n): wrap aria-label in t() */}
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title={'Forward' /* TODO(i18n): wrap title in t() */}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
