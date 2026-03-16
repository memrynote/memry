import type { Task } from '@/data/sample-tasks'
import type { Project, Status, SortField, SortDirection } from '@/data/tasks-data'
import { groupTasksByStatus, type TaskGroupByStatus } from '@/lib/task-utils'
import { getTopLevelTasks, getSubtasks, hasSubtasks } from '@/lib/subtask-utils'
import { groupTasksForSort } from '@/lib/task-grouping'

// ============================================================================
// VIRTUAL ITEM TYPES
// ============================================================================

export type VirtualItemType = 'status-header' | 'group-header' | 'task' | 'parent-task'

interface VirtualItemBase {
  id: string
  type: VirtualItemType
}

export interface StatusHeaderItem extends VirtualItemBase {
  type: 'status-header'
  status: Status
  count: number
}

export interface GroupHeaderItem extends VirtualItemBase {
  type: 'group-header'
  groupKey: string
  label: string
  count: number
  sortField: SortField
  color?: string
  variant?: 'overdue' | 'default'
  isCollapsed?: boolean
}

export interface TaskItem extends VirtualItemBase {
  type: 'task'
  task: Task
  project: Project
  sectionId: string
}

export interface ParentTaskItem extends VirtualItemBase {
  type: 'parent-task'
  task: Task
  project: Project
  subtasks: Task[]
  sectionId: string
}

export type VirtualItem = StatusHeaderItem | GroupHeaderItem | TaskItem | ParentTaskItem

// ============================================================================
// HEIGHT CONSTANTS
// ============================================================================

export const ITEM_HEIGHTS = {
  'status-header': 48,
  'group-header': 33,
  task: 31,
  'parent-task-collapsed': 31,
  'subtask-row': 28
} as const

export const estimateItemHeight = (
  item: VirtualItem,
  expandedIds: Set<string>,
  allTasks: Task[]
): number => {
  switch (item.type) {
    case 'status-header':
      return ITEM_HEIGHTS['status-header']

    case 'group-header':
      return ITEM_HEIGHTS['group-header']

    case 'task':
      return ITEM_HEIGHTS.task

    case 'parent-task': {
      if (!expandedIds.has(item.task.id)) {
        return ITEM_HEIGHTS['parent-task-collapsed']
      }
      const subtasks = allTasks.filter((t) => t.parentId === item.task.id)
      return ITEM_HEIGHTS['parent-task-collapsed'] + subtasks.length * ITEM_HEIGHTS['subtask-row']
    }

    default:
      return 50
  }
}

// ============================================================================
// FLATTENING UTILITIES - FLAT LIST (All Tasks / Today Views)
// ============================================================================

export const flattenTasksFlat = (
  tasks: Task[],
  projects: Project[],
  allTasks: Task[]
): VirtualItem[] => {
  const items: VirtualItem[] = []
  const topLevelTasks = getTopLevelTasks(tasks)
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  topLevelTasks.forEach((task) => {
    const project = projectMap.get(task.projectId)
    if (!project) return

    if (hasSubtasks(task)) {
      const subtasks = getSubtasks(task.id, allTasks)
      items.push({
        id: `parent-task-${task.id}`,
        type: 'parent-task',
        task,
        project,
        subtasks,
        sectionId: 'flat'
      })
    } else {
      items.push({
        id: `task-${task.id}`,
        type: 'task',
        task,
        project,
        sectionId: 'flat'
      })
    }
  })

  return items
}

// ============================================================================
// FLATTENING UTILITIES - BY STATUS (Project View)
// ============================================================================

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
    items.push({
      id: `status-header-${group.status.id}`,
      type: 'status-header',
      status: group.status,
      count: group.tasks.length
    })

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
// FLATTENING UTILITIES - GROUPED BY SORT FIELD (All Tasks with grouping)
// ============================================================================

export const flattenTasksGrouped = (
  tasks: Task[],
  projects: Project[],
  allTasks: Task[],
  sortField: SortField,
  sortDirection: SortDirection,
  collapsedGroups?: Set<string>
): VirtualItem[] => {
  const groups = groupTasksForSort(tasks, sortField, sortDirection, projects)

  if (groups.length === 0) {
    return flattenTasksFlat(tasks, projects, allTasks)
  }

  const items: VirtualItem[] = []
  const projectMap = new Map(projects.map((p) => [p.id, p]))

  groups.forEach((group) => {
    const isCollapsed = collapsedGroups?.has(group.key) ?? false

    items.push({
      id: `group-header-${group.key}`,
      type: 'group-header',
      groupKey: group.key,
      label: group.label,
      count: group.tasks.length,
      sortField,
      color: group.color,
      variant: group.variant,
      isCollapsed
    })

    if (isCollapsed) return

    const topLevelTasks = getTopLevelTasks(group.tasks)

    topLevelTasks.forEach((task) => {
      const project = projectMap.get(task.projectId)
      if (!project) return

      if (hasSubtasks(task)) {
        const subtasks = getSubtasks(task.id, allTasks)
        items.push({
          id: `parent-task-${task.id}`,
          type: 'parent-task',
          task,
          project,
          subtasks,
          sectionId: group.key
        })
      } else {
        items.push({
          id: `task-${task.id}`,
          type: 'task',
          task,
          project,
          sectionId: group.key
        })
      }
    })
  })

  return items
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

export const getTaskIdsFromVirtualItems = (items: VirtualItem[]): string[] => {
  return items
    .filter(
      (item): item is TaskItem | ParentTaskItem =>
        item.type === 'task' || item.type === 'parent-task'
    )
    .map((item) => item.task.id)
}
