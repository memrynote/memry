import { Calendar, Repeat, AlertTriangle } from '@/lib/icons'
import { formatTaskDue } from '@/lib/format-task-due'
import { TagChip, type Tag } from '@/components/note/tags-row'
import { PriorityIcon } from '@/components/tasks/task-icons'
import { priorityConfig, type Priority } from '@/data/task-model'
import { TaskDescriptionPreview } from '@/components/tasks/task-description-preview'
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
  projectColor: string
  tags: Tag[]
  repeatSummary: string | null
  description: string | null
  now?: Date
  isCompleted: boolean
  onTagClick?: (tag: Tag) => void
}

const MAX_VISIBLE_TAGS = 3
const PRIORITY_BY_NUMBER: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent']

export function CalendarTaskPopoverMeta({
  task,
  projectName,
  projectColor,
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
  const showPriorityRow = task.priority > 0 || tags.length > 0
  const priorityKey = PRIORITY_BY_NUMBER[task.priority] ?? 'none'
  const priorityCfg = priorityConfig[priorityKey]

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

      <div data-testid="project-row" className="flex items-center">
        <span
          className="flex items-center rounded-sm py-0.5 px-2 gap-1.5 [font-synthesis:none]"
          style={{ backgroundColor: `${projectColor}14` }}
        >
          <span
            data-testid="project-color-swatch"
            className="rounded-xs shrink-0 size-2"
            style={{ backgroundColor: projectColor }}
          />
          <span className="text-[11px] font-medium leading-3.5" style={{ color: projectColor }}>
            {projectName}
          </span>
        </span>
      </div>

      {showPriorityRow && (
        <div data-testid="priority-row" className="flex items-center gap-3">
          {task.priority > 0 && (
            <span className="flex items-center gap-1">
              <PriorityIcon priority={priorityKey} />
              <span
                className="text-[11px] font-medium leading-3.5"
                style={{ color: priorityCfg.color ?? 'var(--text-tertiary)' }}
              >
                {priorityCfg.label ?? priorityKey}
              </span>
            </span>
          )}
          {tags.length > 0 && (
            <span className="flex items-center gap-1.5 flex-wrap">
              {visibleTags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={tag}
                  onClick={onTagClick ? () => onTagClick(tag) : undefined}
                />
              ))}
              {overflowCount > 0 && (
                <span className="rounded-[10px] px-2 py-0.5 text-[11px]/3.5 font-medium text-muted-foreground">
                  +{overflowCount}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {description && (
        <TaskDescriptionPreview
          data-testid="description"
          markdown={description}
          className="line-clamp-3"
        />
      )}
    </div>
  )
}
