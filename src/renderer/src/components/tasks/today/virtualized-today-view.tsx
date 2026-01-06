import { useMemo, useRef, useEffect, memo, useCallback } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"
import { AnimatePresence } from "framer-motion"
import { AlertTriangle, Star, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { SortableParentTaskRow } from "@/components/tasks/sortable-parent-task-row"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import {
  CelebrationEmptyState,
  OverdueClearedBanner,
} from "@/components/tasks/empty-states"
import {
  flattenTodayTasks,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type SectionHeaderItem,
  type TaskItem,
  type ParentTaskItem,
  type EmptyStateItem,
} from "@/lib/virtual-list-utils"
import { getTodayTasks, startOfDay } from "@/lib/task-utils"
import { createLookupContext, isTaskCompletedFast } from "@/lib/lookup-utils"
import { calculateProgress } from "@/lib/subtask-utils"
import { useExpandedTasks, useOverdueCelebration } from "@/hooks"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface VirtualizedTodayViewProps {
  tasks: Task[]
  projects: Project[]
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
  onViewUpcoming?: () => void
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
// URGENCY STYLING
// ============================================================================

const urgencyStyles = {
  critical: {
    containerClass: "bg-red-50/30 dark:bg-red-950/20 border border-red-200/50 dark:border-red-900/50 rounded-lg",
    headerClass: "text-red-700 dark:text-red-400 font-semibold",
    countClass: "bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400",
    accentClass: "border-l-[3px] border-l-red-500",
    icon: <AlertTriangle className="size-4" aria-hidden="true" />,
  },
  high: {
    containerClass: "bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-900/50 rounded-lg",
    headerClass: "text-blue-700 dark:text-blue-400 font-semibold",
    countClass: "bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400",
    accentClass: "border-l-[3px] border-l-blue-500",
    icon: <Star className="size-4" aria-hidden="true" />,
  },
} as const

// ============================================================================
// VIRTUAL SECTION HEADER (with droppable)
// ============================================================================

interface VirtualSectionHeaderProps {
  item: SectionHeaderItem
  isOver: boolean
}

const VirtualSectionHeader = memo(({
  item,
  isOver,
}: VirtualSectionHeaderProps): React.JSX.Element => {
  const isOverdue = item.sectionKey === "overdue"
  const styles = isOverdue ? urgencyStyles.critical : urgencyStyles.high

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-2 transition-colors",
        styles.containerClass,
        isOver && "ring-2 ring-primary/50 ring-inset"
      )}
    >
      <div className="flex items-center gap-2">
        {styles.icon && (
          <span className={styles.headerClass}>
            {styles.icon}
          </span>
        )}
        <h3 className={cn("text-xs uppercase tracking-wide", styles.headerClass)}>
          {item.label}
        </h3>
      </div>
      <span className={cn("text-xs px-1.5 py-0.5 rounded-full", styles.countClass)}>
        {item.count}
      </span>
    </div>
  )
})

VirtualSectionHeader.displayName = "VirtualSectionHeader"

// ============================================================================
// DROPPABLE SECTION HEADER WRAPPER
// ============================================================================

interface DroppableSectionHeaderProps {
  item: SectionHeaderItem
}

const DroppableSectionHeader = memo(({
  item,
}: DroppableSectionHeaderProps): React.JSX.Element => {
  const today = startOfDay(new Date())
  const sectionId = item.sectionKey

  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: "section",
      sectionId,
      label: item.label,
      date: today, // Both overdue and today drop to today
    },
  })

  return (
    <div ref={setNodeRef}>
      <VirtualSectionHeader item={item} isOver={isOver} />
    </div>
  )
})

DroppableSectionHeader.displayName = "DroppableSectionHeader"

// ============================================================================
// VIRTUAL ITEM RENDERER
// ============================================================================

interface VirtualItemRendererProps {
  item: VirtualItem
  lookupContext: ReturnType<typeof createLookupContext>
  allTasks: Task[]
  projects: Project[]
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
  // Callbacks
  onAddTaskForToday: () => void
  onViewUpcoming?: () => void
}

const VirtualItemRenderer = memo(({
  item,
  lookupContext,
  allTasks,
  projects,
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
  onAddTaskForToday,
  onViewUpcoming,
}: VirtualItemRendererProps): React.JSX.Element | null => {
  switch (item.type) {
    case "section-header":
      return <DroppableSectionHeader item={item as SectionHeaderItem} />

    case "task": {
      const taskItem = item as TaskItem
      const isCompleted = isTaskCompletedFast(taskItem.task, lookupContext.completionMap)
      const isCheckedForSelection = selectedIds?.has(taskItem.task.id) ?? false
      const styles = taskItem.isOverdue ? urgencyStyles.critical : urgencyStyles.high

      return (
        <SortableTaskRow
          task={taskItem.task}
          project={taskItem.project}
          projects={projects}
          sectionId={taskItem.sectionId}
          allTasks={allTasks}
          isCompleted={isCompleted}
          isSelected={selectedTaskId === taskItem.task.id}
          showProjectBadge={true}
          onToggleComplete={onToggleComplete}
          onUpdateTask={onUpdateTask}
          onClick={onTaskClick}
          isSelectionMode={isSelectionMode}
          isCheckedForSelection={isCheckedForSelection}
          onToggleSelect={onToggleSelect}
          onShiftSelect={onShiftSelect}
          accentClass={taskItem.isOverdue ? styles.accentClass : undefined}
        />
      )
    }

    case "parent-task": {
      const parentItem = item as ParentTaskItem
      const isCompleted = isTaskCompletedFast(parentItem.task, lookupContext.completionMap)
      const isCheckedForSelection = selectedIds?.has(parentItem.task.id) ?? false
      const isExpanded = expandedIds.has(parentItem.task.id)
      const progress = calculateProgress(parentItem.subtasks)
      const styles = parentItem.isOverdue ? urgencyStyles.critical : urgencyStyles.high

      return (
        <SortableParentTaskRow
          task={parentItem.task}
          project={parentItem.project}
          sectionId={parentItem.sectionId}
          subtasks={parentItem.subtasks}
          progress={progress}
          isExpanded={isExpanded}
          isCompleted={isCompleted}
          isSelected={selectedTaskId === parentItem.task.id}
          showProjectBadge={true}
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
          accentClass={parentItem.isOverdue ? styles.accentClass : undefined}
        />
      )
    }

    case "add-task-button":
      return (
        <button
          type="button"
          onClick={onAddTaskForToday}
          className={cn(
            "w-full flex items-center gap-2 px-4 py-2.5 text-sm text-text-tertiary",
            "hover:bg-accent/50 hover:text-text-secondary",
            "border-t border-border/50 transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
          <span>Add task for today</span>
        </button>
      )

    case "empty-state": {
      const emptyItem = item as EmptyStateItem
      if (emptyItem.variant === "celebration") {
        return (
          <CelebrationEmptyState
            title="All clear for today!"
            description="Enjoy your free time or plan ahead."
            onAddTask={onAddTaskForToday}
            addButtonLabel="Add task for today"
            onViewUpcoming={onViewUpcoming}
          />
        )
      }
      return null
    }

    default:
      return null
  }
})

VirtualItemRenderer.displayName = "VirtualItemRenderer"

// ============================================================================
// VIRTUALIZED TODAY VIEW
// ============================================================================

export const VirtualizedTodayView = ({
  tasks,
  projects,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  onViewUpcoming,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
}: VirtualizedTodayViewProps): React.JSX.Element => {
  // Scroll container ref
  const parentRef = useRef<HTMLDivElement>(null)

  // Expand/collapse state with persistence
  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: "today",
    persist: true,
  })

  // Get filtered tasks for today
  const todayData = useMemo(
    () => getTodayTasks(tasks, projects),
    [tasks, projects]
  )

  // Track overdue celebration state
  const { showCelebration, dismiss: dismissCelebration } = useOverdueCelebration(
    todayData.overdue.length
  )

  // Create lookup context for O(1) project/status lookups
  const lookupContext = useMemo(
    () => createLookupContext(projects),
    [projects]
  )

  // Check if completely empty (no overdue, no today tasks)
  const isEmpty = todayData.overdue.length === 0 && todayData.today.length === 0

  // Flatten tasks into virtual items
  const virtualItems = useMemo(
    () => flattenTodayTasks(todayData, projects, expandedIds, tasks, isEmpty),
    [todayData, projects, expandedIds, tasks, isEmpty]
  )

  // Get all task IDs for SortableContext
  const allTaskIds = useMemo(
    () => getTaskIdsFromVirtualItems(virtualItems),
    [virtualItems]
  )

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

  // Handle adding task for today
  const handleAddTaskForToday = useCallback(() => {
    onQuickAdd("", {
      dueDate: startOfDay(new Date()),
      priority: "none",
      projectId: null,
    })
  }, [onQuickAdd])

  // Handle quick add with context (defaults to today)
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
      dueDate: parsedData?.dueDate ?? startOfDay(new Date()),
      priority: parsedData?.priority ?? "none" as Priority,
      projectId: parsedData?.projectId ?? null,
    }
    onQuickAdd(title, finalData)
  }, [onQuickAdd])

  return (
    <div className={cn("flex flex-1 flex-col overflow-hidden", className)}>
      {/* Quick Add Input - fixed at top */}
      <div className="p-4 pb-0">
        <QuickAddInput
          onAdd={handleQuickAdd}
          onOpenModal={onOpenModal}
          projects={projects}
          placeholder="Add task for today..."
        />
      </div>

      {/* Overdue Cleared Celebration Banner */}
      <AnimatePresence>
        {showCelebration && (
          <div className="px-4 pt-4">
            <OverdueClearedBanner onDismiss={dismissCelebration} />
          </div>
        )}
      </AnimatePresence>

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
                    projects={projects}
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
                    onAddTaskForToday={handleAddTaskForToday}
                    onViewUpcoming={onViewUpcoming}
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

export default VirtualizedTodayView
