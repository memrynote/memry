import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDraggable } from '@dnd-kit/core'
import { toast } from 'sonner'
import { ICS_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'
import { cn } from '@/lib/utils'
import { useCalendarRange } from '@/hooks/use-calendar-range'
import type {
  CalendarProjectionItem,
  CalendarProjectionVisualType
} from '@/services/calendar-service'
import {
  tasksService,
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onTaskCompleted,
  type TaskListItem
} from '@/services/tasks-service'
import { useTasksContext } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import type { Status, Project } from '@/data/tasks-data'
import { GripVertical, Plus } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { extractErrorMessage } from '@/lib/ipc-error'
import { localDayRange } from '@/lib/local-day-range'
import { resolveProjectIdForNoteTask } from '@/lib/note-task-project'
import { formatTimeOfDay, formatTimeString, type ClockFormat } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('JournalDayPanel')

type ScheduleRowKind = Exclude<CalendarProjectionVisualType, 'task'>

interface ScheduleEvent {
  id: string
  startAt: string
  timeLabel: string | null
  title: string
  kind: ScheduleRowKind
  label: string | null
}

function formatScheduleTimeLabel(
  startAt: string,
  endAt: string | null,
  isAllDay: boolean,
  clockFormat: ClockFormat
): string | null {
  if (isAllDay) return null
  const start = new Date(startAt)
  const startLabel = formatTimeOfDay(start, clockFormat)
  if (!endAt) return startLabel
  const end = new Date(endAt)
  if (end.getTime() <= start.getTime()) return startLabel
  const endLabel = formatTimeOfDay(end, clockFormat)
  const sameLocalDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  return sameLocalDay ? `${startLabel} - ${endLabel}` : `${startLabel} - ${endLabel} (+1)`
}

function formatSnoozeOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  if (abs < 60) return `${sign}${abs}m`

  const hours = Math.floor(abs / 60)
  const rem = abs % 60
  if (rem === 0) return `${sign}${hours}h`
  return `${sign}${hours}h${rem}m`
}

function capitalize(value: string): string {
  if (!value) return value
  return value[0].toUpperCase() + value.slice(1)
}

function getScheduleLabel(item: CalendarProjectionItem): string | null {
  switch (item.visualType) {
    case 'event':
      return null
    case 'external_event':
      if (item.source.provider === ICS_CALENDAR_PROVIDER) return item.source.title
      return item.source.provider ? capitalize(item.source.provider) : null
    case 'reminder':
      return item.snoozeOffsetMinutes !== null ? formatSnoozeOffset(item.snoozeOffsetMinutes) : null
    case 'snooze':
      return 'inbox'
    default:
      return null
  }
}

function toScheduleEvent(
  item: CalendarProjectionItem,
  clockFormat: ClockFormat
): ScheduleEvent | null {
  if (item.visualType === 'task') return null

  return {
    id: item.projectionId,
    startAt: item.startAt,
    timeLabel: formatScheduleTimeLabel(item.startAt, item.endAt, item.isAllDay, clockFormat),
    title: item.title,
    kind: item.visualType,
    label: getScheduleLabel(item)
  }
}

interface TaskRowProps {
  task: TaskListItem
  statuses: Status[]
  clockFormat: ClockFormat
  onToggleComplete: (id: string, isCompleted: boolean) => void
  onStatusChange: (id: string, statusId: string) => void
  onNavigate: (taskId: string, projectId: string) => void
}

/**
 * One line: status, title, and a fixed trailing slot. The slot shows the task's
 * time when it has one; on hover it shows the drag handle instead, since the
 * row can be dragged onto the timeline above.
 */
function TaskRow({
  task,
  statuses,
  clockFormat,
  onToggleComplete,
  onStatusChange,
  onNavigate
}: TaskRowProps) {
  const isCompleted = !!task.completedAt
  const timeLabel = task.dueTime ? formatTimeString(task.dueTime, clockFormat) : null

  return (
    <div
      data-testid="day-panel-task-row"
      className="group flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 transition-colors hover:bg-surface"
      onClick={() => onNavigate(task.id, task.projectId)}
    >
      <div
        className="flex size-4 shrink-0 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <InlineStatusPopover
          statusId={task.statusId ?? ''}
          statuses={statuses}
          isCompleted={isCompleted}
          onStatusChange={(sid) => onStatusChange(task.id, sid)}
          onToggleComplete={() => onToggleComplete(task.id, isCompleted)}
        />
      </div>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-start text-[13px]',
          isCompleted
            ? 'text-muted-foreground/60 line-through [text-underline-position:from-font]'
            : 'text-foreground'
        )}
      >
        {task.title}
      </span>
      <div className="flex w-[52px] shrink-0 items-center justify-end">
        {timeLabel && (
          <span
            className={cn(
              'whitespace-nowrap text-xs tabular-nums text-text-tertiary',
              !isCompleted && 'group-hover:hidden'
            )}
          >
            {timeLabel}
          </span>
        )}
        {!isCompleted && (
          <GripVertical
            aria-hidden="true"
            className="hidden size-3 text-text-tertiary group-hover:block"
          />
        )}
      </div>
    </div>
  )
}

interface AddTaskRowProps {
  onCreate: (title: string) => Promise<boolean>
}

/** "+ Add task": opens an inline field; Enter creates a task due on the panel's day. */
function AddTaskRow({ onCreate }: AddTaskRowProps) {
  const { t } = useT('journal')
  const [isEditing, setIsEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const label = t('dayPanel.addTask')

  const close = () => {
    setIsEditing(false)
    setTitle('')
  }

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) {
      close()
      return
    }
    setIsSaving(true)
    const created = await onCreate(trimmed)
    setIsSaving(false)
    // Stay open after a create so several tasks can be typed in a row.
    if (created) setTitle('')
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        data-testid="day-panel-add-task"
        onClick={() => setIsEditing(true)}
        className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-text-tertiary transition-colors hover:bg-surface hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Plus className="size-[13px]" aria-hidden="true" />
        </span>
        <span className="text-[13px]">{label}</span>
      </button>
    )
  }

  return (
    <div className="flex h-8 items-center gap-2.5 rounded-md bg-surface px-2.5">
      <span className="flex size-4 shrink-0 items-center justify-center text-text-tertiary">
        <Plus className="size-[13px]" aria-hidden="true" />
      </span>
      <input
        autoFocus
        aria-label={label}
        placeholder={t('dayPanel.taskTitlePlaceholder')}
        value={title}
        disabled={isSaving}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (!title.trim()) close()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
}

/**
 * Drags the row onto a calendar time grid (this panel's or the Calendar tab's)
 * to schedule the same task. The draggable id is namespaced because a Tasks
 * tab row may register the bare task id in the same DndContext; drag-context
 * reads the task from `data.taskId`.
 */
function DraggableTaskRow(props: TaskRowProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `day-panel-task:${props.task.id}`,
    // Title and length let the timeline preview the block before the drop.
    data: {
      type: 'calendar-task',
      sourceType: 'calendar',
      taskId: props.task.id,
      title: props.task.title,
      durationMinutes: props.task.durationMinutes ?? null
    },
    disabled: Boolean(props.task.completedAt)
  })

  return (
    <div
      ref={setNodeRef}
      className={cn('touch-none', isDragging && 'opacity-35')}
      {...attributes}
      {...listeners}
    >
      <TaskRow {...props} />
    </div>
  )
}

interface ScheduleRowProps {
  event: ScheduleEvent
  onHoverColor?: (color: string | null) => void
}

function ScheduleRow({ event, onHoverColor }: ScheduleRowProps) {
  const borderColor = getEventBaseColor(event.kind)

  return (
    <div
      className="flex flex-col gap-0.5 rounded-e border-s-2 py-1 ps-2.5 transition-colors hover:bg-accent/40"
      style={{ borderColor }}
      onMouseEnter={() => onHoverColor?.(borderColor)}
      onMouseLeave={() => onHoverColor?.(null)}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">
          {event.title}
        </span>
        {event.label && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {event.label}
          </span>
        )}
      </div>
      {event.timeLabel && (
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
          {event.timeLabel}
        </span>
      )}
    </div>
  )
}

interface JournalDayPanelProps {
  date: string
  className?: string
  /** Off where a time grid for the same day already shows these items. */
  showSchedule?: boolean
  onHoverColor?: (color: string | null) => void
}

export function JournalDayPanel({
  date,
  className,
  showSchedule = true,
  onHoverColor
}: JournalDayPanelProps) {
  const { t } = useT('journal')
  const { isEnabled } = useFeatureFlags()
  const { projects } = useTasksContext()
  const { openTab } = useTabActions()
  const queryClient = useQueryClient()
  const { settings } = useGeneralSettings()
  const clockFormat = settings.clockFormat
  const scheduleRange = useMemo(() => localDayRange(date), [date])
  const scheduleQuery = useCalendarRange(scheduleRange)

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>()
    for (const p of projects) map.set(p.id, p)
    return map
  }, [projects])

  const today = useMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }, [])

  const isToday = date === today

  const schedule = useMemo(
    () =>
      scheduleQuery.items
        .map((item) => toScheduleEvent(item, clockFormat))
        .filter((event): event is ScheduleEvent => event !== null)
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [scheduleQuery.items, clockFormat]
  )

  useEffect(() => {
    onHoverColor?.(null)
  }, [schedule, onHoverColor])

  const { data: tasks = [] } = useQuery({
    queryKey: ['journal-day-panel', 'tasks', date],
    queryFn: async (): Promise<TaskListItem[]> => {
      try {
        const result = await tasksService.list({
          dueAfter: date,
          dueBefore: date,
          includeCompleted: true,
          sortBy: 'priority',
          sortOrder: 'desc'
        })
        return result.tasks
      } catch (err) {
        log.error('Failed to fetch tasks for date', date, err)
        return []
      }
    },
    enabled: isEnabled('tasks')
  })

  const { data: overdueCount = 0 } = useQuery({
    queryKey: ['journal-day-panel', 'overdue-count'],
    queryFn: async (): Promise<number> => {
      try {
        const stats = await tasksService.getStats()
        return stats.overdue
      } catch (err) {
        log.error('Failed to fetch overdue count', err)
        return 0
      }
    },
    enabled: isToday && isEnabled('tasks')
  })

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['journal-day-panel', 'tasks', date] })
      if (isToday) {
        void queryClient.invalidateQueries({ queryKey: ['journal-day-panel', 'overdue-count'] })
      }
    }
    const unsubs = [
      onTaskCreated(refresh),
      onTaskUpdated(refresh),
      onTaskDeleted(refresh),
      onTaskCompleted(refresh)
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [date, isToday, queryClient])

  const handleToggleComplete = useCallback(async (id: string, isCompleted: boolean) => {
    try {
      if (isCompleted) {
        await tasksService.uncomplete(id)
      } else {
        await tasksService.complete({ id })
      }
    } catch (err) {
      log.error('Failed to toggle task completion', err)
    }
  }, [])

  const handleStatusChange = useCallback(async (id: string, statusId: string) => {
    try {
      await tasksService.update({ id, statusId })
    } catch (err) {
      log.error('Failed to update task status', err)
    }
  }, [])

  const handleCreateTask = useCallback(
    async (title: string): Promise<boolean> => {
      const failed = t('dayPanel.addTaskFailed')
      try {
        // No note here, so this resolves to Settings > Tasks default, then inbox.
        const projectId = await resolveProjectIdForNoteTask({ noteId: null, projects })
        if (!projectId) {
          toast.error(failed)
          return false
        }
        const result = await tasksService.create({ projectId, title, dueDate: date })
        if (!result.success) {
          toast.error(result.error ?? failed)
          return false
        }
        void queryClient.invalidateQueries({ queryKey: ['journal-day-panel', 'tasks', date] })
        return true
      } catch (err) {
        log.error('Failed to create task', err)
        toast.error(extractErrorMessage(err, failed))
        return false
      }
    },
    [date, projects, queryClient, t]
  )

  const handleNavigateToOverdue = useCallback(() => {
    openTab({
      type: 'tasks',
      title: t('section.tasks'),
      icon: 'list-checks',
      path: '/tasks',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab, t])

  const handleNavigateToTask = useCallback(
    (taskId: string, projectId: string) => {
      openTab({
        type: 'tasks',
        title: t('section.tasks'),
        icon: 'list-checks',
        path: '/tasks',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: {
          openTaskId: taskId,
          selectedProjectId: projectId
        }
      })
    },
    [openTab, t]
  )

  const hasSchedule = showSchedule && isEnabled('calendar') && schedule.length > 0
  const showTasks = isEnabled('tasks')
  if (!hasSchedule && !showTasks) return null

  return (
    <div className={cn('[font-synthesis:none] flex flex-col gap-4 antialiased', className)}>
      {hasSchedule && (
        <div className="flex flex-col gap-1 px-2.5">
          {schedule.map((event) => (
            <ScheduleRow key={event.id} event={event} onHoverColor={onHoverColor} />
          ))}
        </div>
      )}

      {showTasks && (
        <section data-testid="day-panel-tasks" className="flex flex-col">
          <div className="flex h-7 items-center justify-between gap-2 px-2.5">
            <h3 className="flex items-baseline gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">
                {t('section.tasks')}
              </span>
              {tasks.length > 0 && (
                <span className="text-xs tabular-nums text-text-tertiary">{tasks.length}</span>
              )}
            </h3>
            {overdueCount > 0 && isToday && (
              <button
                type="button"
                onClick={handleNavigateToOverdue}
                className="shrink-0 rounded-sm text-xs font-medium text-destructive underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {t('count.overdue', { count: overdueCount })}
              </button>
            )}
          </div>
          {tasks.map((task) => {
            const proj = projectMap.get(task.projectId)
            const statuses = proj?.statuses ?? []
            return (
              <DraggableTaskRow
                key={task.id}
                task={task}
                statuses={statuses}
                clockFormat={clockFormat}
                onToggleComplete={(...args) => void handleToggleComplete(...args)}
                onStatusChange={(...args) => void handleStatusChange(...args)}
                onNavigate={handleNavigateToTask}
              />
            )
          })}
          <AddTaskRow onCreate={handleCreateTask} />
        </section>
      )}
    </div>
  )
}
