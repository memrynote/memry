import { VirtualizedAllTasksView } from '@/components/tasks/virtualized-all-tasks-view'
import { VirtualizedProjectTaskList } from '@/components/tasks/project/virtualized-project-task-list'
import type { Task } from '@/data/task-model'
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
  onNoteClick?: (noteId: string) => void
  onQuickAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: import('@/data/task-model').Priority
      projectId: string | null
    }
  ) => void
  /** Focus the toolbar quick-add input (used by the empty-state Add task button). */
  onFocusQuickAdd?: () => void
  className?: string
  /** Gutter for the scrolling list area. Project lists only (the project hub). */
  contentClassName?: string
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
  doneTasks?: Task[]
  getOrderedTasks?: (sectionId: string, tasks: Task[]) => Task[]
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
  onNoteClick,
  onQuickAdd,
  onFocusQuickAdd,
  className,
  contentClassName,
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
  showProjectBadge = true,
  doneTasks,
  getOrderedTasks
}: TaskListProps): React.JSX.Element => {
  const selectedProject =
    selectedType === 'project' ? projects.find((p) => p.id === selectedId) : null

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
        onNoteClick={onNoteClick}
        onQuickAdd={onQuickAdd}
        className={className}
        contentClassName={contentClassName}
        isSelectionMode={isSelectionMode}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onShiftSelect={onShiftSelect}
        onAddSubtask={onAddSubtask}
        onReorderSubtasks={onReorderSubtasks}
        getOrderedTasks={getOrderedTasks}
      />
    )
  }

  return (
    <VirtualizedAllTasksView
      tasks={tasks}
      projects={projects}
      selectedTaskId={selectedTaskId}
      onToggleComplete={onToggleComplete}
      onUpdateTask={onUpdateTask}
      onToggleSubtaskComplete={onToggleSubtaskComplete}
      onTaskClick={onTaskClick}
      onNoteClick={onNoteClick}
      onQuickAdd={onQuickAdd}
      onFocusQuickAdd={onFocusQuickAdd}
      className={className}
      storageKey={selectedId}
      isSelectionMode={isSelectionMode}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
      onShiftSelect={onShiftSelect}
      onAddSubtask={onAddSubtask}
      onReorderSubtasks={onReorderSubtasks}
      sortField={sortField}
      sortDirection={sortDirection}
      showProjectBadge={showProjectBadge}
      doneTasks={doneTasks}
      getOrderedTasks={getOrderedTasks}
    />
  )
}

export default TaskList
