import { useMemo, useRef, useEffect, memo, useCallback } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"

import { cn } from "@/lib/utils"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { SortableParentTaskRow } from "@/components/tasks/sortable-parent-task-row"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import { TaskEmptyState } from "@/components/tasks/task-empty-state"
import {
  flattenTasksByStatus,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type StatusHeaderItem,
  type TaskItem,
  type ParentTaskItem,
} from "@/lib/virtual-list-utils"
import { createLookupContext, isTaskCompletedFast } from "@/lib/lookup-utils"
import { calculateProgress } from "@/lib/subtask-utils"
import { useExpandedTasks } from "@/hooks"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project, Status } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface VirtualizedProjectTaskListProps {
  tasks: Task[]
  project: Project
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onToggleSubtaskComplete?: (subtaskId: string) => void
  onTaskClick?: (taskId: string) => void
  onQuickAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Priority
      projectId: string | null
    }
  ) => void
  onOpenModal?: (prefillTitle: string) => void
  className?: string
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  // Subtask management props
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

// ============================================================================
// VIRTUAL STATUS HEADER (with droppable for status changes)
// ============================================================================

interface VirtualStatusHeaderProps {
  status: Status
  count: number
  isOver: boolean
}

const VirtualStatusHeader = memo(({
  status,
  count,
  isOver,
}: VirtualStatusHeaderProps): React.JSX.Element => {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-2 transition-colors rounded-lg",
        isOver && "ring-2 ring-primary/50 ring-inset bg-primary/5"
      )}
    >
      <div className="flex items-center gap-2">
        {/* Status color indicator */}
        <div
          className="size-2.5 rounded-full"
          style={{ backgroundColor: status.color }}
          aria-hidden="true"
        />
        <h3 className="text-xs uppercase tracking-wide font-medium text-text-secondary">
          {status.name}
        </h3>
      </div>
      <span className="text-xs text-text-tertiary">
        ({count})
      </span>
    </div>
  )
})

VirtualStatusHeader.displayName = "VirtualStatusHeader"

// ============================================================================
// DROPPABLE STATUS HEADER WRAPPER
// ============================================================================

interface DroppableStatusHeaderProps {
  item: StatusHeaderItem
}

const DroppableStatusHeader = memo(({
  item,
}: DroppableStatusHeaderProps): React.JSX.Element => {
  // Use "column" type for status drops (like kanban columns)
  const { setNodeRef, isOver } = useDroppable({
    id: `status-${item.status.id}`,
    data: {
      type: "column",
      columnId: item.status.id,
      statusId: item.status.id,
      status: item.status,
    },
  })

  return (
    <div ref={setNodeRef}>
      <VirtualStatusHeader
        status={item.status}
        count={item.count}
        isOver={isOver}
      />
    </div>
  )
})

DroppableStatusHeader.displayName = "DroppableStatusHeader"

// ============================================================================
// VIRTUAL ITEM RENDERER
// ============================================================================

interface VirtualItemRendererProps {
  item: VirtualItem
  lookupContext: ReturnType<typeof createLookupContext>
  allTasks: Task[]
  project: Project
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
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
  // Subtask management
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

const VirtualItemRenderer = memo(({
  item,
  lookupContext,
  allTasks,
  project,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  expandedIds,
  onToggleExpand,
  onAddSubtask,
  onReorderSubtasks,
}: VirtualItemRendererProps): React.JSX.Element | null => {
  switch (item.type) {
    case "status-header":
      return <DroppableStatusHeader item={item as StatusHeaderItem} />

    case "task": {
      const taskItem = item as TaskItem
      const isCompleted = isTaskCompletedFast(taskItem.task, lookupContext.completionMap)
      const isCheckedForSelection = selectedIds?.has(taskItem.task.id) ?? false

      return (
        <SortableTaskRow
          task={taskItem.task}
          project={taskItem.project}
          projects={[project]}
          sectionId={`status-${taskItem.sectionId}`}
          allTasks={allTasks}
          isCompleted={isCompleted}
          isSelected={selectedTaskId === taskItem.task.id}
          showProjectBadge={false} // Don't show project badge in project view
          onToggleComplete={onToggleComplete}
          onUpdateTask={onUpdateTask}
          onClick={onTaskClick}
          isSelectionMode={isSelectionMode}
          isCheckedForSelection={isCheckedForSelection}
          onToggleSelect={onToggleSelect}
          onShiftSelect={onShiftSelect}
        />
      )
    }

    case "parent-task": {
      const parentItem = item as ParentTaskItem
      const isCompleted = isTaskCompletedFast(parentItem.task, lookupContext.completionMap)
      const isCheckedForSelection = selectedIds?.has(parentItem.task.id) ?? false
      const isExpanded = expandedIds.has(parentItem.task.id)
      const progress = calculateProgress(parentItem.subtasks)

      return (
        <SortableParentTaskRow
          task={parentItem.task}
          project={parentItem.project}
          sectionId={`status-${parentItem.sectionId}`}
          subtasks={parentItem.subtasks}
          progress={progress}
          isExpanded={isExpanded}
          isCompleted={isCompleted}
          isSelected={selectedTaskId === parentItem.task.id}
          showProjectBadge={false} // Don't show project badge in project view
          onToggleExpand={onToggleExpand}
          onToggleComplete={onToggleComplete}
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

    default:
      return null
  }
})

VirtualItemRenderer.displayName = "VirtualItemRenderer"

// ============================================================================
// VIRTUALIZED PROJECT TASK LIST
// ============================================================================

export const VirtualizedProjectTaskList = ({
  tasks,
  project,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
}: VirtualizedProjectTaskListProps): React.JSX.Element => {
  // Scroll container ref
  const parentRef = useRef<HTMLDivElement>(null)

  // Expand/collapse state with persistence per project
  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: `project-${project.id}`,
    persist: true,
  })

  // Create lookup context for O(1) project/status lookups
  const lookupContext = useMemo(
    () => createLookupContext([project]),
    [project]
  )

  // Flatten tasks into virtual items
  const virtualItems = useMemo(
    () => flattenTasksByStatus(tasks, project, expandedIds, tasks),
    [tasks, project, expandedIds]
  )

  // Get all task IDs for SortableContext
  const allTaskIds = useMemo(
    () => getTaskIdsFromVirtualItems(virtualItems),
    [virtualItems]
  )

  // Check if empty (only status headers, no tasks)
  const isEmpty = allTaskIds.length === 0

  // Set up virtualizer with dynamic height support
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(virtualItems[index], expandedIds, tasks),
    overscan: 5,
  })

  // Remeasure when expanded state changes
  useEffect(() => {
    virtualizer.measure()
  }, [expandedIds, virtualizer])

  // Handle quick add with project context
  const handleQuickAdd = useCallback((
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Priority
      projectId: string | null
    }
  ) => {
    const finalData = {
      ...parsedData,
      dueDate: parsedData?.dueDate ?? null,
      priority: parsedData?.priority ?? "none" as Priority,
      projectId: project.id, // Always use current project
    }
    onQuickAdd(title, finalData)
  }, [onQuickAdd, project.id])

  // Empty state (but still show status headers as drop targets)
  if (isEmpty && virtualItems.length === 0) {
    return (
      <div className={cn("flex-1 overflow-auto p-4", className)}>
        <div className="mb-4">
          <QuickAddInput
            onAdd={handleQuickAdd}
            onOpenModal={onOpenModal}
            projects={[project]}
            placeholder={`Add task to ${project.name}...`}
          />
        </div>
        <TaskEmptyState
          variant="project"
          projectName={project.name}
          onAddTask={() => handleQuickAdd("New Task")}
        />
      </div>
    )
  }

  return (
    <div className={cn("flex flex-1 flex-col overflow-hidden", className)}>
      {/* Quick Add Input - fixed at top */}
      <div className="p-4 pb-0">
        <QuickAddInput
          onAdd={handleQuickAdd}
          onOpenModal={onOpenModal}
          projects={[project]}
          placeholder={`Add task to ${project.name}...`}
        />
      </div>

      {/* Virtualized content */}
      <SortableContext items={allTaskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={parentRef}
          className="flex-1 overflow-auto px-4 pt-4"
          style={{ contain: "strict" }}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              return (
                <div
                  key={item.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <VirtualItemRenderer
                    item={item}
                    lookupContext={lookupContext}
                    allTasks={tasks}
                    project={project}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onUpdateTask={onUpdateTask}
                    onToggleSubtaskComplete={onToggleSubtaskComplete}
                    onTaskClick={onTaskClick}
                    isSelectionMode={isSelectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onShiftSelect={onShiftSelect}
                    expandedIds={expandedIds}
                    onToggleExpand={toggleExpanded}
                    onAddSubtask={onAddSubtask}
                    onReorderSubtasks={onReorderSubtasks}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </SortableContext>
    </div>
  )
}

export default VirtualizedProjectTaskList
