import { useMemo, useRef, useState, memo } from "react"
import { Plus } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AnimatePresence } from "framer-motion"

import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { DaySectionHeader } from "@/components/tasks/day-section-header"
import {
  PlanningEmptyState,
  SimpleEmptyState,
  OverdueClearedBanner,
} from "@/components/tasks/empty-states"
import { cn } from "@/lib/utils"
import {
  getUpcomingTasks,
  parseDateKey,
  startOfDay,
  addDays,
} from "@/lib/task-utils"
import {
  createLookupContext,
  isTaskCompletedFast,
  type LookupContext,
} from "@/lib/lookup-utils"
import { getSectionVisibility } from "@/lib/section-visibility"
import { useOverdueCelebration } from "@/hooks"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface VirtualizedUpcomingViewProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
  daysAhead?: number
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
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
  onViewCalendar?: () => void
  className?: string
}

// Virtual item types for flattened data structure
type VirtualItemType =
  | "overdue-header"
  | "day-header"
  | "task"
  | "empty-day"
  | "add-task-button"

interface VirtualItem {
  id: string
  type: VirtualItemType
  date?: Date
  dateKey?: string
  task?: Task
  project?: Project
  taskCount?: number
  isOverdue?: boolean
  isTomorrow?: boolean
}

// Estimated heights for different item types
const ITEM_HEIGHTS = {
  "overdue-header": 44,
  "day-header": 44,
  task: 52,
  "empty-day": 80,
  "add-task-button": 40,
} as const

// ============================================================================
// FLATTENING UTILITY
// ============================================================================

/**
 * Flatten the grouped task data into a single array for virtualization
 */
const flattenUpcomingData = (
  overdue: Task[],
  byDay: Map<string, Task[]>,
  lookupContext: LookupContext,
  showEmptyDays: boolean,
  tomorrowKey: string,
  hasTasksThisWeek: boolean
): VirtualItem[] => {
  const items: VirtualItem[] = []

  // Add overdue section if has tasks
  if (overdue.length > 0) {
    items.push({
      id: "overdue-header",
      type: "overdue-header",
      taskCount: overdue.length,
      isOverdue: true,
    })

    overdue.forEach((task) => {
      const project = lookupContext.projectMap.get(task.projectId)
      items.push({
        id: `task-${task.id}`,
        type: "task",
        task,
        project,
        isOverdue: true,
      })
    })
  }

  // Add day sections
  byDay.forEach((dayTasks, dateKey) => {
    const date = parseDateKey(dateKey)
    const isTomorrow = dateKey === tomorrowKey

    // Check visibility for tomorrow section
    if (isTomorrow) {
      const visibility = getSectionVisibility("tomorrow", dayTasks.length, {
        hasTasksThisWeek,
      })
      if (!visibility.shouldShow) return
    }

    // Skip empty days if setting is off (except tomorrow which has special handling)
    if (dayTasks.length === 0 && !showEmptyDays && !isTomorrow) {
      return
    }

    // Add day header
    items.push({
      id: `day-${dateKey}`,
      type: "day-header",
      date,
      dateKey,
      taskCount: dayTasks.length,
      isTomorrow,
    })

    if (dayTasks.length > 0) {
      // Add tasks for this day
      dayTasks.forEach((task) => {
        const project = lookupContext.projectMap.get(task.projectId)
        items.push({
          id: `task-${task.id}`,
          type: "task",
          task,
          project,
          dateKey,
        })
      })

      // Add "add task" button at end of day
      items.push({
        id: `add-${dateKey}`,
        type: "add-task-button",
        date,
        dateKey,
      })
    } else {
      // Add empty day state
      items.push({
        id: `empty-${dateKey}`,
        type: "empty-day",
        date,
        dateKey,
        isTomorrow,
      })
    }
  })

  return items
}

// ============================================================================
// VIRTUAL ITEM RENDERER
// ============================================================================

interface VirtualItemRendererProps {
  item: VirtualItem
  lookupContext: LookupContext
  allTasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
  onToggleComplete: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onTaskClick?: (taskId: string) => void
  onAddTaskForDate: (date: Date) => void
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
    onTaskClick,
    onAddTaskForDate,
  }: VirtualItemRendererProps): React.JSX.Element | null => {
    switch (item.type) {
      case "overdue-header":
        return (
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50 bg-red-50/50 dark:bg-red-950/20 rounded-t-lg border border-red-200 dark:border-red-900">
            <span className="font-semibold text-sm uppercase tracking-wide text-red-600 dark:text-red-400">
              OVERDUE
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400">
              {item.taskCount}
            </span>
          </div>
        )

      case "day-header":
        if (!item.date) return null
        return (
          <div className="mt-4 first:mt-0">
            <DaySectionHeader date={item.date} taskCount={item.taskCount || 0} />
          </div>
        )

      case "task":
        if (!item.task || !item.project) return null
        const isCompleted = isTaskCompletedFast(item.task, lookupContext.completionMap)
        return (
          <SortableTaskRow
            task={item.task}
            project={item.project}
            projects={projects}
            sectionId={item.dateKey || "overdue"}
            allTasks={allTasks}
            isCompleted={isCompleted}
            isSelected={selectedTaskId === item.task.id}
            showProjectBadge={true}
            onToggleComplete={onToggleComplete}
            onUpdateTask={onUpdateTask}
            onClick={onTaskClick}
            accentClass={
              item.isOverdue && !isCompleted
                ? "border-l-2 border-l-destructive"
                : undefined
            }
          />
        )

      case "empty-day":
        if (!item.date) return null
        return (
          <SimpleEmptyState
            label={item.isTomorrow ? "tomorrow" : item.date.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase()}
            onAddTask={() => onAddTaskForDate(item.date!)}
          />
        )

      case "add-task-button":
        if (!item.date) return null
        return (
          <button
            type="button"
            onClick={() => onAddTaskForDate(item.date!)}
            className={cn(
              "w-full flex items-center gap-2 px-4 py-2.5 text-sm text-text-tertiary",
              "hover:bg-accent/50 hover:text-text-secondary",
              "border-t border-border/50 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            )}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span>Add task</span>
          </button>
        )

      default:
        return null
    }
  }
)

VirtualItemRenderer.displayName = "VirtualItemRenderer"

// ============================================================================
// VIRTUALIZED UPCOMING VIEW COMPONENT
// ============================================================================

export const VirtualizedUpcomingView = ({
  tasks,
  projects,
  selectedTaskId,
  daysAhead = 7,
  onToggleComplete,
  onUpdateTask,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  onAddTaskWithDate,
  onViewCalendar,
  className,
}: VirtualizedUpcomingViewProps): React.JSX.Element => {
  // State for showing/hiding empty days
  const [showEmptyDays, setShowEmptyDays] = useState(true)

  // Ref for the scroll container
  const parentRef = useRef<HTMLDivElement>(null)

  // Create lookup context for O(1) project/status lookups
  const lookupContext = useMemo(
    () => createLookupContext(projects),
    [projects]
  )

  // Get filtered and grouped tasks for upcoming view
  const { overdue, byDay } = useMemo(
    () => getUpcomingTasks(tasks, projects, daysAhead),
    [tasks, projects, daysAhead]
  )

  // Track overdue celebration state
  const { showCelebration, dismiss: dismissCelebration } = useOverdueCelebration(
    overdue.length
  )

  // Calculate section visibility
  const overdueVisibility = getSectionVisibility("overdue", overdue.length)
  const upcomingVisibility = getSectionVisibility("upcoming", 0)

  // Calculate if there are any tasks this week
  let totalUpcomingTasks = 0
  byDay.forEach((dayTasks) => {
    totalUpcomingTasks += dayTasks.length
  })
  const hasTasksThisWeek = totalUpcomingTasks > 0 || overdue.length > 0
  const isCompletelyEmpty = totalUpcomingTasks === 0 && !overdueVisibility.shouldShow

  // Determine tomorrow's date key
  const tomorrow = addDays(startOfDay(new Date()), 1)
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`

  // Flatten data for virtualization
  const virtualItems = useMemo(
    () =>
      flattenUpcomingData(
        overdue,
        byDay,
        lookupContext,
        showEmptyDays,
        tomorrowKey,
        hasTasksThisWeek
      ),
    [overdue, byDay, lookupContext, showEmptyDays, tomorrowKey, hasTasksThisWeek]
  )

  // Set up virtualizer
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = virtualItems[index]
      return ITEM_HEIGHTS[item.type] || 50
    },
    overscan: 5,
  })

  // Handle adding task for a specific date
  const handleAddTaskForDate = (date: Date): void => {
    if (onAddTaskWithDate) {
      onAddTaskWithDate(date)
    } else {
      onQuickAdd("", {
        dueDate: date,
        priority: "none",
        projectId: null,
      })
    }
  }

  // Handle adding task (defaults to tomorrow for upcoming)
  const handleAddTask = (): void => {
    handleAddTaskForDate(tomorrow)
  }

  // Handle quick add with context
  const handleQuickAdd = (
    title: string,
    parsedData?: {
      dueDate: Date | null
      priority: Priority
      projectId: string | null
    }
  ): void => {
    const finalData = {
      ...parsedData,
      dueDate: parsedData?.dueDate ?? tomorrow,
      priority: parsedData?.priority ?? ("none" as Priority),
      projectId: parsedData?.projectId ?? null,
    }
    onQuickAdd(title, finalData)
  }

  return (
    <div className={cn("flex flex-1 flex-col overflow-hidden", className)}>
      {/* Header with toggle */}
      <div className="flex items-center justify-between p-4 border-b border-border/50">
        <QuickAddInput
          onAdd={handleQuickAdd}
          onOpenModal={onOpenModal}
          projects={projects}
          placeholder="Add upcoming task..."
          className="flex-1 mr-4"
        />

        <div className="flex items-center gap-2 shrink-0">
          <Switch
            id="show-empty-days"
            checked={showEmptyDays}
            onCheckedChange={setShowEmptyDays}
          />
          <Label
            htmlFor="show-empty-days"
            className="text-sm text-text-tertiary cursor-pointer"
          >
            Show empty days
          </Label>
        </div>
      </div>

      {/* Overdue Cleared Celebration Banner */}
      <AnimatePresence>
        {showCelebration && (
          <div className="px-4 pt-4">
            <OverdueClearedBanner onDismiss={dismissCelebration} />
          </div>
        )}
      </AnimatePresence>

      {/* Planning empty state - show when completely empty */}
      {isCompletelyEmpty && upcomingVisibility.showEmptyState && (
        <div className="p-4">
          <PlanningEmptyState
            onAddTask={handleAddTask}
            onViewCalendar={onViewCalendar}
          />
        </div>
      )}

      {/* Virtualized content */}
      {!isCompletelyEmpty && (
        <div
          ref={parentRef}
          className="flex-1 overflow-auto px-4"
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
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
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
                    onTaskClick={onTaskClick}
                    onAddTaskForDate={handleAddTaskForDate}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default VirtualizedUpcomingView
