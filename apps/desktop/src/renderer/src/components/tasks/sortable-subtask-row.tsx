import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
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
        {...attributes}
        {...listeners}
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
          'hover:bg-accent/50 rounded-r-sm',
          'transition-colors duration-150',
          onClick && 'focus-visible:outline-none',
          isDragging
            ? 'cursor-grabbing opacity-50 shadow-lg ring-2 ring-primary bg-background z-10'
            : 'cursor-grab'
        )}
        aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
      >
        <div onClick={(e) => e.stopPropagation()}>
          <InteractiveStatusIcon
            type={statusType}
            color={statusColor}
            isCompleted={isCompleted}
            onClick={() => onToggleComplete(subtask.id)}
          />
        </div>

        {/* Title */}
        <span
          className={cn(
            'text-[13px] font-medium whitespace-nowrap',
            isCompleted
              ? 'line-through text-muted-foreground/60 decoration-1'
              : 'text-foreground/90'
          )}
        >
          {subtask.title}
        </span>
      </div>
    </div>
  )
}

export default SortableSubtaskRow
