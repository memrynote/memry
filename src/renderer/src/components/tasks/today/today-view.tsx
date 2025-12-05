import { useMemo } from "react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { TaskSection } from "@/components/tasks/task-section"
import { TodayEmptyState } from "@/components/tasks/today-empty-state"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import { cn } from "@/lib/utils"
import { getTodayTasks, startOfDay } from "@/lib/task-utils"
import type { Task, Priority } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface TodayViewProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
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
  onViewUpcoming?: () => void
  className?: string
}

// ============================================================================
// TODAY VIEW COMPONENT
// ============================================================================

export const TodayView = ({
  tasks,
  projects,
  selectedTaskId,
  onToggleComplete,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  onViewUpcoming,
  className,
}: TodayViewProps): React.JSX.Element => {
  // Get filtered and sorted tasks for today
  const { overdue, today } = useMemo(
    () => getTodayTasks(tasks, projects),
    [tasks, projects]
  )

  const totalTasks = overdue.length + today.length
  const hasOverdue = overdue.length > 0
  const hasTodayTasks = today.length > 0
  const isEmpty = totalTasks === 0

  // Handle adding task with today's date
  const handleAddTaskForToday = (): void => {
    onQuickAdd("", {
      dueDate: startOfDay(new Date()),
      priority: "none",
      projectId: null,
    })
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
    // Default to today if no date specified
    const finalData = {
      ...parsedData,
      dueDate: parsedData?.dueDate ?? startOfDay(new Date()),
      priority: parsedData?.priority ?? "none" as Priority,
      projectId: parsedData?.projectId ?? null,
    }
    onQuickAdd(title, finalData)
  }

  return (
    <ScrollArea className={cn("flex-1", className)}>
      <div className="p-4 space-y-4">
        {/* Quick Add Input */}
        <QuickAddInput
          onAdd={handleQuickAdd}
          onOpenModal={onOpenModal}
          projects={projects}
          placeholder="Add task for today... (use !!high #project for quick options)"
        />

        {/* Empty state */}
        {isEmpty && (
          <TodayEmptyState
            hasOverdue={false}
            onAddTask={handleAddTaskForToday}
            onViewUpcoming={onViewUpcoming}
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

        {/* Today section */}
        {(hasTodayTasks || hasOverdue) && (
          <>
            {hasTodayTasks ? (
              <TaskSection
                id="today"
                title="TODAY"
                count={today.length}
                tasks={today}
                allTasks={tasks}
                projects={projects}
                variant="today"
                date={startOfDay(new Date())} // Explicitly today's date
                showAddTask
                selectedTaskId={selectedTaskId}
                onAddTask={handleAddTaskForToday}
                onToggleComplete={onToggleComplete}
                onTaskClick={onTaskClick}
              />
            ) : (
              // Has overdue but nothing for today
              <TodayEmptyState
                hasOverdue={true}
                onAddTask={handleAddTaskForToday}
                onViewUpcoming={onViewUpcoming}
              />
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TodayView
