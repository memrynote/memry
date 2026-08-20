import * as React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface SidebarSectionActionProps {
  icon: React.ComponentType<{ className?: string }>
  /** Accessible name, and the tooltip text unless `tooltip` overrides it. */
  label: string
  tooltip?: string
  onClick: () => void
}

/**
 * One icon button in a sidebar section header — new note, new folder, expand
 * all. The section header reveals these on hover, so they are small, unlabelled
 * and identical apart from the icon and what they do.
 */
export const SidebarSectionAction = ({
  icon: Icon,
  label,
  tooltip,
  onClick
}: SidebarSectionActionProps): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={onClick}
        className="p-0.5 rounded cursor-pointer hover:bg-sidebar-accent transition-colors"
        aria-label={label}
      >
        <Icon className="size-3.5 text-sidebar-muted hover:text-sidebar-foreground" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom" className="text-xs">
      {tooltip ?? label}
    </TooltipContent>
  </Tooltip>
)

export default SidebarSectionAction
