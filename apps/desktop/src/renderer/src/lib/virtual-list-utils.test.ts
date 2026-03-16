import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

vi.mock('@/lib/task-utils', async () => {
  const actual = await vi.importActual('@/lib/task-utils')
  return {
    ...actual,
    groupTasksByStatus: vi.fn()
  }
})

vi.mock('@/lib/subtask-utils', () => ({
  getTopLevelTasks: vi.fn((tasks: Task[]) => tasks.filter((t) => t.parentId === null)),
  getSubtasks: vi.fn((id: string, tasks: Task[]) => tasks.filter((t) => t.parentId === id)),
  hasSubtasks: vi.fn((task: Task) => task.subtaskIds?.length > 0)
}))

import {
  ITEM_HEIGHTS,
  estimateItemHeight,
  flattenTasksFlat,
  flattenTasksGrouped,
  flattenTasksByStatus,
  getTaskIdsFromVirtualItems,
  type VirtualItem,
  type StatusHeaderItem,
  type GroupHeaderItem,
  type TaskItem,
  type ParentTaskItem
} from './virtual-list-utils'

import { groupTasksByStatus } from '@/lib/task-utils'
import { getTopLevelTasks, getSubtasks, hasSubtasks } from '@/lib/subtask-utils'

// ============================================================================
// MOCK FACTORIES
// ============================================================================

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: `task-${Math.random().toString(36).substring(2, 9)}`,
  title: 'Test Task',
  description: '',
  projectId: 'project-1',
  statusId: 'status-todo',
  priority: 'none' as Priority,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const createMockStatus = (overrides: Partial<Status> = {}): Status => ({
  id: 'status-todo',
  name: 'Todo',
  color: '#gray',
  type: 'todo' as StatusType,
  order: 0,
  ...overrides
})

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  icon: 'folder',
  color: '#3b82f6',
  statuses: [
    createMockStatus({ id: 'status-todo', name: 'Todo', type: 'todo', order: 0 }),
    createMockStatus({ id: 'status-done', name: 'Done', color: '#green', type: 'done', order: 1 })
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(),
  taskCount: 0,
  ...overrides
})

// ============================================================================
// TESTS
// ============================================================================

describe('virtual-list-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================================================
  // ITEM HEIGHT CONSTANTS & ESTIMATION
  // ==========================================================================

  describe('ITEM_HEIGHTS constants', () => {
    it('should have correct height for status-header', () => {
      expect(ITEM_HEIGHTS['status-header']).toBe(48)
    })

    it('should have correct height for task', () => {
      expect(ITEM_HEIGHTS.task).toBe(31)
    })

    it('should have correct height for parent-task-collapsed', () => {
      expect(ITEM_HEIGHTS['parent-task-collapsed']).toBe(31)
    })

    it('should have correct height for group-header', () => {
      expect(ITEM_HEIGHTS['group-header']).toBe(33)
    })

    it('should have correct height for subtask-row', () => {
      expect(ITEM_HEIGHTS['subtask-row']).toBe(28)
    })
  })

  describe('estimateItemHeight', () => {
    const mockProject = createMockProject()
    const emptyExpandedIds = new Set<string>()

    it('should return 48 for status-header', () => {
      const item: StatusHeaderItem = {
        id: 'status-header-todo',
        type: 'status-header',
        status: createMockStatus(),
        count: 3
      }
      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(48)
    })

    it('should return 31 for task', () => {
      const task = createMockTask()
      const item: TaskItem = {
        id: `task-${task.id}`,
        type: 'task',
        task,
        project: mockProject,
        sectionId: 'flat'
      }
      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(31)
    })

    it('should return 31 for collapsed parent-task', () => {
      const task = createMockTask({ subtaskIds: ['sub-1', 'sub-2'] })
      const item: ParentTaskItem = {
        id: `parent-task-${task.id}`,
        type: 'parent-task',
        task,
        project: mockProject,
        subtasks: [],
        sectionId: 'flat'
      }
      expect(estimateItemHeight(item, emptyExpandedIds, [])).toBe(31)
    })

    it('should return expanded height for parent-task when expanded', () => {
      const parentTask = createMockTask({ id: 'parent-1', subtaskIds: ['sub-1', 'sub-2'] })
      const subtask1 = createMockTask({ id: 'sub-1', parentId: 'parent-1' })
      const subtask2 = createMockTask({ id: 'sub-2', parentId: 'parent-1' })
      const allTasks = [parentTask, subtask1, subtask2]
      const expandedIds = new Set<string>(['parent-1'])

      const item: ParentTaskItem = {
        id: `parent-task-${parentTask.id}`,
        type: 'parent-task',
        task: parentTask,
        project: mockProject,
        subtasks: [subtask1, subtask2],
        sectionId: 'flat'
      }

      // 31 (base) + 2 * 28 (subtasks) = 87
      expect(estimateItemHeight(item, expandedIds, allTasks)).toBe(87)
    })
  })

  // ==========================================================================
  // FLATTEN TASKS FLAT
  // ==========================================================================

  describe('flattenTasksFlat', () => {
    const mockProject = createMockProject()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should return empty array for empty tasks', () => {
      const result = flattenTasksFlat([], [mockProject], [])
      expect(result).toEqual([])
    })

    it('should create task items without section headers', () => {
      const task = createMockTask({ id: 'task-1' })

      const result = flattenTasksFlat([task], [mockProject], [task])

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('task')
      expect((result[0] as TaskItem).task.id).toBe('task-1')
      expect((result[0] as TaskItem).sectionId).toBe('flat')
    })

    it('should not produce any section-header items', () => {
      const task1 = createMockTask({ id: 't1', dueDate: new Date(2026, 0, 10) })
      const task2 = createMockTask({ id: 't2', dueDate: new Date(2026, 0, 15) })

      const result = flattenTasksFlat([task1, task2], [mockProject], [task1, task2])

      const sectionHeaders = result.filter((i) => i.type === 'status-header')
      expect(sectionHeaders).toHaveLength(0)
      expect(result).toHaveLength(2)
      expect(result.every((i) => i.type === 'task')).toBe(true)
    })

    it('should handle parent tasks with subtasks', () => {
      const parentTask = createMockTask({
        id: 'parent-1',
        subtaskIds: ['sub-1', 'sub-2']
      })
      const subtask1 = createMockTask({ id: 'sub-1', parentId: 'parent-1' })
      const subtask2 = createMockTask({ id: 'sub-2', parentId: 'parent-1' })
      const allTasks = [parentTask, subtask1, subtask2]

      const result = flattenTasksFlat(allTasks, [mockProject], allTasks)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('parent-task')
      const parentItem = result[0] as ParentTaskItem
      expect(parentItem.task.id).toBe('parent-1')
      expect(parentItem.subtasks).toHaveLength(2)
    })

    it('should skip tasks without a matching project', () => {
      const task = createMockTask({ id: 'task-orphan', projectId: 'nonexistent' })
      const result = flattenTasksFlat([task], [mockProject], [task])
      expect(result).toHaveLength(0)
    })

    it('should handle multiple tasks preserving order', () => {
      const task1 = createMockTask({ id: 't1' })
      const task2 = createMockTask({ id: 't2' })
      const task3 = createMockTask({ id: 't3' })
      const allTasks = [task1, task2, task3]

      const result = flattenTasksFlat(allTasks, [mockProject], allTasks)

      expect(result).toHaveLength(3)
      expect((result[0] as TaskItem).task.id).toBe('t1')
      expect((result[1] as TaskItem).task.id).toBe('t2')
      expect((result[2] as TaskItem).task.id).toBe('t3')
    })
  })

  // ==========================================================================
  // FLATTEN BY STATUS (Project View)
  // ==========================================================================

  describe('flattenTasksByStatus', () => {
    const mockProject = createMockProject()
    const emptyExpandedIds = new Set<string>()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should create status headers and tasks grouped by status', () => {
      const task = createMockTask({ id: 'task-1', statusId: 'status-todo' })

      vi.mocked(groupTasksByStatus).mockReturnValue([
        { status: mockProject.statuses[0], tasks: [task] },
        { status: mockProject.statuses[1], tasks: [] }
      ])

      const result = flattenTasksByStatus([task], mockProject, emptyExpandedIds, [task])

      const statusHeaders = result.filter((i) => i.type === 'status-header')
      expect(statusHeaders).toHaveLength(2)

      const taskItems = result.filter((i) => i.type === 'task')
      expect(taskItems).toHaveLength(1)
    })

    it('should always show empty status headers as drop targets', () => {
      vi.mocked(groupTasksByStatus).mockReturnValue([
        { status: mockProject.statuses[0], tasks: [] },
        { status: mockProject.statuses[1], tasks: [] }
      ])

      const result = flattenTasksByStatus([], mockProject, emptyExpandedIds, [])

      expect(result).toHaveLength(2)
      expect(result.every((i) => i.type === 'status-header')).toBe(true)
    })
  })

  // ==========================================================================
  // HELPER UTILITIES
  // ==========================================================================

  // ==========================================================================
  // FLATTEN TASKS GROUPED
  // ==========================================================================

  describe('flattenTasksGrouped', () => {
    const mockProject = createMockProject()

    beforeEach(() => {
      vi.mocked(getTopLevelTasks).mockImplementation((tasks: Task[]) =>
        tasks.filter((t) => t.parentId === null)
      )
      vi.mocked(hasSubtasks).mockImplementation((task: Task) => task.subtaskIds?.length > 0)
      vi.mocked(getSubtasks).mockImplementation((id: string, tasks: Task[]) =>
        tasks.filter((t) => t.parentId === id)
      )
    })

    it('should fall back to flat list for title sort', () => {
      // #given
      const task = createMockTask({ id: 't1' })

      // #when
      const result = flattenTasksGrouped([task], [mockProject], [task], 'title', 'asc')

      // #then
      const groupHeaders = result.filter((i) => i.type === 'group-header')
      expect(groupHeaders).toHaveLength(0)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('task')
    })

    it('should insert group headers when sorting by priority', () => {
      // #given
      const urgent = createMockTask({ id: 'u', priority: 'urgent' })
      const low = createMockTask({ id: 'l', priority: 'low' })

      // #when
      const result = flattenTasksGrouped(
        [urgent, low],
        [mockProject],
        [urgent, low],
        'priority',
        'asc'
      )

      // #then
      const groupHeaders = result.filter((i) => i.type === 'group-header') as GroupHeaderItem[]
      expect(groupHeaders).toHaveLength(2)
      expect(groupHeaders[0].label).toBe('Urgent')
      expect(groupHeaders[0].count).toBe(1)
      expect(groupHeaders[1].label).toBe('Low')
      expect(groupHeaders[1].count).toBe(1)
    })

    it('should include sortField on group header items', () => {
      // #given
      const task = createMockTask({ id: 't1', dueDate: new Date(2026, 0, 15) })

      // #when
      const result = flattenTasksGrouped([task], [mockProject], [task], 'dueDate', 'asc')

      // #then
      const header = result.find((i) => i.type === 'group-header') as GroupHeaderItem
      expect(header.sortField).toBe('dueDate')
    })

    it('should place tasks under their correct group header', () => {
      // #given
      const urgent = createMockTask({ id: 'u', priority: 'urgent' })
      const low = createMockTask({ id: 'l', priority: 'low' })

      // #when
      const result = flattenTasksGrouped(
        [urgent, low],
        [mockProject],
        [urgent, low],
        'priority',
        'asc'
      )

      // #then — [group-header(urgent), task(u), group-header(low), task(l)]
      expect(result).toHaveLength(4)
      expect(result[0].type).toBe('group-header')
      expect(result[1].type).toBe('task')
      expect((result[1] as TaskItem).task.id).toBe('u')
      expect(result[2].type).toBe('group-header')
      expect(result[3].type).toBe('task')
      expect((result[3] as TaskItem).task.id).toBe('l')
    })

    it('should reverse group order for desc direction', () => {
      // #given
      const urgent = createMockTask({ id: 'u', priority: 'urgent' })
      const low = createMockTask({ id: 'l', priority: 'low' })

      // #when
      const asc = flattenTasksGrouped(
        [urgent, low],
        [mockProject],
        [urgent, low],
        'priority',
        'asc'
      )
      const desc = flattenTasksGrouped(
        [urgent, low],
        [mockProject],
        [urgent, low],
        'priority',
        'desc'
      )

      // #then
      const ascHeaders = asc.filter((i) => i.type === 'group-header') as GroupHeaderItem[]
      const descHeaders = desc.filter((i) => i.type === 'group-header') as GroupHeaderItem[]
      expect(ascHeaders[0].label).toBe('Urgent')
      expect(descHeaders[0].label).toBe('Low')
    })

    it('should handle parent tasks with subtasks in grouped view', () => {
      // #given
      const parent = createMockTask({ id: 'p1', priority: 'high', subtaskIds: ['s1'] })
      const subtask = createMockTask({ id: 's1', priority: 'high', parentId: 'p1' })

      // #when
      const result = flattenTasksGrouped(
        [parent, subtask],
        [mockProject],
        [parent, subtask],
        'priority',
        'asc'
      )

      // #then
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('group-header')
      expect(result[1].type).toBe('parent-task')
    })
  })

  // ==========================================================================
  // HELPER UTILITIES
  // ==========================================================================

  describe('getTaskIdsFromVirtualItems', () => {
    const mockProject = createMockProject()

    it('should extract task IDs from task and parent-task items', () => {
      const items: VirtualItem[] = [
        {
          id: 'status-header-todo',
          type: 'status-header',
          status: createMockStatus(),
          count: 2
        },
        {
          id: 'task-1',
          type: 'task',
          task: createMockTask({ id: 'actual-task-1' }),
          project: mockProject,
          sectionId: 'flat'
        },
        {
          id: 'parent-task-2',
          type: 'parent-task',
          task: createMockTask({ id: 'actual-task-2' }),
          project: mockProject,
          subtasks: [],
          sectionId: 'flat'
        }
      ]

      const ids = getTaskIdsFromVirtualItems(items)
      expect(ids).toEqual(['actual-task-1', 'actual-task-2'])
    })

    it('should return empty array for no task items', () => {
      const items: VirtualItem[] = [
        {
          id: 'status-header-todo',
          type: 'status-header',
          status: createMockStatus(),
          count: 0
        }
      ]

      expect(getTaskIdsFromVirtualItems(items)).toEqual([])
    })
  })
})
