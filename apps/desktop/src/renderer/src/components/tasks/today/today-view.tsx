import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'

import { ScrollArea } from '@/components/ui/scroll-area'
import { TaskSection } from '@/components/tasks/task-section'
import { CelebrationEmptyState, OverdueClearedBanner } from '@/components/tasks/empty-states'
import { cn } from '@/lib/utils'
import { getTodayTasks, startOfDay } from '@/lib/task-utils'
import { getSectionVisibility } from '@/lib/section-visibility'
import { useOverdueCelebration } from '@/hooks'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

export const TodayView = ({
  tasks,
  projects,
  selectedTaskId,
  onToggleComplete,
  onUpdateTask,
  onTaskClick,
  onQuickAdd: _onQuickAdd,
  onOpenModal,
  className
}: TodayViewProps): React.JSX.Element => {
  const { overdue, today } = useMemo(() => getTodayTasks(tasks, projects), [tasks, projects])
  const { showCelebration, dismiss: dismissCelebration } = useOverdueCelebration(overdue.length)

  const overdueVisibility = getSectionVisibility('overdue', overdue.length)
  const todayVisibility = getSectionVisibility('today', today.length)

  const totalTasks = overdue.length + today.length
  const completedCount = useMemo(() => {
    const todayStart = startOfDay(new Date())
    return tasks.filter((t) => t.completedAt && t.completedAt >= todayStart).length
  }, [tasks])
  const totalWithCompleted = totalTasks + completedCount
  const progressPct = totalWithCompleted > 0 ? (completedCount / totalWithCompleted) * 100 : 0

  const now = new Date()
  const dayName = DAY_NAMES[now.getDay()]
  const monthName = MONTH_NAMES[now.getMonth()]
  const dayNum = now.getDate()

  const handleAddTaskForToday = (): void => {
    onOpenModal?.('')
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="space-y-4 pt-4">
        {/* Day Summary */}
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-text-tertiary leading-4">
            {dayName}, {monthName} {dayNum} — {totalTasks} task{totalTasks !== 1 ? 's' : ''}{' '}
            remaining
          </span>
          {totalWithCompleted > 0 && (
            <>
              <div className="h-1 w-20 flex ml-2 rounded-xs overflow-hidden bg-[#7B9E871F] shrink-0">
                <div
                  className="h-full rounded-xs bg-[#7B9E87] transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-[11px] text-[#7B9E87] font-[family-name:var(--font-mono)] font-medium leading-3.5">
                {completedCount}/{totalWithCompleted}
              </span>
            </>
          )}
        </div>

        {/* Overdue Cleared Celebration Banner */}
        <AnimatePresence>
          {showCelebration && <OverdueClearedBanner onDismiss={dismissCelebration} />}
        </AnimatePresence>

        {/* Overdue section */}
        {overdueVisibility.shouldShow && (
          <TaskSection
            id="overdue"
            title="Overdue"
            count={overdue.length}
            tasks={overdue}
            allTasks={tasks}
            projects={projects}
            variant="overdue"
            date={startOfDay(new Date())}
            selectedTaskId={selectedTaskId}
            onToggleComplete={onToggleComplete}
            onUpdateTask={onUpdateTask}
            onTaskClick={onTaskClick}
          />
        )}

        {/* Today section */}
        {todayVisibility.shouldShow && (
          <>
            {today.length > 0 ? (
              <TaskSection
                id="today"
                title="Today"
                count={today.length}
                tasks={today}
                allTasks={tasks}
                projects={projects}
                variant="today"
                date={startOfDay(new Date())}
                selectedTaskId={selectedTaskId}
                onToggleComplete={onToggleComplete}
                onUpdateTask={onUpdateTask}
                onTaskClick={onTaskClick}
              />
            ) : (
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

        {/* Dashed Add Task Placeholder */}
        <button
          type="button"
          onClick={handleAddTaskForToday}
          className="w-full flex items-center mt-2 rounded-sm py-3.5 px-4 gap-3 border-[1.5px] border-dashed border-[#DAD9D4] hover:border-text-tertiary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle
              cx="9"
              cy="9"
              r="7.5"
              stroke="#C4654A"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
            <path d="M9 6v6M6 9h6" stroke="#C4654A" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-[14px] text-text-tertiary leading-[18px]">Add a task...</span>
          <div className="flex items-center ml-auto gap-1">
            <span className="rounded-sm py-0.5 px-1.5 bg-surface text-[16px] text-text-primary font-sans leading-5">
              Q
            </span>
          </div>
        </button>
      </div>
    </ScrollArea>
  )
}

export default TodayView
