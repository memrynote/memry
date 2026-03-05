import type { Task } from '@/data/sample-tasks'
import type { Project, Status } from '@/data/tasks-data'
import {
  groupTasksByDueDate,
  groupTasksByStatus,
  dueDateGroupConfig,
  formatDateKey,
  parseDateKey,
  startOfDay,
  type TaskGroupByDate,
  type TaskGroupByStatus,
  type UrgencyLevel
} from '@/lib/task-utils'
import { getTopLevelTasks, getSubtasks, hasSubtasks } from '@/lib/subtask-utils'

// ============================================================================
// VIRTUAL ITEM TYPES
// ============================================================================

/**
 * Virtual item types for flattened list rendering
 */
export type VirtualItemType =
  | 'section-header' // Due date group header (Overdue, Today, etc.)
  | 'status-header' // Project status header
  | 'task' // Simple task (no subtasks)
  | 'parent-task' // Task with subtasks (variable height when expanded)
  | 'empty-state' // Per-section empty state
  | 'add-task-button' // Add task button at section end
  | 'week-accordion-header' // "This Week" collapsible accordion
  | 'day-header' // Per-day header within week accordion

/**
 * Base interface for all virtual items
 */
interface VirtualItemBase {
  id: string
  type: VirtualItemType
}

/**
 * Section header for due date grouping (All Tasks view)
 */
export interface SectionHeaderItem extends VirtualItemBase {
  type: 'section-header'
  sectionKey: keyof TaskGroupByDate
  label: string
  count: number
  urgency: UrgencyLevel
  accentColor?: string
  isMuted?: boolean
  isCollapsed?: boolean
}

/**
 * Status header for project view
 */
export interface StatusHeaderItem extends VirtualItemBase {
  type: 'status-header'
  status: Status
  count: number
}

/**
 * Simple task item (no subtasks)
 */
export interface TaskItem extends VirtualItemBase {
  type: 'task'
  task: Task
  project: Project
  sectionId: string
  isOverdue?: boolean
}

/**
 * Parent task item (has subtasks, variable height when expanded)
 */
export interface ParentTaskItem extends VirtualItemBase {
  type: 'parent-task'
  task: Task
  project: Project
  subtasks: Task[]
  sectionId: string
  isOverdue?: boolean
}

/**
 * Empty state for a section
 */
export interface EmptyStateItem extends VirtualItemBase {
  type: 'empty-state'
  variant: 'section' | 'celebration'
  sectionId?: string
  message?: string
}

/**
 * Add task button at end of section
 */
export interface AddTaskButtonItem extends VirtualItemBase {
  type: 'add-task-button'
  sectionId: string
  date?: Date
}

export interface WeekAccordionHeaderItem extends VirtualItemBase {
  type: 'week-accordion-header'
  totalCount: number
  isCollapsed: boolean
}

export interface DayHeaderItem extends VirtualItemBase {
  type: 'day-header'
  date: Date
  dateKey: string
  taskCount: number
  isTomorrow: boolean
}

/**
 * Union type for all virtual items
 */
export type VirtualItem =
  | SectionHeaderItem
  | StatusHeaderItem
  | TaskItem
  | ParentTaskItem
  | EmptyStateItem
  | AddTaskButtonItem
  | WeekAccordionHeaderItem
  | DayHeaderItem

// ============================================================================
// HEIGHT CONSTANTS
// ============================================================================

/**
 * Estimated heights for virtual items (in pixels)
 */
export const ITEM_HEIGHTS = {
  'section-header': 48,
  'status-header': 48,
  task: 52,
  'parent-task-collapsed': 52,
  'subtask-row': 38,
  'add-subtask-input': 40,
  'empty-state': 80,
  'empty-state-celebration': 200,
  'add-task-button': 40,
  'week-accordion-header': 48,
  'day-header': 40,
  'empty-day': 56
} as const

/**
 * Calculate estimated height for a virtual item
 * Handles dynamic height for expanded parent tasks
 */
export const estimateItemHeight = (
  item: VirtualItem,
  expandedIds: Set<string>,
  allTasks: Task[]
): number => {
  switch (item.type) {
    case 'section-header':
      return ITEM_HEIGHTS['section-header']

    case 'status-header':
      return ITEM_HEIGHTS['status-header']

    case 'task':
      return ITEM_HEIGHTS.task

    case 'parent-task': {
      if (!expandedIds.has(item.task.id)) {
        return ITEM_HEIGHTS['parent-task-collapsed']
      }
      // Calculate expanded height: base + subtasks + add input
      const subtasks = allTasks.filter((t) => t.parentId === item.task.id)
      return (
        ITEM_HEIGHTS['parent-task-collapsed'] +
        subtasks.length * ITEM_HEIGHTS['subtask-row'] +
        ITEM_HEIGHTS['add-subtask-input']
      )
    }

    case 'empty-state':
      return item.variant === 'celebration'
        ? ITEM_HEIGHTS['empty-state-celebration']
        : ITEM_HEIGHTS['empty-state']

    case 'add-task-button':
      return ITEM_HEIGHTS['add-task-button']

    case 'week-accordion-header':
      return ITEM_HEIGHTS['week-accordion-header']

    case 'day-header':
      return ITEM_HEIGHTS['day-header']

    default:
      return 50
  }
}

// ============================================================================
// FLATTENING UTILITIES - BY DUE DATE (All Tasks View)
// ============================================================================

/**
 * Flatten tasks grouped by due date into virtual items
 * Used for All Tasks view
 */
export const flattenTasksByDueDate = (
  tasks: Task[],
  projects: Project[],
  _expandedIds: Set<string>,
  allTasks: Task[],
  collapsedSections: Set<string> = new Set(),
  preserveOrder: boolean = false
): VirtualItem[] => {
  const items: VirtualItem[] = []
  const topLevelTasks = getTopLevelTasks(tasks)
  const groupedTasks = groupTasksByDueDate(topLevelTasks, preserveOrder)

  // Create project lookup map
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  // Group order matches the non-virtualized view
  const groupOrder: (keyof TaskGroupByDate)[] = [
    'overdue',
    'today',
    'tomorrow',
    'upcoming',
    'later',
    'noDueDate'
  ]

  groupOrder.forEach((groupKey) => {
    const config = dueDateGroupConfig[groupKey]
    const tasksInGroup = groupedTasks[groupKey]

    if (tasksInGroup.length === 0) return

    const isSectionCollapsed = collapsedSections.has(groupKey)

    items.push({
      id: `header-${groupKey}`,
      type: 'section-header',
      sectionKey: groupKey,
      label: config.label,
      count: tasksInGroup.length,
      urgency: config.urgency,
      accentColor: config.accentColor,
      isMuted: config.isMuted,
      isCollapsed: isSectionCollapsed
    })

    if (isSectionCollapsed) return

    tasksInGroup.forEach((task) => {
      const project = projectMap.get(task.projectId)
      if (!project) return

      const taskHasSubtasks = hasSubtasks(task)

      if (taskHasSubtasks) {
        const subtasks = getSubtasks(task.id, allTasks)
        items.push({
          id: `parent-task-${task.id}`,
          type: 'parent-task',
          task,
          project,
          subtasks,
          sectionId: groupKey,
          isOverdue: groupKey === 'overdue'
        })
      } else {
        items.push({
          id: `task-${task.id}`,
          type: 'task',
          task,
          project,
          sectionId: groupKey,
          isOverdue: groupKey === 'overdue'
        })
      }
    })

    items.push({
      id: `add-${groupKey}`,
      type: 'add-task-button',
      sectionId: groupKey
    })
  })

  return items
}

// ============================================================================
// FLATTENING UTILITIES - TODAY VIEW
// ============================================================================

export interface TodayViewData {
  overdue: Task[]
  today: Task[]
  weekByDay?: Map<string, Task[]>
}

/**
 * Flatten today view tasks into virtual items
 * Used for Today view with overdue and today sections
 */
export const flattenTodayTasks = (
  todayData: TodayViewData,
  projects: Project[],
  _expandedIds: Set<string>,
  allTasks: Task[],
  showCelebration: boolean,
  collapsedSections: Set<string> = new Set(),
  showEmptyDays: boolean = true
): VirtualItem[] => {
  const items: VirtualItem[] = []
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  const hasOverdue = todayData.overdue.length > 0
  const hasToday = todayData.today.length > 0
  const hasWeekTasks = todayData.weekByDay
    ? Array.from(todayData.weekByDay.values()).some((d) => d.length > 0)
    : false
  const isEmpty = !hasOverdue && !hasToday && !hasWeekTasks

  // Show celebration empty state when completely empty
  if (isEmpty) {
    if (showCelebration) {
      items.push({
        id: 'empty-celebration',
        type: 'empty-state',
        variant: 'celebration',
        message: 'All clear for today!'
      })
    }
    return items
  }

  // Overdue section
  if (hasOverdue) {
    const isOverdueCollapsed = collapsedSections.has('overdue')
    items.push({
      id: 'header-overdue',
      type: 'section-header',
      sectionKey: 'overdue',
      label: 'OVERDUE',
      count: todayData.overdue.length,
      urgency: 'critical',
      accentColor: '#ef4444',
      isCollapsed: isOverdueCollapsed
    })

    if (!isOverdueCollapsed) {
      const topLevelOverdue = getTopLevelTasks(todayData.overdue)
      topLevelOverdue.forEach((task) => {
        const project = projectMap.get(task.projectId)
        if (!project) return

        const taskHasSubtasks = hasSubtasks(task)

        if (taskHasSubtasks) {
          const subtasks = getSubtasks(task.id, allTasks)
          items.push({
            id: `parent-task-${task.id}`,
            type: 'parent-task',
            task,
            project,
            subtasks,
            sectionId: 'overdue',
            isOverdue: true
          })
        } else {
          items.push({
            id: `task-${task.id}`,
            type: 'task',
            task,
            project,
            sectionId: 'overdue',
            isOverdue: true
          })
        }
      })
    }
  }

  // Today section
  const isTodayCollapsed = collapsedSections.has('today')
  items.push({
    id: 'header-today',
    type: 'section-header',
    sectionKey: 'today',
    label: 'TODAY',
    count: todayData.today.length,
    urgency: 'high',
    accentColor: '#3b82f6',
    isCollapsed: isTodayCollapsed
  })

  if (!isTodayCollapsed) {
    if (hasToday) {
      const topLevelToday = getTopLevelTasks(todayData.today)
      topLevelToday.forEach((task) => {
        const project = projectMap.get(task.projectId)
        if (!project) return

        const taskHasSubtasks = hasSubtasks(task)

        if (taskHasSubtasks) {
          const subtasks = getSubtasks(task.id, allTasks)
          items.push({
            id: `parent-task-${task.id}`,
            type: 'parent-task',
            task,
            project,
            subtasks,
            sectionId: 'today'
          })
        } else {
          items.push({
            id: `task-${task.id}`,
            type: 'task',
            task,
            project,
            sectionId: 'today'
          })
        }
      })
    }

    items.push({
      id: 'add-today',
      type: 'add-task-button',
      sectionId: 'today'
    })
  }

  if (todayData.weekByDay && todayData.weekByDay.size > 0) {
    let totalWeekTasks = 0
    todayData.weekByDay.forEach((dayTasks) => {
      totalWeekTasks += dayTasks.length
    })

    const isWeekCollapsed = collapsedSections.has('this-week')

    items.push({
      id: 'header-this-week',
      type: 'week-accordion-header',
      totalCount: totalWeekTasks,
      isCollapsed: isWeekCollapsed
    })

    if (!isWeekCollapsed) {
      const tomorrowDate = new Date()
      tomorrowDate.setDate(tomorrowDate.getDate() + 1)
      const tomorrowKey = formatDateKey(startOfDay(tomorrowDate))

      todayData.weekByDay.forEach((dayTasks, dateKey) => {
        const date = parseDateKey(dateKey)
        const isTomorrow = dateKey === tomorrowKey

        if (dayTasks.length === 0 && !showEmptyDays) return

        items.push({
          id: `day-${dateKey}`,
          type: 'day-header',
          date,
          dateKey,
          taskCount: dayTasks.length,
          isTomorrow
        })

        if (dayTasks.length > 0) {
          const topLevelDayTasks = getTopLevelTasks(dayTasks)
          topLevelDayTasks.forEach((task) => {
            const project = projectMap.get(task.projectId)
            if (!project) return

            const taskHasSubtasks = hasSubtasks(task)
            if (taskHasSubtasks) {
              const subtasks = getSubtasks(task.id, allTasks)
              items.push({
                id: `parent-task-${task.id}`,
                type: 'parent-task',
                task,
                project,
                subtasks,
                sectionId: dateKey
              })
            } else {
              items.push({
                id: `task-${task.id}`,
                type: 'task',
                task,
                project,
                sectionId: dateKey
              })
            }
          })
        }

        items.push({
          id: `add-${dateKey}`,
          type: 'add-task-button',
          sectionId: dateKey,
          date
        })
      })
    }
  }

  return items
}

// ============================================================================
// FLATTENING UTILITIES - BY STATUS (Project View)
// ============================================================================

/**
 * Flatten tasks grouped by status into virtual items
 * Used for Project view
 */
export const flattenTasksByStatus = (
  tasks: Task[],
  project: Project,
  _expandedIds: Set<string>,
  allTasks: Task[],
  preserveOrder: boolean = false
): VirtualItem[] => {
  const items: VirtualItem[] = []
  const topLevelTasks = getTopLevelTasks(tasks)
  const groupedTasks = groupTasksByStatus(topLevelTasks, project.statuses, preserveOrder)

  groupedTasks.forEach((group: TaskGroupByStatus) => {
    // Add status header (always show, even if empty - for drop targets)
    items.push({
      id: `status-header-${group.status.id}`,
      type: 'status-header',
      status: group.status,
      count: group.tasks.length
    })

    // Add tasks in this status
    group.tasks.forEach((task) => {
      const taskHasSubtasks = hasSubtasks(task)

      if (taskHasSubtasks) {
        const subtasks = getSubtasks(task.id, allTasks)
        items.push({
          id: `parent-task-${task.id}`,
          type: 'parent-task',
          task,
          project,
          subtasks,
          sectionId: group.status.id
        })
      } else {
        items.push({
          id: `task-${task.id}`,
          type: 'task',
          task,
          project,
          sectionId: group.status.id
        })
      }
    })
  })

  return items
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

/**
 * Extract all task IDs from virtual items for SortableContext
 */
export const getTaskIdsFromVirtualItems = (items: VirtualItem[]): string[] => {
  return items
    .filter(
      (item): item is TaskItem | ParentTaskItem =>
        item.type === 'task' || item.type === 'parent-task'
    )
    .map((item) => item.task.id)
}
