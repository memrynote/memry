import { useState } from 'react'
import { MoreHorizontal, Pencil, Calendar, Flag, ArrowUp, Trash2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { priorityConfig, type Task, type Priority } from '@/data/sample-tasks'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskActionsMenuProps {
  subtask: Task
  onEdit: () => void
  onDelete: () => void
  onPromote: () => void
  onSetPriority: (priority: Priority) => void
  onSetDueDate: (date: Date | null) => void
}

// ============================================================================
// PRIORITY OPTIONS
// ============================================================================

const priorityOptions: { value: Priority; label: string; color: string | null }[] = [
  { value: 'none', label: 'No priority', color: null },
  { value: 'low', label: 'Low', color: priorityConfig.low.color },
  { value: 'medium', label: 'Medium', color: priorityConfig.medium.color },
  { value: 'high', label: 'High', color: priorityConfig.high.color },
  { value: 'urgent', label: 'Urgent', color: priorityConfig.urgent.color }
]

// ============================================================================
// QUICK DATE OPTIONS
// ============================================================================

const getQuickDateOptions = (): { id: string; label: string; getDate: () => Date | null }[] => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const nextWeek = new Date(today)
  nextWeek.setDate(nextWeek.getDate() + 7)

  return [
    { id: 'today', label: 'Today', getDate: () => today },
    { id: 'tomorrow', label: 'Tomorrow', getDate: () => tomorrow },
    { id: 'next-week', label: 'Next week', getDate: () => nextWeek },
    { id: 'none', label: 'No date', getDate: () => null }
  ]
}

// ============================================================================
// SUBTASK ACTIONS MENU COMPONENT
// ============================================================================

export const SubtaskActionsMenu = ({
  subtask,
  onEdit,
  onDelete,
  onPromote,
  onSetPriority,
  onSetDueDate
}: SubtaskActionsMenuProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const quickDateOptions = getQuickDateOptions()

  const handleEdit = (): void => {
    onEdit()
    setIsOpen(false)
  }

  const handleDelete = (): void => {
    onDelete()
    setIsOpen(false)
  }

  const handlePromote = (): void => {
    onPromote()
    setIsOpen(false)
  }

  const handleSetPriority = (priority: Priority): void => {
    onSetPriority(priority)
  }

  const handleSetDueDate = (getDate: () => Date | null): void => {
    onSetDueDate(getDate())
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'p-1 rounded hover:bg-accent transition-colors',
            'opacity-0 group-hover:opacity-100',
            isOpen && 'opacity-100'
          )}
          aria-label="Subtask actions"
        >
          <MoreHorizontal className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={handleEdit}>
          <Pencil className="size-4 mr-2" />
          Edit title
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Due Date Submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Calendar className="size-4 mr-2" />
            Set due date
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {quickDateOptions.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => handleSetDueDate(option.getDate)}>
                {option.label}
                {subtask.dueDate && option.id === 'none' && (
                  <span className="ml-auto text-xs text-muted-foreground">Clear</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Priority Submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Flag className="size-4 mr-2" />
            Set priority
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {priorityOptions.map((option) => (
              <DropdownMenuItem key={option.value} onClick={() => handleSetPriority(option.value)}>
                <span className="flex items-center gap-2">
                  {option.color ? (
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                  ) : (
                    <span className="size-2.5 rounded-full border-2 border-muted-foreground/40" />
                  )}
                  {option.label}
                </span>
                {subtask.priority === option.value && (
                  <span className="ml-auto text-xs text-primary">✓</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handlePromote}>
          <ArrowUp className="size-4 mr-2" />
          Promote to task
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleDelete} variant="destructive">
          <Trash2 className="size-4 mr-2" />
          Delete subtask
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default SubtaskActionsMenu
