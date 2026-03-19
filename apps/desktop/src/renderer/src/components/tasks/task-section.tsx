import { useMemo } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { SectionDivider, type SectionDividerVariant } from '@/components/tasks/section-divider'
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
  isDropTarget?: boolean
  isDragSource?: boolean
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
  onAddTask,
  onTaskClick,
  onToggleComplete,
  onUpdateTask,
  className,
  isDropTarget = false,
  isDragSource = false
}: TaskSectionProps): React.JSX.Element => {
  const sectionId = `section-${id}`
  const dividerVariant = toDividerVariant(variant)
  const lookupContext = useMemo(() => createLookupContext(projects), [projects])
  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks])

  const isTaskCompleted = (task: Task): boolean => {
    return isTaskCompletedFast(task, lookupContext.completionMap)
  }

  return (
    <section
      role="region"
      className={cn(
        'flex flex-col transition-all duration-200',
        isDropTarget && 'ring-2 ring-primary/25 bg-primary/[0.04] rounded-lg',
        isDragSource && 'opacity-50',
        className
      )}
      aria-labelledby={sectionId}
    >
      <SectionDivider label={title} count={count} variant={dividerVariant} onAddTask={onAddTask} />

      <div className="flex flex-col">
        {tasks.length > 0 ? (
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => {
              const project = lookupContext.projectMap.get(task.projectId)
              if (!project) return null

              return (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  projects={projects}
                  allTasks={allTasks}
                  sectionId={id}
                  isCompleted={isTaskCompleted(task)}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={true}
                  onToggleComplete={onToggleComplete}
                  onUpdateTask={onUpdateTask}
                  onClick={onTaskClick}
                />
              )
            })}
          </SortableContext>
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
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                )}
              >
                + Add task
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export default TaskSection
