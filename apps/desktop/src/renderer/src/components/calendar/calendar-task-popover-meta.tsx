import { Calendar, Repeat, AlertTriangle } from '@/lib/icons'
import { formatTaskDue } from '@/lib/format-task-due'
import { TagChip, type Tag } from '@/components/note/tags-row'
import { PriorityIcon } from '@/components/tasks/task-icons'
import { StatusIcon } from '@/components/tasks/status-icon'
import { priorityConfig, type Priority } from '@/data/task-model'
import type { Status } from '@/data/tasks-data'
import { TaskDescriptionPreview } from '@/components/tasks/task-description-preview'
import { cn } from '@/lib/utils'

export interface CalendarTaskPopoverMetaTask {
  dueDate: string | null
  dueTime: string | null
  endAt?: string | null
  isAllDay?: boolean
  priority: 0 | 1 | 2 | 3 | 4
  statusId?: string | null
}

export interface CalendarTaskPopoverMetaProps {
  task: CalendarTaskPopoverMetaTask
  statuses?: Status[]
  tags: Tag[]
  repeatSummary: string | null
  description: string | null
  now?: Date
  isCompleted: boolean
  onTagClick?: (tag: Tag) => void
}

const MAX_VISIBLE_TAGS = 3
const PRIORITY_BY_NUMBER: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

const PILL_CLASS =
  'inline-flex h-[26px] items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0'

/**
 * The task's properties as quiet pills under the title: when, how often,
 * status, priority, tags. Indented to the title so the checkbox stays alone in
 * its lane.
 */
export function CalendarTaskPopoverMeta({
  task,
  statuses = [],
  tags,
  repeatSummary,
  description,
  now,
  isCompleted,
  onTagClick
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
  const priorityKey = PRIORITY_BY_NUMBER[task.priority] ?? 'none'
  const priorityCfg = priorityConfig[priorityKey]
  const status = statuses.find((candidate) => candidate.id === task.statusId)
  const statusType = isCompleted ? 'done' : (status?.type ?? 'todo')

  return (
    <div className="flex flex-col gap-2.5 pb-3.5 ps-[42px] pe-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          data-testid="due-row"
          className={cn(
            PILL_CLASS,
            'tabular-nums',
            due.isOverdue && 'border-destructive/40 text-destructive'
          )}
        >
          {due.isOverdue ? <AlertTriangle /> : <Calendar className="text-muted-foreground" />}
          <span>{due.label}</span>
        </span>

        {repeatSummary && (
          <span data-testid="recurrence-row" className={PILL_CLASS}>
            <Repeat className="text-muted-foreground" />
            <span>{repeatSummary}</span>
          </span>
        )}

        {status && (
          <span data-testid="status-row" className={PILL_CLASS}>
            <span role="img" aria-label={`Status: ${status.name}`} className="inline-flex">
              <StatusIcon type={statusType} color={status.color || '#6B7280'} size="sm" />
            </span>
            <span>{status.name}</span>
          </span>
        )}

        {task.priority > 0 && (
          <span data-testid="priority-row" className={PILL_CLASS}>
            <PriorityIcon priority={priorityKey} />
            <span>{priorityCfg.label ?? priorityKey}</span>
          </span>
        )}

        {visibleTags.map((tag) => (
          <TagChip
            key={tag.id}
            tag={tag}
            onClick={onTagClick ? () => onTagClick(tag) : undefined}
          />
        ))}
        {overflowCount > 0 && (
          <span className="px-1 text-[11px] font-medium text-muted-foreground">
            +{overflowCount}
          </span>
        )}
      </div>

      {description && (
        <TaskDescriptionPreview
          data-testid="description"
          markdown={description}
          className="line-clamp-3 text-muted-foreground"
        />
      )}
    </div>
  )
}
