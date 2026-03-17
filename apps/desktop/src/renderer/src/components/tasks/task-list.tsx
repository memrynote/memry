import { useMemo } from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { TaskGroup } from '@/components/tasks/task-group'
import { TaskEmptyState } from '@/components/tasks/task-empty-state'
import { VirtualizedAllTasksView } from '@/components/tasks/virtualized-all-tasks-view'
import { VirtualizedProjectTaskList } from '@/components/tasks/project/virtualized-project-task-list'
import { cn } from '@/lib/utils'
import {
  groupTasksByCompletion,
  completionGroupConfig,
  type TaskGroupByCompletion
} from '@/lib/task-utils'
import { getTopLevelTasks } from '@/lib/subtask-utils'
import { useExpandedTasks } from '@/hooks'
import type { Task } from '@/data/sample-tasks'
import type { Project, SortField, SortDirection } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface TaskListProps {
  tasks: Task[]
  projects: Project[]
  selectedId: string
  selectedType: 'view' | 'project'
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onTaskClick?: (taskId: string) => void
  onQuickAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: import('@/data/sample-tasks').Priority
      projectId: string | null
    }
  ) => void
  className?: string
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  // Subtask management props
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  // Sort-aware grouping props
  sortField?: SortField
  sortDirection?: SortDirection
  showProjectBadge?: boolean
}

// ============================================================================
// TASK LIST BY COMPLETION DATE (non-virtualized, typically smaller lists)
// ============================================================================

interface TaskListByCompletionProps {
  tasks: Task[]
  allTasks: Task[] // All tasks for subtask lookup
  projects: Project[]
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onTaskClick?: (taskId: string) => void
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  // Expand/collapse props
  expandedIds: Set<string>
  onToggleExpand: (taskId: string) => void
  // Subtask management props
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  showProjectBadge?: boolean
}

const TaskListByCompletion = ({
  tasks,
  allTasks,
  projects,
  selectedTaskId,
  onToggleComplete,
  onToggleSubtaskComplete,
  onTaskClick,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  // Expand/collapse props
  expandedIds,
  onToggleExpand,
  // Subtask management props
  onAddSubtask,
  onReorderSubtasks,
  showProjectBadge = true
}: TaskListByCompletionProps): React.JSX.Element => {
  const groupedTasks = useMemo(() => groupTasksByCompletion(tasks), [tasks])

  const groupOrder: (keyof TaskGroupByCompletion)[] = ['today', 'yesterday', 'earlier']

  return (
    <>
      {groupOrder.map((groupKey) => {
        const config = completionGroupConfig[groupKey]
        const tasksInGroup = groupedTasks[groupKey]

        return (
          <TaskGroup
            key={groupKey}
            label={config.label}
            tasks={tasksInGroup}
            allTasks={allTasks}
            projects={projects}
            accentColor={config.accentColor}
            isMuted={config.isMuted}
            showProjectBadge={showProjectBadge}
            selectedTaskId={selectedTaskId}
            onToggleComplete={onToggleComplete}
            onToggleSubtaskComplete={onToggleSubtaskComplete}
            onTaskClick={onTaskClick}
            // Selection props
            isSelectionMode={isSelectionMode}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onShiftSelect={onShiftSelect}
            // Expand/collapse props
            expandedIds={expandedIds}
            onToggleExpand={onToggleExpand}
            // Subtask management props
            onAddSubtask={onAddSubtask}
            onReorderSubtasks={onReorderSubtasks}
          />
        )
      })}
    </>
  )
}

// ============================================================================
// MAIN TASK LIST COMPONENT
// ============================================================================

export const TaskList = ({
  tasks,
  projects,
  selectedId,
  selectedType,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  onQuickAdd,
  className,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  // Subtask management props
  onAddSubtask,
  onReorderSubtasks,
  // Sort-aware grouping
  sortField,
  sortDirection,
  showProjectBadge = true
}: TaskListProps): React.JSX.Element => {
  // Expand/collapse state - only needed for non-virtualized completed view
  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: selectedId,
    persist: true
  })

  // Get selected project for project view
  const selectedProject =
    selectedType === 'project' ? projects.find((p) => p.id === selectedId) : null

  // Check if empty (only count top-level tasks) - for completed view empty state
  const topLevelTasks = useMemo(() => getTopLevelTasks(tasks), [tasks])
  const isEmpty = topLevelTasks.length === 0

  // Project view - use virtualized component (handles own scroll, quick add, empty state)
  if (selectedType === 'project' && selectedProject) {
    return (
      <VirtualizedProjectTaskList
        tasks={tasks}
        project={selectedProject}
        selectedTaskId={selectedTaskId}
        onToggleComplete={onToggleComplete}
        onUpdateTask={onUpdateTask}
        onToggleSubtaskComplete={onToggleSubtaskComplete}
        onTaskClick={onTaskClick}
        onQuickAdd={onQuickAdd}
        className={className}
        // Selection props
        isSelectionMode={isSelectionMode}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onShiftSelect={onShiftSelect}
        // Subtask management props
        onAddSubtask={onAddSubtask}
        onReorderSubtasks={onReorderSubtasks}
      />
    )
  }

  // Completed view - non-virtualized (typically smaller lists)
  if (selectedId === 'completed') {
    return (
      <ScrollArea className={cn('flex-1', className)}>
        <div className="pt-4">
          {isEmpty ? (
            <TaskEmptyState variant="completed" onAddTask={() => onQuickAdd('New Task')} />
          ) : (
            <TaskListByCompletion
              tasks={tasks}
              allTasks={tasks}
              projects={projects}
              selectedTaskId={selectedTaskId}
              onToggleComplete={onToggleComplete}
              onToggleSubtaskComplete={onToggleSubtaskComplete}
              onTaskClick={onTaskClick}
              // Selection props
              isSelectionMode={isSelectionMode}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onShiftSelect={onShiftSelect}
              // Expand/collapse props
              expandedIds={expandedIds}
              onToggleExpand={toggleExpanded}
              // Subtask management props
              onAddSubtask={onAddSubtask}
              onReorderSubtasks={onReorderSubtasks}
              showProjectBadge={showProjectBadge}
            />
          )}
        </div>
      </ScrollArea>
    )
  }

  // Views (All) - use virtualized component (handles own scroll, quick add, empty state)
  return (
    <VirtualizedAllTasksView
      tasks={tasks}
      projects={projects}
      selectedTaskId={selectedTaskId}
      onToggleComplete={onToggleComplete}
      onUpdateTask={onUpdateTask}
      onToggleSubtaskComplete={onToggleSubtaskComplete}
      onTaskClick={onTaskClick}
      onQuickAdd={onQuickAdd}
      className={className}
      storageKey={selectedId}
      // Selection props
      isSelectionMode={isSelectionMode}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
      onShiftSelect={onShiftSelect}
      // Subtask management props
      onAddSubtask={onAddSubtask}
      onReorderSubtasks={onReorderSubtasks}
      // Sort-aware grouping
      sortField={sortField}
      sortDirection={sortDirection}
      showProjectBadge={showProjectBadge}
    />
  )
}

export default TaskList
