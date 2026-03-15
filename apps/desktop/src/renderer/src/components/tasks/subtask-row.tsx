import { cn } from '@/lib/utils'
import { TaskCheckbox } from '@/components/tasks/task-badges'
import type { Task } from '@/data/sample-tasks'

interface SubtaskRowProps {
  subtask: Task
  isLast: boolean
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

export const SubtaskRow = ({
  subtask,
  isLast: _isLast,
  onToggleComplete,
  onClick,
  className
}: SubtaskRowProps): React.JSX.Element => {
  const isCompleted = !!subtask.completedAt

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
        onClick && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <TaskCheckbox
          checked={isCompleted}
          onChange={() => onToggleComplete(subtask.id)}
          size="sm"
        />
      </div>

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
  )
}

export default SubtaskRow
