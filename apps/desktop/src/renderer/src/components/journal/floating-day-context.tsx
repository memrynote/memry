/**
 * Floating Day Context Panel
 * Compact floating panel showing schedule & tasks on the right edge of the editor
 */

import { memo, useState } from 'react'
import {
  Calendar,
  CheckCircle2,
  Circle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Users,
  AlertCircle
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { PRIORITY_TEXT_CLASSES, type Priority } from '@/data/sample-tasks'
import type { ScheduleEvent, DayTask } from './day-context-sidebar'

// =============================================================================
// TYPES
// =============================================================================

export interface FloatingDayContextProps {
  events?: ScheduleEvent[]
  tasks?: DayTask[]
  overdueCount?: number
  isToday?: boolean
  onTaskClick?: (taskId: string) => void
  onTaskToggle?: (taskId: string) => void
  onEventClick?: (eventId: string) => void
  className?: string
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const FloatingDayContext = memo(function FloatingDayContext({
  events = [],
  tasks = [],
  overdueCount = 0,
  isToday = false,
  onTaskClick,
  onTaskToggle,
  onEventClick,
  className
}: FloatingDayContextProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(true)
  const [activeTab, setActiveTab] = useState<'schedule' | 'tasks'>('schedule')

  const pendingTasks = tasks.filter((t) => !t.completed)
  const completedTasks = tasks.filter((t) => t.completed)

  // Don't render if no content
  if (events.length === 0 && tasks.length === 0) {
    return <></>
  }

  return (
    <div className={cn('transition-all duration-200 ease-out', className)}>
      {/* Collapsed State - Just icons */}
      {!isExpanded && (
        <button
          onClick={() => setIsExpanded(true)}
          className={cn(
            'flex flex-col items-center gap-2 p-2',
            'rounded-md border border-border/60 bg-background/95 backdrop-blur-sm',
            'shadow-sm hover:shadow-md hover:border-border',
            'transition-all duration-150'
          )}
        >
          <ChevronLeft className="size-4 text-muted-foreground" />

          {/* Schedule indicator */}
          {events.length > 0 && (
            <div className="flex flex-col items-center gap-1">
              <Calendar className="size-4 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">{events.length}</span>
            </div>
          )}

          {/* Tasks indicator */}
          {tasks.length > 0 && (
            <div className="flex flex-col items-center gap-1 relative">
              <CheckCircle2 className="size-4 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground">{pendingTasks.length}</span>
              {overdueCount > 0 && (
                <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500" />
              )}
            </div>
          )}
        </button>
      )}

      {/* Expanded State - Full panel */}
      {isExpanded && (
        <div
          className={cn(
            'w-64 rounded-md border border-border/60 bg-background/95 backdrop-blur-sm',
            'shadow-lg overflow-hidden',
            'animate-in slide-in-from-right-2 fade-in duration-200'
          )}
        >
          {/* Header with tabs */}
          <div className="flex items-center justify-between border-b border-border/40 px-1 py-1">
            <div className="flex items-center gap-1">
              {/* Schedule Tab */}
              <button
                onClick={() => setActiveTab('schedule')}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium',
                  'transition-colors',
                  activeTab === 'schedule'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                <Calendar className="size-3.5" />
                <span>{isToday ? 'Today' : 'Schedule'}</span>
                {events.length > 0 && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-muted-foreground/20">
                    {events.length}
                  </span>
                )}
              </button>

              {/* Tasks Tab */}
              <button
                onClick={() => setActiveTab('tasks')}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium',
                  'transition-colors',
                  activeTab === 'tasks'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                <CheckCircle2 className="size-3.5" />
                <span>Tasks</span>
                {pendingTasks.length > 0 && (
                  <span
                    className={cn(
                      'text-[10px] px-1 py-0.5 rounded',
                      overdueCount > 0
                        ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                        : 'bg-muted-foreground/20'
                    )}
                  >
                    {pendingTasks.length}
                  </span>
                )}
              </button>
            </div>

            {/* Collapse button */}
            <button
              onClick={() => setIsExpanded(false)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-80 overflow-y-auto">
            {activeTab === 'schedule' && (
              <ScheduleContent events={events} onEventClick={onEventClick} />
            )}
            {activeTab === 'tasks' && (
              <TasksContent
                tasks={tasks}
                pendingTasks={pendingTasks}
                completedTasks={completedTasks}
                overdueCount={overdueCount}
                onTaskClick={onTaskClick}
                onTaskToggle={onTaskToggle}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
})

// =============================================================================
// SCHEDULE CONTENT
// =============================================================================

interface ScheduleContentProps {
  events: ScheduleEvent[]
  onEventClick?: (eventId: string) => void
}

function ScheduleContent({ events, onEventClick }: ScheduleContentProps): React.JSX.Element {
  if (events.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <Calendar className="size-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No events scheduled</p>
      </div>
    )
  }

  return (
    <div className="p-2">
      {events.map((event, index) => (
        <button
          key={event.id}
          onClick={() => onEventClick?.(event.id)}
          className={cn(
            'w-full flex items-start gap-2 p-2 rounded-md',
            'hover:bg-muted/50 transition-colors text-left',
            index < events.length - 1 && 'mb-1'
          )}
        >
          {/* Time dot */}
          <div
            className={cn(
              'size-2 rounded-full mt-1.5 flex-shrink-0',
              event.type === 'meeting'
                ? 'bg-blue-500'
                : event.type === 'focus'
                  ? 'bg-purple-500'
                  : event.type === 'reminder'
                    ? 'bg-amber-500'
                    : 'bg-gray-400'
            )}
          />

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {event.isAllDay ? 'All day' : event.time}
              </span>
              {event.attendeeCount && event.attendeeCount > 1 && (
                <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70">
                  <Users className="size-3" />
                  {event.attendeeCount}
                </span>
              )}
            </div>
            <p className="text-xs text-foreground truncate">{event.title}</p>
          </div>
        </button>
      ))}
    </div>
  )
}

// =============================================================================
// TASKS CONTENT
// =============================================================================

interface TasksContentProps {
  tasks: DayTask[]
  pendingTasks: DayTask[]
  completedTasks: DayTask[]
  overdueCount: number
  onTaskClick?: (taskId: string) => void
  onTaskToggle?: (taskId: string) => void
}

function TasksContent({
  tasks,
  pendingTasks,
  completedTasks,
  overdueCount,
  onTaskClick,
  onTaskToggle
}: TasksContentProps): React.JSX.Element {
  if (tasks.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <CheckCircle2 className="size-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No tasks due</p>
      </div>
    )
  }

  const getPriorityColor = (priority?: string) =>
    PRIORITY_TEXT_CLASSES[(priority ?? 'none') as Priority] ?? PRIORITY_TEXT_CLASSES.none

  return (
    <div className="p-2">
      {/* Overdue warning */}
      {overdueCount > 0 && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 mb-2 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <AlertCircle className="size-3.5" />
          <span className="text-xs font-medium">{overdueCount} overdue</span>
        </div>
      )}

      {/* Pending tasks */}
      {pendingTasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center gap-2 p-1.5 rounded-md hover:bg-muted/50 transition-colors group"
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              onTaskToggle?.(task.id)
            }}
            className="flex-shrink-0"
          >
            <Circle className={cn('size-4', getPriorityColor(task.priority))} />
          </button>
          <button
            onClick={() => onTaskClick?.(task.id)}
            className="flex-1 text-left text-xs text-foreground truncate"
          >
            {task.title}
          </button>
          {task.isOverdue && <Clock className="size-3 text-red-500 flex-shrink-0" />}
        </div>
      ))}

      {/* Completed summary */}
      {completedTasks.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/30">
          <span className="text-[11px] text-muted-foreground px-1.5">
            {completedTasks.length} completed
          </span>
        </div>
      )}
    </div>
  )
}

export default FloatingDayContext
