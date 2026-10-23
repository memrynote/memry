import { cn } from '@/lib/utils'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import type { Task } from '@/data/task-model'
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
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- semantic tag would change default styles/behavior; ARIA role kept to preserve visuals and semantics
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
        'flex items-center gap-2 border-s-[3px] border-s-transparent',
        'py-1.5 ps-[44px] pe-3',
        'hover:bg-muted cursor-pointer rounded-e-sm',
        'transition-colors duration-150',
        onClick && 'focus-visible:outline-none',
        className
      )}
      aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer-only wrapper; keyboard access is provided by the inner controls */}
      <div
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <InteractiveStatusIcon
          type={statusType}
          color={statusColor}
          isCompleted={isCompleted}
          onClick={() => {
            onToggleComplete(subtask.id)
          }}
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
