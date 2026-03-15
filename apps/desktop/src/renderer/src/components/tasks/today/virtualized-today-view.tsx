import { useState, useMemo, useRef, useEffect, memo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { SortableParentTaskRow } from '@/components/tasks/sortable-parent-task-row'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { CelebrationEmptyState } from '@/components/tasks/empty-states'
import { DaySectionHeader } from '@/components/tasks/day-section-header'
import { SectionDivider } from '@/components/tasks/section-divider'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  flattenTodayTasks,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type SectionHeaderItem,
  type WeekAccordionHeaderItem,
  type DayHeaderItem
} from '@/lib/virtual-list-utils'
import {
  getTodayTasks,
  getTodayWithWeekTasks,
  getDayHeaderText,
  startOfDay
} from '@/lib/task-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { calculateProgress } from '@/lib/subtask-utils'
import { useExpandedTasks, useCollapsedSections } from '@/hooks'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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
  onAddTaskWithDate?: (date: Date) => void
  className?: string
  showWeek?: boolean
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
// VIRTUAL SECTION HEADER (with droppable)
// ============================================================================

interface VirtualSectionHeaderProps {
  item: SectionHeaderItem
  isOver: boolean
  onToggleCollapse?: (sectionKey: string) => void
  onAddTask?: () => void
}

const VirtualSectionHeader = memo(
  ({ item, isOver, onToggleCollapse, onAddTask }: VirtualSectionHeaderProps): React.JSX.Element => {
    const variant = item.sectionKey === 'overdue' ? 'overdue' : 'default'

    return (
      <button
        type="button"
        onClick={() => onToggleCollapse?.(item.sectionKey)}
        className={cn(
          'flex w-full cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm',
          isOver && 'ring-2 ring-primary/50 ring-inset'
        )}
      >
        <SectionDivider
          label={item.label}
          count={item.count}
          variant={variant}
          className="w-full pt-5"
          onAddTask={onAddTask}
        />
      </button>
    )
  }
)

VirtualSectionHeader.displayName = 'VirtualSectionHeader'

// ============================================================================
// DROPPABLE SECTION HEADER WRAPPER
// ============================================================================

interface DroppableSectionHeaderProps {
  item: SectionHeaderItem
  onToggleCollapse?: (sectionKey: string) => void
  onAddTask?: () => void
}

const DroppableSectionHeader = memo(
  ({ item, onToggleCollapse, onAddTask }: DroppableSectionHeaderProps): React.JSX.Element => {
    const today = startOfDay(new Date())
    const sectionId = item.sectionKey

    const { setNodeRef, isOver } = useDroppable({
      id: sectionId,
      data: {
        type: 'section',
        sectionId,
        label: item.label,
        date: today
      }
    })

    return (
      <div ref={setNodeRef}>
        <VirtualSectionHeader
          item={item}
          isOver={isOver}
          onToggleCollapse={onToggleCollapse}
          onAddTask={onAddTask}
        />
      </div>
    )
  }
)

DroppableSectionHeader.displayName = 'DroppableSectionHeader'

// ============================================================================
// DROPPABLE DAY HEADER (week days)
// ============================================================================

interface DroppableDayHeaderProps {
  item: DayHeaderItem
  onAddTask?: () => void
}

const DroppableDayHeader = memo(
  ({ item, onAddTask }: DroppableDayHeaderProps): React.JSX.Element => {
    const { setNodeRef, isOver } = useDroppable({
      id: item.dateKey,
      data: {
        type: 'section',
        sectionId: item.dateKey,
        label: getDayHeaderText(item.date).primary,
        date: item.date
      }
    })

    return (
      <div ref={setNodeRef} className="ml-2">
        <DaySectionHeader
          date={item.date}
          taskCount={item.taskCount}
          className={cn(isOver && 'ring-2 ring-primary/50 ring-inset rounded-sm')}
          onAddTask={onAddTask}
        />
      </div>
    )
  }
)

DroppableDayHeader.displayName = 'DroppableDayHeader'

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
  onToggleCollapse?: (sectionKey: string) => void
  onAddTaskWithDate?: (date: Date) => void
  showEmptyDays?: boolean
  onToggleEmptyDays?: (value: boolean) => void
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
    onToggleCollapse,
    onAddTaskWithDate,
    showEmptyDays,
    onToggleEmptyDays
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case 'section-header': {
        const sectionDate =
          item.sectionKey === 'today' ? startOfDay(new Date()) : startOfDay(new Date())
        return (
          <DroppableSectionHeader
            item={item}
            onToggleCollapse={onToggleCollapse}
            onAddTask={onAddTaskWithDate ? () => onAddTaskWithDate(sectionDate) : undefined}
          />
        )
      }

      case 'task': {
        const taskItem = item
        const isCompleted = isTaskCompletedFast(taskItem.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(taskItem.task.id) ?? false

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
          />
        )
      }

      case 'week-accordion-header': {
        const weekItem = item as WeekAccordionHeaderItem
        return (
          <button
            type="button"
            onClick={() => onToggleCollapse?.('this-week')}
            className={cn(
              'flex w-full cursor-pointer mt-4',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm'
            )}
          >
            <SectionDivider
              label="This Week"
              count={weekItem.totalCount}
              className="w-full pt-1"
              actions={
                !weekItem.isCollapsed ? (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <Switch
                      id="show-empty-days"
                      checked={showEmptyDays}
                      onCheckedChange={onToggleEmptyDays}
                      className="scale-75"
                    />
                    <Label
                      htmlFor="show-empty-days"
                      className="text-[11px] text-text-tertiary cursor-pointer"
                    >
                      Empty days
                    </Label>
                  </div>
                ) : undefined
              }
            />
          </button>
        )
      }

      case 'day-header': {
        const dayItem = item as DayHeaderItem
        return (
          <DroppableDayHeader
            item={dayItem}
            onAddTask={onAddTaskWithDate ? () => onAddTaskWithDate(dayItem.date) : undefined}
          />
        )
      }

      case 'empty-state': {
        const emptyItem = item
        if (emptyItem.variant === 'celebration') {
          return (
            <CelebrationEmptyState
              title="All clear for today!"
              description="Enjoy your free time or plan ahead."
              onAddTask={() => onAddTaskWithDate?.(startOfDay(new Date()))}
              addButtonLabel="Add task for today"
            />
          )
        }
        return null
      }

      default:
        return null
    }
  }
)

VirtualItemRenderer.displayName = 'VirtualItemRenderer'

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
  onAddTaskWithDate,
  className,
  showWeek = true,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks
}: VirtualizedTodayViewProps): React.JSX.Element => {
  const parentRef = useRef<HTMLDivElement>(null)

  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: 'today',
    persist: true
  })

  const { collapsedSections, toggleSection } = useCollapsedSections('today')

  const [showEmptyDays, setShowEmptyDays] = useState(true)

  const todayData = useMemo(
    () => (showWeek ? getTodayWithWeekTasks(tasks, projects) : getTodayTasks(tasks, projects)),
    [tasks, projects, showWeek]
  )

  const lookupContext = useMemo(() => createLookupContext(projects), [projects])

  const isEmpty = todayData.overdue.length === 0 && todayData.today.length === 0

  const virtualItems = useMemo(
    () =>
      flattenTodayTasks(
        todayData,
        projects,
        expandedIds,
        tasks,
        isEmpty,
        collapsedSections,
        showEmptyDays
      ),
    [todayData, projects, expandedIds, tasks, isEmpty, collapsedSections, showEmptyDays]
  )

  const allTaskIds = useMemo(() => getTaskIdsFromVirtualItems(virtualItems), [virtualItems])

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(virtualItems[index], expandedIds, tasks),
    overscan: 5
  })

  useEffect(() => {
    virtualizer.measure()
  }, [expandedIds, virtualizer])

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
        dueDate: parsedData?.dueDate ?? startOfDay(new Date()),
        priority: parsedData?.priority ?? ('none' as Priority),
        projectId: parsedData?.projectId ?? null
      }
      onQuickAdd(title, finalData)
    },
    [onQuickAdd]
  )

  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      <div className="pt-4">
        <QuickAddInput onAdd={handleQuickAdd} onOpenModal={onOpenModal} projects={projects} />
      </div>

      <SortableContext items={allTaskIds} strategy={verticalListSortingStrategy}>
        <div ref={parentRef} className="flex-1 overflow-auto pt-4" style={{ contain: 'strict' }}>
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
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
                    onToggleCollapse={toggleSection}
                    onAddTaskWithDate={onAddTaskWithDate}
                    showEmptyDays={showEmptyDays}
                    onToggleEmptyDays={setShowEmptyDays}
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
