import { MoreHorizontal, CheckCircle2, Circle, Calendar, Flag, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface BulkSubtaskActionsMenuProps {
  subtaskCount: number
  hasIncomplete: boolean
  hasComplete: boolean
  onCompleteAll: () => void
  onMarkAllIncomplete: () => void
  onSetDueDate: () => void
  onSetPriority: () => void
  onDeleteAll: () => void
}

// ============================================================================
// BULK SUBTASK ACTIONS MENU COMPONENT
// ============================================================================

export const BulkSubtaskActionsMenu = ({
  subtaskCount,
  hasIncomplete,
  hasComplete,
  onCompleteAll,
  onMarkAllIncomplete,
  onSetDueDate,
  onSetPriority,
  onDeleteAll
}: BulkSubtaskActionsMenuProps): React.JSX.Element | null => {
  // Don't show menu if no subtasks
  if (subtaskCount === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-accent transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          aria-label="Bulk subtask actions"
        >
          <MoreHorizontal className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-52">
        {/* Completion actions */}
        <DropdownMenuItem
          onClick={onCompleteAll}
          disabled={!hasIncomplete}
          className={cn(!hasIncomplete && 'opacity-50')}
        >
          <CheckCircle2 className="size-4 mr-2" />
          Complete all subtasks
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={onMarkAllIncomplete}
          disabled={!hasComplete}
          className={cn(!hasComplete && 'opacity-50')}
        >
          <Circle className="size-4 mr-2" />
          Mark all incomplete
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Bulk property changes */}
        <DropdownMenuItem onClick={onSetDueDate}>
          <Calendar className="size-4 mr-2" />
          Set due date for all...
        </DropdownMenuItem>

        <DropdownMenuItem onClick={onSetPriority}>
          <Flag className="size-4 mr-2" />
          Set priority for all...
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Delete all */}
        <DropdownMenuItem onClick={onDeleteAll} variant="destructive">
          <Trash2 className="size-4 mr-2" />
          Delete all subtasks
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default BulkSubtaskActionsMenu
