import { RefreshCw } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getRepeatDisplayText, getRepeatProgress } from '@/lib/repeat-utils'
import type { RepeatConfig } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface RepeatIndicatorProps {
  config: RepeatConfig
  showTooltip?: boolean
  size?: 'sm' | 'md'
  className?: string
}

// ============================================================================
// REPEAT INDICATOR COMPONENT
// ============================================================================

export const RepeatIndicator = ({
  config,
  showTooltip = true,
  size = 'sm',
  className
}: RepeatIndicatorProps): React.JSX.Element => {
  const displayText = getRepeatDisplayText(config)
  const progress = getRepeatProgress(config)

  const iconSize = size === 'sm' ? 'size-3.5' : 'size-4'

  const indicator = (
    <span
      className={cn('inline-flex items-center text-blue-500', className)}
      aria-label={`Repeating: ${displayText}`}
    >
      <RefreshCw className={iconSize} aria-hidden="true" />
    </span>
  )

  if (!showTooltip) {
    return indicator
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{indicator}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px]">
          <div className="flex flex-col gap-1">
            <span className="font-medium">{displayText}</span>
            {progress && (
              <span className="text-xs text-muted-foreground">
                {progress.current} of {progress.total} completed
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default RepeatIndicator
