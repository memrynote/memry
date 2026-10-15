import { useState, useEffect, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useCalendarRange } from '@/hooks/use-calendar-range'
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
import type { Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { ChevronDown } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { localDayRange } from '@/lib/local-day-range'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useT } from '@memry/i18n/renderer'
import { DayTimeline } from '@/components/day-panel/day-timeline/day-timeline'
import { DayTaskList } from '@/components/day-panel/day-timeline/unscheduled-task-list'

const log = createLogger('JournalDayPanel')

const PRIORITY_REVERSE_MAP: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

interface JournalDayPanelProps {
  date: string
  className?: string
  onHoverColor?: (color: string | null) => void
}

export function JournalDayPanel({ date, className, onHoverColor }: JournalDayPanelProps) {
  const { t, i18n } = useT('journal')
  const { isEnabled } = useFeatureFlags()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const { projects, tasks: workspaceTasks } = useTasksContext()
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

  useEffect(() => {
    onHoverColor?.(null)
  }, [scheduleQuery.items, onHoverColor])

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

  const handleOpenTimelineTask = useCallback(
    (taskId: string) => {
      const projectId = workspaceTasks.find((task) => task.id === taskId)?.projectId ?? ''
      handleNavigateToTask(taskId, projectId)
    },
    [workspaceTasks, handleNavigateToTask]
  )

  const handleCompleteTimelineTask = useCallback(
    (taskId: string) => void handleToggleComplete(taskId, false),
    [handleToggleComplete]
  )

  const handleResizeTask = useCallback(async (id: string, durationMinutes: number) => {
    try {
      await tasksService.update({ id, durationMinutes })
    } catch (err) {
      log.error('Failed to resize task', err)
    }
  }, [])

  const showTimeline = isEnabled('calendar')
  const showTasks = isEnabled('tasks')
  const listedTasks = showTimeline
    ? tasks.filter((task) => !task.dueTime && !task.completedAt)
    : tasks
  const statusesFor = useCallback(
    (projectId: string) => projectMap.get(projectId)?.statuses ?? [],
    [projectMap]
  )

  if (!showTimeline && !(showTasks && tasks.length > 0)) return null

  return (
    <div className={cn('[font-synthesis:none] flex flex-col gap-2.5 antialiased', className)}>
      <button
        type="button"
        className="flex items-center justify-between w-full"
        onClick={() => setIsCollapsed((v) => !v)}
      >
        <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold shrink-0 text-[11px]">
          {isToday ? t('date.relative.today') : formatShortDate(date, i18n.language)}
        </span>
        <ChevronDown
          className={cn(
            'size-4 text-foreground/70 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
            !isCollapsed && 'rotate-180'
          )}
        />
      </button>

      {!isCollapsed && (
        <>
          {showTimeline && (
            <DayTimeline
              date={date}
              items={scheduleQuery.items}
              includeTasks={showTasks}
              clockFormat={clockFormat}
              onCompleteTask={handleCompleteTimelineTask}
              onOpenTask={handleOpenTimelineTask}
              onResizeTask={(...args) => void handleResizeTask(...args)}
              onHoverColor={onHoverColor}
            />
          )}

          {showTasks && (
            <DayTaskList
              date={date}
              title={showTimeline ? t('dayTimeline.unscheduled') : t('section.tasks')}
              tasks={listedTasks}
              statusesFor={statusesFor}
              schedulable={showTimeline}
              headerAccessory={
                overdueCount > 0 &&
                isToday && (
                  <button
                    type="button"
                    onClick={handleNavigateToOverdue}
                    className="flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 transition-colors hover:bg-destructive/15 cursor-pointer"
                  >
                    <span className="size-1 shrink-0 rounded-full bg-destructive" />
                    <span className="text-[10px] font-medium text-destructive">
                      {t('count.overdue', { count: overdueCount })}
                    </span>
                  </button>
                )
              }
              handlers={{
                onToggleComplete: (...args) => void handleToggleComplete(...args),
                onStatusChange: (...args) => void handleStatusChange(...args),
                onPriorityChange: (...args) => void handlePriorityChange(...args),
                onNavigate: handleNavigateToTask
              }}
            />
          )}
        </>
      )}
    </div>
  )
}

function formatShortDate(iso: string, locale: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}
