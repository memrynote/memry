import { StatusIcon } from '@/components/tasks/status-icon'
import { cn } from '@/lib/utils'
import type { Status } from '@/data/tasks-data'

export interface CalendarTaskPopoverHeaderTask {
  id: string
  title: string
  completedAt: string | null
  parentId: string | null
  statusId: string | null
}

export interface CalendarTaskPopoverHeaderProps {
  task: CalendarTaskPopoverHeaderTask
  parentTitle: string | null
  statuses: Status[]
}

export function CalendarTaskPopoverHeader({
  task,
  parentTitle,
  statuses
}: CalendarTaskPopoverHeaderProps): React.JSX.Element {
  const isDone = !!task.completedAt
  const currentStatus = statuses.find((status) => status.id === task.statusId)
  const statusColor = currentStatus?.color || '#6B7280'
  const statusName = currentStatus?.name || 'Unknown'
  const statusType = isDone ? 'done' : (currentStatus?.type ?? 'todo')

  return (
    <div className="flex items-start gap-2 ps-3 pe-3 py-2 border-b">
      <div className="flex-1 min-w-0">
        {task.parentId && parentTitle && (
          <div data-testid="parent-breadcrumb" className="text-xs text-muted-foreground truncate">
            ↳ {parentTitle}
          </div>
        )}
        <div className="flex items-start gap-2">
          {statuses.length > 0 && (
            <span
              role="img"
              aria-label={`Status: ${statusName}`}
              title={statusName}
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm"
              style={{ backgroundColor: `${statusColor}14` }}
            >
              <StatusIcon type={statusType} color={statusColor} />
            </span>
          )}
          <span
            className={cn(
              'min-w-0 flex-1 text-sm font-medium leading-snug line-clamp-2',
              isDone && 'line-through text-muted-foreground'
            )}
            title={task.title}
          >
            {task.title}
          </span>
        </div>
      </div>
    </div>
  )
}
