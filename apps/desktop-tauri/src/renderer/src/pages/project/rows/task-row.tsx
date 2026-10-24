import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { TaskTagsBadge } from '@/components/tasks/task-badges'
import { formatDueDate } from '@/lib/task-utils'
import type { Priority, Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { HubRow, HUB_ROW_TITLE } from './hub-row'

interface TaskRowProps {
  task: Task
  project: Project
  onOpen: (taskId: string) => void
  onStatusChange: (taskId: string, statusId: string) => void
  onToggleComplete: (taskId: string) => void
  onPriorityChange: (taskId: string, priority: Priority) => void
  /** False where a column of its own already says when the task is due. */
  showDue?: boolean
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
  onPriorityChange,
  showDue = true
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
          <TaskTagsBadge tags={task.tags} maxVisible={2} size="sm" className="shrink-0" />
          {isDone ? (
            <span className="text-success">{status?.name}</span>
          ) : showDue && due ? (
            <span className={cn(DUE_TONE[due.status] ?? 'text-muted-foreground')}>{due.label}</span>
          ) : null}
        </>
      }
    >
      <span className={cn(HUB_ROW_TITLE, isDone && 'text-muted-foreground line-through')}>
        {task.title}
      </span>
    </HubRow>
  )
}
