import { Calendar, Repeat, Folder, Flag, AlertTriangle } from '@/lib/icons'
import { formatTaskDue } from '@/lib/format-task-due'
import { cn } from '@/lib/utils'

export interface CalendarTaskPopoverMetaTask {
  dueDate: string | null
  dueTime: string | null
  endAt?: string | null
  isAllDay?: boolean
  priority: 0 | 1 | 2 | 3 | 4
}

export interface CalendarTaskPopoverMetaProps {
  task: CalendarTaskPopoverMetaTask
  projectName: string
  statusLabel: string | null
  tags: string[]
  repeatSummary: string | null
  description: string | null
  now?: Date
  isCompleted: boolean
}

const MAX_VISIBLE_TAGS = 3

export function CalendarTaskPopoverMeta({
  task,
  projectName,
  statusLabel,
  tags,
  repeatSummary,
  description,
  now,
  isCompleted
}: CalendarTaskPopoverMetaProps): React.JSX.Element | null {
  if (!task.dueDate) return null

  const due = formatTaskDue({
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    endAt: task.endAt,
    completedAt: isCompleted ? '1' : null,
    now
  })
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS)
  const overflowCount = Math.max(0, tags.length - MAX_VISIBLE_TAGS)
  const showPriorityRow = task.priority > 0 || tags.length > 0

  return (
    <div className="px-3 py-2 space-y-1.5 text-sm">
      <div
        data-testid="due-row"
        className={cn('flex items-center gap-1.5', due.isOverdue && 'text-destructive')}
      >
        {due.isOverdue ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : (
          <Calendar className="h-3.5 w-3.5" />
        )}
        <span>{due.label}</span>
      </div>

      {repeatSummary && (
        <div
          data-testid="recurrence-row"
          className="flex items-center gap-1.5 text-muted-foreground"
        >
          <Repeat className="h-3.5 w-3.5" />
          <span>{repeatSummary}</span>
        </div>
      )}

      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Folder className="h-3.5 w-3.5" />
          {projectName}
        </span>
        {statusLabel && (
          <span
            data-testid="status-pill"
            className="rounded-full px-2 py-0.5 text-xs bg-muted"
          >
            {statusLabel}
          </span>
        )}
      </div>

      {showPriorityRow && (
        <div data-testid="priority-row" className="flex items-center gap-3">
          {task.priority > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Flag className="h-3.5 w-3.5" />
              {priorityLabel(task.priority)}
            </span>
          )}
          {tags.length > 0 && (
            <span className="flex items-center gap-1.5 flex-wrap">
              {visibleTags.map((tag) => (
                <span key={tag} className="text-xs text-muted-foreground">
                  #{tag.replace(/^#/, '')}
                </span>
              ))}
              {overflowCount > 0 && (
                <span className="text-xs text-muted-foreground">+{overflowCount}</span>
              )}
            </span>
          )}
        </div>
      )}

      {description && (
        <p data-testid="description" className="text-muted-foreground line-clamp-3">
          {description}
        </p>
      )}
    </div>
  )
}

function priorityLabel(p: number): string {
  if (p >= 3) return 'Urgent'
  if (p === 2) return 'High'
  return 'Medium'
}
