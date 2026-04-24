import { Archive } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { QuickSnoozeButton } from '@/components/snooze'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface QuickActionsProps {
  itemId: string
  onArchive: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  variant?: 'row' | 'card'
  className?: string
}

const QuickActions = ({
  itemId,
  onArchive,
  onSnooze,
  variant = 'row',
  className
}: QuickActionsProps): React.JSX.Element => {
  const handleArchive = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onArchive(itemId)
  }

  const handleSnooze = (snoozeUntil: string): void => {
    onSnooze?.(itemId, snoozeUntil)
  }

  const isRow = variant === 'row'

  return (
    <div
      className={cn('flex items-center', isRow ? 'gap-1' : 'gap-2', className)}
      role="group"
      aria-label="Quick actions"
    >
      {/* Snooze button - with dropdown picker */}
      {onSnooze && <QuickSnoozeButton onSnooze={handleSnooze} showLabel={false} />}

      {/* Archive button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleArchive}
            className={cn(
              'rounded-md',
              'transition-[background-color,color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
              'focus-visible:outline-none',
              'hover:scale-110 active:scale-95',
              isRow
                ? 'p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent'
                : 'p-2 text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
            aria-label="Archive item"
          >
            <Archive className={isRow ? 'size-4' : 'size-4'} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Archive</TooltipContent>
      </Tooltip>
    </div>
  )
}

export { QuickActions, type QuickActionsProps }
