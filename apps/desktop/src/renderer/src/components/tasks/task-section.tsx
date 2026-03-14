import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { startOfDay, addDays } from '@/lib/task-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

type TaskSectionVariant = 'overdue' | 'today' | 'default'

interface TaskSectionProps {
  id: string
  title: string
  subtitle?: string
  count: number
  tasks: Task[]
  allTasks?: Task[]
  projects: Project[]
  variant: TaskSectionVariant
  emptyMessage?: string
  showAddTask?: boolean
  selectedTaskId?: string | null
  date?: Date | null
  onAddTask?: () => void
  onTaskClick?: (taskId: string) => void
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  className?: string
}

const VARIANT_STYLES = {
  overdue: {
    label: 'text-[#C4654A]',
    divider: 'bg-[#F0DEDA] dark:bg-[#5a3030]',
    count: 'text-[#C4654A]',
    borderColor: '#EF4444'
  },
  today: {
    label: 'text-text-primary',
    divider: 'bg-border',
    count: 'text-text-secondary',
    borderColor: undefined
  },
  default: {
    label: 'text-text-secondary',
    divider: 'bg-border',
    count: 'text-text-tertiary',
    borderColor: undefined
  }
} as const

export const TaskSection = ({
  id,
  title,
  subtitle: _subtitle,
  count,
  tasks,
  allTasks = [],
  projects,
  variant,
  emptyMessage,
  showAddTask = false,
  selectedTaskId,
  date,
  onAddTask,
  onTaskClick,
  onToggleComplete,
  onUpdateTask,
  className
}: TaskSectionProps): React.JSX.Element => {
  const sectionId = `section-${id}`
  const styles = VARIANT_STYLES[variant]

  const getDefaultDate = (): Date | null => {
    const today = startOfDay(new Date())
    switch (variant) {
      case 'overdue':
        return addDays(today, -1)
      case 'today':
        return today
      default:
        return null
    }
  }

  const targetDate = date !== undefined ? date : getDefaultDate()
  const lookupContext = useMemo(() => createLookupContext(projects), [projects])

  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: 'section',
      sectionId: id,
      label: title,
      date: targetDate
    }
  })

  const taskIds = tasks.map((t) => t.id)

  const isTaskCompleted = (task: Task): boolean => {
    return isTaskCompletedFast(task, lookupContext.completionMap)
  }

  return (
    <section
      ref={setNodeRef}
      className={cn('flex flex-col transition-all', isOver && 'bg-primary/5 rounded-sm', className)}
      aria-labelledby={sectionId}
    >
      {/* Section Header — flat divider style */}
      <div className="flex items-center pb-2 gap-2">
        <span
          className={cn(
            'text-[12px] tracking-[0.04em] uppercase font-[family-name:var(--font-heading)] font-semibold leading-4 shrink-0',
            styles.label
          )}
        >
          {title}
        </span>
        <div className={cn('h-px grow shrink basis-0', styles.divider)} />
        <div className="flex items-center gap-1 shrink-0">
          {onAddTask && (
            <button
              type="button"
              onClick={onAddTask}
              className={cn(
                'size-5 flex items-center justify-center rounded-sm',
                'text-text-tertiary hover:text-text-secondary hover:bg-accent/50',
                'transition-colors cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              title={`Add task to ${title}`}
            >
              <Plus className="size-3.5" strokeWidth={2} />
            </button>
          )}
          <span
            className={cn(
              'text-[11px] font-[family-name:var(--font-mono)] font-medium leading-3.5',
              styles.count
            )}
          >
            {count}
          </span>
        </div>
      </div>

      {/* Task list */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col">
          {tasks.length > 0 ? (
            tasks.map((task) => {
              const project = lookupContext.projectMap.get(task.projectId)
              if (!project) return null

              return (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  projects={projects}
                  sectionId={id}
                  allTasks={allTasks}
                  isCompleted={isTaskCompleted(task)}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={true}
                  onToggleComplete={onToggleComplete}
                  onUpdateTask={onUpdateTask}
                  onClick={onTaskClick}
                />
              )
            })
          ) : (
            <div className="px-4 py-8 text-center text-text-tertiary text-sm">
              {emptyMessage || 'No tasks'}
              {showAddTask && onAddTask && (
                <button
                  type="button"
                  onClick={onAddTask}
                  className={cn(
                    'block mx-auto mt-3 text-primary hover:text-primary/80',
                    'text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  )}
                >
                  + Add task
                </button>
              )}
            </div>
          )}
        </div>
      </SortableContext>

      {/* Drop indicator */}
      {isOver && (
        <div className="px-4 py-2 text-center text-sm text-primary font-medium bg-primary/5 border-t border-primary/20 rounded-b-sm">
          Drop to move to {title}
        </div>
      )}
    </section>
  )
}

export default TaskSection
