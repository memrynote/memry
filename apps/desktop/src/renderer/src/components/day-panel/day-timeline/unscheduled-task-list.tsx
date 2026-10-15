import { useCallback, useRef, type ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { useCalendarDateDroppable } from '@/components/calendar/use-calendar-date-droppable'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import { useNativeTaskDrop } from './use-native-task-drop'
import type { TaskListItem } from '@/services/tasks-service'
import type { Priority } from '@/data/task-model'
import type { Status } from '@/data/tasks-data'

const PRIORITY_NUM_TO_KEY: Record<number, Priority> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent'
}

const COMPLETED_COLOR = '#7B9E87'

export interface TaskRowHandlers {
  onToggleComplete: (id: string, isCompleted: boolean) => void
  onStatusChange: (id: string, statusId: string) => void
  onPriorityChange: (id: string, priority: Priority) => void
  onNavigate: (taskId: string, projectId: string) => void
}

interface TaskRowProps extends TaskRowHandlers {
  task: TaskListItem
  statuses: Status[]
  draggable: boolean
}

function TaskRow({
  task,
  statuses,
  draggable,
  onToggleComplete,
  onStatusChange,
  onPriorityChange,
  onNavigate
}: TaskRowProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `day-panel-task:${task.id}`,
    data: { type: 'calendar-task', sourceType: 'calendar', taskId: task.id },
    disabled: !draggable
  })
  const isCompleted = !!task.completedAt
  const priority = PRIORITY_NUM_TO_KEY[task.priority] ?? 'none'
  const statusColor = isCompleted
    ? COMPLETED_COLOR
    : (statuses.find((s) => s.id === task.statusId)?.color ?? '#A0A0A8')

  return (
    <div
      ref={setNodeRef}
      data-testid="day-panel-task"
      data-task-id={task.id}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      className={cn(
        'flex flex-col gap-0.5 py-[5px] -mx-1.5 px-1.5 rounded-md transition-colors hover:bg-accent/60 cursor-pointer',
        draggable && 'touch-none',
        isDragging && 'opacity-40'
      )}
      onClick={() => onNavigate(task.id, task.projectId)}
    >
      <div className="flex items-center gap-2 w-full">
        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <InlineStatusPopover
            statusId={task.statusId ?? ''}
            statuses={statuses}
            isCompleted={isCompleted}
            onStatusChange={(sid) => onStatusChange(task.id, sid)}
            onToggleComplete={() => onToggleComplete(task.id, isCompleted)}
          />
        </div>
        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <InlinePriorityPopover
            priority={priority}
            onPriorityChange={(p) => onPriorityChange(task.id, p)}
          />
        </div>
        <span
          className={cn(
            'text-[13px] font-medium truncate min-w-0 text-start',
            isCompleted
              ? 'text-muted-foreground/60 line-through [text-underline-position:from-font]'
              : 'text-foreground/90'
          )}
        >
          {task.title}
        </span>
      </div>

      {(task.subtaskCount ?? 0) > 0 && (
        <div className="ps-[52px]">
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

/**
 * The day's tasks below the timeline. With the timeline on, these are the
 * open tasks with no time, the list is a drop target that clears a block's
 * time, and each row drags onto a slot.
 */
export function DayTaskList({
  date,
  title,
  tasks,
  statusesFor,
  schedulable,
  headerAccessory,
  handlers,
  onUnscheduleTask
}: {
  date: string
  title: string
  tasks: TaskListItem[]
  statusesFor: (projectId: string) => Status[]
  schedulable: boolean
  headerAccessory?: ReactNode
  handlers: TaskRowHandlers
  onUnscheduleTask: (taskId: string) => void
}): React.JSX.Element | null {
  const { t } = useT('journal')
  const { setNodeRef, isOver } = useCalendarDateDroppable({
    date,
    timeBehavior: 'clear',
    scope: 'day-panel-unscheduled'
  })
  const nativeRef = useRef<HTMLDivElement | null>(null)
  const { isOver: isNativeOver } = useNativeTaskDrop(nativeRef, { onDrop: onUnscheduleTask })
  const setListRef = useCallback(
    (node: HTMLDivElement | null) => {
      nativeRef.current = node
      setNodeRef(node)
    },
    [setNodeRef]
  )
  if (!schedulable && tasks.length === 0) return null

  return (
    <div
      ref={schedulable ? setListRef : undefined}
      data-testid="day-panel-task-list"
      className={cn(
        'flex flex-col gap-1.5 rounded-md pt-1 transition-colors',
        (isOver || isNativeOver) && 'bg-tint/10 outline-1 outline-dashed outline-tint'
      )}
    >
      <div className="flex items-center justify-between">
        <span className="tracking-[0.06em] uppercase inline-block text-muted-foreground font-semibold text-[11px]">
          {title}
        </span>
        {headerAccessory}
      </div>
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          statuses={statusesFor(task.projectId)}
          draggable={schedulable}
          {...handlers}
        />
      ))}
      {schedulable && tasks.length === 0 && (
        <p className="py-1 text-[12px] text-muted-foreground">
          {t('dayTimeline.unscheduledEmpty')}
        </p>
      )}
    </div>
  )
}
