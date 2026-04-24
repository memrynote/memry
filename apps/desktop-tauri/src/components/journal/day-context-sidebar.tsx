/**
 * Day Context Sidebar Component
 * Shows schedule, tasks, and AI connections for the selected day
 * Clean, minimal design with collapsible sections
 */

import { memo, useState } from 'react'
import {
  Calendar,
  Clock,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Users
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { PRIORITY_TEXT_CLASSES, type Priority } from '@/data/sample-tasks'

// =============================================================================
// TYPES
// =============================================================================

export interface ScheduleEvent {
  id: string
  time: string
  endTime?: string
  title: string
  type?: 'meeting' | 'focus' | 'reminder' | 'other'
  attendeeCount?: number
  isAllDay?: boolean
}

export interface DayTask {
  id: string
  title: string
  completed: boolean
  priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  dueTime?: string
  isOverdue?: boolean
}

export interface DayContextSidebarProps {
  /** Today's schedule/events */
  events?: ScheduleEvent[]
  /** Tasks due today */
  tasks?: DayTask[]
  /** Overdue tasks count */
  overdueCount?: number
  /** Whether this is today */
  isToday?: boolean
  /** Whether this date is in the past */
  isPast?: boolean
  /** Selected date label */
  dateLabel?: string
  /** Callback when task is clicked */
  onTaskClick?: (taskId: string) => void
  /** Callback when task completion is toggled */
  onTaskToggle?: (taskId: string) => void
  /** Callback when event is clicked */
  onEventClick?: (eventId: string) => void
  /** Whether to show the Schedule section */
  showSchedule?: boolean
  /** Whether to show the Tasks section */
  showTasks?: boolean
  className?: string
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const DayContextSidebar = memo(function DayContextSidebar({
  events = [],
  tasks = [],
  overdueCount = 0,
  isToday = false,
  isPast = false,
  dateLabel: _dateLabel,
  onTaskClick,
  onTaskToggle,
  onEventClick,
  showSchedule = true,
  showTasks = true,
  className
}: DayContextSidebarProps): React.JSX.Element | null {
  // dateLabel reserved for future use (e.g., showing selected date label)
  void _dateLabel
  const [eventsExpanded, setEventsExpanded] = useState(true)
  const [tasksExpanded, setTasksExpanded] = useState(true)

  // If both sections are hidden, don't render anything
  if (!showSchedule && !showTasks) {
    return null
  }

  const completedTasks = tasks.filter((t) => t.completed).length
  const pendingTasks = tasks.filter((t) => !t.completed).length

  // Contextual empty messages based on date context
  const getEventsEmptyMessage = () => {
    if (isPast) return 'No events were scheduled'
    if (isToday) return 'No events scheduled today'
    return 'No events scheduled'
  }

  const getTasksEmptyMessage = () => {
    if (isPast) return 'No tasks were due'
    if (isToday) return 'No tasks due today'
    return 'No tasks due'
  }

  return (
    <div
      className={cn('flex flex-col gap-4', className)}
      role="complementary"
      aria-label="Day context: tasks and schedule"
    >
      {/* Schedule Section */}
      {showSchedule && (
        <ContextSection
          icon={<Calendar className="size-4" aria-hidden="true" />}
          title={isToday ? "Today's Schedule" : 'Schedule'}
          count={events.length}
          countLabel={events.length === 1 ? 'event' : 'events'}
          isExpanded={eventsExpanded}
          onToggle={() => setEventsExpanded(!eventsExpanded)}
          isEmpty={events.length === 0}
          emptyMessage={getEventsEmptyMessage()}
        >
          <div className="flex flex-col" role="list" aria-label="Schedule events">
            {events.map((event, index) => (
              <EventItem
                key={event.id}
                event={event}
                onClick={() => onEventClick?.(event.id)}
                isLast={index === events.length - 1}
              />
            ))}
          </div>
        </ContextSection>
      )}

      {/* Tasks Section */}
      {showTasks && (
        <ContextSection
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          title={isToday ? "Today's Tasks" : 'Tasks'}
          count={pendingTasks}
          countLabel="to do"
          badge={overdueCount > 0 ? { count: overdueCount, type: 'warning' } : undefined}
          isExpanded={tasksExpanded}
          onToggle={() => setTasksExpanded(!tasksExpanded)}
          isEmpty={tasks.length === 0}
          emptyMessage={getTasksEmptyMessage()}
        >
          <div className="flex flex-col gap-0.5" role="list" aria-label="Tasks">
            {tasks.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onClick={() => onTaskClick?.(task.id)}
                onToggle={() => onTaskToggle?.(task.id)}
              />
            ))}

            {/* Completed summary if any */}
            {completedTasks > 0 && (
              <div className="mt-2 pt-2 border-t border-border/30">
                <span className="text-xs text-muted-foreground">{completedTasks} completed</span>
              </div>
            )}
          </div>
        </ContextSection>
      )}
    </div>
  )
})

// =============================================================================
// CONTEXT SECTION WRAPPER
// =============================================================================

interface ContextSectionProps {
  icon: React.ReactNode
  title: string
  count?: number
  countLabel?: string
  badge?: { count: number; type: 'warning' | 'info' }
  isExpanded: boolean
  onToggle: () => void
  isEmpty?: boolean
  emptyMessage?: string
  children: React.ReactNode
}

function ContextSection({
  icon,
  title,
  count,
  countLabel,
  badge,
  isExpanded,
  onToggle,
  isEmpty,
  emptyMessage,
  children
}: ContextSectionProps): React.JSX.Element {
  const sectionId = `section-${title.replace(/\s+/g, '-').toLowerCase()}`
  const contentId = `${sectionId}-content`

  return (
    <div className="rounded-md border border-border/40 bg-card/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className={cn(
          'w-full flex items-center justify-between',
          'px-3 py-2.5',
          'hover:bg-muted/30 transition-colors',
          'text-left'
        )}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        id={sectionId}
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <span className="text-sm font-medium text-foreground">{title}</span>

          {/* Count */}
          {count !== undefined && count > 0 && (
            <span className="text-xs text-muted-foreground">
              {count} {countLabel}
            </span>
          )}

          {/* Warning badge */}
          {badge && (
            <span
              className={cn(
                'flex items-center gap-1 text-xs px-1.5 py-0.5 rounded',
                badge.type === 'warning'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              )}
            >
              <AlertCircle className="size-3" />
              {badge.count} overdue
            </span>
          )}
        </div>

        {/* Expand/collapse icon */}
        {isExpanded ? (
          <ChevronDown className="size-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" />
        )}
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-3 pb-3" id={contentId} role="region" aria-labelledby={sectionId}>
          {isEmpty ? (
            <p className="text-xs text-muted-foreground/70 py-2 text-center">{emptyMessage}</p>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// EVENT ITEM
// =============================================================================

interface EventItemProps {
  event: ScheduleEvent
  onClick?: () => void
  isLast?: boolean
}

function EventItem({ event, onClick, isLast }: EventItemProps): React.JSX.Element {
  const getEventColor = (type?: string) => {
    switch (type) {
      case 'meeting':
        return 'bg-blue-500'
      case 'focus':
        return 'bg-purple-500'
      case 'reminder':
        return 'bg-amber-500'
      default:
        return 'bg-gray-400'
    }
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 py-2 w-full text-left',
        'hover:bg-muted/30 rounded-md transition-colors',
        'group px-1 -mx-1',
        !isLast && 'border-b border-border/20'
      )}
    >
      {/* Time indicator line */}
      <div className="flex flex-col items-center pt-0.5">
        <div className={cn('size-2 rounded-full', getEventColor(event.type))} />
        {!isLast && <div className="w-px h-full min-h-[20px] bg-border/30 mt-1" />}
      </div>

      {/* Event details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {event.isAllDay ? 'All day' : event.time}
          </span>
          {event.attendeeCount && event.attendeeCount > 1 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
              <Users className="size-3" />
              {event.attendeeCount}
            </span>
          )}
        </div>
        <p className="text-sm text-foreground truncate mt-0.5">{event.title}</p>
      </div>
    </button>
  )
}

// =============================================================================
// TASK ITEM
// =============================================================================

interface TaskItemProps {
  task: DayTask
  onClick?: () => void
  onToggle?: () => void
}

function TaskItem({ task, onClick, onToggle }: TaskItemProps): React.JSX.Element {
  const getPriorityColor = (priority?: string) =>
    PRIORITY_TEXT_CLASSES[(priority ?? 'none') as Priority] ?? PRIORITY_TEXT_CLASSES.none

  const getPriorityLabel = (priority?: string) => {
    if (!priority || priority === 'none') return ''
    return `, ${priority} priority`
  }

  const statusLabel = task.completed ? 'Completed' : 'Not completed'
  const overdueLabel = task.isOverdue && !task.completed ? ', overdue' : ''
  const ariaLabel = `${task.title}. ${statusLabel}${getPriorityLabel(task.priority)}${overdueLabel}`

  return (
    <div
      className={cn(
        'flex items-center gap-2 py-1.5 px-1 -mx-1',
        'hover:bg-muted/30 rounded-md transition-colors',
        'group'
      )}
      role="listitem"
    >
      {/* Checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggle?.()
        }}
        className="flex-shrink-0 p-0.5"
        aria-label={`Mark "${task.title}" as ${task.completed ? 'not completed' : 'completed'}`}
        aria-pressed={task.completed}
      >
        {task.completed ? (
          <CheckCircle2 className="size-4 text-green-500" aria-hidden="true" />
        ) : (
          <Circle className={cn('size-4', getPriorityColor(task.priority))} aria-hidden="true" />
        )}
      </button>

      {/* Task title */}
      <button
        onClick={onClick}
        className={cn(
          'flex-1 text-left text-sm truncate',
          task.completed ? 'text-muted-foreground line-through' : 'text-foreground'
        )}
        aria-label={ariaLabel}
      >
        {task.title}
      </button>

      {/* Time badge */}
      {task.dueTime && !task.completed && (
        <span
          className={cn(
            'text-xs px-1.5 py-0.5 rounded',
            task.isOverdue ? 'bg-red-500/10 text-red-500' : 'text-muted-foreground'
          )}
        >
          {task.dueTime}
        </span>
      )}

      {/* Overdue indicator */}
      {task.isOverdue && !task.completed && (
        <Clock className="size-3 text-red-500 flex-shrink-0" aria-hidden="true" />
      )}
    </div>
  )
}

export default DayContextSidebar
