/**
 * Tab Bar Action Button
 * Action buttons for tab bar (split, layout, new tab)
 */

import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface TabBarActionProps {
  /** Icon element to display */
  icon: React.ReactNode
  /** Tooltip text */
  tooltip: string
  /** Click handler */
  onClick: () => void
  /** Disabled state */
  disabled?: boolean
  /** Active/toggled state */
  isActive?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * Action button for tab bar
 * Features refined styling with smooth micro-interactions
 */
export const TabBarAction = ({
  icon,
  tooltip,
  onClick,
  disabled = false,
  isActive = false,
  className
}: TabBarActionProps): React.JSX.Element => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            // Base styles with refined sizing
            'flex h-7 w-7 items-center justify-center rounded-md',
            // Colors with smooth transitions
            'text-text-tertiary hover:text-foreground',
            isActive ? 'bg-surface-active/70 text-foreground' : 'hover:bg-surface-active/50',
            // Smooth transitions for all properties
            'transition-all duration-150 ease-out',
            // Active state
            'active:scale-95 active:bg-surface-active/70',
            // Disabled state
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:active:scale-100',
            className
          )}
          aria-label={tooltip}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="text-xs px-2.5 py-1.5 font-medium bg-primary text-primary-foreground border-0"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export default TabBarAction
