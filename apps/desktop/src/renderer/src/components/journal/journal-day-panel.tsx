import { useState, useEffect, useCallback, useMemo } from 'react'
import { cn } from '@/lib/utils'
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
import { ChevronUp, ChevronDown } from '@/lib/icons'
import { createLogger } from '@/lib/logger'

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

interface ScheduleEvent {
  time: string
  title: string
  duration: string
  color: string
}

const SCHEDULE_COLORS = ['#5E6AD2', '#8B5CF6', '#F97316', '#06B6D4', '#EC4899']

function getDummySchedule(date: string): ScheduleEvent[] {
  const d = new Date(date + 'T00:00:00')
  const dow = d.getDay()

  if (dow === 0 || dow === 6) return []

  const seed = d.getDate() + d.getMonth() * 31
  const events: ScheduleEvent[] = []

  const pool: Array<[string, string, string]> = [
    ['9:00', 'Team standup', '30 min'],
    ['10:00', 'Sprint planning', '1 hr'],
    ['11:00', 'Design review', '45 min'],
    ['13:00', '1:1 with lead', '30 min'],
    ['14:00', 'Architecture sync', '1 hr'],
    ['15:00', 'Code review session', '45 min'],
    ['16:00', 'Retro', '1 hr']
  ]

  const count = 1 + (seed % 3)
  const start = seed % pool.length

  for (let i = 0; i < count; i++) {
    const [time, title, duration] = pool[(start + i * 2) % pool.length]
    events.push({
      time,
      title,
      duration,
      color: SCHEDULE_COLORS[(start + i) % SCHEDULE_COLORS.length]
    })
  }

  return events.sort((a, b) => a.time.localeCompare(b.time))
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

      {task.subtaskCount > 0 && (
        <div className="pl-[52px]">
          <SubtaskProgressIndicator
            completed={task.completedSubtaskCount}
            total={task.subtaskCount}
            accentColor={statusColor}
          />
        </div>
      )}
    </div>
  )
}

interface JournalDayPanelProps {
  date: string
  className?: string
}

export function JournalDayPanel({ date, className }: JournalDayPanelProps) {
  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [overdueCount, setOverdueCount] = useState(0)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { projects } = useTasksContext()
  const { openTab } = useTabActions()

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

  const schedule = useMemo(() => getDummySchedule(date), [date])

  const fetchTasks = useCallback(async () => {
    try {
      const result = await tasksService.list({
        dueAfter: date,
        dueBefore: date,
        includeCompleted: true,
        sortBy: 'priority',
        sortOrder: 'desc'
      })
      setTasks(result.tasks)
    } catch (err) {
      log.error('Failed to fetch tasks for date', date, err)
    }
  }, [date])

  const fetchOverdueCount = useCallback(async () => {
    if (!isToday) return
    try {
      const stats = await tasksService.getStats()
      setOverdueCount(stats.overdue)
    } catch (err) {
      log.error('Failed to fetch overdue count', err)
    }
  }, [isToday])

  useEffect(() => {
    fetchTasks()
    fetchOverdueCount()
  }, [fetchTasks, fetchOverdueCount])

  useEffect(() => {
    const refresh = () => {
      fetchTasks()
      fetchOverdueCount()
    }
    const unsubs = [
      onTaskCreated(refresh),
      onTaskUpdated(refresh),
      onTaskDeleted(refresh),
      onTaskCompleted(refresh)
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [fetchTasks, fetchOverdueCount])

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
            <div className="flex flex-col gap-2.5">
              <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold text-[11px]">
                Schedule
              </span>
              {schedule.map((event) => (
                <div key={`${event.time}-${event.title}`} className="flex items-start gap-2.5">
                  <span className="w-10 shrink-0 inline-block text-muted-foreground font-mono text-xs tabular-nums">
                    {event.time}
                  </span>
                  <div
                    className="w-0.5 h-8 shrink-0 rounded-[1px]"
                    style={{ backgroundColor: event.color }}
                  />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="inline-block text-foreground/90 font-medium text-[13px] truncate">
                      {event.title}
                    </span>
                    <span className="inline-block text-muted-foreground text-xs">
                      {event.duration}
                    </span>
                  </div>
                </div>
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
