import { Globe, Brain } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface ModeToggleProps {
  mode: 'web' | 'thinking'
  enabled: boolean
  onToggle: () => void
}

export function ModeToggle({ mode, enabled, onToggle }: ModeToggleProps) {
  const config = {
    web: {
      icon: Globe,
      activeClass: 'bg-blue-100 text-blue-600',
      tooltipEnabled: 'Web search enabled',
      tooltipDisabled: 'Web search'
    },
    thinking: {
      icon: Brain,
      activeClass: 'bg-purple-100 text-purple-600',
      tooltipEnabled: 'Thinking mode enabled',
      tooltipDisabled: 'Deep thinking'
    }
  }

  const { icon: Icon, activeClass, tooltipEnabled, tooltipDisabled } = config[mode]

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={enabled}
            aria-label={enabled ? tooltipEnabled : tooltipDisabled}
            className={cn(
              'h-8 w-8 rounded-full flex items-center justify-center',
              'transition-all duration-150',
              'focus:outline-none focus:ring-1 focus:ring-stone-400 focus:ring-offset-1',
              enabled ? activeClass : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600',
              enabled && 'animate-pulse-once'
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {enabled ? tooltipEnabled : tooltipDisabled}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
