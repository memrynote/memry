import { useMemo, useRef, useEffect, memo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { ChevronRight, Star, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { SortableParentTaskRow } from '@/components/tasks/sortable-parent-task-row'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { TaskEmptyState } from '@/components/tasks/task-empty-state'
import {
  flattenTasksByDueDate,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type SectionHeaderItem
} from '@/lib/virtual-list-utils'
import {
  startOfDay,
  addDays,
  dueDateGroupConfig,
  type UrgencyLevel,
  type TaskGroupByDate
} from '@/lib/task-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { calculateProgress } from '@/lib/subtask-utils'
import { useExpandedTasks, useCollapsedSections } from '@/hooks'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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
  // Storage key for expand/collapse persistence
  storageKey?: string
}

// ============================================================================
// URGENCY STYLING
// ============================================================================

interface UrgencyStyleConfig {
  containerClass: string
  headerClass: string
  countClass: string
  accentClass: string
  icon: React.ReactNode | null
}

const urgencyStyles: Record<UrgencyLevel, UrgencyStyleConfig> = {
  critical: {
    containerClass: 'rounded-sm',
    headerClass: 'text-text-secondary font-semibold',
    countClass: 'bg-muted text-text-tertiary',
    accentClass: '',
    icon: null
  },
  high: {
    containerClass:
      'bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-900/50 rounded-sm',
    headerClass: 'text-blue-700 dark:text-blue-400 font-semibold',
    countClass: 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400',
    accentClass: 'border-l-[3px] border-l-blue-500',
    icon: <Star className="size-4" aria-hidden="true" />
  },
  normal: {
    containerClass: '',
    headerClass: 'text-muted-foreground font-medium',
    countClass: 'bg-muted text-muted-foreground',
    accentClass: '',
    icon: null
  },
  low: {
    containerClass: '',
    headerClass: 'text-text-tertiary font-medium',
    countClass: 'bg-muted/50 text-text-tertiary',
    accentClass: '',
    icon: null
  }
}

// ============================================================================
// HELPER: Get date from section key
// ============================================================================

const getDateFromSectionKey = (sectionKey: keyof TaskGroupByDate): Date | null => {
  const today = startOfDay(new Date())

  switch (sectionKey) {
    case 'overdue':
      return addDays(today, -1)
    case 'today':
      return today
    case 'tomorrow':
      return addDays(today, 1)
    case 'upcoming':
      return addDays(today, 2)
    case 'later':
      return addDays(today, 7)
    case 'noDueDate':
      return null
    default:
      return null
  }
}

// ============================================================================
// VIRTUAL SECTION HEADER (with droppable)
// ============================================================================

interface VirtualSectionHeaderProps {
  item: SectionHeaderItem
  isOver: boolean
  onToggleCollapse?: (sectionKey: string) => void
  onAddTask?: (sectionKey: keyof TaskGroupByDate) => void
}

const VirtualSectionHeader = memo(
  ({ item, isOver, onToggleCollapse, onAddTask }: VirtualSectionHeaderProps): React.JSX.Element => {
    const styles = urgencyStyles[item.urgency]
    const isOverdue = item.sectionKey === 'overdue'
    const hasUrgentStyling = item.urgency === 'high'

    if (isOverdue) {
      return (
        <div
          className={cn(
            'flex items-center pb-2 gap-2',
            isOver && 'ring-2 ring-primary/50 ring-inset rounded-sm'
          )}
        >
          <span className="text-[12px] tracking-[0.04em] uppercase font-[family-name:var(--font-heading)] font-semibold leading-4 shrink-0 text-[#C4654A]">
            {item.label}
          </span>
          <div className="h-px grow shrink basis-0 bg-[#F0DEDA] dark:bg-[#5a3030]" />
          <span className="text-[11px] font-[family-name:var(--font-mono)] font-medium leading-3.5 shrink-0 text-[#C4654A]">
            {item.count}
          </span>
        </div>
      )
    }

    return (
      <div
        className={cn(
          'flex w-full items-center justify-between px-3 py-2 transition-colors',
          'rounded-sm',
          hasUrgentStyling && styles.containerClass,
          isOver && 'ring-2 ring-primary/50 ring-inset'
        )}
      >
        <button
          type="button"
          onClick={() => onToggleCollapse?.(item.sectionKey)}
          className={cn(
            'flex items-center gap-1.5 hover:bg-accent/30 rounded-sm cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
        >
          <ChevronRight
            className={cn(
              'size-3.5 text-text-tertiary transition-transform duration-200',
              !item.isCollapsed && 'rotate-90'
            )}
            strokeWidth={2.5}
          />
          {styles.icon && <span className={styles.headerClass}>{styles.icon}</span>}
          <h3
            className={cn(
              'text-xs uppercase tracking-wide',
              hasUrgentStyling
                ? styles.headerClass
                : item.isMuted
                  ? 'text-text-tertiary font-medium'
                  : 'text-text-secondary font-semibold'
            )}
            style={!hasUrgentStyling && item.accentColor ? { color: item.accentColor } : undefined}
          >
            {item.label}
          </h3>
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onAddTask?.(item.sectionKey)
            }}
            className={cn(
              'size-5 flex items-center justify-center rounded-sm',
              'text-text-tertiary hover:text-text-secondary hover:bg-accent/50',
              'transition-colors cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
            title={`Add task to ${item.label}`}
          >
            <Plus className="size-3.5" strokeWidth={2} />
          </button>
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full',
              hasUrgentStyling ? styles.countClass : 'text-text-tertiary'
            )}
          >
            {hasUrgentStyling ? item.count : `(${item.count})`}
          </span>
        </div>
      </div>
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
  onAddTask?: (sectionKey: keyof TaskGroupByDate) => void
}

const DroppableSectionHeader = memo(
  ({ item, onToggleCollapse, onAddTask }: DroppableSectionHeaderProps): React.JSX.Element => {
    const targetDate = getDateFromSectionKey(item.sectionKey)
    const sectionId = `group-${item.sectionKey}`

    const { setNodeRef, isOver } = useDroppable({
      id: sectionId,
      data: {
        type: 'section',
        sectionId,
        label: item.label,
        date: targetDate
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
  // Add task for section
  onAddTaskForSection: (sectionKey: keyof TaskGroupByDate) => void
  onToggleCollapse?: (sectionKey: string) => void
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
    onAddTaskForSection,
    onToggleCollapse
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case 'section-header':
        return (
          <DroppableSectionHeader
            item={item}
            onToggleCollapse={onToggleCollapse}
            onAddTask={onAddTaskForSection}
          />
        )

      case 'task': {
        const taskItem = item
        const isCompleted = isTaskCompletedFast(taskItem.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(taskItem.task.id) ?? false
        const styles =
          urgencyStyles[
            dueDateGroupConfig[taskItem.sectionId as keyof TaskGroupByDate]?.urgency || 'normal'
          ]
        const hasUrgentStyling = taskItem.isOverdue

        return (
          <SortableTaskRow
            task={taskItem.task}
            project={taskItem.project}
            projects={projects}
            sectionId={`group-${taskItem.sectionId}`}
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
            accentClass={hasUrgentStyling ? styles.accentClass : undefined}
          />
        )
      }

      case 'parent-task': {
        const parentItem = item
        const isCompleted = isTaskCompletedFast(parentItem.task, lookupContext.completionMap)
        const isCheckedForSelection = selectedIds?.has(parentItem.task.id) ?? false
        const isExpanded = expandedIds.has(parentItem.task.id)
        const progress = calculateProgress(parentItem.subtasks)
        const styles =
          urgencyStyles[
            dueDateGroupConfig[parentItem.sectionId as keyof TaskGroupByDate]?.urgency || 'normal'
          ]
        const hasUrgentStyling = parentItem.isOverdue

        return (
          <SortableParentTaskRow
            task={parentItem.task}
            project={parentItem.project}
            sectionId={`group-${parentItem.sectionId}`}
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
            accentClass={hasUrgentStyling ? styles.accentClass : undefined}
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
  onOpenModal,
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks,
  storageKey = 'all'
}: VirtualizedAllTasksViewProps): React.JSX.Element => {
  // Scroll container ref
  const parentRef = useRef<HTMLDivElement>(null)

  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey,
    persist: true
  })

  const { collapsedSections, toggleSection } = useCollapsedSections(storageKey)

  const lookupContext = useMemo(() => createLookupContext(projects), [projects])

  const virtualItems = useMemo(
    () => flattenTasksByDueDate(tasks, projects, expandedIds, tasks, collapsedSections, true),
    [tasks, projects, expandedIds, collapsedSections]
  )

  // Get all task IDs for SortableContext
  const allTaskIds = useMemo(() => getTaskIdsFromVirtualItems(virtualItems), [virtualItems])

  // Check if empty
  const isEmpty = virtualItems.length === 0

  // Set up virtualizer with dynamic height support
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(virtualItems[index], expandedIds, tasks),
    overscan: 5
  })

  // Remeasure when expanded state changes
  useEffect(() => {
    virtualizer.measure()
  }, [expandedIds, virtualizer])

  // Handle adding task for a specific section
  const handleAddTaskForSection = useCallback(
    (sectionKey: keyof TaskGroupByDate) => {
      const date = getDateFromSectionKey(sectionKey)
      onQuickAdd('', {
        dueDate: date,
        priority: 'none',
        projectId: null
      })
    },
    [onQuickAdd]
  )

  // Empty state
  if (isEmpty) {
    return (
      <div className={cn('flex-1 overflow-auto p-4', className)}>
        <div className="mb-4">
          <QuickAddInput
            onAdd={onQuickAdd}
            onOpenModal={onOpenModal}
            projects={projects}
            placeholder="Add task..."
          />
        </div>
        <TaskEmptyState variant="all" onAddTask={() => onQuickAdd('New Task')} />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      {/* Quick Add Input - fixed at top */}
      <div className="p-4 pb-0">
        <QuickAddInput
          onAdd={onQuickAdd}
          onOpenModal={onOpenModal}
          projects={projects}
          placeholder="Add task..."
        />
      </div>

      {/* Virtualized content */}
      <SortableContext items={allTaskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={parentRef}
          className="flex-1 overflow-auto px-4 pt-4"
          style={{ contain: 'strict' }}
        >
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
                    onAddTaskForSection={handleAddTaskForSection}
                    onToggleCollapse={toggleSection}
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

export default VirtualizedAllTasksView
