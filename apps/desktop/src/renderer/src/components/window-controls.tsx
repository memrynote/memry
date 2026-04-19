'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight } from '@/lib/icons'
import { TrafficLights } from '@/components/traffic-lights'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

interface WindowControlsProps {
  className?: string
}

export function WindowControls({ className }: WindowControlsProps): React.JSX.Element {
  return (
    <div className={cn('drag-region flex items-center gap-2 shrink-0 h-9 pl-3 pr-2', className)}>
      <div className="no-drag flex items-center">
        <TrafficLights />
      </div>

      <div className="no-drag flex items-center gap-0.5 ml-1">
        <SidebarTrigger className="text-text-tertiary hover:text-foreground transition-colors duration-150" />

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label="Go back"
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title="Back (coming soon)"
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-label="Go forward"
          className="flex items-center justify-center size-7 rounded text-text-tertiary/40 cursor-default"
          title="Forward (coming soon)"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
