import { Trash2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { QuickSnoozeButton } from '@/components/snooze'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface QuickActionsProps {
  itemId: string
  onDelete: (id: string) => void
  onSnooze?: (id: string, snoozeUntil: string) => void
  variant?: 'row' | 'card'
  className?: string
}

const QuickActions = ({
  itemId,
  onDelete,
  onSnooze,
  variant = 'row',
  className
}: QuickActionsProps): React.JSX.Element => {
  const handleDelete = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onDelete(itemId)
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

      {/* Delete button - danger state with red tint on hover */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleDelete}
            className={cn(
              'rounded-md',
              'transition-[background-color,color,transform] duration-[var(--duration-instant)] ease-[var(--ease-out)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'hover:scale-110 active:scale-95',
              isRow
                ? 'p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10'
                : 'p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10'
            )}
            aria-label="Delete item"
          >
            <Trash2 className={isRow ? 'size-4' : 'size-4'} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete</TooltipContent>
      </Tooltip>
    </div>
  )
}

export { QuickActions, type QuickActionsProps }
