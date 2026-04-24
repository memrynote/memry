import { useMemo } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { ParentTaskRow } from '@/components/tasks/parent-task-row'
import { SectionDivider, type SectionDividerVariant } from '@/components/tasks/section-divider'
import { type UrgencyLevel } from '@/lib/task-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { getTopLevelTasks, getSubtasks, calculateProgress } from '@/lib/subtask-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'

const urgencyToDividerVariant = (urgency: UrgencyLevel): SectionDividerVariant =>
  urgency === 'critical' ? 'overdue' : 'default'

// ============================================================================
// TYPES
// ============================================================================

interface TaskGroupHeaderProps {
  label: string
  count: number
  urgency?: UrgencyLevel
  className?: string
}

interface TaskGroupProps {
  label: string
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  urgency?: UrgencyLevel
  accentColor?: string
  isMuted?: boolean
  showProjectBadge?: boolean
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onTaskClick?: (taskId: string) => void
  className?: string
  date?: Date | null
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  expandedIds?: Set<string>
  onToggleExpand?: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

interface StatusTaskGroupProps {
  status: Status
  tasks: Task[]
  allTasks: Task[]
  project: Project
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onTaskClick?: (taskId: string) => void
  className?: string
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  expandedIds?: Set<string>
  onToggleExpand?: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

// ============================================================================
// TASK GROUP HEADER
// ============================================================================

const TaskGroupHeader = ({
  label,
  count,
  urgency = 'normal',
  className
}: TaskGroupHeaderProps): React.JSX.Element => {
  const variant = urgencyToDividerVariant(urgency)

  return <SectionDivider label={label} count={count} variant={variant} className={className} />
}

// ============================================================================
// TASK GROUP (for due date grouping)
// ============================================================================

export const TaskGroup = ({
  label,
  tasks,
  allTasks,
  projects,
  urgency = 'normal',
  showProjectBadge = false,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  expandedIds,
  onToggleExpand,
  onAddSubtask,
  onReorderSubtasks
}: TaskGroupProps): React.JSX.Element | null => {
  const topLevelTasks = getTopLevelTasks(tasks)
  const topLevelCount = topLevelTasks.length

  if (topLevelCount === 0) return null

  const lookupContext = useMemo(() => createLookupContext(projects), [projects])
  const taskIds = useMemo(() => topLevelTasks.map((t) => t.id), [topLevelTasks])

  return (
    <section className={cn('mb-4', className)} aria-label={label}>
      <TaskGroupHeader label={label} count={topLevelCount} urgency={urgency} />
      <div className="flex flex-col">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {topLevelTasks.map((task) => {
            const project = lookupContext.projectMap.get(task.projectId)
            if (!project) return null

            const completed = isTaskCompletedFast(task, lookupContext.completionMap)
            const isCheckedForSelection = selectedIds?.has(task.id) ?? false
            const subtasks = getSubtasks(task.id, allTasks || tasks)
            const progress = calculateProgress(subtasks)
            const hasSubtasksFlag = subtasks.length > 0
            const isExpanded = expandedIds?.has(task.id) ?? false

            if (hasSubtasksFlag && onToggleExpand) {
              return (
                <ParentTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  projects={projects}
                  subtasks={subtasks}
                  progress={progress}
                  isExpanded={isExpanded}
                  isCompleted={completed}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={showProjectBadge}
                  onToggleExpand={onToggleExpand}
                  onToggleComplete={onToggleComplete}
                  onUpdateTask={onUpdateTask}
                  onToggleSubtaskComplete={onToggleSubtaskComplete}
                  onClick={onTaskClick}
                  isSelectionMode={isSelectionMode}
                  isCheckedForSelection={isCheckedForSelection}
                  onToggleSelect={onToggleSelect}
                  onShiftSelect={onShiftSelect}
                  onAddSubtask={onAddSubtask}
                  onReorderSubtasks={onReorderSubtasks}
                />
              )
            }

            return (
              <SortableTaskRow
                key={task.id}
                task={task}
                project={project}
                projects={projects}
                sectionId={label}
                isCompleted={completed}
                isSelected={selectedTaskId === task.id}
                showProjectBadge={showProjectBadge}
                onToggleComplete={onToggleComplete}
                onUpdateTask={onUpdateTask}
                onClick={onTaskClick}
                isSelectionMode={isSelectionMode}
                isCheckedForSelection={isCheckedForSelection}
                onToggleSelect={onToggleSelect}
                onShiftSelect={onShiftSelect}
              />
            )
          })}
        </SortableContext>
      </div>
    </section>
  )
}

// ============================================================================
// STATUS TASK GROUP (for project view grouping by status)
// ============================================================================

export const StatusTaskGroup = ({
  status,
  tasks,
  allTasks,
  project,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  expandedIds,
  onToggleExpand,
  onAddSubtask,
  onReorderSubtasks
}: StatusTaskGroupProps): React.JSX.Element | null => {
  const topLevelTasks = getTopLevelTasks(tasks)
  const topLevelCount = topLevelTasks.length

  if (topLevelCount === 0) return null

  const taskIds = topLevelTasks.map((t) => t.id)

  return (
    <section className={cn('mb-4', className)} aria-label={status.name}>
      <TaskGroupHeader label={status.name.toUpperCase()} count={topLevelCount} />
      <div className="flex flex-col">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {topLevelTasks.map((task) => {
            const completed = status.type === 'done'
            const isCheckedForSelection = selectedIds?.has(task.id) ?? false
            const subtasks = getSubtasks(task.id, allTasks || tasks)
            const progress = calculateProgress(subtasks)
            const hasSubtasksFlag = subtasks.length > 0
            const isExpanded = expandedIds?.has(task.id) ?? false

            if (hasSubtasksFlag && onToggleExpand) {
              return (
                <ParentTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  projects={[project]}
                  subtasks={subtasks}
                  progress={progress}
                  isExpanded={isExpanded}
                  isCompleted={completed}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={false}
                  onToggleExpand={onToggleExpand}
                  onToggleComplete={onToggleComplete}
                  onUpdateTask={onUpdateTask}
                  onToggleSubtaskComplete={onToggleSubtaskComplete}
                  onClick={onTaskClick}
                  isSelectionMode={isSelectionMode}
                  isCheckedForSelection={isCheckedForSelection}
                  onToggleSelect={onToggleSelect}
                  onShiftSelect={onShiftSelect}
                  onAddSubtask={onAddSubtask}
                  onReorderSubtasks={onReorderSubtasks}
                />
              )
            }

            return (
              <SortableTaskRow
                key={task.id}
                task={task}
                project={project}
                projects={[project]}
                sectionId={status.id}
                isCompleted={completed}
                isSelected={selectedTaskId === task.id}
                showProjectBadge={false}
                onToggleComplete={onToggleComplete}
                onUpdateTask={onUpdateTask}
                onClick={onTaskClick}
                isSelectionMode={isSelectionMode}
                isCheckedForSelection={isCheckedForSelection}
                onToggleSelect={onToggleSelect}
                onShiftSelect={onShiftSelect}
              />
            )
          })}
        </SortableContext>
      </div>
    </section>
  )
}

export default TaskGroup
