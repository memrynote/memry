import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

import { cn } from '@/lib/utils'
import { StatusCircle } from '@/components/tasks/task-icons'
import type { Task } from '@/data/sample-tasks'
import type { Status } from '@/data/tasks-data'

interface SortableSubtaskRowProps {
  subtask: Task
  statuses: Status[]
  parentId: string
  isLast: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

export const SortableSubtaskRow = ({
  subtask,
  statuses,
  parentId,
  isLast: _isLast,
  onToggleComplete,
  onClick,
  className
}: SortableSubtaskRowProps): React.JSX.Element => {
  const isCompleted = !!subtask.completedAt
  const status = statuses.find((s) => s.id === subtask.statusId)
  const doneStatus = statuses.find((s) => s.type === 'done')
  const statusType = isCompleted
    ? 'done'
    : ((status?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
  const statusColor = isCompleted
    ? (doneStatus?.color ?? status?.color ?? 'var(--text-tertiary)')
    : (status?.color ?? 'var(--text-tertiary)')

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
    data: { type: 'subtask', subtask, parentId, sourceType: 'subtask-list' }
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out'
  }

  return (
    <div ref={setNodeRef} style={style} className={cn('group/subtask relative', className)}>
      <div
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={() => onClick?.(subtask.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onClick) {
            e.preventDefault()
            onClick(subtask.id)
          }
        }}
        className={cn(
          'flex items-center gap-2 border-l-[3px] border-l-transparent',
          'py-1.5 pl-[44px] pr-3',
          'hover:bg-accent/50 cursor-pointer rounded-r-sm',
          'transition-colors duration-150',
          onClick && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isDragging && 'opacity-50 shadow-lg ring-2 ring-primary bg-background z-10'
        )}
        aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
      >
        {/* Drag Handle — overlay, visible on hover */}
        <button
          type="button"
          data-drag-handle
          {...attributes}
          {...listeners}
          className={cn(
            'absolute left-[30px] top-1/2 -translate-y-1/2',
            'shrink-0 cursor-grab touch-none p-0.5 text-muted-foreground/50',
            'hover:text-muted-foreground active:cursor-grabbing',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded',
            'opacity-0 group-hover/subtask:opacity-100 transition-opacity',
            isDragging && 'cursor-grabbing opacity-100'
          )}
          aria-label="Drag to reorder subtask"
        >
          <GripVertical className="size-3" />
        </button>

        <div onClick={(e) => e.stopPropagation()}>
          <StatusCircle
            statusType={statusType}
            statusColor={statusColor}
            isCompleted={isCompleted}
            onClick={() => onToggleComplete(subtask.id)}
          />
        </div>

        {/* Title */}
        <span
          className={cn(
            'text-xs leading-4 whitespace-nowrap',
            isCompleted
              ? 'line-through text-[#A3A09B] decoration-1'
              : 'text-[#4A4A46] dark:text-foreground/80'
          )}
        >
          {subtask.title}
        </span>
      </div>
    </div>
  )
}

export default SortableSubtaskRow
