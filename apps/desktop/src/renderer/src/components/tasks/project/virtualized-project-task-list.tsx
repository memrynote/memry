import { useMemo, useRef, useEffect, memo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import {
  DroppableListHeader,
  SortableParentTaskRow,
  SortableTaskRow
} from '@/components/tasks/drag-drop'
import { TaskEmptyState } from '@/components/tasks/task-empty-state'
import {
  flattenTasksByStatus,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem
} from '@/lib/virtual-list-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { calculateProgress } from '@/lib/subtask-utils'
import { useExpandedTasks } from '@/hooks'
import { useDragContext } from '@/contexts/drag-context'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import { PROJECT_TASKS_SCROLL_KEY } from '@/pages/tasks-view-state'
import { annotateProjectStatusVirtualItems } from '@/lib/task-list-dnd-utils'
import type { Task, Priority } from '@/data/task-model'
import type { Project, Status } from '@/data/tasks-data'

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
  onNoteClick?: (noteId: string) => void
  onQuickAdd: (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Priority
      projectId: string | null
    }
  ) => void
  className?: string
  /**
   * Extra classes for the scrolling area itself, so a host can give the list a
   * gutter without insetting the scrollbar. The Tasks page leaves it unset and
   * keeps its full-bleed list; the project hub passes its section padding.
   */
  contentClassName?: string
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  getOrderedTasks?: (sectionId: string, tasks: Task[]) => Task[]
}

// ============================================================================
// VIRTUAL STATUS HEADER
// ============================================================================

interface VirtualStatusHeaderProps {
  status: Status
  count: number
}

const VirtualStatusHeader = memo(
  ({ status, count }: VirtualStatusHeaderProps): React.JSX.Element => {
    return (
      <div className="flex items-center justify-between px-3 py-2 transition-colors rounded-sm">
        <div className="flex items-center gap-2">
          <div
            className="size-2.5 rounded-full"
            style={{ backgroundColor: status.color }}
            aria-hidden="true"
          />
          <h3 className="text-xs uppercase tracking-wide font-medium text-text-secondary">
            {status.name}
          </h3>
        </div>
        <span className="text-xs text-text-tertiary">({count})</span>
      </div>
    )
  }
)

VirtualStatusHeader.displayName = 'VirtualStatusHeader'

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
  onNoteClick?: (noteId: string) => void
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  expandedIds: Set<string>
  onToggleExpand: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

const VirtualItemRenderer = memo(
  ({
    item,
    lookupContext,
    allTasks,
    project,
    selectedTaskId,
    onToggleComplete,
    onUpdateTask,
    onToggleSubtaskComplete,
    onTaskClick,
    onNoteClick,
    isSelectionMode = false,
    selectedIds,
    onToggleSelect,
    onShiftSelect,
    expandedIds,
    onToggleExpand,
    onAddSubtask,
    onReorderSubtasks
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case 'status-header':
        return item.columnId ? (
          <DroppableListHeader
            id={item.id}
            label={item.status.name}
            columnId={item.columnId}
            sectionId={item.sectionId}
            sectionTaskIds={item.sectionTaskIds}
          >
            <VirtualStatusHeader status={item.status} count={item.count} />
          </DroppableListHeader>
        ) : (
          <VirtualStatusHeader status={item.status} count={item.count} />
        )

      case 'task': {
        const taskItem = item
        const isCompleted = isTaskCompletedFast(taskItem.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(taskItem.task.id) ?? false

        return (
          <SortableTaskRow
            task={taskItem.task}
            project={taskItem.project}
            projects={[project]}
            allTasks={allTasks}
            sectionId={taskItem.sectionId}
            sectionTaskIds={taskItem.sectionTaskIds}
            columnId={taskItem.columnId}
            isCompleted={isCompleted}
            isSelected={selectedTaskId === taskItem.task.id}
            showProjectBadge={false}
            onToggleComplete={onToggleComplete}
            onUpdateTask={onUpdateTask}
            onClick={onTaskClick}
            onNoteClick={onNoteClick}
            isSelectionMode={isSelectionMode}
            isCheckedForSelection={isCheckedForSelection}
            onToggleSelect={onToggleSelect}
            onShiftSelect={onShiftSelect}
          />
        )
      }

      case 'parent-task': {
        const parentItem = item
        const isCompleted = isTaskCompletedFast(parentItem.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(parentItem.task.id) ?? false
        const isExpanded = expandedIds.has(parentItem.task.id)
        const progress = calculateProgress(parentItem.subtasks)

        return (
          <SortableParentTaskRow
            task={parentItem.task}
            project={parentItem.project}
            projects={[parentItem.project]}
            subtasks={parentItem.subtasks}
            progress={progress}
            isExpanded={isExpanded}
            isCompleted={isCompleted}
            sectionId={parentItem.sectionId}
            sectionTaskIds={parentItem.sectionTaskIds}
            columnId={parentItem.columnId}
            isSelected={selectedTaskId === parentItem.task.id}
            showProjectBadge={false}
            onToggleExpand={onToggleExpand}
            onToggleComplete={onToggleComplete}
            onUpdateTask={onUpdateTask}
            onToggleSubtaskComplete={onToggleSubtaskComplete}
            onClick={onTaskClick}
            onNoteClick={onNoteClick}
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
  }
)

VirtualItemRenderer.displayName = 'VirtualItemRenderer'

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
  onNoteClick,
  onQuickAdd,
  className,
  contentClassName,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
  getOrderedTasks
}: VirtualizedProjectTaskListProps): React.JSX.Element => {
  const parentRef = useRef<HTMLDivElement>(null)

  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: `project-${project.id}`,
    persist: true
  })
  const { dragState } = useDragContext()

  const lookupContext = useMemo(() => createLookupContext([project]), [project])

  const virtualItems = useMemo(
    () =>
      annotateProjectStatusVirtualItems(
        flattenTasksByStatus(tasks, project, expandedIds, tasks, true, getOrderedTasks)
      ),
    [tasks, project, expandedIds, getOrderedTasks]
  )
  const sortableTaskIds = useMemo(() => getTaskIdsFromVirtualItems(virtualItems), [virtualItems])

  const isEmpty = virtualItems.every((item) => item.type === 'status-header')

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(virtualItems[index], expandedIds, tasks),
    getItemKey: (index) => virtualItems[index]?.id ?? index,
    overscan: 5
  })

  // Virtualized: restoring by writing `scrollTop` would land on the wrong row
  // while the total height is still an estimate.
  const getScrollElement = useCallback(() => parentRef.current, [])
  useTabScrollRestore({ getScrollElement, virtualizer, key: PROJECT_TASKS_SCROLL_KEY })

  useEffect(() => {
    virtualizer.measure()
    return () => {}
  }, [
    expandedIds,
    virtualizer,
    dragState.isDragging,
    dragState.activeId,
    dragState.activeIds.length,
    dragState.sourceType,
    dragState.sourceContainerId,
    dragState.overId,
    dragState.overType,
    dragState.overSectionId,
    dragState.sectionDropPosition
  ])

  const handleQuickAdd = useCallback(
    (
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
        priority: parsedData?.priority ?? ('none' as Priority),
        projectId: project.id
      }
      onQuickAdd(title, finalData)
    },
    [onQuickAdd, project.id]
  )

  if (isEmpty && virtualItems.length === 0) {
    return (
      <div className={cn('flex-1 overflow-auto pt-4', contentClassName, className)}>
        <TaskEmptyState
          variant="project"
          projectName={project.name}
          onAddTask={() => handleQuickAdd('New Task')}
        />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      <div
        ref={parentRef}
        className={cn('flex-1 overflow-auto pt-4', contentClassName)}
        style={{ contain: 'strict' }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          <SortableContext items={sortableTaskIds} strategy={verticalListSortingStrategy}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              return (
                <div
                  key={item.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
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
                    onNoteClick={onNoteClick}
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
          </SortableContext>
        </div>
      </div>
    </div>
  )
}

export default VirtualizedProjectTaskList
