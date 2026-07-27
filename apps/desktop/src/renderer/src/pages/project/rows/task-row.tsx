import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { formatDueDate } from '@/lib/task-utils'
import type { Priority, Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { HubRow } from './hub-row'

interface TaskRowProps {
  task: Task
  project: Project
  onOpen: (taskId: string) => void
  onStatusChange: (taskId: string, statusId: string) => void
  onToggleComplete: (taskId: string) => void
  onPriorityChange: (taskId: string, priority: Priority) => void
}

const DUE_TONE: Record<string, string> = {
  overdue: 'text-destructive',
  today: 'text-warning',
  tomorrow: 'text-foreground'
}

export const TaskRow = ({
  task,
  project,
  onOpen,
  onStatusChange,
  onToggleComplete,
  onPriorityChange
}: TaskRowProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const status = project.statuses.find((candidate) => candidate.id === task.statusId)
  const isDone = status?.type === 'done'
  const due = formatDueDate(task.dueDate, task.dueTime)

  return (
    <HubRow
      leading={
        <>
          <InlineStatusPopover
            statusId={task.statusId}
            statuses={project.statuses}
            isCompleted={isDone}
            onStatusChange={(statusId) => onStatusChange(task.id, statusId)}
            onToggleComplete={() => onToggleComplete(task.id)}
          />
          <InlinePriorityPopover
            priority={task.priority}
            onPriorityChange={(priority) => onPriorityChange(task.id, priority)}
          />
        </>
      }
      onOpen={() => onOpen(task.id)}
      openLabel={t('projectHub.rows.openTask', { title: task.title })}
      trailing={
        <>
          {task.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border px-1.5 py-0.5 text-[11px] leading-none"
            >
              {tag}
            </span>
          ))}
          {isDone ? (
            <span className="text-success">{status?.name}</span>
          ) : due ? (
            <span className={cn(DUE_TONE[due.status] ?? 'text-muted-foreground')}>{due.label}</span>
          ) : null}
        </>
      }
    >
      <span className={cn('truncate text-sm', isDone && 'text-muted-foreground line-through')}>
        {task.title}
      </span>
    </HubRow>
  )
}
