import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import type { Priority } from '@/data/sample-tasks'
import type { Status, Project } from '@/data/tasks-data'
import { ChevronDown } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'
import { useGeneralSettings } from '@/hooks/use-general-settings'

const log = createLogger('JournalDayPanel')

const PRIORITY_NUM_TO_KEY: Record<number, Priority> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent'
}

const COMPLETED_COLOR = '#7B9E87'

const PRIORITY_REVERSE_MAP: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

type ScheduleRowKind = Exclude<CalendarProjectionVisualType, 'task'>

interface ScheduleEvent {
  id: string
  startAt: string
  timeLabel: string | null
  title: string
  kind: ScheduleRowKind
  label: string | null
}

function getDayRange(date: string): { startAt: string; endAt: string } {
  const start = new Date(`${date}T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)

  return {
    startAt: start.toISOString(),
    endAt: end.toISOString()
  }
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
  onToggleComplete: (id: string, isCompleted: boolean) => void
  onStatusChange: (id: string, statusId: string) => void
  onPriorityChange: (id: string, priority: Priority) => void
  onNavigate: (taskId: string, projectId: string) => void
}

function TaskRow({
  task,
  statuses,
  onToggleComplete,
  onStatusChange,
  onPriorityChange,
  onNavigate
}: TaskRowProps) {
  const isCompleted = !!task.completedAt
  const priority = PRIORITY_NUM_TO_KEY[task.priority] ?? 'none'
  const statusColor = isCompleted
    ? COMPLETED_COLOR
    : (statuses.find((s) => s.id === task.statusId)?.color ?? '#A0A0A8')

  return (
    <div
      className="flex flex-col gap-0.5 py-[5px] -mx-1.5 px-1.5 rounded-md transition-colors hover:bg-accent/60 cursor-pointer"
      onClick={() => onNavigate(task.id, task.projectId)}
    >
      <div className="flex items-center gap-2 w-full">
        <div onClick={(e) => e.stopPropagation()}>
          <InlineStatusPopover
            statusId={task.statusId ?? ''}
            statuses={statuses}
            isCompleted={isCompleted}
            onStatusChange={(sid) => onStatusChange(task.id, sid)}
            onToggleComplete={() => onToggleComplete(task.id, isCompleted)}
          />
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <InlinePriorityPopover
            priority={priority}
            onPriorityChange={(p) => onPriorityChange(task.id, p)}
          />
        </div>
        <span
          className={cn(
            'text-[13px] font-medium truncate min-w-0 text-left',
            isCompleted
              ? 'text-muted-foreground/60 line-through [text-underline-position:from-font]'
              : 'text-foreground/90'
          )}
        >
          {task.title}
        </span>
      </div>

      {(task.subtaskCount ?? 0) > 0 && (
        <div className="pl-[52px]">
          <SubtaskProgressIndicator
            completed={task.completedSubtaskCount ?? 0}
            total={task.subtaskCount ?? 0}
            accentColor={statusColor}
          />
        </div>
      )}
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
      className="flex flex-col gap-0.5 rounded-r border-l-2 py-1 pl-2.5 transition-colors hover:bg-accent/40"
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
  onHoverColor?: (color: string | null) => void
}

export function JournalDayPanel({ date, className, onHoverColor }: JournalDayPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { projects } = useTasksContext()
  const { openTab } = useTabActions()
  const queryClient = useQueryClient()
  const { settings } = useGeneralSettings()
  const clockFormat = settings.clockFormat
  const scheduleRange = useMemo(() => getDayRange(date), [date])
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
    }
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
    enabled: isToday
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

  const handlePriorityChange = useCallback(async (id: string, priority: Priority) => {
    try {
      await tasksService.update({
        id,
        priority: PRIORITY_REVERSE_MAP[priority] as 0 | 1 | 2 | 3 | 4
      })
    } catch (err) {
      log.error('Failed to update task priority', err)
    }
  }, [])

  const handleNavigateToOverdue = useCallback(() => {
    openTab({
      type: 'tasks',
      title: 'Tasks',
      icon: 'list-checks',
      path: '/tasks',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab])

  const handleNavigateToTask = useCallback(
    (taskId: string, projectId: string) => {
      openTab({
        type: 'tasks',
        title: 'Tasks',
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
    [openTab]
  )

  const hasContent = schedule.length > 0 || tasks.length > 0
  if (!hasContent) return null

  return (
    <div className={cn('[font-synthesis:none] flex flex-col gap-2.5 antialiased', className)}>
      <button
        type="button"
        className="flex items-center justify-between w-full"
        onClick={() => setIsCollapsed((v) => !v)}
      >
        <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold shrink-0 text-[11px]">
          {isToday ? 'Today' : formatShortDate(date)}
        </span>
        <ChevronDown
          className={cn(
            'size-4 text-foreground/70 shrink-0 transition-transform duration-200',
            !isCollapsed && 'rotate-180'
          )}
        />
      </button>

      {!isCollapsed && (
        <>
          {schedule.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold text-[11px]">
                  Schedule
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {schedule.length}
                </span>
              </div>
              {schedule.map((event) => (
                <ScheduleRow key={event.id} event={event} onHoverColor={onHoverColor} />
              ))}
            </div>
          )}

          {tasks.length > 0 && (
            <div className="flex flex-col pt-1 gap-1.5">
              <div className="flex items-center justify-between">
                <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold text-[11px]">
                  Tasks
                </span>
                {overdueCount > 0 && isToday && (
                  <button
                    type="button"
                    onClick={handleNavigateToOverdue}
                    className="flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 transition-colors hover:bg-destructive/15 cursor-pointer"
                  >
                    <span className="size-1 shrink-0 rounded-full bg-destructive" />
                    <span className="text-[10px] font-medium text-destructive">
                      {overdueCount} overdue
                    </span>
                  </button>
                )}
              </div>
              {tasks.map((task) => {
                const proj = projectMap.get(task.projectId)
                const statuses = proj?.statuses ?? []
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    statuses={statuses}
                    onToggleComplete={handleToggleComplete}
                    onStatusChange={handleStatusChange}
                    onPriorityChange={handlePriorityChange}
                    onNavigate={handleNavigateToTask}
                  />
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function formatShortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
