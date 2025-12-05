import { useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { TaskSection } from "@/components/tasks/task-section"
import { DaySectionHeader } from "@/components/tasks/day-section-header"
import { SortableTaskRow } from "@/components/tasks/drag-drop"
import { UpcomingEmptyState } from "@/components/tasks/upcoming-empty-state"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import { cn } from "@/lib/utils"
import {
  getUpcomingTasks,
  parseDateKey,
  startOfDay,
  isSameDay,
  addDays,
} from "@/lib/task-utils"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface UpcomingViewProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
  daysAhead?: number
  onToggleComplete: (taskId: string) => void
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
}

// ============================================================================
// DAY SECTION COMPONENT
// ============================================================================

interface DaySectionProps {
  dateKey: string
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
  showEmptyDays: boolean
  onToggleComplete: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  onAddTaskForDate: (date: Date) => void
}

const DaySection = ({
  dateKey,
  tasks,
  allTasks,
  projects,
  selectedTaskId,
  showEmptyDays,
  onToggleComplete,
  onTaskClick,
  onAddTaskForDate,
}: DaySectionProps): React.JSX.Element | null => {
  const date = parseDateKey(dateKey)
  const isToday = isSameDay(date, startOfDay(new Date()))
  const isEmpty = tasks.length === 0

  // Section ID for drag-drop
  const sectionId = `day-${dateKey}`

  // Set up droppable for section-level drops
  const { setNodeRef, isOver } = useDroppable({
    id: sectionId,
    data: {
      type: "section",
      sectionId: dateKey,
      label: date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
      date: date, // Pass the actual date for reschedule
    },
  })

  // Get task IDs for SortableContext
  const taskIds = tasks.map((t) => t.id)

  // Hide empty days if setting is off
  if (isEmpty && !showEmptyDays) {
    return null
  }

  const handleAddTask = (): void => {
    onAddTaskForDate(date)
  }

  // Check if a task is completed
  const isTaskCompleted = (task: Task): boolean => {
    const project = projects.find((p) => p.id === task.projectId)
    if (!project) return false
    const status = project.statuses.find((s) => s.id === task.statusId)
    return status?.type === "done"
  }

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-lg border border-border overflow-hidden transition-all",
        "border-l-2",
        isToday ? "border-l-amber-500 bg-amber-50/30 dark:bg-amber-950/10" : "border-l-border",
        isOver && "ring-2 ring-primary/50 border-primary/50"
      )}
    >
      {/* Day header */}
      <DaySectionHeader date={date} taskCount={tasks.length} />

      {/* Task list */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="divide-y divide-border/50">
          {tasks.length > 0 ? (
            tasks.map((task) => {
              const project = projects.find((p) => p.id === task.projectId)
              if (!project) return null

              return (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  project={project}
                  sectionId={dateKey}
                  allTasks={allTasks}
                  isCompleted={isTaskCompleted(task)}
                  isSelected={selectedTaskId === task.id}
                  showProjectBadge={true}
                  onToggleComplete={onToggleComplete}
                  onClick={onTaskClick}
                />
              )
            })
          ) : (
            <div className="px-4 py-6 text-center text-text-tertiary text-sm">
              No tasks scheduled
              <button
                type="button"
                onClick={handleAddTask}
                className={cn(
                  "block mx-auto mt-2 text-primary hover:text-primary/80",
                  "text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                + Add task for {date.toLocaleDateString("en-US", { weekday: "long" })}
              </button>
            </div>
          )}
        </div>
      </SortableContext>

      {/* Drop indicator message when hovering */}
      {isOver && (
        <div className="px-4 py-2 text-center text-sm text-primary font-medium bg-primary/5 border-t border-primary/20">
          Drop to reschedule to {date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
        </div>
      )}

      {/* Add task footer for non-empty days */}
      {tasks.length > 0 && (
        <button
          type="button"
          onClick={handleAddTask}
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
      )}
    </section>
  )
}

// ============================================================================
// UPCOMING VIEW COMPONENT
// ============================================================================

export const UpcomingView = ({
  tasks,
  projects,
  selectedTaskId,
  daysAhead = 7,
  onToggleComplete,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  onAddTaskWithDate,
  className,
}: UpcomingViewProps): React.JSX.Element => {
  // State for showing/hiding empty days
  const [showEmptyDays, setShowEmptyDays] = useState(true)

  // Get filtered and grouped tasks for upcoming view
  const { overdue, byDay } = useMemo(
    () => getUpcomingTasks(tasks, projects, daysAhead),
    [tasks, projects, daysAhead]
  )

  // Calculate if there are any tasks at all
  const hasOverdue = overdue.length > 0
  let totalUpcomingTasks = 0
  byDay.forEach((dayTasks) => {
    totalUpcomingTasks += dayTasks.length
  })
  const isEmpty = totalUpcomingTasks === 0 && !hasOverdue

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
    const tomorrow = addDays(startOfDay(new Date()), 1)
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
    // Default to tomorrow if no date specified
    const tomorrow = addDays(startOfDay(new Date()), 1)
    const finalData = {
      ...parsedData,
      dueDate: parsedData?.dueDate ?? tomorrow,
      priority: parsedData?.priority ?? "none" as Priority,
      projectId: parsedData?.projectId ?? null,
    }
    onQuickAdd(title, finalData)
  }

  // Convert Map to array for rendering
  const dayEntries = Array.from(byDay.entries())

  return (
    <ScrollArea className={cn("flex-1", className)}>
      <div className="p-4 space-y-4">
        {/* Header with toggle */}
        <div className="flex items-center justify-between">
          <QuickAddInput
            onAdd={handleQuickAdd}
            onOpenModal={onOpenModal}
            projects={projects}
            placeholder="Add upcoming task... (use !tomorrow !!high for quick options)"
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

        {/* Empty state */}
        {isEmpty && (
          <UpcomingEmptyState
            hasOverdue={false}
            onAddTask={handleAddTask}
          />
        )}

        {/* Overdue section */}
        {hasOverdue && (
          <TaskSection
            id="overdue"
            title="OVERDUE"
            count={overdue.length}
            tasks={overdue}
            allTasks={tasks}
            projects={projects}
            variant="overdue"
            date={startOfDay(new Date())} // Dropping here reschedules to today
            selectedTaskId={selectedTaskId}
            onToggleComplete={onToggleComplete}
            onTaskClick={onTaskClick}
          />
        )}

        {/* Day sections */}
        {(totalUpcomingTasks > 0 || showEmptyDays) && (
          <div className="space-y-4">
            {dayEntries.map(([dateKey, dayTasks]) => (
              <DaySection
                key={dateKey}
                dateKey={dateKey}
                tasks={dayTasks}
                allTasks={tasks}
                projects={projects}
                selectedTaskId={selectedTaskId}
                showEmptyDays={showEmptyDays}
                onToggleComplete={onToggleComplete}
                onTaskClick={onTaskClick}
                onAddTaskForDate={handleAddTaskForDate}
              />
            ))}
          </div>
        )}

        {/* Show empty state in place of day sections if no tasks and not showing empty days */}
        {totalUpcomingTasks === 0 && !showEmptyDays && hasOverdue && (
          <UpcomingEmptyState
            hasOverdue={true}
            onAddTask={handleAddTask}
          />
        )}
      </div>
    </ScrollArea>
  )
}

export default UpcomingView
