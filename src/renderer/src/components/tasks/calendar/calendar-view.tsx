import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { CalendarHeader } from './calendar-header'
import { CalendarGrid } from './calendar-grid'
import { DayDetailPopover } from './day-detail-popover'
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  formatDateKey,
  formatDateShort,
  getCalendarDays,
  groupTasksByCalendarDate,
  isTaskCompleted,
  startOfDay,
  startOfMonth,
  subMonths,
  isBefore,
  isAfter,
  isSameDay,
  type CalendarDay
} from '@/lib/task-utils'
import { calculateNextOccurrence } from '@/lib/repeat-utils'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/sample-tasks'
import { ScrollArea } from '@/components/ui/scroll-area'

type SelectionType = 'view' | 'project'

interface CalendarViewProps {
  tasks: Task[]
  projects: Project[]
  selectedId: string
  selectedType: SelectionType
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onTaskClick: (taskId: string) => void
  onAddTaskWithDate: (date: Date) => void
  onToggleComplete: (taskId: string) => void
  // Selection props
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
}

const useIsCompact = (): boolean => {
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const handleResize = (): void => {
      setCompact(window.innerWidth < 768)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return compact
}

export const CalendarView = ({
  tasks,
  projects,
  selectedId,
  selectedType,
  onUpdateTask,
  onTaskClick,
  onAddTaskWithDate,
  onToggleComplete,
  // Selection props
  isSelectionMode = false,
  selectedIds,
  onToggleSelect
}: CalendarViewProps): React.JSX.Element => {
  const [currentMonth, setCurrentMonth] = useState<Date>(startOfDay(new Date()))
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [focusedDate, setFocusedDate] = useState<Date | null>(null)
  const [isDayDetailOpen, setIsDayDetailOpen] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)

  const isCompact = useIsCompact()

  const calendarDays: CalendarDay[] = useMemo(() => getCalendarDays(currentMonth), [currentMonth])

  const visibleStart = useMemo(
    () => calendarDays[0]?.date || startOfDay(currentMonth),
    [calendarDays, currentMonth]
  )
  const visibleEnd = useMemo(
    () => calendarDays[calendarDays.length - 1]?.date || endOfWeek(currentMonth),
    [calendarDays, currentMonth]
  )

  // Generate occurrences for repeating tasks within visible range
  const expandRepeatingTasks = useCallback(
    (taskList: Task[], rangeStart: Date, rangeEnd: Date): Task[] => {
      const expanded: Task[] = []

      taskList.forEach((task) => {
        if (!task.dueDate) return

        // For non-repeating tasks, just check if in range
        if (!task.isRepeating || !task.repeatConfig) {
          const taskDate = startOfDay(task.dueDate)
          if (
            taskDate.getTime() >= rangeStart.getTime() &&
            taskDate.getTime() <= rangeEnd.getTime()
          ) {
            expanded.push(task)
          }
          return
        }

        // For repeating tasks, generate occurrences within the range
        let currentDate = startOfDay(task.dueDate)
        let occurrenceCount = 0
        const maxOccurrences = 50 // Safety limit

        while (occurrenceCount < maxOccurrences) {
          // If current date is past the range end, stop
          if (isAfter(currentDate, rangeEnd)) break

          // If current date is within range, add an occurrence
          if (!isBefore(currentDate, rangeStart) && !isAfter(currentDate, rangeEnd)) {
            const occurrence: Task = {
              ...task,
              // Create unique ID for each occurrence to avoid key conflicts
              id: isSameDay(currentDate, task.dueDate)
                ? task.id
                : `${task.id}-occ-${formatDateKey(currentDate)}`,
              dueDate: currentDate
            }
            expanded.push(occurrence)
          }

          // Calculate next occurrence
          const next = calculateNextOccurrence(currentDate, task.repeatConfig)
          if (!next) break

          currentDate = next
          occurrenceCount++
        }
      })

      return expanded
    },
    []
  )

  const visibleTasks = useMemo(() => {
    const rangeStart = startOfDay(visibleStart)
    const rangeEnd = startOfDay(visibleEnd)

    // First filter by project and completed status
    const filteredTasks = tasks.filter((task) => {
      // Apply project filter (only in All Tasks view)
      if (selectedType === 'view' && selectedId === 'all' && projectFilter) {
        if (task.projectId !== projectFilter) return false
      }

      if (!showCompleted && isTaskCompleted(task, projects)) {
        return false
      }
      return true
    })

    // Then expand repeating tasks
    return expandRepeatingTasks(filteredTasks, rangeStart, rangeEnd)
  }, [
    tasks,
    visibleStart,
    visibleEnd,
    showCompleted,
    projects,
    selectedType,
    selectedId,
    projectFilter,
    expandRepeatingTasks
  ])

  const tasksByDate = useMemo(
    () => groupTasksByCalendarDate(visibleTasks, startOfDay(visibleStart), startOfDay(visibleEnd)),
    [visibleTasks, visibleStart, visibleEnd]
  )

  const goToPreviousMonth = useCallback(() => {
    setCurrentMonth((prev) => subMonths(prev, 1))
  }, [])

  const goToNextMonth = useCallback(() => {
    setCurrentMonth((prev) => addMonths(prev, 1))
  }, [])

  const goToToday = useCallback(() => {
    const today = startOfDay(new Date())
    setCurrentMonth(today)
    setSelectedDate(today)
  }, [])

  const handleOpenDay = useCallback((date: Date) => {
    setSelectedDate(date)
    setIsDayDetailOpen(true)
  }, [])

  const handleAddTask = useCallback(
    (date: Date) => {
      onAddTaskWithDate(startOfDay(date))
    },
    [onAddTaskWithDate]
  )
  // Drag-and-drop (rescheduling and project moves) is handled by the shared DragProvider.

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Skip if in an input/textarea
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault()
        if (focusedDate) {
          // Navigate to previous day
          setFocusedDate(addDays(focusedDate, -1))
        } else {
          goToPreviousMonth()
        }
        break
      case 'ArrowRight':
        e.preventDefault()
        if (focusedDate) {
          // Navigate to next day
          setFocusedDate(addDays(focusedDate, 1))
        } else {
          goToNextMonth()
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (focusedDate) {
          // Navigate to previous week
          setFocusedDate(addWeeks(focusedDate, -1))
        }
        break
      case 'ArrowDown':
        e.preventDefault()
        if (focusedDate) {
          // Navigate to next week
          setFocusedDate(addWeeks(focusedDate, 1))
        }
        break
      case 'Home':
        e.preventDefault()
        setFocusedDate(startOfMonth(currentMonth))
        break
      case 'End':
        e.preventDefault()
        setFocusedDate(endOfMonth(currentMonth))
        break
      case 'Enter':
        e.preventDefault()
        if (focusedDate) {
          handleOpenDay(focusedDate)
        }
        break
      case ' ':
        e.preventDefault()
        if (focusedDate) {
          handleAddTask(focusedDate)
        }
        break
      case 'Escape':
        e.preventDefault()
        setFocusedDate(null)
        break
      case 't':
      case 'T':
        e.preventDefault()
        goToToday()
        break
      default:
        break
    }
  }

  const selectedDateTasks = useMemo(() => {
    if (!selectedDate) return []
    const key = formatDateKey(selectedDate)
    return tasksByDate.get(key) || []
  }, [selectedDate, tasksByDate])

  // Show project filter only in All Tasks view
  const showProjectFilter = selectedType === 'view' && selectedId === 'all'

  return (
    <div
      className="flex h-full flex-col gap-4 p-6 outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Calendar view"
    >
      <CalendarHeader
        currentMonth={currentMonth}
        onPreviousMonth={goToPreviousMonth}
        onNextMonth={goToNextMonth}
        onToday={goToToday}
        showCompleted={showCompleted}
        onToggleCompleted={setShowCompleted}
        projects={showProjectFilter ? projects : undefined}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
      />

      <ScrollArea className="h-full">
        <CalendarGrid
          days={calendarDays}
          tasksByDate={tasksByDate}
          allTasks={tasks}
          selectedDate={selectedDate}
          focusedDate={focusedDate}
          maxVisibleTasks={isCompact ? 2 : 3}
          isCompact={isCompact}
          onOpenDay={handleOpenDay}
          onTaskClick={onTaskClick}
          onAddTask={handleAddTask}
        />
      </ScrollArea>

      <DayDetailPopover
        date={selectedDate}
        tasks={selectedDateTasks}
        allTasks={tasks}
        isOpen={isDayDetailOpen}
        onClose={() => setIsDayDetailOpen(false)}
        onTaskClick={onTaskClick}
        onToggleComplete={onToggleComplete}
        onAddTask={handleAddTask}
        // Selection props
        isSelectionMode={isSelectionMode}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
      />
    </div>
  )
}

export default CalendarView
