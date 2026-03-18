import { useMemo, useRef, useEffect, useCallback, useState, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { DroppableListHeader, SortableParentTaskRow, SortableTaskRow } from '@/components/tasks/drag-drop'
import { TaskEmptyState } from '@/components/tasks/task-empty-state'
import {
  flattenTasksFlat,
  flattenTasksGrouped,
  getTaskIdsFromVirtualItems,
  estimateItemHeight,
  type VirtualItem,
  type GroupHeaderItem
} from '@/lib/virtual-list-utils'
import { GroupHeader } from '@/components/tasks/group-header'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { calculateProgress, getTopLevelTasks } from '@/lib/subtask-utils'
import { useExpandedTasks } from '@/hooks'
import { annotateFlatVirtualItems, annotateGroupedVirtualItems } from '@/lib/task-list-dnd-utils'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, SortField, SortDirection } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface VirtualizedAllTasksViewProps {
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
  className?: string
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  storageKey?: string
  sortField?: SortField
  sortDirection?: SortDirection
  showProjectBadge?: boolean
  doneTasks?: Task[]
  getOrderedTasks?: (sectionId: string, tasks: Task[]) => Task[]
}

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
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
  onShiftSelect?: (taskId: string) => void
  expandedIds: Set<string>
  onToggleExpand: (taskId: string) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
  onToggleGroup?: (groupKey: string) => void
  showProjectBadge?: boolean
}

const VirtualItemRenderer = memo(
  ({
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
    onToggleGroup,
    showProjectBadge = true
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case 'group-header':
        return item.columnId ? (
          <DroppableListHeader
            id={item.id}
            label={item.label}
            columnId={item.columnId}
            sectionId={item.sectionId}
            sectionTaskIds={item.sectionTaskIds}
          >
            <GroupHeader
              label={item.label}
              count={item.count}
              sortField={item.sortField}
              groupKey={item.groupKey}
              color={item.color}
              variant={item.variant}
              isCollapsed={item.isCollapsed}
              onToggle={() => onToggleGroup?.(item.groupKey)}
            />
          </DroppableListHeader>
        ) : (
          <GroupHeader
            label={item.label}
            count={item.count}
            sortField={item.sortField}
            groupKey={item.groupKey}
            color={item.color}
            variant={item.variant}
            isCollapsed={item.isCollapsed}
            onToggle={() => onToggleGroup?.(item.groupKey)}
          />
        )

      case 'task': {
        const isCompleted = isTaskCompletedFast(item.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(item.task.id) ?? false

        return (
          <SortableTaskRow
            task={item.task}
            project={item.project}
            projects={projects}
            allTasks={allTasks}
            sectionId={item.sectionId ?? 'all'}
            sectionTaskIds={item.sectionTaskIds}
            columnId={item.columnId}
            isCompleted={isCompleted}
            isSelected={selectedTaskId === item.task.id}
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
      }

      case 'parent-task': {
        const isCompleted = isTaskCompletedFast(item.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(item.task.id) ?? false
        const isExpanded = expandedIds.has(item.task.id)
        const progress = calculateProgress(item.subtasks)

        return (
          <SortableParentTaskRow
            task={item.task}
            project={item.project}
            projects={projects}
            subtasks={item.subtasks}
            progress={progress}
            isExpanded={isExpanded}
            isCompleted={isCompleted}
            sectionId={item.sectionId}
            sectionTaskIds={item.sectionTaskIds}
            columnId={item.columnId}
            isSelected={selectedTaskId === item.task.id}
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

      default:
        return null
    }
  }
)

VirtualItemRenderer.displayName = 'VirtualItemRenderer'

// ============================================================================
// VIRTUALIZED ALL TASKS VIEW
// ============================================================================

export const VirtualizedAllTasksView = ({
  tasks,
  projects,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onToggleSubtaskComplete,
  onTaskClick,
  onQuickAdd,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
  storageKey = 'all',
  sortField,
  sortDirection,
  showProjectBadge = true,
  doneTasks,
  getOrderedTasks
}: VirtualizedAllTasksViewProps): React.JSX.Element => {
  const parentRef = useRef<HTMLDivElement>(null)

  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey,
    persist: true
  })

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(['done']))

  const handleToggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      return next
    })
  }, [])

  const lookupContext = useMemo(() => createLookupContext(projects), [projects])

  const combinedTasks = useMemo(() => [...tasks, ...(doneTasks ?? [])], [tasks, doneTasks])

  const virtualItems = useMemo(() => {
    if (sortField && sortField !== 'title' && sortDirection) {
      return annotateGroupedVirtualItems(
        flattenTasksGrouped(
          tasks,
          projects,
          combinedTasks,
          sortField,
          sortDirection,
          collapsedGroups,
          getOrderedTasks
        ),
        { sortField, projects }
      )
    }
    return annotateFlatVirtualItems(flattenTasksFlat(tasks, projects, combinedTasks, getOrderedTasks))
  }, [tasks, projects, combinedTasks, sortField, sortDirection, collapsedGroups, getOrderedTasks])

  const doneVirtualItems = useMemo((): VirtualItem[] => {
    if (!doneTasks || doneTasks.length === 0) return []

    const isCollapsed = collapsedGroups.has('done')
    const topLevel = getTopLevelTasks(doneTasks)

    const header: GroupHeaderItem = {
      id: 'group-header-done',
      type: 'group-header',
      groupKey: 'done',
      label: 'Done',
      count: topLevel.length,
      sortField: 'status',
      isCollapsed
    }

    if (isCollapsed) return [header]

    const doneItems = annotateFlatVirtualItems(
      flattenTasksFlat(doneTasks, projects, combinedTasks, getOrderedTasks),
      { sectionId: 'done' }
    )
    return [header, ...doneItems]
  }, [doneTasks, projects, combinedTasks, collapsedGroups, getOrderedTasks])

  const allVirtualItems = useMemo(
    () => [...virtualItems, ...doneVirtualItems],
    [virtualItems, doneVirtualItems]
  )
  const sortableTaskIds = useMemo(() => getTaskIdsFromVirtualItems(allVirtualItems), [allVirtualItems])

  const isEmpty = virtualItems.length === 0 && doneVirtualItems.length === 0

  const virtualizer = useVirtualizer({
    count: allVirtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(allVirtualItems[index], expandedIds, combinedTasks),
    getItemKey: (index) => allVirtualItems[index]?.id ?? index,
    overscan: 5
  })

  useEffect(() => {
    virtualizer.measure()
  }, [expandedIds, virtualizer])

  if (isEmpty) {
    return (
      <div className={cn('flex-1 overflow-auto pt-4', className)}>
        <TaskEmptyState variant="all" onAddTask={() => onQuickAdd('New Task')} />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      <div ref={parentRef} className="flex-1 overflow-auto pt-4" style={{ contain: 'strict' }}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          <SortableContext items={sortableTaskIds} strategy={verticalListSortingStrategy}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = allVirtualItems[virtualRow.index]
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
                    allTasks={combinedTasks}
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
                    onToggleGroup={handleToggleGroup}
                    showProjectBadge={showProjectBadge}
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

export default VirtualizedAllTasksView
