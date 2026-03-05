import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'

import { ScrollArea } from '@/components/ui/scroll-area'
import { TaskSection } from '@/components/tasks/task-section'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { CelebrationEmptyState, OverdueClearedBanner } from '@/components/tasks/empty-states'
import { cn } from '@/lib/utils'
import { getTodayTasks, startOfDay } from '@/lib/task-utils'
import { getSectionVisibility } from '@/lib/section-visibility'
import { useOverdueCelebration } from '@/hooks'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface TodayViewProps {
  tasks: Task[]
  projects: Project[]
  selectedTaskId?: string | null
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
  onUpdateTask,
  onTaskClick,
  onQuickAdd,
  onOpenModal,
  className
}: TodayViewProps): React.JSX.Element => {
  // Get filtered and sorted tasks for today
  const { overdue, today } = useMemo(() => getTodayTasks(tasks, projects), [tasks, projects])

  // Track overdue celebration state
  const { showCelebration, dismiss: dismissCelebration } = useOverdueCelebration(overdue.length)

  // Calculate section visibility
  const overdueVisibility = getSectionVisibility('overdue', overdue.length)
  const todayVisibility = getSectionVisibility('today', today.length)

  // Handle adding task with today's date
  const handleAddTaskForToday = (): void => {
    onQuickAdd('', {
      dueDate: startOfDay(new Date()),
      priority: 'none',
      projectId: null
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
      priority: parsedData?.priority ?? ('none' as Priority),
      projectId: parsedData?.projectId ?? null
    }
    onQuickAdd(title, finalData)
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="p-4 space-y-4">
        {/* Quick Add Input */}
        <QuickAddInput
          onAdd={handleQuickAdd}
          onOpenModal={onOpenModal}
          projects={projects}
          placeholder="Add task for today..."
        />

        {/* Overdue Cleared Celebration Banner */}
        <AnimatePresence>
          {showCelebration && <OverdueClearedBanner onDismiss={dismissCelebration} />}
        </AnimatePresence>

        {/* Overdue section - only show when has tasks */}
        {overdueVisibility.shouldShow && (
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
            onUpdateTask={onUpdateTask}
            onTaskClick={onTaskClick}
          />
        )}

        {/* Today section - always show with empty state when needed */}
        {todayVisibility.shouldShow && (
          <>
            {today.length > 0 ? (
              <TaskSection
                id="today"
                title="TODAY"
                count={today.length}
                tasks={today}
                allTasks={tasks}
                projects={projects}
                variant="today"
                date={startOfDay(new Date())}
                showAddTask
                selectedTaskId={selectedTaskId}
                onAddTask={handleAddTaskForToday}
                onToggleComplete={onToggleComplete}
                onUpdateTask={onUpdateTask}
                onTaskClick={onTaskClick}
              />
            ) : (
              /* Empty state for today - show celebration style */
              todayVisibility.showEmptyState && (
                <CelebrationEmptyState
                  title="All clear for today!"
                  description="Enjoy your free time or plan ahead."
                  onAddTask={handleAddTaskForToday}
                  addButtonLabel="Add task for today"
                />
              )
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

export default TodayView
