import { useMemo } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { SectionDivider, type SectionDividerVariant } from '@/components/tasks/section-divider'
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

const toDividerVariant = (v: TaskSectionVariant): SectionDividerVariant =>
  v === 'overdue' ? 'overdue' : 'default'

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
  const dividerVariant = toDividerVariant(variant)

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
      <SectionDivider label={title} count={count} variant={dividerVariant} onAddTask={onAddTask} />

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
