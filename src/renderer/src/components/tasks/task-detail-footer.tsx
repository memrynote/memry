import { Trash2, MoreHorizontal, Copy, FolderInput, Link2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
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

interface TaskDetailFooterProps {
  onDelete: () => void
  onDuplicate: () => void
  onMoveToProject: () => void
  onCopyLink: () => void
  className?: string
}

// ============================================================================
// TASK DETAIL FOOTER COMPONENT
// ============================================================================

export const TaskDetailFooter = ({
  onDelete,
  onDuplicate,
  onMoveToProject,
  onCopyLink,
  className
}: TaskDetailFooterProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-t border-border px-4 py-3',
        className
      )}
    >
      {/* Delete button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="size-4 mr-2" aria-hidden="true" />
        Delete
      </Button>

      {/* More actions menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <MoreHorizontal className="size-4 mr-2" aria-hidden="true" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy className="size-4 mr-2" aria-hidden="true" />
            Duplicate task
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onMoveToProject}>
            <FolderInput className="size-4 mr-2" aria-hidden="true" />
            Move to project...
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyLink}>
            <Link2 className="size-4 mr-2" aria-hidden="true" />
            Copy link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default TaskDetailFooter
