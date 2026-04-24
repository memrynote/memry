import { cn } from '@/lib/utils'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import type { Task } from '@/data/sample-tasks'
import type { Status } from '@/data/tasks-data'

interface SubtaskRowProps {
  subtask: Task
  statuses: Status[]
  isLast: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

export const SubtaskRow = ({
  subtask,
  statuses,
  isLast: _isLast,
  onToggleComplete,
  onClick,
  className
}: SubtaskRowProps): React.JSX.Element => {
  const isCompleted = !!subtask.completedAt
  const status = statuses.find((s) => s.id === subtask.statusId)
  const doneStatus = statuses.find((s) => s.type === 'done')
  const statusType = isCompleted
    ? 'done'
    : ((status?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
  const statusColor = isCompleted
    ? (doneStatus?.color ?? status?.color ?? 'var(--text-tertiary)')
    : (status?.color ?? 'var(--text-tertiary)')

  return (
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
        onClick && 'focus-visible:outline-none',
        className
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

      <span
        className={cn(
          'text-[13px] font-medium whitespace-nowrap',
          isCompleted ? 'line-through text-muted-foreground/60 decoration-1' : 'text-foreground/90'
        )}
      >
        {subtask.title}
      </span>
    </div>
  )
}

export default SubtaskRow
