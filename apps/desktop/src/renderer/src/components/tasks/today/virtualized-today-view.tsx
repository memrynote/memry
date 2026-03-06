import { useState, useMemo, useRef, useEffect, memo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { AnimatePresence } from 'framer-motion'
import { ChevronRight, Star, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { SortableTaskRow } from '@/components/tasks/drag-drop'
import { SortableParentTaskRow } from '@/components/tasks/sortable-parent-task-row'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { CelebrationEmptyState, OverdueClearedBanner } from '@/components/tasks/empty-states'
import { DaySectionHeader } from '@/components/tasks/day-section-header'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  flattenTodayTasks,
  estimateItemHeight,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type SectionHeaderItem,
  type TaskItem,
  type ParentTaskItem,
  type EmptyStateItem,
  type AddTaskButtonItem,
  type WeekAccordionHeaderItem,
  type DayHeaderItem
} from '@/lib/virtual-list-utils'
import { getTodayWithWeekTasks, getDayHeaderText, startOfDay } from '@/lib/task-utils'
import { createLookupContext, isTaskCompletedFast } from '@/lib/lookup-utils'
import { calculateProgress } from '@/lib/subtask-utils'
import { useExpandedTasks, useOverdueCelebration, useCollapsedSections } from '@/hooks'
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
    containerClass: 'rounded-lg',
    headerClass: 'text-text-secondary font-semibold',
    countClass: 'bg-muted text-text-tertiary',
    accentClass: '',
    icon: null
  },
  high: {
    containerClass:
      'bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-900/50 rounded-lg',
    headerClass: 'text-blue-700 dark:text-blue-400 font-semibold',
    countClass: 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400',
    accentClass: 'border-l-[3px] border-l-blue-500',
    icon: <Star className="size-4" aria-hidden="true" />
  }
} as const

// ============================================================================
// VIRTUAL SECTION HEADER (with droppable)
// ============================================================================

interface VirtualSectionHeaderProps {
  item: SectionHeaderItem
  isOver: boolean
  onToggleCollapse?: (sectionKey: string) => void
}

const VirtualSectionHeader = memo(
  ({ item, isOver, onToggleCollapse }: VirtualSectionHeaderProps): React.JSX.Element => {
    const isOverdue = item.sectionKey === 'overdue'
    const styles = isOverdue ? urgencyStyles.critical : urgencyStyles.high

    return (
      <button
        type="button"
        onClick={() => onToggleCollapse?.(item.sectionKey)}
        className={cn(
          'flex w-full items-center justify-between px-3 py-2 transition-colors',
          'hover:bg-accent/30 rounded-md cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          styles.containerClass,
          isOver && 'ring-2 ring-primary/50 ring-inset'
        )}
      >
        <div className="flex items-center gap-1.5">
          <ChevronRight
            className={cn(
              'size-3.5 text-text-tertiary transition-transform duration-200',
              !item.isCollapsed && 'rotate-90'
            )}
            strokeWidth={2.5}
          />
          {styles.icon && <span className={styles.headerClass}>{styles.icon}</span>}
          <h3 className={cn('text-xs uppercase tracking-wide', styles.headerClass)}>
            {item.label}
          </h3>
        </div>
        <span className={cn('text-xs px-1.5 py-0.5 rounded-full', styles.countClass)}>
          {item.count}
        </span>
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
}

const DroppableSectionHeader = memo(
  ({ item, onToggleCollapse }: DroppableSectionHeaderProps): React.JSX.Element => {
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
        <VirtualSectionHeader item={item} isOver={isOver} onToggleCollapse={onToggleCollapse} />
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
}

const DroppableDayHeader = memo(({ item }: DroppableDayHeaderProps): React.JSX.Element => {
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
        className={cn(isOver && 'ring-2 ring-primary/50 ring-inset rounded-md')}
      />
    </div>
  )
})

DroppableDayHeader.displayName = 'DroppableDayHeader'

// ============================================================================
// INLINE ADD TASK INPUT
// ============================================================================

interface InlineAddTaskInputProps {
  date?: Date
  onSubmit: (title: string, date?: Date) => void
  onCancel: () => void
  placeholder?: string
  className?: string
}

const InlineAddTaskInput = ({
  date,
  onSubmit,
  onCancel,
  placeholder = 'Task name...',
  className
}: InlineAddTaskInputProps): React.JSX.Element => {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = value.trim()
      if (trimmed) {
        onSubmit(trimmed, date)
        setValue('')
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleBlur = (): void => {
    const trimmed = value.trim()
    if (trimmed) {
      onSubmit(trimmed, date)
    }
    onCancel()
  }

  return (
    <div className={cn('flex items-center gap-2 px-4 py-2 border-t border-border/50', className)}>
      <div className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-text-tertiary" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm outline-none text-text-primary placeholder:text-text-tertiary"
        aria-label="New task name"
      />
    </div>
  )
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
  onActivateInlineAdd: (sectionId: string) => void
  onInlineAddSubmit: (title: string, date?: Date) => void
  onInlineAddCancel: () => void
  inlineAddSection: string | null
  onToggleCollapse?: (sectionKey: string) => void
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
    onActivateInlineAdd,
    onInlineAddSubmit,
    onInlineAddCancel,
    inlineAddSection,
    onToggleCollapse,
    showEmptyDays,
    onToggleEmptyDays
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case 'section-header':
        return <DroppableSectionHeader item={item} onToggleCollapse={onToggleCollapse} />

      case 'task': {
        const taskItem = item
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

      case 'parent-task': {
        const parentItem = item
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

      case 'week-accordion-header': {
        const weekItem = item as WeekAccordionHeaderItem
        return (
          <button
            type="button"
            onClick={() => onToggleCollapse?.('this-week')}
            className={cn(
              'flex w-full items-center justify-between px-3 py-2 transition-colors mt-4',
              'hover:bg-accent/30 rounded-md cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
          >
            <div className="flex items-center gap-1.5">
              <ChevronRight
                className={cn(
                  'size-3.5 text-text-tertiary transition-transform duration-200',
                  !weekItem.isCollapsed && 'rotate-90'
                )}
                strokeWidth={2.5}
              />
              <h3 className="text-xs uppercase tracking-wide text-text-secondary font-semibold">
                This Week
              </h3>
            </div>
            <div className="flex items-center gap-2">
              {!weekItem.isCollapsed && (
                <div
                  className="flex items-center gap-1.5 ml-2"
                  onClick={(e) => e.stopPropagation()}
                >
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
              )}
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-text-tertiary">
                {weekItem.totalCount}
              </span>
            </div>
          </button>
        )
      }

      case 'day-header': {
        const dayItem = item as DayHeaderItem
        return <DroppableDayHeader item={dayItem} />
      }

      case 'add-task-button': {
        const addItem = item as AddTaskButtonItem
        const isActive = inlineAddSection === addItem.sectionId
        const isWeekDay = !!addItem.date
        const label = isWeekDay ? 'Add task' : 'Add task for today'

        if (isActive) {
          return (
            <InlineAddTaskInput
              date={addItem.date}
              onSubmit={onInlineAddSubmit}
              onCancel={onInlineAddCancel}
              placeholder={label + '...'}
              className={isWeekDay ? 'ml-2' : ''}
            />
          )
        }

        return (
          <button
            type="button"
            onClick={() => onActivateInlineAdd(addItem.sectionId)}
            className={cn(
              'w-full flex items-center gap-2 px-4 py-2.5 text-sm text-text-tertiary',
              'hover:bg-accent/50 hover:text-text-secondary',
              'border-t border-border/50 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              isWeekDay && 'ml-2'
            )}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span>{label}</span>
          </button>
        )
      }

      case 'empty-state': {
        const emptyItem = item
        if (emptyItem.variant === 'celebration') {
          return (
            <CelebrationEmptyState
              title="All clear for today!"
              description="Enjoy your free time or plan ahead."
              onAddTask={() => onActivateInlineAdd('today')}
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
  className,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect,
  onShiftSelect,
  onAddSubtask,
  onReorderSubtasks
}: VirtualizedTodayViewProps): React.JSX.Element => {
  // Scroll container ref
  const parentRef = useRef<HTMLDivElement>(null)

  const { expandedIds, toggleExpanded } = useExpandedTasks({
    storageKey: 'today',
    persist: true
  })

  const { collapsedSections, toggleSection } = useCollapsedSections('today')

  const [showEmptyDays, setShowEmptyDays] = useState(true)
  const [inlineAddSection, setInlineAddSection] = useState<string | null>(null)

  const todayData = useMemo(() => getTodayWithWeekTasks(tasks, projects), [tasks, projects])

  const { showCelebration, dismiss: dismissCelebration } = useOverdueCelebration(
    todayData.overdue.length
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

  // Get all task IDs for SortableContext
  const allTaskIds = useMemo(() => getTaskIdsFromVirtualItems(virtualItems), [virtualItems])

  // Set up virtualizer with dynamic height support
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateItemHeight(virtualItems[index], expandedIds, tasks),
    overscan: 5
  })

  useEffect(() => {
    virtualizer.measure()
  }, [expandedIds, inlineAddSection, virtualizer])

  const handleActivateInlineAdd = useCallback((sectionId: string) => {
    setInlineAddSection(sectionId)
  }, [])

  const handleInlineAddCancel = useCallback(() => {
    setInlineAddSection(null)
  }, [])

  const handleInlineAddSubmit = useCallback(
    (title: string, date?: Date) => {
      const dueDate = date ?? startOfDay(new Date())
      onQuickAdd(title, {
        dueDate,
        priority: 'none',
        projectId: null
      })
      setInlineAddSection(null)
    },
    [onQuickAdd]
  )

  // Handle quick add with context (defaults to today)
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
                    onActivateInlineAdd={handleActivateInlineAdd}
                    onInlineAddSubmit={handleInlineAddSubmit}
                    onInlineAddCancel={handleInlineAddCancel}
                    inlineAddSection={inlineAddSection}
                    onToggleCollapse={toggleSection}
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
